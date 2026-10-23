// 构建包装脚本：先把 esbuild 的临时目录指到项目内，再调用 electron-vite。
//
// 为什么不直接写 "electron-vite build"：
//   在 Windows 上 esbuild 会在系统 TEMP 建临时文件再删，本机环境下这一步会报
//   "Access is denied"，构建在 vite:esbuild-transpile 阶段直接失败。
//   把 TMP/TEMP 指到项目内的 .tmp 即可绕开。
// 用 Node 包装而不是在 package.json 里写 `set TMP=... &&`，
// 是为了不依赖 cmd/bash 语法，Windows 与 macOS/Linux 行为一致。
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { root, tempDir } from './esbuild-aliases.mjs'

const cli = path.join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')

/**
 * 清掉 ELECTRON_RUN_AS_NODE —— 它在场时 electron.exe **以纯 Node 运行**：
 * 主进程文件被当成普通 ESM 交给 Node 执行，`import { BrowserWindow } from 'electron'`
 * 会解析到 npm 的 electron 包（只导出一个路径字符串），于是直接抛
 * "does not provide an export named 'BrowserWindow'"，**永远不会创建窗口**。
 *
 * 本机（以及任何从带这个变量的终端里启动的场景）就会这样：`npm run dev` 打完
 * 「start electron app...」之后一片安静，什么都没有 —— 用户实际遇到过。
 * 打包后的 exe 从资源管理器双击启动时没有这个变量，所以「装好的能用、dev 起不来」。
 * 这里统一剔除，dev 与 build 都不再受调用方环境的影响。
 */
const env = {
  ...process.env,
  TMP: tempDir,
  TEMP: tempDir,
  TMPDIR: tempDir
}
delete env.ELECTRON_RUN_AS_NODE

const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: root,
  env
})

process.exit(result.status === null ? 1 : result.status)
