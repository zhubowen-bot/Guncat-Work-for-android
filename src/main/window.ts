// Electron 主窗口。
//
// 一条血泪教训（真实事故）：窗口原先用 show:false 建，只在 ready-to-show 时才显示。
// 结果一旦渲染进程因任何原因没加载完，窗口就**永远不出现** —— 用户看到的现象是
// 「双击了，什么都没发生」。首屏要加载 1.5MB JS 加 KaTeX 字体，新 profile 下要好几秒，
// 用户根本等不到。
//
// 现在的策略：
//   1) 窗口**立刻显示**（配合 backgroundColor 与 index.html 里的加载占位，不会白屏闪烁）；
//   2) 渲染进程的每个生命周期事件都写进启动日志，出问题能一眼看出卡在哪；
//   3) 页面加载慢也不影响窗口可见性 —— 可见性永不依赖渲染进程。
import { BrowserWindow, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resource } from '@core/platform/appPaths'
import { bootLog, bootLogPath, bootMark } from './bootlog'
import { rendererUrl } from './protocol'
import { isCompatMode } from './compat'

const __dirname: string = path.dirname(fileURLToPath(import.meta.url))

/** 诊断模式：只用一张内联页面，判断故障发生在渲染进程还是界面产物加载 */
export const DIAG_MODE: boolean = process.argv.includes('--guncat-diag')

/**
 * 兼容模式（禁用渲染沙箱与 GPU）：这台机器上唯一能让渲染进程起来的配置。
 *
 * 判定交给 compat.ts 的 isCompatMode：只看 --guncat-safe-mode 标记会漏掉
 * run-compat.cmd 那条路径（它只传真实 Chromium 开关），日志与窗口标题就会
 * 给出「兼容模式=false」这个错误结论 —— 用户机器上已经发生过。
 * index.ts 在启动早期还会用 setCompatMode 覆盖一次（标记文件那条路径）。
 */
let compatMode: boolean = isCompatMode(process.argv)

export function setCompatMode(value: boolean): void {
  compatMode = value
}

export function isCompatWindow(): boolean {
  return compatMode
}

function diagPageUrl(): string {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>Guncat Work 诊断</title></head>
<body style="margin:0;font-family:'Segoe UI','Microsoft YaHei',sans-serif;background:#eef6ff;color:#1c1c1e">
<div style="max-width:560px;margin:90px auto;text-align:center">
  <h2 style="font-size:18px">渲染进程正常</h2>
  <p style="color:#3a5a7a;font-size:13px;line-height:1.8">
    这张页面能显示出来，说明 Electron 的渲染进程与窗口都没问题。<br>
    问题出在加载界面产物（out/renderer）上。
  </p>
</div>
<script>console.log('GUNCAT_DIAG_OK')</script>
</body></html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

let mainWindow: BrowserWindow | null = null

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

/**
 * 应用图标（取自鸿蒙原项目的 cat_avatar，由 scripts/make-icon.py 生成两种格式）。
 * 打包态落在 resources/resources/ 下，与会话资源同处一地。
 *
 * Windows 上**优先 .ico**：任务栏、Alt+Tab、窗口系统菜单都要按多尺寸图标取值，
 * 单张 PNG 只能靠系统缩放，边缘会糊。.ico 里有 7 种尺寸，系统按需取。
 * 取不到就交给 Electron 用默认图标，不能让窗口因为图标起不来。
 */
function resolveIcon(): string | undefined {
  try {
    const candidates: string[] =
      process.platform === 'win32'
        ? ['app-icon.ico', 'app-icon.png']
        : ['app-icon.png', 'app-icon.ico']
    for (const name of candidates) {
      const file: string = resource(name)
      if (fs.existsSync(file)) {
        return file
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * 把渲染进程的生命周期完整记进日志 —— 出问题时这是唯一的线索来源。
 *
 * 每条里程碑都带一个 ASCII 标记（bootMark），诊断脚本靠标记做判定，
 * 因为脚本本身必须是纯 ASCII（见 package-portable.mjs）。
 */
function traceWebContents(window: BrowserWindow, preloadPath: string, pagePath: string): void {
  const wc = window.webContents

  bootLog(`preload 路径: ${preloadPath}（存在=${fs.existsSync(preloadPath)}）`)
  bootLog(`页面路径: ${pagePath}（存在=${fs.existsSync(pagePath)}）`)

  wc.on('did-start-loading', () => bootLog('渲染进程: 开始加载'))
  wc.on('did-start-navigation', (_e, url) => bootLog(`渲染进程: 开始导航 ${url}`))
  wc.on('dom-ready', () => {
    bootMark('RENDERER_DOM_READY', '渲染进程: DOM 就绪')
  })
  wc.on('did-finish-load', () => {
    bootMark('RENDERER_FINISH_LOAD', '渲染进程: 加载完成')
    flushPending()
  })
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    bootMark(
      'RENDERER_LOAD_FAILED',
      `✗ 渲染进程加载失败: code=${code} desc=${desc} url=${url} 主框架=${isMainFrame}`
    )
  })
  wc.on('did-fail-provisional-load', (_e, code, desc, url) => {
    bootMark('RENDERER_PROVISIONAL_FAILED', `✗ 渲染进程预加载失败: code=${code} desc=${desc} url=${url}`)
  })
  wc.on('preload-error', (_e, preloadPath2, error) => {
    bootMark(
      'RENDERER_PRELOAD_ERROR',
      `✗ preload 执行出错: ${preloadPath2}\n${error?.stack ?? String(error)}`
    )
  })
  wc.on('render-process-gone', (_e, details) => {
    bootMark('RENDERER_GONE', `✗ 渲染进程退出: ${JSON.stringify(details)}`)
  })
  wc.on('unresponsive', () => bootMark('RENDERER_UNRESPONSIVE', '✗ 渲染进程无响应'))

  // 渲染进程的 console 只有落进启动日志，才可能看到 CSP / CORS / 脚本加载这类错误。
  //
  // 关于签名（已对着 node_modules/electron/electron.d.ts 核过）：
  //   Electron 38 的类型是 on('console-message', (details: Event<WebContentsConsoleMessageEventParams>,
  //   level, message, line, sourceId) => void)，而 Event<Params> = { preventDefault, defaultPrevented } & Params，
  //   也就是说**新形态把参数并进了第一个事件对象**，后面那几个位置参数是废弃的兼容副本。
  //   这里两种都认；万一两种都不像，也**绝不静默**：把参数的形状原样写进日志。
  //   曾经的问题正是「认不出来就什么都不记」，于是最该有线索的一次白屏里一条控制台日志都没有。
  wc.on('console-message', (...args: unknown[]) => {
    const first: unknown = args[0]
    if (typeof first === 'object' && first !== null && 'message' in first) {
      const e = first as {
        level?: unknown
        message?: unknown
        lineNumber?: unknown
        sourceId?: unknown
      }
      bootLog(
        `[渲染控制台 ${String(e.level)}] ${String(e.message)} (${String(e.sourceId)}:${String(e.lineNumber)})`
      )
      return
    }
    if (typeof args[2] === 'string') {
      const [, level, message, line, sourceId] = args
      bootLog(`[渲染控制台 ${String(level)}] ${String(message)} (${String(sourceId)}:${String(line)})`)
      return
    }
    bootLog(`[渲染控制台 ???] 事件参数形状无法识别，原样记录以免丢线索: ${describeArgs(args)}`)
  })
}

/** 把一个事件参数列表描述成一行可读文本（截断，避免日志被大对象撑爆） */
function describeArgs(args: unknown[]): string {
  const parts: string[] = args.map((value: unknown, index: number) => {
    const type: string = typeof value
    if (value === null) {
      return `${index}:null`
    }
    if (type === 'object') {
      const keys: string = Object.keys(value as object).join(',')
      let preview: string = ''
      try {
        preview = JSON.stringify(value)
      } catch {
        preview = '(无法序列化)'
      }
      return `${index}:object{${keys}} ${preview.slice(0, 160)}`
    }
    return `${index}:${type}=${String(value).slice(0, 80)}`
  })
  return `args=${args.length} [${parts.join(' | ')}]`
}

/**
 * 渲染进程主动上报「我还活着」（React 已挂载）时调用。
 * 看门狗此时必须撤销：渲染进程既然已经走到挂载这一步，再自动重启一次已经毫无意义，
 * 而且会把用户能看到的界面强行换掉。
 */
let stallTimer: ReturnType<typeof setTimeout> | null = null

export function markRendererAlive(): void {
  if (stallTimer !== null) {
    clearTimeout(stallTimer)
    stallTimer = null
  }
}

/** 待收件的外部文件（页面还没加载完时先攒着） */
let pendingFlush: () => void = () => {}

export function setPendingFlush(fn: () => void): void {
  pendingFlush = fn
}

function flushPending(): void {
  try {
    pendingFlush()
  } catch {
    // 忽略
  }
}

/** 界面产物目录（app:// 的根目录） */
export function rendererDir(): string {
  return path.join(__dirname, '../renderer')
}

/** 渲染进程就绪的看门狗：超时未就绪则判定卡住，交给上层处理（通常是安全模式重启） */
let stalledHandler: (info: { pagePath: string; preloadPath: string }) => void = () => {}
// 6 秒而不是 10 秒：实测主进程约在启动后 10 秒会以 STATUS_BREAKPOINT 终止，
// 看门狗必须抢在它前面，否则永远等不到自愈的机会。
let watchdogMs = 6000

export function setRendererStalledHandler(
  fn: (info: { pagePath: string; preloadPath: string }) => void
): void {
  stalledHandler = fn
}

export function setWatchdogMs(ms: number): void {
  watchdogMs = ms
}

export function createMainWindow(): BrowserWindow {
  const preloadPath: string = path.join(__dirname, '../preload/index.mjs')
  const pagePath: string = path.join(__dirname, '../renderer/index.html')

  const window: BrowserWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 940,
    minHeight: 620,
    // 立刻显示：可见性不依赖渲染进程是否加载成功
    show: true,
    autoHideMenuBar: true,
    backgroundColor: '#f5f5f7',
    // 兼容模式下注明，免得用户以为界面卡顿是程序本身的问题（其实是软件渲染）
    title: compatMode ? 'Guncat Work（兼容模式）' : 'Guncat Work',
    icon: resolveIcon(),
    webPreferences: {
      preload: preloadPath,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // 渲染进程需要 Web Speech API（朗读/语音输入）
      spellcheck: false
    }
  })

  traceWebContents(window, preloadPath, pagePath)

  // 看门狗：渲染进程若在超时内没有任何「就绪」信号，说明它卡住了。
  // 现象是窗口一直停在加载占位页、且没有任何失败事件 —— 只能靠超时判定。
  let settled = false
  const clearWatchdog = (): void => {
    settled = true
    if (stallTimer !== null) {
      clearTimeout(stallTimer)
      stallTimer = null
    }
  }
  stallTimer = setTimeout(() => {
    stallTimer = null
    if (settled || window.isDestroyed()) {
      return
    }
    bootMark('RENDERER_STALLED', `✗ 渲染进程在 ${watchdogMs / 1000} 秒内没有就绪，判定为卡住`)
    stalledHandler({ pagePath, preloadPath })
  }, watchdogMs)
  window.webContents.once('dom-ready', clearWatchdog)
  window.webContents.once('did-fail-load', clearWatchdog)
  window.webContents.once('render-process-gone', clearWatchdog)
  window.on('closed', clearWatchdog)

  // 外链一律交给系统浏览器，不在应用内开新窗口
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL !== undefined) {
    bootLog(`加载开发态页面: ${process.env.ELECTRON_RENDERER_URL}`)
    window.loadURL(process.env.ELECTRON_RENDERER_URL).catch((e: unknown) => {
      onLoadFailed(window, process.env.ELECTRON_RENDERER_URL ?? '', e)
    })
  } else if (DIAG_MODE) {
    // 诊断模式：加载一张极简的内联页面。
    // 用途是把故障一分为二 —— 这张页面能渲染出来，说明渲染进程本身没问题，
    // 问题出在加载界面产物上；连它都不出来，就是渲染进程/GPU 层的问题。
    bootLog('诊断模式：加载极简内联页面')
    window.loadURL(diagPageUrl()).catch((e: unknown) => {
      onLoadFailed(window, '(内联诊断页)', e)
    })
  } else {
    // 走自定义协议而不是 file://：file:// 下 Vite 的 ESM 产物会被 CORS 拦掉，
    // 表现为文档加载了但 DOMContentLoaded 永不触发（详见 protocol.ts）。
    const url: string = rendererUrl()
    bootLog(`加载 app:// 页面: ${url}`)
    window.loadURL(url).catch((e: unknown) => {
      bootLog(`app:// 加载失败，回退 file://: ${String(e)}`)
      onLoadFailed(window, url, e)
    })
  }

  window.on('closed', () => {
    mainWindow = null
  })

  mainWindow = window
  return window
}

/**
 * 页面加载失败时的兜底。
 *
 * 两个都必须做，缺一个都会让用户面对「一片空白 + 毫无线索」：
 *   1) 把失败写进启动日志（含真实错误）；
 *   2) 在窗口里**显示**失败原因 —— 空白窗口比错误信息更难排查。
 *
 * 另外：loadFile 返回的 Promise 必须显式 catch。只写 `void window.loadFile(...)`
 * 会让失败变成 unhandledRejection，被兜底处理器抓成「未处理的 Promise 拒绝」，
 * 反而掩盖了真正的原因。
 */
function onLoadFailed(window: BrowserWindow, target: string, error: unknown): void {
  const message: string = error instanceof Error ? error.message : String(error)
  bootLog(`✗ 页面加载失败: ${target}\n${message}`)
  showLoadError(window, target, message)
}

/** 在窗口里直接显示失败原因 —— 空白窗口比错误信息更难排查 */
export function showLoadError(window: BrowserWindow, target: string, message: string): void {
  if (window.isDestroyed()) {
    return
  }
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>Guncat Work</title></head>
<body style="margin:0;font-family:'Segoe UI','Microsoft YaHei',sans-serif;background:#f5f5f7;color:#1c1c1e">
<div style="max-width:640px;margin:80px auto;padding:0 24px">
  <h2 style="font-size:18px;margin:0 0 12px">界面加载失败</h2>
  <p style="color:#6b6b73;font-size:13px;line-height:1.7;margin:0 0 16px">
    应用本身已启动，但界面没能加载。把下面这段信息发出来即可定位。
  </p>
  <div style="background:#fff;border:1px solid #e0e0e4;border-radius:8px;padding:14px;
              font-family:Consolas,monospace;font-size:12px;line-height:1.6;word-break:break-all">
    <div style="color:#6b6b73">目标文件</div>
    <div style="margin-bottom:10px">${escapeHtml(target)}</div>
    <div style="color:#6b6b73">错误</div>
    <div style="color:#c0392b">${escapeHtml(message)}</div>
  </div>
  <p style="color:#6b6b73;font-size:12px;margin-top:16px">
    完整启动日志：${escapeHtml(bootLogPath())}
  </p>
</div></body></html>`
  window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => {
    // 连错误页都加载不了就只能空着了，日志里已经有记录
  })
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
