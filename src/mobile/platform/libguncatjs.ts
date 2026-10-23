// Android 端 run_js 引擎：用 Web Worker 替代 node:vm。
//
// 为什么用 Worker 而不是直接 eval：`run_js` 的契约里有「超时即中断」。主线程的
// Function/eval 没有中断接口（鸿蒙侧的 JSVM 同样没有），而 Worker 可以被 terminate()，
// 所以死循环会在调用方预算内真正停下来。
//
// 沙箱边界：脚本拿不到 fetch / indexedDB / 宿主 DOM；文件只能通过 inputs/read 进、
// write 出。注意这不是进程级安全边界（同源的 Worker 仍可通过 Function 拿到全局），
// 与桌面版 node:vm 的定位一致：约束的是「正常写法」，不是恶意逃逸。
export interface JsRunOptions {
  inputs: Record<string, string>
  resourceName?: string
  timeoutMs?: number
  heapMb?: number
  stdoutLimitKb?: number
  outputFileLimitKb?: number
  outputTotalLimitKb?: number
  maxOutputFiles?: number
}

export interface JsRunResult {
  ok: boolean
  error: string
  inputCount: number
  inputKeys: string[]
  hasResult: boolean
  result: string
  stdout: string
  outputs: Record<string, string>
  durationMs: number
  notice: string
}

function normalizeRel(raw: string): string {
  let body = String(raw ?? '').trim()
  while (body.startsWith('/')) {
    body = body.substring(1)
  }
  while (body.startsWith('./')) {
    body = body.substring(2)
  }
  let out = ''
  for (let i = 0; i < body.length; i++) {
    const ch = body.charAt(i)
    if (ch === '/' && (out === '' || out.endsWith('/'))) {
      continue
    }
    out += ch
  }
  while (out.endsWith('/')) {
    out = out.substring(0, out.length - 1)
  }
  return out
}

function stringify(value: unknown): string {
  if (value === undefined) {
    return ''
  }
  if (typeof value === 'string') {
    return value
  }
  if (value === null) {
    return 'null'
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, null, 2) ?? String(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

const WORKER_SOURCE = `
self.fetch = undefined;
self.XMLHttpRequest = undefined;
self.WebSocket = undefined;
self.indexedDB = undefined;
self.caches = undefined;
self.importScripts = undefined;
self.postMessage = self.postMessage.bind(self);
self.onmessage = async (event) => {
  const { code, inputs, limits } = event.data;
  const encode = (s) => new TextEncoder().encode(s).length;
  const stdoutLimit = limits.stdoutLimitKb * 1024;
  const perFile = limits.outputFileLimitKb * 1024;
  const totalLimit = limits.outputTotalLimitKb * 1024;
  const maxFiles = limits.maxOutputFiles;
  let stdout = '';
  let truncated = false;
  const notices = [];
  const outputs = {};
  let total = 0;
  const keys = Object.keys(inputs);
  const log = (...args) => {
    if (truncated) return;
    stdout += args.map((a) => typeof a === 'string' ? a : JSON.stringify(a) ?? String(a)).join(' ') + '\\n';
    if (encode(stdout) > stdoutLimit) {
      stdout = stdout.slice(0, Math.floor(stdoutLimit / 2)) + '\\n...(控制台输出超限已截断)';
      truncated = true;
      notices.push('控制台输出超过上限已被截断');
    }
  };
  const read = (path) => {
    const key = String(path).replace(/^\\/+/, '');
    if (keys.length === 0) throw new Error('read() 不可用：本次调用没有通过 files 参数预载任何输入文件。');
    if (!Object.prototype.hasOwnProperty.call(inputs, key)) throw new Error('read("' + path + '") 找不到输入文件。可用：' + keys.join(', '));
    return inputs[key];
  };
  const write = (path, content) => {
    const key = String(path).replace(/^\\/+/, '');
    if (!key) throw new Error('write() 的路径不能为空');
    const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    const bytes = encode(text);
    if (bytes > perFile) throw new Error('write("' + path + '") 超过单文件上限');
    if (!Object.prototype.hasOwnProperty.call(outputs, key) && Object.keys(outputs).length >= maxFiles) throw new Error('输出文件数量超过上限');
    const previous = Object.prototype.hasOwnProperty.call(outputs, key) ? encode(outputs[key]) : 0;
    total = total - previous + bytes;
    if (total > totalLimit) throw new Error('输出总量超过上限');
    outputs[key] = text;
  };
  try {
    const value = await eval(code);
    self.postMessage({ ok: true, hasResult: value !== undefined, result: value, stdout, outputs, notice: notices.join('；') });
  } catch (e) {
    self.postMessage({ ok: false, error: e && e.message ? e.message : String(e), stdout, outputs, notice: notices.join('；') });
  }
};
`

export function engineStatus(): string {
  return typeof Worker === 'undefined' ? 'Web Worker 不可用' : ''
}

export async function runJs(code: string, options: JsRunOptions): Promise<JsRunResult> {
  const startedAt = Date.now()
  const inputs: Record<string, string> = {}
  for (const key of Object.keys(options.inputs ?? {})) {
    inputs[normalizeRel(key)] = options.inputs[key]
  }
  const inputKeys = Object.keys(inputs)
  const timeoutMs = Math.max(1000, options.timeoutMs ?? 10_000)
  const limits = {
    stdoutLimitKb: Math.max(1, options.stdoutLimitKb ?? 64),
    outputFileLimitKb: Math.max(1, options.outputFileLimitKb ?? 512),
    outputTotalLimitKb: Math.max(1, options.outputTotalLimitKb ?? 4096),
    maxOutputFiles: options.maxOutputFiles ?? 16
  }

  if (typeof Worker === 'undefined') {
    return {
      ok: false,
      error: '当前运行环境不支持 Web Worker，run_js 不可用',
      inputCount: inputKeys.length,
      inputKeys,
      hasResult: false,
      result: '',
      stdout: '',
      outputs: {},
      durationMs: Date.now() - startedAt,
      notice: ''
    }
  }

  const blob = new Blob([WORKER_SOURCE], { type: 'application/javascript' })
  const url = URL.createObjectURL(blob)
  const worker = new Worker(url)
  URL.revokeObjectURL(url)

  const result = await new Promise<Record<string, unknown>>((resolve) => {
    let done = false
    const finish = (value: Record<string, unknown>): void => {
      if (done) {
        return
      }
      done = true
      clearTimeout(timer)
      worker.terminate()
      resolve(value)
    }
    const timer = setTimeout(() => {
      finish({ ok: false, error: `执行超时：脚本在 ${timeoutMs}ms 内没有结束，已被终止（请检查死循环）` })
    }, timeoutMs)
    worker.onmessage = (event: MessageEvent) => finish(event.data as Record<string, unknown>)
    worker.onerror = (event: ErrorEvent) => {
      finish({ ok: false, error: event.message || '脚本执行失败' })
    }
    worker.postMessage({ code, inputs, limits })
  })

  const outputs = (result.outputs as Record<string, string>) ?? {}
  return {
    ok: result.ok === true,
    error: typeof result.error === 'string' ? result.error : '',
    inputCount: inputKeys.length,
    inputKeys,
    hasResult: result.hasResult === true,
    result: result.hasResult === true ? stringify(result.result) : '',
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    outputs,
    durationMs: Date.now() - startedAt,
    notice: typeof result.notice === 'string' ? result.notice : ''
  }
}
