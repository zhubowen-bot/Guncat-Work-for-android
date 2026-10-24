// Android 原生桥（MainActivity 里通过 addJavascriptInterface 注入）。
//
// 只暴露「WebView 自己做不到」的几件事：
//   · 把 Blob 存到用户选择的位置 / 系统下载目录 / 分享出去（WebView 对 blob: 下载支持很差）
//   · 写系统剪贴板（Android WebView 里 navigator.clipboard 会报 NotAllowedError）
//   · 用系统程序打开工作区里的文件
//   · 系统 TTS
// 文件选择走 HTML <input type=file>（MainActivity 实现了 onShowFileChooser），不需要桥。
export interface AndroidBridge {
  saveFile(name: string, mime: string, base64: string): string
  /**
   * 保存到用户自己选择的位置（ACTION_CREATE_DOCUMENT）。返回 "pending:<id>"，
   * 结果经 window.__guncatExportResult(id, json) 异步回来。
   */
  exportFile?(name: string, mime: string, base64: string): string
  openFile(name: string, mime: string, base64: string): string
  shareFile(name: string, mime: string, base64: string): string
  /** 写系统剪贴板；返回 "ok" 或 "err:…" */
  copyText?(text: string): string
  toast(message: string): void
  info(): string
  ttsSpeak(text: string, rate: string): void
  ttsStop(): void
  pickDirectory(): string
  getVersion(): string
  asrStatus(): string
  asrStart(): string
  asrStop(): void
  armCameraCapture(): void
}

declare global {
  interface Window {
    GuncatAndroid?: AndroidBridge
    __GUNCAT_NATIVE__?: { token?: string; version?: string }
    __guncatAsrResult?: (id: string, json: string) => void
    __guncatExportResult?: (id: string, json: string) => void
  }
}

export function androidBridge(): AndroidBridge | null {
  return typeof window !== 'undefined' && window.GuncatAndroid !== undefined
    ? window.GuncatAndroid
    : null
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunk)) as unknown as number[]
    )
  }
  return btoa(binary)
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

export interface SavedFile {
  ok: boolean
  path: string
  /** 用户在选择位置/保存对话框里按了取消 */
  canceled?: boolean
  error?: string
}

let exportCallbackInstalled = false
const pendingExports = new Map<
  string,
  { resolve(result: SavedFile): void; timer: ReturnType<typeof setTimeout> }
>()

function installExportCallback(): void {
  if (exportCallbackInstalled) {
    return
  }
  exportCallbackInstalled = true
  window.__guncatExportResult = (id: string, json: string): void => {
    const item = pendingExports.get(id)
    if (item === undefined) {
      return
    }
    pendingExports.delete(id)
    clearTimeout(item.timer)
    try {
      const parsed = JSON.parse(json) as {
        status?: string
        path?: string
        message?: string
      }
      if (parsed.status === 'saved') {
        item.resolve({ ok: true, path: typeof parsed.path === 'string' ? parsed.path : '' })
        return
      }
      if (parsed.status === 'canceled') {
        item.resolve({ ok: false, path: '', canceled: true })
        return
      }
      item.resolve({
        ok: false,
        path: '',
        error: typeof parsed.message === 'string' ? parsed.message : '导出失败'
      })
    } catch {
      item.resolve({ ok: false, path: '', error: '原生保存返回了无法解析的结果' })
    }
  }
}

/**
 * 保存到用户自己选择的位置。
 *
 * 有原生桥时走 ACTION_CREATE_DOCUMENT（系统文件管理器：可换目录、可改文件名、可取消）；
 * 没有就退化成浏览器的 <a download>（开发预览时至少能存下来）。
 */
export function saveBytesToUserLocation(
  name: string,
  mime: string,
  bytes: Uint8Array
): Promise<SavedFile> {
  const bridge = androidBridge()
  if (bridge !== null && typeof bridge.exportFile === 'function') {
    installExportCallback()
    return new Promise<SavedFile>((resolve) => {
      let id = ''
      try {
        id = bridge.exportFile?.(name, mime, bytesToBase64(bytes)) ?? ''
      } catch (e) {
        resolve({ ok: false, path: '', error: String(e) })
        return
      }
      if (id.startsWith('err:')) {
        resolve({ ok: false, path: '', error: id.slice(4) })
        return
      }
      if (!id.startsWith('pending:')) {
        resolve({ ok: false, path: '', error: '原生保存没有返回任务 id' })
        return
      }
      const key = id.slice(8)
      // 用户可能在系统文件管理器里停留很久，超时给足 10 分钟；
      // 超时只是不再等待，文件仍会按用户的选择写完（结果事件到达时被忽略）。
      const timer = setTimeout(() => {
        pendingExports.delete(key)
        resolve({ ok: false, path: '', error: '保存超时，请重试' })
      }, 600_000)
      pendingExports.set(key, { resolve, timer })
    })
  }
  if (bridge !== null) {
    // 老版本桥没有 exportFile：退回「直接写下载目录」，至少不会丢文件
    const saved = saveBytes(name, mime, bytes)
    return Promise.resolve(saved)
  }
  return Promise.resolve(saveBytes(name, mime, bytes))
}

/** 保存到系统下载目录；没有任何原生桥时退化成浏览器下载。 */
export function saveBytes(name: string, mime: string, bytes: Uint8Array): SavedFile {
  const bridge = androidBridge()
  if (bridge !== null) {
    try {
      const result = bridge.saveFile(name, mime, bytesToBase64(bytes))
      if (result.startsWith('ok:')) {
        return { ok: true, path: result.slice(3) }
      }
      return { ok: false, path: '', error: result.replace(/^err:/, '') }
    } catch (e) {
      return { ok: false, path: '', error: String(e) }
    }
  }
  try {
    const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = name
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    return { ok: true, path: name }
  } catch (e) {
    return { ok: false, path: '', error: String(e) }
  }
}

/** 用系统程序打开工作区文件（下载目录里的临时副本）。 */
export function openBytes(name: string, mime: string, bytes: Uint8Array): void {
  const bridge = androidBridge()
  if (bridge !== null) {
    bridge.openFile(name, mime, bytesToBase64(bytes))
    return
  }
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime })
  const url = URL.createObjectURL(blob)
  window.open(url, '_blank')
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

export interface ShareOutcome {
  ok: boolean
  error?: string
}

/**
 * 分享文件：一律走**系统分享面板**。
 *
 * 曾经试过 `setPackage("com.tencent.mm")` 直达微信，结果是
 * `No Activity found to handle Intent … pkg=com.tencent.mm`：微信对文件类型挑得很严，
 * 用包名硬指过去只会把失败甩给用户，而系统面板本来就能选微信（还不挑类型）。
 * 没有原生桥时用 Web Share API（桌面 Chrome 支持），再不行就退化成下载。
 */
export function shareBytesTo(name: string, mime: string, bytes: Uint8Array): ShareOutcome {
  const bridge = androidBridge()
  if (bridge !== null) {
    try {
      const result = bridge.shareFile(name, mime, bytesToBase64(bytes))
      if (result === 'ok') {
        return { ok: true }
      }
      return { ok: false, error: result.replace(/^err:/, '') }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  }
  void (async () => {
    const file = new File([bytes.slice().buffer as ArrayBuffer], name, { type: mime })
    const nav = navigator as Navigator & {
      canShare?: (data: { files: File[] }) => boolean
      share?: (data: { files: File[]; title?: string }) => Promise<void>
    }
    if (nav.canShare?.({ files: [file] }) === true && nav.share !== undefined) {
      await nav.share({ files: [file], title: name })
      return
    }
    saveBytes(name, mime, bytes)
  })()
  return { ok: true }
}

export function shareBytes(name: string, mime: string, bytes: Uint8Array): void {
  shareBytesTo(name, mime, bytes)
}

/**
 * 写系统剪贴板。Android WebView 里 navigator.clipboard.writeText 会抛
 * NotAllowedError（WebView 不给页面授予剪贴板写权限），原生桥是唯一可靠的路。
 * 返回是否写成功；调用方可据此决定是否再走浏览器回退。
 */
export function copyTextNative(text: string): boolean {
  const bridge = androidBridge()
  if (bridge === null || typeof bridge.copyText !== 'function') {
    return false
  }
  try {
    return bridge.copyText(text) === 'ok'
  } catch {
    return false
  }
}

export function toast(message: string): void {
  const bridge = androidBridge()
  if (bridge !== null) {
    bridge.toast(message)
    return
  }
  console.log('[toast]', message)
}

export function ttsSpeak(text: string, rate: number): void {
  const bridge = androidBridge()
  if (bridge !== null) {
    bridge.ttsSpeak(text, String(rate))
    return
  }
  if (typeof window.speechSynthesis !== 'undefined') {
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.rate = rate
    window.speechSynthesis.speak(utterance)
  }
}

export function ttsStop(): void {
  const bridge = androidBridge()
  if (bridge !== null) {
    bridge.ttsStop()
    return
  }
  if (typeof window.speechSynthesis !== 'undefined') {
    window.speechSynthesis.cancel()
  }
}

export function ttsSupported(): boolean {
  return androidBridge() !== null || typeof window.speechSynthesis !== 'undefined'
}

// 供 host 的 ASR / 图片读取使用
export { base64ToBytes }
