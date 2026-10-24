// Android 原生语音识别桥：优先 on-device（API 31+ 的离线模型），否则用系统识别服务。
// 网页层的 MediaRecorder + 服务商转写仍保留，作为桌面端/无原生能力时的回退。

export interface NativeAsrResult {
  ok: boolean
  text: string
  error: string
}

interface Pending {
  resolve(result: NativeAsrResult): void
  timer: ReturnType<typeof setTimeout>
}

const pending = new Map<string, Pending>()
let installed = false

function installCallback(): void {
  if (installed) {
    return
  }
  installed = true
  window.__guncatAsrResult = (id: string, json: string): void => {
    const item = pending.get(id)
    if (item === undefined) {
      return
    }
    pending.delete(id)
    clearTimeout(item.timer)
    try {
      const parsed = JSON.parse(json) as Partial<NativeAsrResult>
      item.resolve({
        ok: parsed.ok === true,
        text: typeof parsed.text === 'string' ? parsed.text : '',
        error: typeof parsed.error === 'string' ? parsed.error : ''
      })
    } catch {
      item.resolve({ ok: false, text: '', error: '原生语音识别返回了无法解析的结果' })
    }
  }
}

export function nativeAsrStatus(): 'on-device' | 'system' | 'none' {
  const bridge = window.GuncatAndroid
  if (bridge === undefined || typeof bridge.asrStatus !== 'function') {
    return 'none'
  }
  try {
    const status = bridge.asrStatus()
    return status === 'on-device' || status === 'system' ? status : 'none'
  } catch {
    return 'none'
  }
}

export function nativeAsrStart(): Promise<NativeAsrResult> {
  installCallback()
  const bridge = window.GuncatAndroid
  if (bridge === undefined || typeof bridge.asrStart !== 'function') {
    return Promise.resolve({ ok: false, text: '', error: '当前设备没有原生语音识别桥' })
  }
  return new Promise<NativeAsrResult>((resolve) => {
    let id = ''
    try {
      id = bridge.asrStart()
    } catch (e) {
      resolve({ ok: false, text: '', error: `启动语音识别失败：${String(e)}` })
      return
    }
    if (id === '' || id.startsWith('err:')) {
      resolve({ ok: false, text: '', error: id.replace(/^err:/, '') || '启动语音识别失败' })
      return
    }
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve({ ok: false, text: '', error: '语音识别超时，请重试' })
    }, 30_000)
    pending.set(id, { resolve, timer })
  })
}

export function nativeAsrStop(): void {
  const bridge = window.GuncatAndroid
  if (bridge !== undefined && typeof bridge.asrStop === 'function') {
    try {
      bridge.asrStop()
    } catch {
      // 停止失败时让 30 秒兜底超时收尾
    }
  }
}
