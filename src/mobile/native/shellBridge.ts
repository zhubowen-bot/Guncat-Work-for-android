// 原生 Shell 桥（MainActivity 里 addJavascriptInterface(new ShellManager(this), "GuncatShell")）。
//
// 这里只放「WebView 绝无可能自己做到」的两件事：
//   1. 真正拉起内置的 Termux bash / 系统 /system/bin/sh；
//   2. 把 memfs 工作区落到应用私有目录（真实命令只认真实文件）。
//
// 所有方法都是同步的（@JavascriptInterface 在 WebView 的 JS 线程执行），
// 因此上层 ShellTask 仍能保持桌面版那套同步 start() 接口不变。
export interface GuncatShellBridge {
  /** JSON：虚拟根、真实根、内置终端状态、系统 shell、外部 Termux 状态 */
  info(): string
  /** JSON：{ok, id, pid, backend, cwd} 或 {ok:false, error} */
  start(command: string, virtualCwd: string, envJson: string, limitChars: number, backend: string): string
  /** JSON：{ok, data, next, dropped, running, exitCode, killed, error, backend, pid, gap?} */
  read(id: string, from: number): string
  kill(id: string): void
  release(id: string): void
  reinstallBundled(): void
  fsList(virtualPath: string): string
  fsRead(virtualPath: string): string
  fsWrite(virtualPath: string, base64: string): string
  fsDelete(virtualPath: string): string
  fsMkdir(virtualPath: string): string
  fsStat(virtualPath: string): string
}

declare global {
  interface Window {
    GuncatShell?: GuncatShellBridge
  }
}

export function shellBridge(): GuncatShellBridge | null {
  if (typeof window === 'undefined') {
    return null
  }
  return window.GuncatShell ?? null
}

export function shellBridgeAvailable(): boolean {
  return shellBridge() !== null
}

export function parseJson(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text)
    if (value !== null && typeof value === 'object') {
      return value as Record<string, unknown>
    }
  } catch {
    // 落到下面的统一结构
  }
  return {}
}

export interface ShellInfo {
  available: boolean
  nativeRoot: string
  shell: string
  abi: string
  /** 随包内置的 Termux 用户态 */
  bundledSupported: boolean
  bundledReady: boolean
  bundledInstalling: boolean
  bundledExtracted: number
  bundledError: string
  bundledVersion: string
  bundledPrefix: string
  termuxInstalled: boolean
  termuxPermission: boolean
  termuxHome: string
  error: string
}

export function readShellInfo(): ShellInfo {
  const bridge = shellBridge()
  const info: ShellInfo = {
    available: bridge !== null,
    nativeRoot: '',
    shell: '',
    abi: '',
    bundledSupported: false,
    bundledReady: false,
    bundledInstalling: false,
    bundledExtracted: 0,
    bundledError: '',
    bundledVersion: '',
    bundledPrefix: '',
    termuxInstalled: false,
    termuxPermission: false,
    termuxHome: '',
    error: ''
  }
  if (bridge === null) {
    info.error = '当前环境没有注入 GuncatShell 原生桥（浏览器预览 / 桌面端）'
    return info
  }
  let parsed: Record<string, unknown>
  try {
    parsed = parseJson(bridge.info())
  } catch (e) {
    info.error = e instanceof Error ? e.message : String(e)
    return info
  }
  if (parsed.ok !== true) {
    info.error = typeof parsed.error === 'string' ? parsed.error : '原生桥不可用'
    return info
  }
  info.nativeRoot = typeof parsed.nativeRoot === 'string' ? parsed.nativeRoot : ''
  info.shell = typeof parsed.shell === 'string' ? parsed.shell : ''
  info.abi = typeof parsed.abi === 'string' ? parsed.abi : ''
  const bundled = (parsed.bundled ?? {}) as Record<string, unknown>
  info.bundledSupported = bundled.supported === true
  info.bundledReady = bundled.ready === true
  info.bundledInstalling = bundled.installing === true
  info.bundledExtracted = Number(bundled.extracted ?? 0)
  info.bundledError = typeof bundled.error === 'string' ? bundled.error : ''
  info.bundledVersion = typeof bundled.version === 'string' ? bundled.version : ''
  info.bundledPrefix = typeof bundled.prefix === 'string' ? bundled.prefix : ''
  const termux = (parsed.termux ?? {}) as Record<string, unknown>
  info.termuxInstalled = termux.installed === true
  info.termuxPermission = termux.permission === true
  info.termuxHome = typeof termux.home === 'string' ? termux.home : ''
  return info
}
