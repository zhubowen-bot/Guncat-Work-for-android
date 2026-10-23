// 平台适配层：本机命令执行（node:child_process）。
//
// 为什么放在 platform 层而不是 core/service：鸿蒙侧**没有**「跑 shell 命令」这个能力
// （没有对应的 ShellKit），这是桌面端独有的口子，和 appPaths.ts / svgRaster.ts 一样属于
// 「宿主能力适配」。分两层的意义在于：这里只管「怎么把进程拉起来、怎么收输出、怎么杀树」，
// 安全策略（危险判定、审批、权限档位）全部留在 service 层 —— 策略可以脱离真实进程做断言，
// 进程细节也不会渗进端口代码。
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import process from 'node:process'

/**
 * 传给子进程的环境变量白名单。
 *
 * 不透传 process.env：主进程的环境里可能有 API Key、令牌、云凭证，
 * 而 run_command 跑的是模型写的命令（Windows 上一条 `set` 就把全部环境变量打出来了）。
 * 白名单是 fail-closed 写法 —— 默认什么都拿不到，只给跑命令真正需要的。
 */
const ENV_ALLOWLIST: string[] = [
  'PATH', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR',
  'LANG', 'LC_ALL', 'TZ', 'SHELL', 'PWD', 'USER', 'USERNAME',
  'PROGRAMFILES', 'PROGRAMDATA', 'LOCALAPPDATA', 'APPDATA', 'NODE_PATH'
]

/** 强制设定的变量：让常见解释器输出 UTF-8，并把工具的交互式提问关掉（子进程没有 TTY） */
const ENV_FORCED: Record<string, string> = {
  PYTHONIOENCODING: 'utf-8',
  // git 需要凭证时会挂住等输入；没有 TTY 就只能等超时。让它直接失败更快。
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  PAGER: 'cat',
  // 颜色转义序列会把截断后的输出刷成一堆没法读的 \x1b[
  FORCE_COLOR: '0',
  NO_COLOR: '1',
  TERM: 'dumb'
}

/**
 * 构建净化后的子进程环境。
 * Windows 环境变量名大小写不敏感（PATH / Path / path 都可能出现），统一按大写归一。
 */
export function buildCleanEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  const wanted: Set<string> = new Set(ENV_ALLOWLIST)
  for (const key of Object.keys(process.env)) {
    const upper: string = key.toUpperCase()
    if (wanted.has(upper)) {
      const value: string | undefined = process.env[key]
      if (value !== undefined) {
        env[upper] = value
      }
    }
  }
  for (const key of Object.keys(ENV_FORCED)) {
    env[key] = ENV_FORCED[key]
  }
  return env
}

/** 一条命令的执行结果 */
export class ShellOutcome {
  /** 进程是否成功拉起 */
  started: boolean = false
  /** 拉起失败的原因（cwd 不存在等） */
  error: string = ''
  exitCode: number = -1
  signal: string = ''
  timedOut: boolean = false
  /** 被主动杀掉（超时 / job_kill / 用户停止任务） */
  killed: boolean = false
  /** stdout+stderr 合并文本（stdout 在前） */
  output: string = ''
  /** 输出超过缓冲上限被丢弃的开头字符数（>0 时 output 不是全文，别宣称已落盘） */
  droppedChars: number = 0
  durationMs: number = 0
}

interface StreamBuffer {
  text: string
  dropped: number
}

/**
 * 一条正在运行的命令的句柄。
 * 前台用 wait() 拿完整结果；后台把句柄交给 job 注册表，由 job_output 按游标增量读 snapshot()。
 */
export class ShellTask {
  pid: number = -1
  alive: boolean = false
  readonly command: string
  readonly cwd: string
  readonly startedAt: number = Date.now()

  private child: ChildProcess | null = null
  private out: StreamBuffer = { text: '', dropped: 0 }
  private err: StreamBuffer = { text: '', dropped: 0 }
  private limitPerStream: number = 256 * 1024
  private closed: boolean = false
  private exitCode: number = -1
  private exitSignal: string = ''
  private spawnError: string = ''
  private timedOut: boolean = false
  private killedByUser: boolean = false
  private aborted: boolean = false
  private startTime: number = Date.now()
  private waiters: Array<(o: ShellOutcome) => void> = []
  private settledOutcome: ShellOutcome | null = null
  private holdTimer: ReturnType<typeof setTimeout> | null = null
  private holdPoll: ReturnType<typeof setInterval> | null = null

  constructor(command: string, cwd: string) {
    this.command = command
    this.cwd = cwd
  }

  /** 拉起进程；失败时直接返回带 error 的结果，成功返回 null */
  start(env: Record<string, string>, limitPerStream: number): ShellOutcome | null {
    this.limitPerStream = Math.max(4096, limitPerStream)
    const isWin: boolean = process.platform === 'win32'
    // Windows 的 cmd 默认跟随系统码页（中文机是 GBK），而 Node 按 utf8 解码外部程序的输出：
    // 先把这个 cmd 实例切到 UTF-8，git / npm / python 这些真正干活的程序才会跟着用 UTF-8 写。
    // 实测**修不掉** cmd 内建命令自己那些本地化提示（"系统找不到指定的路径"仍是 GBK 字节），
    // 所以不能对外承诺「输出一定是 UTF-8」—— 乱码只出现在内建命令的报错文案里，不影响的判定。
    const realCommand: string = isWin ? `chcp 65001 >nul & ${this.command}` : this.command
    const options: SpawnOptions = {
      cwd: this.cwd,
      env,
      // shell:true 让 Node 自己拼 `cmd /d /s /c "<command>"` 或 `/bin/sh -c <command>`；
      // 手工引号会踩 cmd 与 CRT 规则不一致的坑（内层引号被拆坏）
      shell: true,
      windowsHide: true,
      // POSIX 下脱离父进程组，才能一次 kill(-pid) 带走整棵树
      detached: !isWin,
      stdio: ['ignore', 'pipe', 'pipe']
    }
    let child: ChildProcess
    try {
      child = spawn(realCommand, options)
    } catch (e) {
      const failed: ShellOutcome = new ShellOutcome()
      failed.error = e instanceof Error ? e.message : String(e)
      return failed
    }
    this.child = child
    this.pid = child.pid ?? -1
    this.alive = true
    this.startTime = Date.now()
    child.on('error', (err: Error): void => {
      this.spawnError = err.message
    })
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string): void => {
      this.append(this.out, chunk)
    })
    child.stderr?.on('data', (chunk: string): void => {
      this.append(this.err, chunk)
    })
    child.on('close', (code: number | null, signal: NodeJS.Signals | null): void => {
      this.exitCode = code === null ? -1 : code
      this.exitSignal = signal === null ? '' : signal
      this.alive = false
      this.closed = true
      this.release()
    })
    return null
  }

  /** 增量快照：返回 from 之后新增的输出（job_output 的「读后即弃」游标用） */
  snapshot(from: number): string {
    const all: string = this.merged()
    return from >= all.length ? '' : all.slice(from)
  }

  get outputLength(): number {
    return this.merged().length
  }

  /** 进程是否已退出（后台任务登记处可以同步读到，不必等 wait 的 promise） */
  get exited(): boolean {
    return this.closed
  }

  get exitCodeValue(): number {
    return this.exitCode
  }

  /** 是否被主动终止（超时 / job_kill / 停止任务） */
  get wasKilled(): boolean {
    return this.killedByUser || this.timedOut || this.aborted
  }

  /** 主动杀掉（连同子进程派生的孙子进程） */
  kill(): void {
    if (!this.alive) {
      return
    }
    this.killedByUser = true
    if (this.child !== null) {
      killProcessTree(this.child.pid ?? -1)
    }
  }

  /**
   * 等待退出。timeoutMs<=0 表示不设超时；abortSignal 每 200ms 轮询一次，
   * 取消即杀进程树（核心层的中断标志是个纯对象，没有事件可挂，只能轮询）。
   */
  wait(timeoutMs: number, abortSignal: { aborted: boolean } | null): Promise<ShellOutcome> {
    if (this.settledOutcome !== null) {
      return Promise.resolve(this.settledOutcome)
    }
    return new Promise<ShellOutcome>((resolve: (o: ShellOutcome) => void): void => {
      this.waiters.push(resolve)
      if (timeoutMs > 0) {
        this.holdTimer = setTimeout((): void => {
          this.timedOut = true
          this.kill()
        }, timeoutMs)
      }
      if (abortSignal !== null) {
        this.holdPoll = setInterval((): void => {
          if (abortSignal.aborted) {
            this.aborted = true
            this.kill()
          }
        }, 200)
      }
      if (this.closed) {
        this.release()
      }
    })
  }

  private release(): void {
    if (this.holdTimer !== null) {
      clearTimeout(this.holdTimer)
      this.holdTimer = null
    }
    if (this.holdPoll !== null) {
      clearInterval(this.holdPoll)
      this.holdPoll = null
    }
    if (this.settledOutcome !== null || this.waiters.length === 0) {
      return
    }
    const outcome: ShellOutcome = this.buildOutcome()
    this.settledOutcome = outcome
    const waiters: Array<(o: ShellOutcome) => void> = this.waiters.splice(0)
    for (const resolve of waiters) {
      resolve(outcome)
    }
  }

  private buildOutcome(): ShellOutcome {
    const o: ShellOutcome = new ShellOutcome()
    o.started = true
    o.exitCode = this.exitCode
    o.signal = this.aborted ? 'aborted' : this.exitSignal
    o.timedOut = this.timedOut
    o.killed = this.killedByUser || this.timedOut || this.aborted
    o.output = this.merged()
    if (this.spawnError !== '' && o.output.indexOf(this.spawnError) === -1) {
      o.output = (o.output === '' ? '' : o.output + '\n') + this.spawnError
    }
    o.droppedChars = this.out.dropped + this.err.dropped
    o.durationMs = Date.now() - this.startTime
    return o
  }

  private merged(): string {
    if (this.err.text === '') {
      return this.out.text
    }
    if (this.out.text === '') {
      return this.err.text
    }
    return this.out.text + (this.out.text.endsWith('\n') ? '' : '\n') + this.err.text
  }

  private append(buf: StreamBuffer, chunk: string): void {
    buf.text += chunk
    if (buf.text.length > this.limitPerStream) {
      const cut: number = buf.text.length - this.limitPerStream
      buf.text = buf.text.slice(cut)
      buf.dropped += cut
    }
  }
}

/** 杀掉整棵进程树（命令自己再派生的孙子进程要一起带走，否则超时后留一堆孤儿进程） */
export function killProcessTree(pid: number): void {
  if (pid <= 0) {
    return
  }
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } catch {
      // 拿不到 taskkill 时退化为只杀直接子进程
      try {
        process.kill(pid)
      } catch {
        // 已经退出
      }
    }
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // 已经退出
    }
  }
}
