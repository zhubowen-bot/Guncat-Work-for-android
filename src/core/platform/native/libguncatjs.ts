// 桌面端 run_js 引擎：用 Node 内置的 `node:vm` 替代鸿蒙侧的 JSVM-API 原生模块。
//
// 模块名保持 `libguncatjs.so`（由 bundler 别名指向本文件），
// 因此 service/JsCodeService.ts 的移植代码无需改动 import 路径。
//
// 相对鸿蒙实现的改进：
//   1) `vm.runInNewContext` 支持真正的**执行中断**（timeout 选项），
//      所以死循环不再是"放弃等待但后台继续跑"，而是被引擎直接终止；
//      上游那套 abandoned 计数器在桌面端自然失效（仍保留代码以兼容，永不触发）。
//   2) 脚本的**完成值**就是最后一条表达式的值，与鸿蒙侧契约完全一致。
//
// 沙箱边界与上游一致：无网络、无文件系统、无 require/import。
// 文件只能通过 inputs / read() 进、通过 write() 出。
import vm from 'node:vm'

export interface JsRunOptions {
  /** 预载的只读输入：键 = 归一化后的工作区相对路径 */
  inputs: Record<string, string>
  /** 保留字段（鸿蒙侧用于定位 native 资源脚本） */
  resourceName?: string
  /**
   * 执行上限（毫秒）。桌面端把它直接交给 vm 的 timeout，
   * 于是死循环会在**调用方给定的预算内**被引擎中断，
   * 而不是像上游那样「放弃等待但后台继续跑」。
   */
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
  /** 引擎实际收到的输入条数（调用方用它做自检） */
  inputCount: number
  /** 实际可用的输入键名列表 */
  inputKeys: string[]
  hasResult: boolean
  /** 最后一条表达式的值（字符串化） */
  result: string
  stdout: string
  outputs: Record<string, string>
  durationMs: number
  /** 附加提示（如输出被截断） */
  notice: string
}

/** 与 JsCodeService.normalizeRel 保持同一套归一化规则，保证键名可对得上 */
function normalizeRel(raw: string): string {
  let body: string = String(raw ?? '').trim()
  while (body.startsWith('/')) {
    body = body.substring(1)
  }
  while (body.startsWith('./')) {
    body = body.substring(2)
  }
  let out: string = ''
  for (let i: number = 0; i < body.length; i++) {
    const ch: string = body.charAt(i)
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

/** 引擎可用性探测：Node vm 永远可用，返回空串表示无错误（与上游语义一致） */
export function engineStatus(): string {
  return ''
}

export async function runJs(code: string, options: JsRunOptions): Promise<JsRunResult> {
  const startedAt: number = Date.now()
  const outputs: Record<string, string> = {}
  const notices: string[] = []

  const stdoutLimitBytes: number = Math.max(1, (options.stdoutLimitKb ?? 64) * 1024)
  const perFileLimit: number = Math.max(1, (options.outputFileLimitKb ?? 512) * 1024)
  const totalLimit: number = Math.max(1, (options.outputTotalLimitKb ?? 4096) * 1024)
  const maxOutputFiles: number = options.maxOutputFiles ?? 16

  let stdout: string = ''
  let stdoutTruncated: boolean = false
  let outputTotal: number = 0

  const appendStdout = (text: string): void => {
    if (stdoutTruncated) {
      return
    }
    stdout += text
    if (Buffer.byteLength(stdout, 'utf8') > stdoutLimitBytes) {
      stdout = stdout.slice(0, stdoutLimitBytes / 2) + '\n...(控制台输出超限已截断)'
      stdoutTruncated = true
      notices.push(`控制台输出超过 ${options.stdoutLimitKb ?? 64}KB 已被截断`)
    }
  }

  const inputs: Record<string, string> = {}
  for (const key of Object.keys(options.inputs ?? {})) {
    inputs[normalizeRel(key)] = options.inputs[key]
  }
  const inputKeys: string[] = Object.keys(inputs)

  const read = (path: string): string => {
    const key: string = normalizeRel(path)
    if (inputKeys.length === 0) {
      throw new Error(
        'read() 不可用：本次调用没有通过 files 参数预载任何输入文件。' +
          '请在 files 里列出工作区相对路径后重试。'
      )
    }
    if (!Object.prototype.hasOwnProperty.call(inputs, key)) {
      throw new Error(
        `read("${path}") 找不到输入文件（归一化后为 "${key}"）。` +
          `可用键名：${inputKeys.join(', ')}`
      )
    }
    return inputs[key]
  }

  const write = (path: string, content: unknown): void => {
    const key: string = normalizeRel(path)
    if (key === '') {
      throw new Error('write() 的路径不能为空')
    }
    const text: string = typeof content === 'string' ? content : stringify(content)
    const bytes: number = Buffer.byteLength(text, 'utf8')
    if (bytes > perFileLimit) {
      throw new Error(
        `write("${path}") 超过单文件上限 ${options.outputFileLimitKb ?? 512}KB（当前 ${Math.ceil(bytes / 1024)}KB）`
      )
    }
    if (!Object.prototype.hasOwnProperty.call(outputs, key) && Object.keys(outputs).length >= maxOutputFiles) {
      throw new Error(`输出文件数量超过上限 ${maxOutputFiles} 个`)
    }
    // 同名重复写入：按总预算只累加增量，避免重复计数
    const previous: number = Object.prototype.hasOwnProperty.call(outputs, key)
      ? Buffer.byteLength(outputs[key], 'utf8')
      : 0
    outputTotal = outputTotal - previous + bytes
    if (outputTotal > totalLimit) {
      throw new Error(
        `输出总量超过上限 ${options.outputTotalLimitKb ?? 4096}KB，请减少写出的文件或内容`
      )
    }
    outputs[key] = text
  }

  const makeLogger = (): ((...args: unknown[]) => void) => {
    return (...args: unknown[]): void => {
      appendStdout(args.map((a) => stringify(a)).join(' ') + '\n')
    }
  }
  const log = makeLogger()

  const sandbox: Record<string, unknown> = {
    inputs: Object.freeze({ ...inputs }),
    read,
    write,
    print: log,
    console: {
      log,
      info: log,
      debug: log,
      warn: log,
      error: log
    }
  }

  const context: vm.Context = vm.createContext(sandbox, {
    codeGeneration: { strings: true, wasm: false }
  })

  // 用调用方给的预算做硬中断；未提供时兜底 10 秒（与上游默认执行上限一致）
  const vmTimeoutMs: number = Math.max(1000, options.timeoutMs ?? 10_000)

  let ok: boolean = true
  let error: string = ''
  let hasResult: boolean = false
  let resultText: string = ''

  try {
    const completion: unknown = vm.runInContext(code, context, {
      timeout: vmTimeoutMs,
      displayErrors: true
    })
    // 脚本可能返回 Promise（异步脚本）：这里等待它
    const settled: unknown = completion instanceof Promise ? await completion : completion
    if (settled !== undefined) {
      hasResult = true
      resultText = stringify(settled)
    }
  } catch (e) {
    ok = false
    const err: Error = e as Error
    error = err?.message !== undefined && err.message !== '' ? err.message : String(e)
    if (error.includes('timed out')) {
      error = `执行超时：脚本在 ${vmTimeoutMs}ms 内没有结束，已被引擎中断（请检查死循环）`
    }
  }

  return {
    ok,
    error,
    inputCount: inputKeys.length,
    inputKeys,
    hasResult,
    result: resultText,
    stdout,
    outputs,
    durationMs: Date.now() - startedAt,
    notice: notices.join('；')
  }
}
