// 渲染层读取「终端后端」状态的最小适配。
//
// 刻意不 import src/mobile：桌面端构建也会打进这个文件，把 Node/移动平台模块拖进来会炸。
// 这里只认 window.GuncatShell 这个注入对象；没有它（桌面端 / 浏览器）就整块隐藏。
export const SHELL_BACKEND_KEY = 'guncat.shellBackend'
export type ShellBackend = 'bundled' | 'system'

interface ShellBridge {
  info(): string
  reinstallBundled(): void
}

interface WindowWithShell {
  GuncatShell?: ShellBridge
}

function bridge(): ShellBridge | null {
  if (typeof window === 'undefined') {
    return null
  }
  const value = (window as unknown as WindowWithShell).GuncatShell
  return value ?? null
}

export function shellBridgeAvailable(): boolean {
  return bridge() !== null
}

export function shellBackend(): ShellBackend {
  try {
    return window.localStorage.getItem(SHELL_BACKEND_KEY) === 'system' ? 'system' : 'bundled'
  } catch {
    return 'bundled'
  }
}

export function setShellBackend(choice: ShellBackend): void {
  try {
    window.localStorage.setItem(SHELL_BACKEND_KEY, choice)
  } catch {
    // 写不进去时后端仍按当前选择生效，只是重启后回到默认
  }
}

export interface ShellInfo {
  nativeRoot: string
  shell: string
  abi: string
  bundledSupported: boolean
  bundledReady: boolean
  bundledInstalling: boolean
  bundledExtracted: number
  bundledError: string
  bundledVersion: string
  bundledPrefix: string
  error: string
}

export function shellInfo(): ShellInfo | null {
  const shell = bridge()
  if (shell === null) {
    return null
  }
  const info: ShellInfo = {
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
    error: ''
  }
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(shell.info()) as Record<string, unknown>
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
  return info
}

export function reinstallBundled(): void {
  try {
    bridge()?.reinstallBundled()
  } catch {
    // 重装失败时状态会在下一次检测里显示
  }
}
