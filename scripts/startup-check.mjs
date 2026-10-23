// 主进程启动链路的无头验证。
//
// 为什么需要它：本机的 Electron 二进制连 `--version` 都返回 STATUS_BREAKPOINT，
// 所以我从没见过应用真的起来。这个脚本用 electron 替身把**真实入口**
// （src/main/index.ts）完整跑一遍，并断言：
//   - 单实例锁、whenReady、窗口创建依次发生
//   - BrowserWindow 的 preload 路径**指向真实存在的文件**（路径错会让窗口起不来）
//   - loadFile 指向真实存在的 index.html
//   - IPC 通道全部注册
//   - 数据目录被创建
//   - 全程无异常
//
// 这是对「启动即退」最直接的对冲：即使拿不到窗口，也能证明启动链路本身是通的。
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { root, alias } from './esbuild-aliases.mjs'

const dataRoot = path.join(os.tmpdir(), `guncat-startup-${Date.now()}`)
process.env.GUNCAT_DATA_DIR = dataRoot
// 启动日志写到临时目录：绝不能覆盖用户真实的那份（排查问题时要看的正是它）
process.env.GUNCAT_BOOTLOG_DIR = dataRoot
// 提权判定固定下来：验证结果不能取决于跑验证的终端是不是管理员（见 elevation.ts）
process.env.GUNCAT_FORCE_ELEVATED = '0'

// 记录任何逃逸出来的异常 —— 那正是「启动即退」的形态。
// 注意这里必须**立刻写 stderr**：只把异常攒进数组的话，脚本一旦在顶层 await 处被拒绝，
// 事件循环排空后进程会静默地以 0 退出，验证看起来「跑完了」其实什么都没验证
// （本轮真的踩到过：launch-scripts.mjs 里一个引号写错，整套验证静默中断）。
const uncaught = []
process.on('uncaughtException', (e) => {
  const text = `uncaughtException: ${e && e.stack ? e.stack : e}`
  uncaught.push(text)
  console.error(`\n✗ ${text}`)
})
process.on('unhandledRejection', (e) => {
  const text = `unhandledRejection: ${e && e.stack ? e.stack : e}`
  uncaught.push(text)
  console.error(`\n✗ ${text}`)
})
// 跑完了才允许以 0 退出；没跑完一律算失败
let completed = false
process.on('exit', () => {
  if (!completed) {
    console.error('\n✗ 验证脚本没有跑完就退出了（上面有未捕获异常）—— 记为失败')
    process.exitCode = 1
  }
})

const dir = path.join(root, '.smoke')
fs.mkdirSync(dir, { recursive: true })

/**
 * 平台判定。
 *
 * 有一批行为是**只在 win32 上成立**的（窗口优先用 .ico、打包态默认开 Chromium 日志、
 * 打包态自我重启带 --no-sandbox）。这类断言必须写成「两个平台都断言、但期望值不同」，
 * 而不是「非 win32 就跳过」：
 *   · 无条件断言 win32 的行为 → Linux/macOS 的 CI 上必然红（本文件踩过这个坑）；
 *   · 直接跳过                   → 那些断言在非 win32 上永远不会失败，等于假防线。
 * 所以下面统一按 IS_WIN 分支，两边各自都有明确的期望值。
 */
const IS_WIN = process.platform === 'win32'

const entry = path.join(dir, 'startup-entry.ts')
fs.writeFileSync(
  entry,
  `export * from '@main/index'
export * from 'electron'
export { buildCompatArgs, isSafeModeRequested, isCompatMode, COMPAT_ARGS, COMPAT_SWITCHES } from '@main/compat'
export { noSandboxRelaunchReason, buildNoSandboxRelaunchArgs, shouldLogChromium, chromiumLogPath, hasNoSandboxFlag, isNoSandboxRelaunch, NO_SANDBOX_FLAG, KEEP_SANDBOX_FLAG } from '@main/nosandbox'
export { probeElevated, adminProbePath, isElevated, describeUser, describeBitness, ADMIN_PROBE_DIR } from '@main/elevation'
`
)

// 关键：测试包必须落在与生产**同一层级**，因为 window.ts 用
// `path.join(__dirname, '../preload/index.mjs')` 解析 preload/preload 与 renderer。
// 放在 out/_check/ 下，../preload 才会指向 out/preload，与真实打包态一致。
const checkDir = path.join(root, 'out', '_check')
if (!fs.existsSync(path.join(root, 'out', 'preload'))) {
  console.error('\n✗ 找不到构建产物（out/preload）。请先跑 npm run build。\n')
  process.exit(1)
}
fs.mkdirSync(checkDir, { recursive: true })
const outfile = path.join(checkDir, 'startup.mjs')
// 同一份入口打三份，因为入口的副作用在 import 时就跑完了 —— 同一个模块 URL 只会生效一次：
//   1) 开发态（未打包）正常启动
//   2) win32 打包态、命令行没有 --no-sandbox → 应当立即自我重启
//   3) 自我重启之后的那一次启动（命令行已带 --no-sandbox）→ 稳态
const outfilePackaged = path.join(checkDir, 'startup-packaged.mjs')
const outfileSteady = path.join(checkDir, 'startup-steady.mjs')
for (const target of [outfile, outfilePackaged, outfileSteady]) {
  await build({
    entryPoints: [entry],
    outfile: target,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    // pdfjs 与原生 canvas 保持外部依赖：
    //   · pdfjs 内部有自己的 worker / wasm / 标准字体动态路径，打进 bundle 会被改坏；
    //   · @napi-rs/canvas 是 .node 原生模块，esbuild 根本打不进去。
    // 生产构建（electron.vite.config.ts）对这两者也是 external，两边口径一致。
    external: ['fflate', 'pdfjs-dist', 'pdfjs-dist/*', '@napi-rs/canvas'],
    alias: {
      ...alias,
      '@main': path.join(root, 'src/main'),
      electron: path.join(root, 'scripts/electron-stub.ts')
    },
    logLevel: 'error'
  })
}

let passed = 0
let failed = 0
const failures = []

function check(name, condition, detail = '') {
  if (condition) {
    passed++
    console.log(`  ✓ ${name}${detail !== '' ? ' — ' + detail : ''}`)
  } else {
    failed++
    failures.push(name)
    console.log(`  ✗ ${name}${detail !== '' ? ' — ' + detail : ''}`)
  }
}

console.log('\n20. 主进程启动链路（真实入口 + electron 替身）')

// 导入即执行入口的副作用（单实例锁 → whenReady → 建窗口 → 注册 IPC）
const stub = await import(pathToFileURL(outfile).href)
// 让 whenReady().then(...) 的微任务跑完
await new Promise((resolve) => setTimeout(resolve, 300))

const calls = stub.__calls()
const find = (fn) => calls.filter((c) => c.fn === fn)

check('模块加载无异常', uncaught.length === 0, uncaught[0]?.slice(0, 160) ?? '')
check('申请了单实例锁', find('requestSingleInstanceLock').length === 1)
check('等待了 app ready', find('app.whenReady').length === 1)
check('没有提前退出', find('app.quit').length === 0, find('app.quit').length > 0 ? '调用了 app.quit' : '')

// --- 窗口 ---
const windowCalls = find('new BrowserWindow')
check('创建了主窗口', windowCalls.length === 1, `${windowCalls.length} 个`)

const options = windowCalls[0]?.args[0] ?? {}
const preload = options.webPreferences?.preload
check('窗口配置了 preload', typeof preload === 'string' && preload !== '', String(preload))
check(
  'preload 指向真实存在的文件',
  typeof preload === 'string' && fs.existsSync(preload),
  typeof preload === 'string' ? path.relative(root, preload) : '(无)'
)
check('preload 扩展名与格式匹配', typeof preload === 'string' && /\.(mjs|cjs|js)$/.test(preload), String(preload ?? ''))
check('openExternal 通过 setWindowOpenHandler 接管', find('setWindowOpenHandler').length === 1)

// --- 页面加载方式 ---
// 回归防线：界面**不能**再用 file:// 加载。
// 真实事故：Vite 的 ESM 产物在 file:// 下被 CORS 拦掉，文档加载了但
// DOMContentLoaded 永不触发，窗口永远白屏且没有任何失败事件。
const loadCalls = find('loadURL')
check('通过 loadURL 加载界面', loadCalls.length === 1, `${loadCalls.length} 次`)
const pageUrl = loadCalls[0]?.args[0]
check('界面走自定义 app:// 协议（而非 file://）', typeof pageUrl === 'string' && pageUrl.startsWith('app://'), String(pageUrl))
check('没有再用 loadFile（file://）', find('loadFile').length === 0)

const privileged = find('protocol.registerSchemesAsPrivileged')
check('登记了 app:// 特权协议', privileged.length === 1)
const schemeEntry = privileged[0]?.args[0]?.[0] ?? {}
check(
  'app:// 被登记为 standard + secure（ESM / CSP / fetch 才正常）',
  schemeEntry.privileges?.standard === true && schemeEntry.privileges?.secure === true,
  JSON.stringify(schemeEntry.privileges ?? {})
)
check('注册了 app:// 的处理器', find('protocol.handle').some((c) => c.args[0] === 'app'))

// 回归防线：窗口可见性**绝不能**依赖渲染进程。
// 真实事故——窗口曾用 show:false 建、只在 ready-to-show 时才显示，
// 结果渲染进程没加载完窗口就永远不出现，用户看到的是「双击了没反应」。
check(
  '窗口创建时即可见（不依赖渲染进程）',
  options.show === true,
  options.show === true ? 'show: true' : `show=${String(options.show)} —— 会导致「启动即无反应」`
)
check(
  '页面加载完成后才推送积压的收件文件',
  find('webContents.on').some((c) => c.args[0] === 'did-finish-load'),
  '监听了 did-finish-load'
)

// --- 应用身份与菜单栏（用户报障：exe 与菜单栏里还是 Electron 默认图标） ---
// 这条链路修的是「任务栏按 AppUserModelID 归组并据此找图标」这一环：
// 不设身份时 Windows 会退回 exe 内嵌的图标（= Electron 的）。
const identityCall = find('app.setAppUserModelId')[0]
check(
  '设置了任务栏身份（否则任务栏会退回 exe 内嵌的 Electron 图标）',
  process.platform !== 'win32' || (identityCall !== undefined && identityCall.args[0] === 'com.guncat.work'),
  identityCall !== undefined ? String(identityCall.args[0]) : '未调用（非 win32 可接受）'
)
check(
  '任务栏身份在建窗口之前设置（窗口一旦建立就已经带着旧身份进任务栏）',
  identityCall === undefined ||
    calls.findIndex((c) => c.fn === 'app.setAppUserModelId') <
      calls.findIndex((c) => c.fn === 'new BrowserWindow')
)

const appMenu = stub.__applicationMenu()
const menuLabels = (appMenu ?? []).map((item) => item?.label)
check(
  '菜单栏换成了自己的菜单（不再摆 Electron 自带的英文 File/Edit/View/Window/Help）',
  Array.isArray(appMenu) && menuLabels.includes('视图') && !menuLabels.includes('File'),
  menuLabels.join(', ') || '(未设置)'
)
const viewItems = (appMenu?.[0]?.submenu ?? []).map((i) => i?.label ?? i?.role ?? i?.type)
check(
  '「视图」菜单保留了排障必需的重新加载与开发者工具',
  viewItems.includes('重新加载') && viewItems.includes('开发者工具'),
  viewItems.filter((x) => typeof x === 'string').join(', ')
)

// 窗口图标：Windows 上优先多尺寸的 .ico（任务栏 / Alt+Tab / 系统菜单都要按尺寸取，
// 单张 PNG 靠系统缩放会糊）；其他平台回退 .png —— 期望值随平台变化（见 IS_WIN 的说明）。
const iconPath = String(options.icon ?? '')
check(
  IS_WIN
    ? '窗口图标指向随包的应用图标（Win32 优先 .ico）'
    : '窗口图标指向随包的应用图标（非 Win32 用 .png）',
  iconPath.endsWith(IS_WIN ? 'app-icon.ico' : 'app-icon.png'),
  iconPath || '(未设置)'
)
check(
  '渲染进程的失败路径都有监听（否则出问题无从查起）',
  ['did-fail-load', 'preload-error', 'render-process-gone', 'console-message', 'dom-ready'].every(
    (e) => find('webContents.on').some((c) => c.args[0] === e)
  )
)
// 真实事故：渲染进程 did-start-loading 之后毫无动静，页面永远停在占位页，
// 且没有任何失败事件可依赖 —— 只能用超时判定。这条断言保证看门狗还在。
check(
  '装了渲染进程就绪看门狗（应对「不报错也不动」的卡死）',
  find('webContents.once').some((c) => c.args[0] === 'dom-ready'),
  find('webContents.once').map((c) => c.args[0]).join(', ') || '(未注册)'
)

// --- IPC ---
const channels = stub.__channels()
check('IPC 通道已注册', channels.length >= 24, `${channels.length} 个`)
check('渲染进程需要的核心通道都在', ['settings:load', 'agents:list', 'conversations:load', 'chat:send'].every((c) => channels.includes(c)))

// --- 自动降级：参数拼装（这段一旦错，自愈会静默失效，用户只看得到白屏） ---
// 用户机器上实测：只有带上这组参数渲染进程才起得来。
const built = stub.buildCompatArgs(['C:\\app\\Guncat Work.exe', '--enable-logging', '--gdi'])
check(
  '降级参数只保留已知必要且充分的 --no-sandbox',
  stub.COMPAT_SWITCHES.length === 1 && stub.COMPAT_SWITCHES[0] === '--no-sandbox',
  stub.COMPAT_SWITCHES.join(' ')
)
check('降级参数包含 --no-sandbox', built.includes('--no-sandbox'))
check(
  '降级参数不带 --disable-gpu（实测对这次崩溃无用，只会把界面降成软件渲染）',
  !built.includes('--disable-gpu')
)
// 回归防线：这条开关会把软件光栅化这条唯一的退路也关掉 ——
// 结果是 DOM/JS 全正常、加载也完成，但合成器画不出像素（窗口纯白且毫无报错）。
// 它只允许出现在 diagnose.ps1 的对照档里，绝不允许出现在任何默认/降级路径上。
check('降级参数不带那条只用于诊断对照的开关', !built.some((flag) => flag.includes('rasterizer')), built.join(' '))
check('降级参数带上全新配置目录标记', built.includes('--guncat-fresh-profile'))
check('降级时保留原有参数（不丢应用路径/日志开关）', built.includes('--enable-logging') && built.includes('--gdi'))
check('降级时去掉 argv[0]（可执行文件路径不能当参数传）', !built.some((a) => a.includes('.exe')))
check('重复降级不会叠加参数', stub.buildCompatArgs(['x'].concat(built)).length === built.length)
check('命令行能识别兼容模式标记', stub.isSafeModeRequested(['x', '--guncat-safe-mode']))
check('没有标记时不误判', !stub.isSafeModeRequested(['x', '--gdi']))

// --- 数据目录 ---
check('数据目录已创建', fs.existsSync(dataRoot))

// --- 随包资源要通过 app:// 暴露给渲染层 ---
// 智能体头像（agents.json 的 icon 字段，如 icons/guncat-3.1-flash.png）就是随包资源。
// 原图 1024²×10 张本就在产物里；不这么做渲染层只能退回「名字首字」这类替代品，
// 而把它们拷进渲染层资源要白白多 2.3MB。
// 判据用启动日志：serveRenderer 会把两个根目录都写进去。
{
  const boot = fs.readFileSync(path.join(dataRoot, 'startup.log'), 'utf8')
  const line = boot.split('\n').find((l) => l.includes('app:// 协议已注册')) ?? ''
  check('启动日志记录了 app:// 的根目录', line.includes('根目录='), line.trim().slice(0, 120))
  check(
    'app:// 同时暴露了随包资源根目录（否则智能体头像全部退化）',
    line.includes('资源目录='),
    line.trim().slice(0, 160)
  )
}
check('files 子目录已创建', fs.existsSync(path.join(dataRoot, 'files')))
check('temp 子目录已创建', fs.existsSync(path.join(dataRoot, 'temp')))

// --- 模拟渲染进程事件（真实 Electron 里由 Chromium 触发） ---
// 两个目的：
//   1) 断言里程碑标记确实落进日志 —— 诊断脚本全靠这些 ASCII 标记判读「走到哪一步」；
//   2) 让看门狗知道渲染进程已经就绪，否则它 6 秒后会触发一次降级重启。
const windows = stub.__windows()
check('能拿到建好的窗口实例（验证要往它身上发事件）', windows.length === 1, `${windows.length} 个`)
if (windows.length === 1) {
  windows[0].webContents.emit('dom-ready')
  windows[0].webContents.emit('did-finish-load')
}
const log1 = fs.readFileSync(path.join(dataRoot, 'startup.log'), 'utf8')
check('日志记了 dom-ready 里程碑（ASCII 标记）', log1.includes('[RENDERER_DOM_READY]'))
check('日志记了「加载完成」里程碑（ASCII 标记）', log1.includes('[RENDERER_FINISH_LOAD]'))
check('日志记了 是否提权', /是否提权=(true|false)/.test(log1))

// 定时提醒的每秒推进必须在启动时就拉起来：
// 不启动的话 schedule_create 会「成功但永远不响」——静默失效最伤信任。
check(
  '启动时就拉起了定时提醒推进（否则 schedule_create 成功却永不触发）',
  log1.includes('定时提醒推进已启动'),
  log1.split('\n').filter((l) => l.includes('定时提醒')).join(' | ').slice(0, 120) || '(没有相关日志)'
)
check('日志记了 进程位数', log1.includes('进程位数='))
check('日志记了 userData 目录', log1.includes('userData 目录='))
check('正常启动时日志记 是否兼容模式=false', log1.includes('是否兼容模式=false'))
check('开发态（未打包）不做 --no-sandbox 自我重启', find('app.relaunch').length === 0)
check(
  '开发态日志显示 --no-sandbox 未生效（刻意保留沙箱，便于继续定位真实沙箱问题）',
  /\[SANDBOX_STATE\][^\n]*--no-sandbox 生效=false/.test(log1)
)
check('开发态不写 Chromium 日志文件', log1.includes('Chromium 日志=（未开启）'))

// --- 启动后仍无异常 ---
check('启动完成后无未捕获异常', uncaught.length === 0, uncaught[0]?.slice(0, 200) ?? '')

// =====================================================================
// 21. 启动参数 / 启动脚本 / 提权感知（都是纯函数，先断言逻辑本身）
// =====================================================================
console.log('\n21. 启动参数、启动脚本与提权感知')

// --- 兼容/降级模式的判定 ---
// 判据是**降级标记**，不是 --no-sandbox：后者现在是 win32 打包态的默认启动方式，
// 拿它当「降级」判据会让正常启动与降级启动在日志里长得一模一样，
// 而这两者恰恰是最需要分开的（标题、看门狗是否还该重试都依赖它）。
check('降级模式：命令行标记算', stub.isCompatMode(['x', '--guncat-safe-mode']))
check('降级模式：普通启动不算', !stub.isCompatMode(['C:\\app\\x.exe', '--enable-logging']))
check(
  '降级模式：单带 --no-sandbox 不算（它是默认启动方式，不是降级）',
  !stub.isCompatMode(['C:\\app\\x.exe', '--no-sandbox'])
)

// --- 第 1 步：无条件带上 --no-sandbox 的判定（本次修复的核心，必须有回归防线） ---
const winPackaged = { platform: 'win32', packaged: true, argv: ['app.exe'] }
check(
  'win32 打包态、命令行没有 --no-sandbox → 必须自我重启',
  stub.noSandboxRelaunchReason(winPackaged) !== null,
  String(stub.noSandboxRelaunchReason(winPackaged)).slice(0, 56)
)
check(
  '命令行已有 --no-sandbox → 绝不重启（这是唯一防无限重启的护栏）',
  stub.noSandboxRelaunchReason({ ...winPackaged, argv: ['app.exe', '--no-sandbox'] }) === null
)
check(
  '诊断档显式保留沙箱（--guncat-keep-sandbox）→ 不重启，用来复现原始崩溃',
  stub.noSandboxRelaunchReason({ ...winPackaged, argv: ['app.exe', '--guncat-keep-sandbox'] }) === null
)
check(
  '开发态不重启（刻意保留沙箱，便于将来定位真实沙箱问题）',
  stub.noSandboxRelaunchReason({ ...winPackaged, packaged: false }) === null
)
check('非 win32 不重启', stub.noSandboxRelaunchReason({ ...winPackaged, platform: 'linux' }) === null)

const relaunchArgs = stub.buildNoSandboxRelaunchArgs(['app.exe', '--enable-logging', '--gdi'])
check(
  '重启参数是**真实命令行参数**（--no-sandbox 直接进 argv，不是只在进程内 appendSwitch）',
  relaunchArgs.includes('--no-sandbox')
)
check('重启参数保留原有参数', relaunchArgs.includes('--enable-logging') && relaunchArgs.includes('--gdi'))
check('重启参数丢掉 argv[0]', !relaunchArgs.some((a) => a.includes('.exe')))
check(
  '重启参数带自证标记（新进程能在日志里说明「我是一次重启的产物」，否则用户以为一闪是 bug）',
  relaunchArgs.includes('--guncat-nosandbox-relaunch')
)
check(
  '重复重启不会把参数越叠越多',
  stub.buildNoSandboxRelaunchArgs(['app.exe'].concat(relaunchArgs)).length === relaunchArgs.length
)
check(
  '已带 --no-sandbox 时再拼一次也不会出现重复开关',
  stub.buildNoSandboxRelaunchArgs(['app.exe', '--no-sandbox']).filter((a) => a === '--no-sandbox').length === 1
)

// --- Chromium 日志默认开：上次调查最缺的就是「崩了但什么都没留下」 ---
check(
  'win32 打包态默认开 Chromium 日志',
  stub.shouldLogChromium({ platform: 'win32', packaged: true, argv: [] }) === true &&
    stub.shouldLogChromium({ platform: 'win32', packaged: false, argv: [] }) === false &&
    stub.shouldLogChromium({ platform: 'darwin', packaged: true, argv: [] }) === false
)
const chromiumPath = stub.chromiumLogPath('C:\\Users\\x\\AppData\\Roaming\\Guncat Work')
check(
  'Chromium 日志落在 userData\\logs 下（与启动日志分开，便于整包发回来）',
  chromiumPath.endsWith(path.join('logs', 'chromium.log')),
  chromiumPath
)

// --- 提权探测（elevation.ts）：逻辑全部可注入，因此三种情况都能覆盖 ---
const okIo = { writeFileSync: () => {}, rmSync: () => {} }
const denyIo = {
  writeFileSync: () => {
    throw new Error('EACCES')
  },
  rmSync: () => {}
}
check('探测：写得进去 = 提权', stub.probeElevated(okIo, { dir: 'X:\\probe', pid: 1, nonce: 'n' }) === true)
check('探测：写不进去 = 未提权（这是最常见的结果，不是错误）', stub.probeElevated(denyIo) === false)
let triedRemove = false
const removeFailIo = {
  writeFileSync: () => {},
  rmSync: () => {
    triedRemove = true
    throw new Error('EPERM')
  }
}
check(
  '探测：删不掉也算提权，且绝不抛异常（探测失败不能反过来弄崩启动）',
  stub.probeElevated(removeFailIo) === true && triedRemove
)
check(
  '探测目标目录是只有提权进程可写的位置',
  stub.ADMIN_PROBE_DIR === 'C:\\Windows\\System32',
  stub.ADMIN_PROBE_DIR
)
const probeFile = stub.adminProbePath(stub.ADMIN_PROBE_DIR, 4321, 'nonce9')
check(
  '探测文件名带 pid 与随机段（多实例不互踩），且是临时文件',
  probeFile.includes('4321') && probeFile.includes('nonce9') && probeFile.endsWith('.tmp'),
  probeFile.split('\\').pop() ?? probeFile
)
check('isElevated() 返回布尔值且不抛异常', typeof stub.isElevated() === 'boolean')
check('用户身份只用于日志', stub.describeUser({ USERDOMAIN: 'PC', USERNAME: 'alice' }) === 'PC\\alice')
check('进程位数可读', stub.describeBitness('x64').includes('64') && stub.describeBitness('ia32').includes('32'))

// --- 启动脚本的生成与纯 ASCII 校验 ---
// 这些脚本写错的失败方式是「静默」的：打包照样成功，用户双击只看到窗口一闪。
const launch = await import(pathToFileURL(path.join(root, 'scripts/launch-scripts.mjs')).href)
const compatCmd = launch.buildRunCompatCmd('Guncat Work', stub.COMPAT_SWITCHES)
check('run-compat.cmd 是纯 ASCII', launch.asciiViolations(compatCmd).length === 0)
check(
  'run-compat.cmd 带上全部降级开关（= --no-sandbox）',
  stub.COMPAT_SWITCHES.every((flag) => compatCmd.includes(flag)),
  stub.COMPAT_SWITCHES.join(' ')
)
check('run-compat.cmd 不带 --disable-gpu', !compatCmd.includes('--disable-gpu'))
check('run-compat.cmd 不含只用于诊断对照的那条开关', !compatCmd.includes('rasterizer'))

const adminCmd = launch.buildRunAsAdminCmd('Guncat Work', stub.COMPAT_SWITCHES)
check('run-as-admin.cmd 是纯 ASCII', launch.asciiViolations(adminCmd).length === 0)
check(
  'run-as-admin.cmd 走 PowerShell 的提权开关（Start-Process -Verb RunAs）',
  adminCmd.includes('Start-Process') && adminCmd.includes('-Verb RunAs')
)
check(
  'run-as-admin.cmd 作为逃生口仍带 --no-sandbox',
  stub.COMPAT_SWITCHES.every((flag) => adminCmd.includes(flag))
)
check('run-as-admin.cmd 用 Join-Path 拼路径（目录里有空格）', adminCmd.includes('Join-Path'))
check(
  'run-as-admin.cmd 显式指定工作目录（提权进程默认目录会变成 System32）',
  adminCmd.includes('-WorkingDirectory')
)
// 校验器本身也要有防线：它必须真的能认出中文，否则等于没有校验
check(
  'ASCII 校验器能认出中文（否则这道防线是空的）',
  launch.asciiViolations('@echo off\r\necho 中文提示\r\n').length > 0
)

// --- 「双击即可用」脚本（本机必需） ---
// 本机实测：同样带 --no-sandbox，管理员身份运行完全成功，非管理员双击却连第一行 JS
// 都跑不到（启动日志无新记录）。根因未查明前，靠给 exe 挂 RUNASADMIN 兼容性层来保证
// 双击可用。该设置按 exe 完整路径匹配且存在 HKCU —— 挪动文件夹或拷给别人就失效，
// 所以必须由产物自带脚本完成，而不是靠口头说明。
const enableAdmin = launch.buildEnableAdminCmd('Guncat Work')
const disableAdmin = launch.buildDisableAdminCmd('Guncat Work')
check('enable-admin-mode.cmd 是纯 ASCII', launch.asciiViolations(enableAdmin).length === 0)
check('disable-admin-mode.cmd 是纯 ASCII', launch.asciiViolations(disableAdmin).length === 0)
check(
  '提权脚本写 HKCU 的 AppCompatFlags\\Layers',
  enableAdmin.includes('AppCompatFlags\\Layers'),
  '（这个键名写错就会静默失效 —— 双击仍然没反应）'
)
check('提权脚本设置 ~ RUNASADMIN', enableAdmin.includes('~ RUNASADMIN'))
check(
  '提权脚本以 exe 完整路径当值名（路径含空格也必须正确加引号）',
  enableAdmin.includes('%~dp0Guncat Work.exe')
)
check(
  '提权脚本提醒「挪动文件夹后要重跑」（否则用户会以为是我们修坏了）',
  enableAdmin.toLowerCase().includes('move this folder')
)
check(
  '撤销脚本删除同一路径的值（必须能还原）',
  disableAdmin.includes('reg delete') && disableAdmin.includes('%~dp0Guncat Work.exe')
)

// --- 桌面快捷方式脚本 ---
// 使用说明.txt 一直让用户双击 create-desktop-shortcut.cmd，但产物里从来没有这个文件。
// 这几条断言把「说明里提到的文件必须真的被生成」钉住。
const shortcutCmd = launch.buildDesktopShortcutCmd('Guncat Work')
check('create-desktop-shortcut.cmd 是纯 ASCII', launch.asciiViolations(shortcutCmd).length === 0)
check(
  '快捷方式用 WScript.Shell 创建（Windows 上唯一稳定的方式）',
  shortcutCmd.includes('WScript.Shell') && shortcutCmd.includes('CreateShortcut')
)
check(
  '快捷方式指向本目录的 exe 并用本目录当工作目录',
  shortcutCmd.includes('%~dp0Guncat Work.exe') && shortcutCmd.includes('WorkingDirectory')
)
check(
  '快捷方式带上随包图标（资源的相对路径必须与产物结构一致）',
  shortcutCmd.includes('resources\\resources\\app-icon.ico')
)
check(
  '找不到 exe 时明确报错并退出，不静默成功',
  shortcutCmd.includes(':noexe') && shortcutCmd.includes('exit /b 1')
)

// --- 打包脚本必须把图标写进 exe 的 PE 资源 ---
// 回归防线：exe 是 electron.exe 直接改名的，PE 里的图标资源仍然是 Electron 的，
// 任务栏 / 资源管理器 / Alt+Tab 看到的都是它。图标不是运行时能改的，
// 只能在打包时用资源编辑器写进去（此前完全没有这一步，用户一眼就看出来了）。
const packageScript = fs.readFileSync(path.join(root, 'scripts', 'package-portable.mjs'), 'utf8')
check(
  '打包脚本用 rcedit 覆写 exe 图标（否则 exe 里还是 Electron 的图标）',
  packageScript.includes("import('rcedit')") && packageScript.includes('icon: icoPath')
)
check(
  '打包脚本同时写对版本信息（属性对话框里不该还写着 Electron）',
  packageScript.includes('ProductName: appName') && packageScript.includes("'file-version'")
)
check(
  '图标写入失败会明确告警而不是静默跳过',
  packageScript.includes('写入 exe 图标失败')
)
const asciiProbe = path.join(dataRoot, 'ascii-probe.cmd')
launch.writeAsciiFile(asciiProbe, compatCmd)
const probeBytes = fs.readFileSync(asciiProbe)
check(
  '写盘后逐字节复核仍是 ASCII（编码环节也不能引入非 ASCII）',
  probeBytes.every((b) => b < 0x80) && probeBytes.toString('latin1') === compatCmd,
  `${probeBytes.length} 字节`
)

// --- 诊断阶梯：以 --no-sandbox 为基准，并保留两档「预期失败」的对照 ---
const modeNames = launch.DIAG_MODES.map((m) => m.name)
check(
  '诊断阶梯第一档就是 --no-sandbox（现在的默认启动方式）',
  modeNames[0] === 'no-sandbox' && launch.DIAG_MODES[0].args.join(' ') === '--no-sandbox',
  modeNames.join(' → ')
)
check(
  '--disable-gpu 只在后续兜底档出现，不在第一档',
  !launch.DIAG_MODES[0].args.includes('--disable-gpu') &&
    launch.DIAG_MODES.some((m) => m.args.includes('--disable-gpu'))
)
check(
  '有一档显式保留沙箱用来复现原始崩溃（--guncat-keep-sandbox）',
  launch.DIAG_MODES.some((m) => m.args.includes('--guncat-keep-sandbox')),
  launch.DIAG_MODES.filter((m) => m.args.includes('--guncat-keep-sandbox')).map((m) => m.name).join(',')
)
check(
  '老三参数组合只作为「白屏对照档」保留（预期产不出帧）',
  launch.DIAG_MODES.some(
    (m) => m.expect === 'blank' && m.args.includes('--disable-gpu') && m.args.some((a) => a.includes('rasterizer'))
  )
)
check(
  '阶梯里每一档都标了预期结果（诊断脚本会打印出来对照）',
  launch.DIAG_MODES.every((m) => typeof m.expect === 'string' && m.expect !== '')
)
const diagPs1 = launch.buildDiagnosePs1({ appName: 'Guncat Work' })
check('diagnose.ps1 是纯 ASCII（PowerShell 5.1 按 ANSI 读）', launch.asciiViolations(diagPs1).length === 0)
check(
  'diagnose.ps1 读启动日志的四个里程碑标记',
  ['RENDERER_DOM_READY', 'RENDERER_FINISH_LOAD', 'REACT_MOUNTED', 'FRAME_PAINTED'].every((m) =>
    diagPs1.includes(m)
  )
)
check(
  'diagnose.ps1 明确区分三种失败（没到 dom-ready / 没挂载 / 画不出帧）',
  diagPs1.includes('never reached dom-ready') &&
    diagPs1.includes('React never mounted') &&
    diagPs1.includes('compositor cannot paint')
)
check(
  'diagnose.ps1 会判定 --no-sandbox 是否生效、应用是否自我重启过',
  diagPs1.includes('SANDBOX_STATE') && diagPs1.includes('BOOT_RELAUNCH_NO_SANDBOX')
)
check(
  'diagnose.ps1 会跟随「自我重启」后的新进程（否则只测到那个秒退的父进程）',
  diagPs1.includes('Wait-ForApp') && diagPs1.includes('successor process picked up'),
  'Wait-ForApp'
)
check(
  'diagnose.ps1 收集 Chromium 日志并查 GPU 进程失败的原始签名',
  diagPs1.includes('chromium.log') &&
    diagPs1.includes('GPU process launch failed') &&
    diagPs1.includes("GPU process isn''t usable")
)
check(
  'diagnose.ps1 每轮用独立 --user-data-dir（否则第一轮的单实例锁会让后面几轮失败）',
  diagPs1.includes('--user-data-dir=')
)
check('diagnose.ps1 会提示降级重启可能改变日志归属', diagPs1.includes('AUTO_DEGRADE'))
launch.writeAsciiFile(path.join(dataRoot, 'diagnose-probe.ps1'), diagPs1)
check(
  'diagnose.ps1 落盘后逐字节复核仍是 ASCII',
  fs
    .readFileSync(path.join(dataRoot, 'diagnose-probe.ps1'))
    .every((b) => b < 0x80)
)

// =====================================================================
// 22. win32 打包态的第一道防线：无条件自我重启带上 --no-sandbox
// =====================================================================
//
// 这是本次修复的核心，必须有回归防线：崩溃（沙箱下 GPU 子进程建不出来 → 主进程 FATAL）
// 发生在 Chromium 初始化早期，进程内的看门狗根本来不及跑，所以「正常双击启动」
// 这条路径必须自己把 --no-sandbox 放到真实命令行上。
console.log('\n22. win32 打包态默认启动（自我重启带 --no-sandbox）')

// 打包态的路径解析会用 process.resourcesPath，Node 里没有这个属性，补上
process.resourcesPath = path.join(root, 'resources')

const dataRoot2 = path.join(os.tmpdir(), `guncat-startup-packaged-${Date.now()}`)
process.env.GUNCAT_DATA_DIR = dataRoot2
process.env.GUNCAT_BOOTLOG_DIR = dataRoot2
process.env.GUNCAT_STUB_USERDATA = path.join(dataRoot2, 'userdata')
process.env.GUNCAT_STUB_PACKAGED = '1'
// 提权判定强制为 true：验证必须可复现，不能取决于跑验证的终端是不是管理员
process.env.GUNCAT_FORCE_ELEVATED = '1'
// 哨兵参数：用来断言自我重启时原有命令行参数被完整保留
process.argv.push('--guncat-check-kept-arg')

const stub2 = await import(pathToFileURL(outfilePackaged).href)
await new Promise((resolve) => setTimeout(resolve, 300))

const calls2 = stub2.__calls()
const find2 = (fn) => calls2.filter((c) => c.fn === fn)
const log2 = fs.readFileSync(path.join(dataRoot2, 'startup.log'), 'utf8')

check(
  '打包态、命令行没有 --no-sandbox → 应用立即自我重启（而不是等看门狗）',
  find2('app.relaunch').length === (IS_WIN ? 1 : 0),
  `${find2('app.relaunch').length} 次重启`
)
if (IS_WIN) {
  const relaunchCall = find2('app.relaunch')[0]
  const relaunchArgv = relaunchCall?.args?.[0]?.args ?? []
  check(
    '自我重启把 --no-sandbox 作为**真实命令行参数**传下去',
    Array.isArray(relaunchArgv) && relaunchArgv.includes('--no-sandbox'),
    relaunchArgv.join(' ')
  )
  check(
    '自我重启参数里带自证标记（新进程能在日志里说明自己是一次重启的产物）',
    relaunchArgv.includes('--guncat-nosandbox-relaunch')
  )
  check(
    '自我重启保留原有命令行参数（--user-data-dir 之类不能丢）',
    relaunchArgv.includes('--guncat-check-kept-arg')
  )
  check('自我重启后本进程立即退出（否则会有两个进程抢单实例锁）', find2('app.exit').length === 1)
  check(
    '启动日志留下 BOOT_RELAUNCH_NO_SANDBOX 标记（否则用户看到进程一闪会以为是 bug）',
    log2.includes('[BOOT_RELAUNCH_NO_SANDBOX]')
  )
}
// Chromium 日志只在 win32 打包态默认打开（shouldLogChromium 的平台判定）。
// 非 win32 上就**不该**设 --log-file，日志里也不该出现这一行 —— 两个方向都要断言，
// 否则「非 win32 跳过」会让这条防线在 CI 上永远绿（起因见 IS_WIN 的说明）。
const logFileSwitch = String(stub2.__switches()['log-file'] ?? '')
check(
  IS_WIN
    ? '打包态默认开 Chromium 日志，并写成 --log-file=<userData>\\logs\\chromium.log'
    : '非 win32 打包态不开 Chromium 日志（平台判定生效，不设 --log-file）',
  IS_WIN
    ? stub2.__switches()['enable-logging'] !== undefined &&
        logFileSwitch.endsWith(path.join('logs', 'chromium.log'))
    : logFileSwitch === '',
  logFileSwitch || '(未设置)'
)
// index.ts 里这行是**无条件写入**的（未开启时值为「（未开启）」），所以两个平台都断言它存在，
// 只是期望的内容不同 —— 不能写成「非 win32 就该没有这一行」。
check(
  IS_WIN ? '打包态日志记了 Chromium 日志路径' : '非 win32 打包态日志注明 Chromium 日志未开启',
  IS_WIN
    ? /Chromium 日志=.*chromium\.log/.test(log2)
    : /Chromium 日志=（未开启）/.test(log2)
)
check(
  '这一轮不是降级模式（窗口标题不该说「兼容模式」）',
  !String(stub2.__windows()[0]?.options?.title ?? '').includes('兼容模式'),
  String(stub2.__windows()[0]?.options?.title ?? '')
)
check(
  '这一轮不写降级标记文件（正常启动不该被当成降级）',
  !fs.existsSync(path.join(dataRoot2, 'userdata', 'safe-mode.marker'))
)
check('打包态日志记 是否提权=true（诊断用了强制值）', log2.includes('是否提权=true'))
check('打包态日志记了 进程位数', log2.includes('进程位数='))
check('打包态日志记了 userData 目录', log2.includes('userData 目录='))

// 替身环境下 app.exit() 不会真的终止进程（真实 Electron 里进程在这里就结束了），
// 所以上面断言的是「重启动作本身」；后续的启动准备在真实环境下不会执行。

// =====================================================================
// 23. 自我重启之后的那一次启动（稳态：命令行已带 --no-sandbox）
// =====================================================================
console.log('\n23. 稳态启动（命令行已带 --no-sandbox，不再重启）')

const dataRoot3 = path.join(os.tmpdir(), `guncat-startup-steady-${Date.now()}`)
process.env.GUNCAT_DATA_DIR = dataRoot3
process.env.GUNCAT_BOOTLOG_DIR = dataRoot3
process.env.GUNCAT_STUB_USERDATA = path.join(dataRoot3, 'userdata')
// 稳态进程的 argv：正是自我重启会拼出来的那串
process.argv.push('--no-sandbox', '--guncat-nosandbox-relaunch')

const stub3 = await import(pathToFileURL(outfileSteady).href)
await new Promise((resolve) => setTimeout(resolve, 300))

const calls3 = stub3.__calls()
const find3 = (fn) => calls3.filter((c) => c.fn === fn)
const windows3 = stub3.__windows()
const log3 = fs.readFileSync(path.join(dataRoot3, 'startup.log'), 'utf8')

check('稳态启动不再自我重启（护栏：命令行已有 --no-sandbox）', find3('app.relaunch').length === 0)
check('稳态启动不退出', find3('app.exit').length === 0)
check(
  '稳态启动日志记 --no-sandbox 已生效（这是本次修复的验收点）',
  /\[SANDBOX_STATE\][^\n]*--no-sandbox 生效=true/.test(log3)
)
check(
  '稳态启动日志能看出它是一次自我重启的产物',
  log3.includes('[BOOT_RELAUNCH_NO_SANDBOX]') && log3.includes('由自我重启产生')
)
check('稳态启动日志的 argv 里确实有 --no-sandbox', /argv:.*--no-sandbox/.test(log3))
check('稳态启动仍记 是否兼容模式=false（--no-sandbox ≠ 降级模式）', log3.includes('是否兼容模式=false'))
check('稳态启动创建了窗口', windows3.length === 1, `${windows3.length} 个`)

// 渲染进程走到各个里程碑：dom-ready → 加载完成 → React 挂载 → 首帧
if (windows3.length === 1) {
  windows3[0].webContents.emit('dom-ready')
  windows3[0].webContents.emit('did-finish-load')
}
await stub3.__invoke('app:rendererStage', 'mounted')
await stub3.__invoke('app:rendererStage', 'painted')
// 同一步骤重复上报（React 严格模式下 effect 会跑两遍）不该把日志刷满
await stub3.__invoke('app:rendererStage', 'mounted')
// React 渲染期异常也必须留痕 —— 这条以前是彻底缺失的：页面加载完成、窗口纯白、日志全静音
await stub3.__invoke('app:rendererStage', 'error', 'boom: test only')

const log3b = fs.readFileSync(path.join(dataRoot3, 'startup.log'), 'utf8')
check('日志记了 dom-ready 里程碑', log3b.includes('[RENDERER_DOM_READY]'))
check('日志记了「加载完成」里程碑', log3b.includes('[RENDERER_FINISH_LOAD]'))
check('React 挂载成功落进启动日志（界面已渲染）', log3b.includes('[REACT_MOUNTED]'))
check('首帧已产出落进启动日志', log3b.includes('[FRAME_PAINTED]'))
check(
  'React 渲染异常落进启动日志（原来这类问题完全没有痕迹）',
  log3b.includes('[REACT_ERROR]') && log3b.includes('boom: test only')
)
check(
  '同一步骤重复上报只记一次（严格模式下 effect 会跑两遍）',
  log3b.split('[REACT_MOUNTED]').length - 1 === 1,
  `${log3b.split('[REACT_MOUNTED]').length - 1} 次`
)

// --- 三轮跑完仍无未捕获异常 ---
check(
  '三轮启动（开发态 + 打包态自我重启 + 稳态）跑完都无未捕获异常',
  uncaught.length === 0,
  uncaught[0]?.slice(0, 200) ?? ''
)

// =====================================================================
// 24. 界面产物的加载条件（app://guncat 下的 CSP 自检）
// =====================================================================
//
// 「页面加载完成 + 零控制台报错 + 窗口空白」还有一类成因是 CSP：界面里的脚本/样式
// 被策略静默拦掉时，文档本身仍然加载成功，只是什么都没跑起来。
// 这些断言把最容易踩的几条固定住（内联脚本、外链资源、内联样式权限）。
console.log('\n24. 界面产物的加载条件（CSP 自检）')

const htmlPath = path.join(root, 'out', 'renderer', 'index.html')
check('界面产物存在（smoke 先跑 build）', fs.existsSync(htmlPath), path.relative(root, htmlPath))
const builtHtml = fs.readFileSync(htmlPath, 'utf8')
const scriptTags = builtHtml.match(/<script[^>]*>/g) ?? []
check('界面里有脚本标签', scriptTags.length > 0, `${scriptTags.length} 个`)
check(
  '每个 <script> 都是外链（CSP 是 script-src self，内联脚本会被直接拦掉）',
  scriptTags.length > 0 && scriptTags.every((tag) => /\ssrc=/.test(tag)),
  scriptTags.join(' ').slice(0, 160)
)
const refs = [...builtHtml.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1])
check(
  '脚本与样式全部走本地相对路径（没有 CDN：CSP 与离线都更稳）',
  refs.length > 0 && refs.every((ref) => !/^(?:https?:)?\/\//.test(ref)),
  refs.join(' ')
)
check(
  'CSP 允许内联样式（index.html 的占位样式与组件的 style 都依赖它）',
  /style-src[^;"]*'unsafe-inline'/.test(builtHtml)
)
check(
  'CSP 的 script-src 只允许 self（与 app://guncat 同源）',
  /script-src\s+'self'/.test(builtHtml),
  (builtHtml.match(/script-src[^;"]*/) ?? ['(无)'])[0]
)

console.log(`\n启动链路验证：通过 ${passed} 项，失败 ${failed} 项`)
completed = true
if (failed > 0) {
  console.log('失败项：')
  for (const f of failures) {
    console.log(`  - ${f}`)
  }
}
for (const u of uncaught) {
  console.log(`\n未捕获异常：\n${u}`)
}
// 清掉检查用的临时产物，避免混进打包结果
fs.rmSync(checkDir, { recursive: true, force: true })
fs.rmSync(dataRoot, { recursive: true, force: true })
fs.rmSync(dataRoot2, { recursive: true, force: true })
fs.rmSync(dataRoot3, { recursive: true, force: true })
process.exitCode = failed === 0 ? 0 : 1
