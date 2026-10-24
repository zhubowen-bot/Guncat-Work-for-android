// Electron 的测试替身：让主进程的启动链路与 IPC 契约都能在纯 Node 下被真实调用。
//
// 为什么值得做：本机跑不起 Electron 窗口（electron.exe 连 --version 都是
// STATUS_BREAKPOINT），但「index.ts → whenReady → createMainWindow → loadFile」
// 这条链路完全可以在 Node 里跑，并断言路径解析、preload 是否存在、有无异常。
import fs from 'node:fs'

type Handler = (...args: unknown[]) => unknown

const handlers = new Map<string, Handler>()
const sentEvents: Array<{ channel: string; payload: unknown }> = []
const calls: Array<{ fn: string; args: unknown[] }> = []
/** app.setPath 覆盖过的路径 */
const paths: Record<string, string> = {}
/** app.commandLine.appendSwitch 记录（兼容模式那条路要靠它断言） */
const switches = new Map<string, string>()
/** 建出来的窗口实例：验证需要往 webContents 上发事件（dom-ready / did-finish-load） */
const windows: BrowserWindow[] = []

export const ipcMain = {
  handle(channel: string, handler: Handler): void {
    handlers.set(channel, handler)
    calls.push({ fn: 'ipcMain.handle', args: [channel] })
  },
  removeHandler(channel: string): void {
    handlers.delete(channel)
  }
}

export async function __invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel)
  if (handler === undefined) {
    throw new Error(`IPC 通道未注册: ${channel}`)
  }
  return await handler({}, ...args)
}

export function __channels(): string[] {
  return [...handlers.keys()].sort()
}

export function __events(): Array<{ channel: string; payload: unknown }> {
  return sentEvents
}

export function __calls(): Array<{ fn: string; args: unknown[] }> {
  return calls
}

/** 记录过的 Chromium 开关 —— 用于断言兼容模式到底加了哪几条 */
export function __switches(): Record<string, string> {
  return Object.fromEntries(switches)
}

/** 建出来的窗口（含 webContents），验证时用它模拟渲染进程事件 */
export function __windows(): BrowserWindow[] {
  return windows
}

export function __paths(): Record<string, string> {
  return paths
}

export function __reset(): void {
  handlers.clear()
  sentEvents.length = 0
  calls.length = 0
  switches.clear()
  windows.length = 0
  for (const key of Object.keys(paths)) {
    delete paths[key]
  }
}

interface Listener {
  fn: (...a: unknown[]) => void
  once: boolean
}

class FakeWebContents {
  private listeners: Map<string, Listener[]> = new Map()

  send(channel: string, payload: unknown): void {
    sentEvents.push({ channel, payload })
  }

  setWindowOpenHandler(handler: (...a: unknown[]) => unknown): void {
    calls.push({ fn: 'setWindowOpenHandler', args: [handler] })
  }

  on(event: string, cb: (...a: unknown[]) => void): this {
    const list = this.listeners.get(event) ?? []
    list.push({ fn: cb, once: false })
    this.listeners.set(event, list)
    calls.push({ fn: 'webContents.on', args: [event] })
    return this
  }

  /**
   * 注意：once 必须**追加**一个一次性的监听器，而不是替换掉同名的 on 监听器。
   * 真实 Electron 两者共存；早期替身写成 set() 会把先注册的 on 监听器挤掉，
   * 于是「窗口注册的 did-finish-load 处理器」在验证里根本不会触发 —— 验证就成了空转。
   */
  once(event: string, cb: (...a: unknown[]) => void): this {
    const list = this.listeners.get(event) ?? []
    list.push({ fn: cb, once: true })
    this.listeners.set(event, list)
    calls.push({ fn: 'webContents.once', args: [event] })
    return this
  }

  /** 测试用：模拟页面加载完成 */
  emit(event: string): void {
    const list = [...(this.listeners.get(event) ?? [])]
    for (const listener of list) {
      if (listener.once) {
        const current = this.listeners.get(event) ?? []
        this.listeners.set(
          event,
          current.filter((item) => item !== listener)
        )
      }
      listener.fn()
    }
  }
}

export class BrowserWindow {
  options: Record<string, unknown>
  webContents: FakeWebContents = new FakeWebContents()
  private destroyed: boolean = false

  constructor(options: Record<string, unknown> = {}) {
    this.options = options
    calls.push({ fn: 'new BrowserWindow', args: [options] })
    windows.push(this)
  }

  static getAllWindows(): BrowserWindow[] {
    return []
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  isMinimized(): boolean {
    return false
  }

  restore(): void {}
  focus(): void {}
  show(): void {
    calls.push({ fn: 'window.show', args: [] })
  }
  setWindowOpenHandler(handler: unknown): void {
    calls.push({ fn: 'setWindowOpenHandler', args: [handler] })
  }
  on(event: string, cb: (...a: unknown[]) => void): this {
    calls.push({ fn: 'window.on', args: [event] })
    return this
  }
  async loadURL(url: string): Promise<void> {
    calls.push({ fn: 'loadURL', args: [url] })
  }
  async loadFile(file: string): Promise<void> {
    calls.push({ fn: 'loadFile', args: [file] })
  }
  close(): void {
    this.destroyed = true
  }
}

export const app = {
  /**
   * 打包态由环境变量控制：启动链路里有几条只在「win32 打包态」生效的逻辑
   * （自我重启带 --no-sandbox、默认开 Chromium 日志），必须能被无头验证覆盖。
   */
  get isPackaged(): boolean {
    return process.env.GUNCAT_STUB_PACKAGED === '1'
  },
  getName(): string {
    return 'Guncat Work'
  },
  getVersion(): string {
    return '0.2.1-test'
  },
  getPath(name: string): string {
    if (paths[name] !== undefined) {
      return paths[name]
    }
    if (name === 'userData') {
      // 允许指向临时目录：兼容模式那条路会往 userData 里写标记文件
      return process.env.GUNCAT_STUB_USERDATA ?? '/tmp/guncat-test-userdata'
    }
    if (name === 'downloads') {
      // 「分享」会往下载目录留副本：验证时指到临时目录，别污染真实用户目录
      return process.env.GUNCAT_STUB_DOWNLOADS ?? '/tmp'
    }
    return '/tmp'
  },
  setPath(name: string, value: string): void {
    paths[name] = value
    calls.push({ fn: 'app.setPath', args: [name, value] })
  },
  getAppPath(): string {
    return process.cwd()
  },
  requestSingleInstanceLock(): boolean {
    calls.push({ fn: 'requestSingleInstanceLock', args: [] })
    return true
  },
  quit(): void {
    calls.push({ fn: 'app.quit', args: [] })
  },
  exit(code: number): void {
    calls.push({ fn: 'app.exit', args: [code] })
  },
  relaunch(options: unknown): void {
    calls.push({ fn: 'app.relaunch', args: [options] })
  },
  disableHardwareAcceleration(): void {
    calls.push({ fn: 'app.disableHardwareAcceleration', args: [] })
  },
  commandLine: {
    appendSwitch(name: string, value?: string): void {
      switches.set(name, value ?? '')
      calls.push({ fn: 'app.commandLine.appendSwitch', args: [name, value ?? ''] })
    }
  },
  whenReady(): Promise<void> {
    calls.push({ fn: 'app.whenReady', args: [] })
    return Promise.resolve()
  },
  on(event: string, cb: (...a: unknown[]) => void): void {
    calls.push({ fn: 'app.on', args: [event] })
  },
  setAppUserModelId(id: string): void {
    calls.push({ fn: 'app.setAppUserModelId', args: [id] })
  }
}

export const dialog = {
  async showOpenDialog(): Promise<{ canceled: boolean; filePaths: string[] }> {
    calls.push({ fn: 'dialog.showOpenDialog', args: [] })
    return nextOpenDialog ?? { canceled: true, filePaths: [] }
  },
  async showSaveDialog(): Promise<{ canceled: boolean; filePath?: string }> {
    // 一次性：模拟「这一次保存对话框用户选了什么」。用完即清，
    // 否则后面的导出用例会捡到上一个用例留下的路径（曾因此误触真实导出）。
    const result = nextSaveDialog ?? { canceled: true }
    nextSaveDialog = null
    return result
  },
  /**
   * 确认类对话框（清空工作区等）。默认返回「取消」（response 0）——
   * 验证脚本不该在没人点的情况下把工作区删掉。
   */
  async showMessageBox(
    _window?: unknown,
    options?: { buttons?: string[] }
  ): Promise<{ response: number; checkboxChecked: boolean }> {
    calls.push({ fn: 'dialog.showMessageBox', args: [options?.buttons ?? []] })
    return { response: nextMessageBox ?? 0, checkboxChecked: false }
  },
  showErrorBox(title: string, content: string): void {
    calls.push({ fn: 'dialog.showErrorBox', args: [title, content] })
  }
}

/** 下一次 dialog.showMessageBox 的返回值（null 表示默认「取消」） */
let nextMessageBox: number | null = null

/** 让验证脚本模拟「用户在确认框里点了第 N 个按钮」 */
export function __setMessageBox(response: number | null): void {
  nextMessageBox = response
}

/** 下一次 dialog.showOpenDialog 的返回值（null 表示默认「用户取消」） */
let nextOpenDialog: { canceled: boolean; filePaths: string[] } | null = null

/** 让验证脚本模拟「用户在文件选择框里挑了几个文件」 */
export function __setOpenDialog(result: { canceled: boolean; filePaths: string[] } | null): void {
  nextOpenDialog = result
}

/** 下一次 dialog.showSaveDialog 的返回值（null 表示默认「用户取消」） */
let nextSaveDialog: { canceled: boolean; filePath?: string } | null = null

/** 让验证脚本模拟「用户在保存对话框里选了哪个路径」 */
export function __setSaveDialog(result: { canceled: boolean; filePath?: string } | null): void {
  nextSaveDialog = result
}

/**
 * 剪贴板替身：只记录写入了什么。
 * 桌面端的「分享」= 留副本 + 路径进剪贴板，这条路必须能在无头环境断言。
 */
export const clipboard = {
  writeText(text: string): void {
    calls.push({ fn: 'clipboard.writeText', args: [text] })
  }
}

export const shell = {
  async openExternal(): Promise<void> {},
  async openPath(target: string): Promise<string> {
    calls.push({ fn: 'shell.openPath', args: [target] })
    return ''
  },
  showItemInFolder(target: string): void {
    calls.push({ fn: 'shell.showItemInFolder', args: [target] })
  }
}

/** 菜单栏替身：记下被设成应用菜单的那份模板，验证时用来断言不是 Electron 的默认菜单 */
let applicationMenuTemplate: unknown[] | null = null

export const Menu = {
  buildFromTemplate(template: unknown[]): { __template: unknown[] } {
    calls.push({ fn: 'Menu.buildFromTemplate', args: [template] })
    return { __template: template }
  },
  setApplicationMenu(menu: unknown): void {
    applicationMenuTemplate =
      menu !== null && typeof menu === 'object' && '__template' in menu
        ? (menu as { __template: unknown[] }).__template
        : null
    calls.push({ fn: 'Menu.setApplicationMenu', args: [menu] })
  }
}

/** 被设成应用菜单的模板（null = 从未设置，会退回 Electron 自带的英文菜单） */
export function __applicationMenu(): unknown[] | null {
  return applicationMenuTemplate
}

export const webUtils = {
  getPathForFile(_file: unknown): string {
    return ''
  }
}

/** 特权协议登记与处理器注册 —— 用来断言 app:// 确实装上了 */
export const protocol = {
  registerSchemesAsPrivileged(schemes: unknown[]): void {
    calls.push({ fn: 'protocol.registerSchemesAsPrivileged', args: [schemes] })
  },
  handle(scheme: string, handler: unknown): void {
    calls.push({ fn: 'protocol.handle', args: [scheme, handler] })
  }
}

/** 真实读文件，便于在测试里直接调用 app:// 的处理器验证行为 */
export const net = {
  async fetch(url: string): Promise<Response> {
    const { fileURLToPath } = await import('node:url')
    const body = fs.readFileSync(fileURLToPath(url))
    return new Response(body)
  }
}

export const nativeImage = {
  createFromBuffer(): never {
    throw new Error('测试替身不提供像素解码')
  }
}

/**
 * safeStorage 测试替身。默认关闭 = 照旧明文落盘（现有检查都按这个口径跑通），
 * 凭据加密那一节里显式打开。'broken' 模拟「平台说可用、但密钥已经不在了」
 * （换过机器 / 钥匙串被清空）—— 这是真实会发生的状态，必须能断言降级行为。
 */
let safeStorageMode: 'off' | 'on' | 'broken' = 'off'

export function __setSafeStorage(mode: 'off' | 'on' | 'broken'): void {
  safeStorageMode = mode
}

export const safeStorage = {
  isEncryptionAvailable(): boolean {
    return safeStorageMode !== 'off'
  },
  encryptString(text: string): Buffer {
    if (safeStorageMode === 'off') {
      throw new Error('测试替身：安全存储未开启')
    }
    return Buffer.from('gk:' + text, 'utf8')
  },
  decryptString(cipher: Buffer): string {
    const raw: string = cipher.toString('utf8')
    if (safeStorageMode === 'broken' || !raw.startsWith('gk:')) {
      throw new Error('测试替身：密钥不在了')
    }
    return raw.slice(3)
  }
}
