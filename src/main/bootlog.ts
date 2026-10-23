// 启动诊断日志。
//
// 目的：一旦应用在用户机器上「启动即退」，要能拿到证据，而不是只有一句「打不开」。
//
// 两个刻意的设计：
//   1) 不依赖任何 Electron API —— 用 %APPDATA% 直接定位日志文件。
//      如果崩溃发生在 app 可用之前，Electron 的路径 API 本身就不可靠。
//   2) 每个启动里程碑都记一行。这样即使最终崩了，日志能告诉我们它走到了哪一步，
//      是「还没到 JS」还是「死在窗口创建」。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

let logPath = ''
let opened = false

function resolveLogPath(): string {
  // 测试可以指定目录，避免覆盖用户真实的启动日志（那正是排查问题时要看的证据）
  const override: string | undefined = process.env.GUNCAT_BOOTLOG_DIR
  if (override !== undefined && override !== '') {
    return path.join(override, 'startup.log')
  }
  const base: string =
    process.env.APPDATA !== undefined && process.env.APPDATA !== ''
      ? process.env.APPDATA
      : path.join(os.homedir(), '.config')
  return path.join(base, 'Guncat Work', 'logs', 'startup.log')
}

export function bootLogPath(): string {
  if (logPath === '') {
    logPath = resolveLogPath()
  }
  return logPath
}

/**
 * 写入一行启动日志。任何失败都必须被吞掉 —— 诊断不该反过来弄崩应用。
 *
 * 用同步 append 而不是 WriteStream：**启动日志最需要它的时刻，恰恰是进程即将死掉的时候**，
 * 而流是有缓冲的，进程猝死会把还没刷盘的日志一起带走 —— 那正好是我们要的那几行。
 * 启动期日志量很小，同步写的代价可以忽略。
 */
export function bootLog(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}\n`
  try {
    const file = bootLogPath()
    if (!opened) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      // 每次启动重写，避免日志无限增长
      fs.writeFileSync(file, '')
      opened = true
    }
    fs.appendFileSync(file, line)
  } catch {
    // 忽略
  }
  // 需要时也写 stderr（配合 --enable-logging 从终端看）；默认关闭以免污染测试输出
  if (process.env.GUNCAT_BOOTLOG_STDERR === '1') {
    try {
      process.stderr.write(line)
    } catch {
      // 忽略
    }
  }
}

/**
 * 里程碑标记：一行日志，前缀一个**纯 ASCII** 的大写标记。
 *
 * 为什么要这层标记：诊断脚本（diagnose.ps1）必须是纯 ASCII（见 package-portable.mjs
 * 里的说明），它没法在文件里写中文去匹配日志。而「渲染进程走到哪一步了」正是排查
 * 白屏时唯一能靠得住的证据，比如：
 *   RENDERER_DOM_READY   → DOM 解析完了
 *   RENDERER_FINISH_LOAD → 页面与子资源都加载完了
 *   REACT_MOUNTED        → React 真的挂载上去了（渲染进程主动上报）
 *   FRAME_PAINTED        → 浏览器已产出首帧
 * 这四步是递进的：加载完成 ≠ React 挂载成功 ≠ 界面真的画出来了。
 * 三种失败在白屏这件事上长得一模一样，只有靠标记才能区分。
 */
export function bootMark(marker: string, message: string): void {
  bootLog(`[${marker}] ${message}`)
}

/** 取启动日志末尾若干行 —— 用于把「为什么失败」直接放进错误框，省去用户翻文件 */
export function bootLogTail(lines: number = 24): string {
  try {
    const all: string[] = fs.readFileSync(bootLogPath(), 'utf8').split('\n').filter((l) => l !== '')
    return all.slice(-lines).join('\n')
  } catch {
    return '(无法读取启动日志)'
  }
}

/** 记录一个致命错误，并把它留在日志里 */
export function bootFail(where: string, error: unknown): void {
  const detail =
    error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
  bootLog(`✗ 致命错误 @ ${where}\n${detail}`)
}

/**
 * 装上兜底处理器：未捕获异常与未处理的 Promise 拒绝都要落到日志里，
 * 否则 Electron 会静默退出，用户只看到「闪一下就没了」。
 * onFatal 用于弹一个错误框（app 可用时才有意义）。
 */
export function installCrashHandlers(onFatal: (text: string) => void): void {
  process.on('uncaughtException', (error: Error) => {
    bootFail('uncaughtException', error)
    onFatal(`未捕获异常：${error.message}`)
  })
  process.on('unhandledRejection', (reason: unknown) => {
    bootFail('unhandledRejection', reason)
    onFatal(`未处理的 Promise 拒绝：${String(reason)}`)
  })
}
