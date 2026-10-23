// 兼容（降级）模式的参数拼装与判定。
//
// 抽成纯函数是为了能被无头验证覆盖：这段逻辑一旦拼错，自动降级会静默失效 ——
// 用户看到的仍然是白屏，而且没有任何报错指向参数问题。
//
// 根因已由崩溃转储确证（docs/STARTUP-TROUBLESHOOTING.md §3-§4）：
//   沙箱开启时 Chromium 建不出 GPU 子进程，fallback 耗尽后主进程执行
//   `LOG(FATAL) << "GPU process isn't usable. Goodbye."` 自杀（STATUS_BREAKPOINT）。
//   14 组对照实验里，**只有 --no-sandbox 能改变结果**：--disable-gpu、
//   --disable-gpu-sandbox、--disable-gpu-compositing、--in-process-gpu、--single-process、
//   --use-angle=swiftshader、--disable-features=Vulkan 单独使用一律照崩。
//   而在 --no-sandbox 之下 GPU 进程 44ms 就正常起来了（Chromium 日志里的
//   `GPUProcessLaunchTime mean=44.0`）。
//
// 所以这里只剩一条开关，而且是**必要且充分**的那一条：
//   · 它现在不是「降级专用」—— win32 打包态的默认启动路径也会带上它（见 nosandbox.ts，
//     必须在启动第一刻就生效，进程内的降级逻辑来不及救）；
//   · 不再用 --disable-gpu 之类的开关：实测没有额外作用，却会把界面强制成软件渲染。

export const SAFE_MODE_FLAG = '--guncat-safe-mode'
export const FRESH_PROFILE_FLAG = '--guncat-fresh-profile'

/** 已知必要且充分的唯一开关 */
export const COMPAT_SWITCHES: string[] = ['--no-sandbox']

/** 兼容模式下要加到命令行上的全部内容 */
export const COMPAT_ARGS: string[] = COMPAT_SWITCHES.concat([
  SAFE_MODE_FLAG,
  FRESH_PROFILE_FLAG
])

/**
 * 组装自动降级时的重启参数。
 * 必须保留原有参数（开发态 argv[1] 是应用目录，丢了就启动不到应用），
 * 同时去掉重复项，避免参数越叠越长。
 */
export function buildCompatArgs(argv: string[]): string[] {
  return argv
    .slice(1)
    .filter((a: string) => !COMPAT_ARGS.includes(a))
    .concat(COMPAT_ARGS)
}

/** 命令行是否显式要求兼容模式（只看标记） */
export function isSafeModeRequested(argv: string[]): boolean {
  return argv.includes(SAFE_MODE_FLAG)
}

/**
 * 是否处于「兼容/降级模式」。
 *
 * 判据是**降级标记**（命令行标记，或上次降级留下的标记文件），不再是那组开关：
 * 既然 --no-sandbox 现在连正常启动路径都要带（win32 打包态默认），
 * 把它当「降级」的判据会让正常启动与降级启动在日志里长得一模一样，
 * 而这两者恰恰是排查时最需要分开的（窗口标题、看门狗是否还该重试都依赖它）。
 */
export function isCompatMode(argv: string[]): boolean {
  return isSafeModeRequested(argv)
}
