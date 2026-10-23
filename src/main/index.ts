// Electron 主进程入口。
//
// 启动顺序很关键：必须先初始化应用路径，再触碰任何会解析 filesDir / rawfile 的模块，
// 否则技能库扫描与配置读取会拿到未初始化目录。
//
// 每个里程碑都写一行启动日志（见 bootlog.ts）：一旦用户机器上「启动即退」，
// 日志能指出它走到了哪一步，而不是只有「打不开」。
import { app, BrowserWindow, dialog, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { initAppPaths, clearTempDir } from '@core/platform/appPaths'
import { bindSafeStorage } from '@core/platform/kit/ArkData'
import { installPdfJsBackend } from '@core/platform/native/pdfBackend'
import { registerElectronPicker } from './picker'
import { registerIpcHandlers } from './ipc'
import { collectFileArgs } from './intake'
import { installAppIdentity, installApplicationMenu } from './appmenu'
import { SessionManager } from './session/SessionManager'
import { CommandService } from '@core/service/CommandService'
import { createMainWindow, getMainWindow, rendererDir, setPendingFlush, setRendererStalledHandler, setCompatMode, showLoadError } from './window'
import { serveRenderer, registerAppScheme } from './protocol'
import { buildCompatArgs, FRESH_PROFILE_FLAG, isCompatMode } from './compat'
import {
  NO_SANDBOX_FLAG,
  KEEP_SANDBOX_FLAG,
  chromiumLogPath,
  hasNoSandboxFlag,
  isNoSandboxRelaunch,
  noSandboxRelaunchReason,
  buildNoSandboxRelaunchArgs,
  shouldLogChromium
} from './nosandbox'
import { resolveAppPaths } from './paths'
import { bootLog, bootLogPath, bootLogTail, bootFail, installCrashHandlers, bootMark } from './bootlog'
import { isElevated, describeUser, describeBitness, ADMIN_PROBE_DIR } from './elevation'
import type { GuncatEvent } from '../ipc/contract'

/**
 * 启动顺序（前两步是有硬性要求的，别往下挪）：
 *
 *   0) 单实例锁 —— 必须在自我重启之前拿，否则「应用已在运行」时第二次双击也会白白重启一次。
 *   1) win32 打包态无条件带上 --no-sandbox —— 通过一次「带真实参数的自我重启」实现，理由见
 *      nosandbox.ts。崩溃发生在 Chromium 初始化早期，主线程卡在 GPU 进程启动失败的等待路径上，
 *      进程内的看门狗/自动降级根本来不及跑（实测那几轮一条日志都没留下），
 *      所以参数必须从启动第一刻就在命令行上。
 *   2) 兼容（降级）模式：只在看门狗判定渲染进程卡住后由应用自己重启进入，或命令行显式标记。
 *      它只是第二道防线 —— 第一道是第 1 步。
 */

/** 曾经降级过一次就记下来，下次不再白等一次超时 */
function compatMarkerPath(base: string): string {
  return path.join(base, 'safe-mode.marker')
}

/** Chromium 日志路径（未开启时为空串）—— 启动日志里要注明，出问题时用户才知道去哪找 */
let chromiumLogFile: string = ''

// ===== 第 0 步：单实例锁 =====
// 必须在自我重启之前拿：否则应用已经在运行时，第二次双击也会白白多起一个进程
// （新进程拿不到锁，只会闪一下就退出）。
const gotLock: boolean = app.requestSingleInstanceLock()
if (!gotLock) {
  bootLog('另一个实例已在运行，本次启动退出')
  app.quit()
}

// ===== 第 1 步：Chromium 日志 + win32 打包态无条件带上 --no-sandbox =====
//
// 为什么必须是「一次带真实参数的自我重启」，而不是 app.commandLine.appendSwitch：
//   GPU 子进程的启动参数取自命令行；而且实测唯一被证实可用的组合就是命令行带 --no-sandbox。
//   用 app.relaunch 而不是自己 spawn：relaunch 在本进程退出后才拉起新进程，不会去抢单实例锁。
// 护栏：命令行已有 --no-sandbox 就绝不重启 —— 这是不做无限重启的唯一开关。
if (shouldLogChromium({ platform: process.platform, packaged: app.isPackaged, argv: process.argv })) {
  // 上次调查最大的障碍就是崩溃时 Chromium 什么都没留下：所有失败运行都在日志初始化之前
  // 就死了，只能靠 %LOCALAPPDATA%\CrashDumps 的转储还原。现在默认落盘。
  chromiumLogFile = chromiumLogPath(app.getPath('userData'))
  try {
    fs.mkdirSync(path.dirname(chromiumLogFile), { recursive: true })
  } catch {
    // 建不出来也照样加开关：Chromium 会退回 stderr
  }
  app.commandLine.appendSwitch('enable-logging')
  app.commandLine.appendSwitch('log-file', chromiumLogFile)
}

const relaunchReason: string | null = gotLock
  ? noSandboxRelaunchReason({
      platform: process.platform,
      packaged: app.isPackaged,
      argv: process.argv
    })
  : null
if (relaunchReason !== null) {
  bootMark('BOOT_RELAUNCH_NO_SANDBOX', `带真实参数自我重启一次：${relaunchReason}`)
  app.relaunch({ args: buildNoSandboxRelaunchArgs(process.argv) })
  app.exit(0)
}
if (isNoSandboxRelaunch(process.argv)) {
  // 这条是留给「新进程」的：否则用户看到进程闪一下就没了，会以为是 bug。
  bootMark(
    'BOOT_RELAUNCH_NO_SANDBOX',
    '本次进程由自我重启产生：上一次启动的命令行没带 --no-sandbox，重启是预期行为'
  )
}

// ===== 第 2 步：兼容（降级）模式：第二道防线 =====
const freshProfile: boolean = process.argv.includes(FRESH_PROFILE_FLAG)

// 降级来源：
//   1) 命令行显式标记（应用自己降级重启时带上）
//   2) 上次留下的标记文件（降级过一次，之后每次启动直接照做，不必再白等一次超时）
let safeMode: boolean = isCompatMode(process.argv)
if (!safeMode) {
  try {
    if (fs.existsSync(compatMarkerPath(app.getPath('userData')))) {
      safeMode = true
    }
  } catch {
    // 读不到就当没有
  }
}

// 窗口标题要反映真实状态（含「靠标记文件进入降级模式」这条没有命令行参数的路径）
setCompatMode(safeMode)

if (safeMode) {
  // 进程内再加一道，覆盖「靠标记文件直接进降级模式」这条命令行上没有开关的路径。
  // 只加这一条：其余开关（--disable-gpu 之类）实测对这次崩溃毫无帮助，却会把界面降成软件渲染。
  app.commandLine.appendSwitch(NO_SANDBOX_FLAG)
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true })
    fs.writeFileSync(compatMarkerPath(app.getPath('userData')), '1')
  } catch {
    // 记不下来就每次重新降级，功能不受影响
  }
}

// app:// 必须在 app ready 之前登记为特权协议
registerAppScheme()

bootLog('=== Guncat Work 启动 ===')
bootLog(`argv: ${process.argv.join(' ')}`)
bootLog(`electron=${process.versions.electron} node=${process.versions.node} chrome=${process.versions.chrome}`)
bootLog(`平台=${process.platform} 打包态=${app.isPackaged}`)
bootLog(`是否兼容模式=${safeMode}（= 走降级路径，窗口标题会注明）`)
// 「命令行带没带 --no-sandbox」与「是不是降级模式」是两件事，必须分开记：
// 前者现在是 win32 打包态的**默认**状态（自我重启一次后生效），后者只在看门狗降级后成立。
// 第 1 步与第 2 步一旦失灵，这一行就是唯一能指认的地方。
bootLog(
  `沙箱开关=${hasNoSandboxFlag(process.argv) ? '命令行已带 --no-sandbox' : '命令行未带 --no-sandbox'}` +
    ` 自我重启过=${isNoSandboxRelaunch(process.argv)} 保留沙箱=${process.argv.includes(KEEP_SANDBOX_FLAG)}`
)
bootMark(
  'SANDBOX_STATE',
  `--no-sandbox 生效=${hasNoSandboxFlag(process.argv) || safeMode}（命令行=${hasNoSandboxFlag(process.argv)} 降级=${safeMode} 自我重启=${isNoSandboxRelaunch(process.argv)}）`
)
bootLog(`全新配置目录标记=${freshProfile}（标记保留：诊断脚本仍会传，但应用不再自动切用户数据目录）`)

// 启动环境的观测项：排查「加载完成却什么都没有 / 启动即退」时，它们是第一手证据。
//   是否提权 —— 曾经被当成必要条件（见 elevation.ts 的探测方式与理由）
//   进程位数 —— 32/64 位混用会以各种奇怪的方式失败
//   userData —— 崩溃与配置都在这里
//   Chromium 日志 —— 上次调查最缺的东西：崩溃时 Chromium 一条日志都没留下
bootLog(`是否提权=${isElevated()}（探测写入 ${ADMIN_PROBE_DIR} 的权限，探测文件立即删除）`)
bootLog(`用户=${describeUser()} 进程位数=${describeBitness()}`)
bootLog(`userData 目录=${app.getPath('userData')}`)
bootLog(`Chromium 日志=${chromiumLogFile !== '' ? chromiumLogFile : '（未开启）'}`)
bootLog(`日志文件: ${bootLogPath()}`)

/** 待收件的外部文件（窗口还没就绪时先攒着，页面加载完再推） */
const pendingIntake: string[] = []

function dispatch(event: GuncatEvent): void {
  const window: BrowserWindow | null = getMainWindow()
  if (window !== null && !window.isDestroyed()) {
    window.webContents.send('guncat:event', event)
  }
}

/** 把外部文件排进队列；窗口就绪时立即推送，否则等 did-finish-load */
function enqueueIntake(paths: string[]): void {
  if (paths.length === 0) {
    return
  }
  const window: BrowserWindow | null = getMainWindow()
  if (window === null || window.isDestroyed()) {
    pendingIntake.push(...paths)
    return
  }
  dispatch({ type: 'files:pending', paths })
}

function flushPendingIntake(): void {
  if (pendingIntake.length === 0) {
    return
  }
  const paths: string[] = pendingIntake.splice(0, pendingIntake.length)
  dispatch({ type: 'files:pending', paths })
}

installCrashHandlers((text) => {
  // app 可用时弹框；不可用时 dialog 会抛，吞掉即可（日志已经写下了）
  try {
    dialog.showErrorBox('Guncat Work 启动出错', `${text}\n\n详细信息见：\n${bootLogPath()}`)
  } catch {
    // 忽略
  }
})

// 单实例：第二次启动时聚焦已有窗口，并把它的文件参数接过来。
// 锁已经在文件开头拿到了（第 0 步，必须在自我重启之前）；这里只是用它决定要不要继续。
if (!gotLock) {
  // 另一个实例在跑：上面已经 quit 过了，这里什么都不做（新进程也不该去抢锁）
} else {
  bootLog('单实例锁已获取')

  app.on('second-instance', (_event, argv: string[]) => {
    bootLog('收到 second-instance')
    const window: BrowserWindow | null = getMainWindow()
    if (window !== null) {
      if (window.isMinimized()) {
        window.restore()
      }
      window.focus()
    }
    enqueueIntake(collectFileArgs(argv))
  })

  // macOS：从访达「打开方式」进来
  app.on('open-file', (event: Electron.Event, filePath: string) => {
    event.preventDefault()
    bootLog(`收到 open-file: ${filePath}`)
    enqueueIntake([filePath])
  })

  app
    .whenReady()
    .then(() => {
      bootLog('app ready')

      const paths = resolveAppPaths()
      bootLog(`数据目录=${paths.dataRoot}`)
      bootLog(`资源目录=${paths.resourcesRoot}`)
      initAppPaths(paths)
      clearTempDir()
      bootLog('应用路径已初始化')

      // 配置的落盘加密要在这里定下来：API Key 之类凭据在第一次读配置之前就得知道本机
      // 有没有凭据保险库（Windows DPAPI / macOS Keychain / Linux 钥匙串）。
      // 注入而不是让平台层自己 require('electron')，见 core/platform/kit/ArkData 的说明。
      bindSafeStorage(safeStorage)
      bootLog(`凭据保险库=${safeStorage.isEncryptionAvailable() ? '可用' : '不可用（明文落盘）'}`)

      registerElectronPicker()
      bootLog('文件选择器已注册')

      // PDF 后端（PDF.js）：不装的话，所有 PDF 工具都会报「文档结构损坏」——
      // 因为平台适配层在没有后端时只能返回 PARSE_ERROR_FORMAT。见 core/platform/native/pdfBackend.ts。
      installPdfJsBackend()
      bootLog('PDF 后端已就绪（PDF.js）')

      // 任务栏身份与菜单栏都要在**建窗口之前**定下来：
      // 窗口一旦建立，就已经带着当时的 AppUserModelID 与默认菜单进了任务栏。
      installAppIdentity()
      installApplicationMenu()

      // 用 app:// 提供界面文件（替代 file://，详见 protocol.ts 的说明）
      try {
        serveRenderer(rendererDir(), paths.resourcesRoot)
      } catch (e: unknown) {
        bootFail('serveRenderer', e)
      }

      const session: SessionManager = new SessionManager((event: GuncatEvent) => {
        dispatch(event)
      })

      registerIpcHandlers(session)
      bootLog('IPC 通道已注册')

      // 定时提醒的每秒推进。不启动的话 schedule_create 会「成功但永远不响」——
      // 静默失效最伤信任，见 SessionManager.startScheduleTicker 的说明。
      session.startScheduleTicker()
      bootLog('定时提醒推进已启动（每秒）')

      // 页面加载完成后把积压的收件文件推给渲染进程（页面加载完成的监听在 window.ts 里）
      setPendingFlush(() => {
        flushPendingIntake()
      })

      // 渲染进程卡住时的自愈（第二道防线）：降级模式已试过就如实报错，否则降级重启一次。
      // 第一道防线是文件开头的「无条件带 --no-sandbox 自我重启」—— 那一类崩溃（GPU 子进程
      // 建不出来 → 主进程 FATAL）发生在 Chromium 初始化早期，主线程被占住，
      // 这里的看门狗根本来不及执行，所以不能指望它。
      setRendererStalledHandler(({ pagePath }: { pagePath: string }) => {
        const window: BrowserWindow | null = getMainWindow()
        if (safeMode) {
          bootLog('降级模式下渲染进程仍未就绪，不再重试')
          if (window !== null) {
            showLoadError(
              window,
              pagePath,
              '渲染进程在降级模式下仍未能就绪。请把启动日志发出来：' + bootLogPath()
            )
          }
          return
        }
        bootLog('→ 自动以降级模式重启（命令行显式带 --no-sandbox）')
        bootMark('AUTO_DEGRADE', '→ 自动降级：本次进程将以降级参数重启')
        // 关键：把**真实 Chromium 参数**作为命令行传过去，而不是只传自己的标记。
        // 这正是用户机器上唯一验证成功的那组参数；只靠进程内 appendSwitch 不可靠
        // （沙箱相关开关在进程启动早期就被读取）。
        app.relaunch({ args: buildCompatArgs(process.argv) })
        app.exit(0)
      })

      const window: BrowserWindow = createMainWindow()
      bootLog('主窗口已创建（立刻可见，不依赖渲染进程）')

      // 启动时若带文件参数（双击关联文件 / 拖到图标上），先入队
      enqueueIntake(collectFileArgs(process.argv))

      // 技能库扫描 + 智能体加载放在窗口创建之后，避免拖慢首屏
      void session
        .bootstrap()
        .then(() => {
          bootLog('会话与技能库初始化完成')
        })
        .catch((e: unknown) => {
          bootFail('bootstrap', e)
        })

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          createMainWindow()
        }
      })
    })
    .catch((e: unknown) => {
      bootFail('whenReady', e)
      const detail: string = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e)
      // 把日志尾部直接放进错误框：用户不必去翻文件，一眼就能看到卡在哪一步
      dialog.showErrorBox(
        'Guncat Work 启动失败',
        `错误：${detail}\n\n最近启动日志：\n${bootLogTail(16)}\n\n完整日志：${bootLogPath()}`
      )
      // 窗口已经建出来就留着（至少能看到界面或错误页），别把能用的部分一起关掉
      if (BrowserWindow.getAllWindows().length === 0) {
        app.quit()
      }
    })

  app.on('window-all-closed', () => {
    bootLog('所有窗口已关闭')
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('will-quit', () => {
    // 后台命令（run_command 的 run_in_background）不会跟着窗口一起没 ——
    // 应用退出时把它们连同进程树收掉，否则用户关掉应用后机器上还留着一堆本应用拉起的进程。
    try {
      CommandService.killAllJobs()
    } catch {
      // 收尾失败不阻塞退出
    }
    bootLog('=== 退出 ===')
  })
}
