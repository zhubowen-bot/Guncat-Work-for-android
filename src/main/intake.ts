// 文件收件：桌面上「系统分享」的等价入口是
//   1) 命令行参数（双击关联文件 / 「打开方式」/ 拖到可执行文件上）
//   2) 第二实例的 argv（应用已在运行时再从系统打开一个文件）
//   3) 窗口内拖拽（由渲染进程处理，见 preload 的 files.pathForFile）
//
// 这里只负责从 argv 里挑出真实存在的文件路径，其余交给会话层导入工作区。
import fs from 'node:fs'
import path from 'node:path'

/**
 * 从 argv 中提取文件路径。
 * 跳过开关项（-x / --x）、应用入口本身、以及不存在的路径或目录。
 */
export function collectFileArgs(argv: string[]): string[] {
  const out: string[] = []
  const seen: Set<string> = new Set()

  // argv[0] 是 electron 可执行文件；开发态 argv[1] 是应用目录
  for (let i = 1; i < argv.length; i++) {
    const raw: string = argv[i]
    if (raw === undefined || raw === '' || raw.startsWith('-')) {
      continue
    }
    let resolved: string
    try {
      resolved = path.resolve(raw)
    } catch {
      continue
    }
    if (seen.has(resolved)) {
      continue
    }
    try {
      // 目录（含开发态的应用目录）不算收件
      if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
        continue
      }
    } catch {
      continue
    }
    seen.add(resolved)
    out.push(resolved)
  }

  return out
}
