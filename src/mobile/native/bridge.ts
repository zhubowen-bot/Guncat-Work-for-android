// Android 原生桥（MainActivity 里通过 addJavascriptInterface 注入）。
//
// 只暴露「WebView 自己做不到」的几件事：
//   · 把 Blob 存到系统下载目录 / 分享出去（WebView 对 blob: 下载支持很差）
//   · 用系统程序打开工作区里的文件
//   · 系统 TTS
// 文件选择走 HTML <input type=file>（MainActivity 实现了 onShowFileChooser），不需要桥。
export interface AndroidBridge {
  saveFile(name: string, mime: string, base64: string): string
  openFile(name: string, mime: string, base64: string): string
  shareFile(name: string, mime: string, base64: string): string
  toast(message: string): void
  info(): string
  ttsSpeak(text: string, rate: string): void
  ttsStop(): void
  pickDirectory(): string
  getVersion(): string
}

declare global {
  interface Window {
    GuncatAndroid?: AndroidBridge
    __GUNCAT_NATIVE__?: { token?: string; version?: string }
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
  error?: string
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

export function shareBytes(name: string, mime: string, bytes: Uint8Array): void {
  const bridge = androidBridge()
  if (bridge !== null) {
    bridge.shareFile(name, mime, bytesToBase64(bytes))
    return
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
