// 「启动第一刻就带上 --no-sandbox」的判定与参数拼装。
//
// 为什么这件事必须发生在最前面，而且必须是**真实命令行参数**：
//   根因已由崩溃转储确证（见 docs/STARTUP-TROUBLESHOOTING.md）—— 沙箱开启时 Chromium 建不出
//   GPU 子进程（`GPU process launch failed: error_code=18`），fallback 耗尽后在主进程主线程
//   执行 `LOG(FATAL) << "GPU process isn't usable. Goodbye."`，随即 __debugbreak 自杀
//   （STATUS_BREAKPOINT，退出码 -2147483645）。崩溃点在 content/browser/gpu/ 里，
//   发生在 Chromium 初始化早期：主线程正卡在 GPU 进程启动失败的等待路径上，
//   进程内的看门狗 setTimeout 与自动降级**根本来不及执行**（这正是之前几轮看门狗
//   一条日志都没留下的原因）。所以只能一启动就把参数带在命令行上。
//
//   也不该用 app.commandLine.appendSwitch 代替：GPU 子进程的启动参数取自命令行，
//   而用户机器上唯一被 14 组对照实验证实可用的正是「命令行带 --no-sandbox」。
//
// 为什么用自我重启（app.relaunch）而不是自己 spawn：
//   relaunch 会在本进程退出**之后**才拉起新进程，不会去抢单实例锁；
//   自己 spawn 会得到一个拿不到锁、随即退出的新进程。
//
// 判定与拼装都是纯函数，便于无头验证 —— 这段逻辑一旦失灵，用户看到的就是
// 「双击 → 进程一闪 → 什么都没有」，而日志里也不会留下任何责备的痕迹。
import path from 'node:path'

export const NO_SANDBOX_FLAG = '--no-sandbox'

/** 自我重启时附带的标记：它让新进程能在日志里自证「我是一次重启的产物」（否则用户看到进程闪一下就没了会以为是 bug） */
export const NO_SANDBOX_RELAUNCH_MARK = '--guncat-nosandbox-relaunch'

/**
 * 诊断专用：显式保留沙箱，抑制上面那次自我重启。
 *
 * 存在的理由：装上无条件重启之后，正常路径再也不会崩了，也就再也**无法复现**根因。
 * 而这个环境问题（为什么只有这份产物建不出 GPU 子进程）仍未查明，
 * 必须留一条能复现的路径 —— diagnose.ps1 的「保持沙箱」档就是干这个的。
 * 只给诊断用，不写进任何默认启动路径。
 */
export const KEEP_SANDBOX_FLAG = '--guncat-keep-sandbox'

export interface LaunchFacts {
  platform: string
  packaged: boolean
  argv: string[]
}

/**
 * 是否需要「带 --no-sandbox 自我重启一次」。返回 null 表示不需要。
 * 返回一段人类可读的理由（写进日志），便于事后知道当时为什么重启。
 */
export function noSandboxRelaunchReason(facts: LaunchFacts): string | null {
  // 只在 win32 打包态做。开发态刻意保留沙箱，便于将来继续定位真实沙箱问题。
  if (facts.platform !== 'win32') {
    return null
  }
  if (!facts.packaged) {
    return null
  }
  // 护栏：命令行已经有 --no-sandbox 就绝不再重启 —— 这是防止无限重启的唯一开关
  if (facts.argv.includes(NO_SANDBOX_FLAG)) {
    return null
  }
  // 诊断档显式要求保留沙箱（用来复现崩溃，见 KEEP_SANDBOX_FLAG）
  if (facts.argv.includes(KEEP_SANDBOX_FLAG)) {
    return null
  }
  return 'win32 打包态启动时命令行没有 --no-sandbox，而沙箱下 GPU 子进程建不出来会让主进程直接 FATAL 自杀'
}

/**
 * 组装自我重启的参数：保留原有参数（丢掉 argv[0]），再补上 --no-sandbox 与重启标记。
 * 重启标记先去重，避免反复重启时参数越叠越长。
 */
export function buildNoSandboxRelaunchArgs(argv: string[]): string[] {
  return argv
    .slice(1)
    .filter((arg: string) => arg !== NO_SANDBOX_RELAUNCH_MARK && arg !== NO_SANDBOX_FLAG)
    .concat([NO_SANDBOX_FLAG, NO_SANDBOX_RELAUNCH_MARK])
}

/**
 * 本次进程的命令行上是否已带 --no-sandbox。
 * （与「是否兼容模式」是两件事：前置是默认启动方式，后者才是降级路径。）
 */
export function hasNoSandboxFlag(argv: string[]): boolean {
  return argv.includes(NO_SANDBOX_FLAG)
}

/** 本次进程是否是那次自我重启产生的 */
export function isNoSandboxRelaunch(argv: string[]): boolean {
  return argv.includes(NO_SANDBOX_RELAUNCH_MARK)
}

// ===== Chromium 日志 =====
//
// 上一次调查最大的障碍就是「崩溃时什么都没留下」：所有失败运行都在日志初始化之前就死了，
// Chromium 一条日志都没写，最后只能靠 %LOCALAPPDATA%\CrashDumps 里的崩溃转储还原。
// 现在默认把 Chromium 日志落到用户数据目录下，下次再出问题就有第一手材料。

export function shouldLogChromium(facts: LaunchFacts): boolean {
  return facts.platform === 'win32' && facts.packaged
}

/** Chromium 日志文件位置（放在 userData 下，与启动日志分开，便于整体打包发回来） */
export function chromiumLogPath(userData: string): string {
  return path.join(userData, 'logs', 'chromium.log')
}
