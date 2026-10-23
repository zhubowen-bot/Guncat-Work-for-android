// Android 端命令执行适配层：接口与 desktop 的 shellExec.ts 完全一致。
//
// 两条路：
//   1. 有原生桥（真机）→ ShellManager 拉起随包内置的 bash（Termux 用户态）或系统 sh；
//      执行前把会话工作区镜像到设备，执行后把改动读回 memfs（见 platform/mirror.ts）。
//   2. 没有原生桥（浏览器冒烟 / 桌面预览移动端）→ 退回内置 JS POSIX 子集，保证预览可用。
//      这条退路只在开发环境出现，真机上不会走。
//
// CommandService（安全判定、审批、后台任务、超时）因此一行都不用改：它看到的仍是
// 同名的 ShellTask / ShellOutcome。
import { runShell } from './shell'
import { WorkspaceMirror, mirrorRootFor, translateNativePaths } from './mirror'
import { parseJson, readShellInfo, shellBridge } from '../native/shellBridge'
import type { ShellInfo } from '../native/shellBridge'

const ENV_ALLOWLIST: string[] = ['HOME', 'PWD', 'LANG', 'TMPDIR']
const ENV_FORCED: Record<string, string> = {
  TERM: 'dumb',
  NO_COLOR: '1',
  FORCE_COLOR: '0'
}

/** 后端选择存在 localStorage：它是 WebView 的同步存储，命令行执行前不需要 await 配置 */
export const SHELL_BACKEND_KEY = 'guncat.shellBackend'
export type ShellBackend = 'bundled' | 'system'

export function shellBackend(): ShellBackend {
  try {
    const value = window.localStorage.getItem(SHELL_BACKEND_KEY)
    // 'termux' 是 0.3.0 早期版本留下的值，统一迁到内置终端
    if (value === 'system') {
      return 'system'
    }
    return 'bundled'
  } catch {
    return 'bundled'
  }
}

export function setShellBackend(choice: ShellBackend): void {
  try {
    window.localStorage.setItem(SHELL_BACKEND_KEY, choice)
  } catch {
    // 隐私模式写不进去时按默认后端执行
  }
}

export interface ShellStatusInfo {
  available: boolean
  backend: ShellBackend
  info: ShellInfo
}

export function shellStatus(): ShellStatusInfo {
  return { available: shellBridge() !== null, backend: shellBackend(), info: readShellInfo() }
}

export function buildCleanEnv(): Record<string, string> {
  const env: Record<string, string> = {
    HOME: '/guncat/data',
    PATH: '/system/bin:/usr/bin:/bin',
    TMPDIR: '/guncat/data/temp'
  }
  for (const key of Object.keys(process.env ?? {})) {
    if (ENV_ALLOWLIST.includes(key.toUpperCase())) {
      env[key.toUpperCase()] = String(process.env[key] ?? '')
    }
  }
  return { ...env, ...ENV_FORCED }
}

export class ShellOutcome {
  started: boolean = false
  error: string = ''
  exitCode: number = -1
  signal: string = ''
  timedOut: boolean = false
  killed: boolean = false
  output: string = ''
  droppedChars: number = 0
  durationMs: number = 0
}

/** 真机路径：ShellManager + 工作区镜像 */
class NativeShellTask {
  pid: number = -1
  alive: boolean = false
  readonly command: string
  readonly cwd: string
  readonly startedAt: number = Date.now()

  private id: string = ''
  private backend: ShellBackend = 'bundled'
  private out: string = ''
  /** 已经从原生缓冲区读到的字符偏移（不是 out.length） */
  private consumed: number = 0
  private dropped: number = 0
  private limit: number = 256 * 1024
  private closed: boolean = false
  private exitCode: number = -1
  private killedByUser: boolean = false
  private timedOut: boolean = false
  private aborted: boolean = false
  private spawnError: string = ''
  private startTime: number = Date.now()
  private nativeRoot: string = ''
  private mirror: WorkspaceMirror | null = null
  private mirrorNotes: string[] = []
  private settled: ShellOutcome | null = null
  private waiters: Array<(o: ShellOutcome) => void> = []
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private holdTimer: ReturnType<typeof setTimeout> | null = null
  private abortTimer: ReturnType<typeof setInterval> | null = null

  constructor(command: string, cwd: string) {
    this.command = command
    this.cwd = cwd
  }

  start(env: Record<string, string>, limitPerStream: number): ShellOutcome | null {
    const bridge = shellBridge()
    if (bridge === null) {
      const failed = new ShellOutcome()
      failed.error = '原生 Shell 桥不可用'
      return failed
    }
    this.limit = Math.max(4096, limitPerStream)
    this.startTime = Date.now()
    this.backend = shellBackend()
    this.nativeRoot = readShellInfo().nativeRoot

    // 两个后端都在真实文件系统上执行，都要先把 memfs 工作区镜像下去
    this.mirror = new WorkspaceMirror(mirrorRootFor(this.cwd))
    try {
      this.mirror.syncDown()
      this.mirrorNotes = this.mirror.warnings.slice()
    } catch (e) {
      this.mirrorNotes.push(`工作区同步失败：${e instanceof Error ? e.message : String(e)}`)
    }
    if (this.mirrorNotes.length > 0) {
      this.appendOut('[工作区同步] ' + this.mirrorNotes.join('；') + '\n')
    }
    let parsed: Record<string, unknown>
    try {
      parsed = parseJson(
        bridge.start(this.command, this.cwd, JSON.stringify(env), this.limit, this.backend)
      )
    } catch (e) {
      const failed = new ShellOutcome()
      failed.error = e instanceof Error ? e.message : String(e)
      return failed
    }
    if (parsed.ok !== true) {
      const failed = new ShellOutcome()
      failed.error = typeof parsed.error === 'string' ? parsed.error : '命令启动失败'
      return failed
    }

    this.id = String(parsed.id ?? '')
    this.pid = Number(parsed.pid ?? -1)
    this.alive = true
    this.pollTimer = setInterval(() => {
      this.refresh()
      if (this.closed) {
        this.stopTimers()
      }
    }, 80)
    return null
  }

  private refresh(): void {
    if (this.closed) {
      return
    }
    const bridge = shellBridge()
    if (bridge === null) {
      return
    }
    let parsed: Record<string, unknown>
    try {
      parsed = parseJson(bridge.read(this.id, this.consumed))
    } catch (e) {
      this.spawnError = e instanceof Error ? e.message : String(e)
      this.finalize()
      return
    }
    if (parsed.ok !== true) {
      if (parsed.error !== undefined) {
        this.spawnError = String(parsed.error)
      }
      this.finalize()
      return
    }
    const gap = Number(parsed.gap ?? 0)
    if (gap > 0) {
      this.dropped += gap
      this.appendOut(`\n[输出过快，开头 ${gap} 个字符已被缓冲区丢弃]\n`)
    }
    const data = String(parsed.data ?? '')
    if (data !== '') {
      this.appendOut(translateNativePaths(data, this.nativeRoot))
    }
    this.consumed = Number(parsed.next ?? this.consumed)
    this.exitCode = Number(parsed.exitCode ?? -1)
    if (parsed.killed === true) {
      this.killedByUser = true
    }
    if (typeof parsed.error === 'string' && parsed.error !== '') {
      this.spawnError = parsed.error
    }
    if (parsed.running !== true) {
      this.finalize()
    }
  }

  private finalize(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.alive = false
    this.stopTimers()
    if (this.mirror !== null) {
      try {
        this.mirror.syncUp()
        for (const note of this.mirror.warnings) {
          if (!this.mirrorNotes.includes(note)) {
            this.mirrorNotes.push(note)
          }
        }
      } catch (e) {
        this.mirrorNotes.push(`工作区回写失败：${e instanceof Error ? e.message : String(e)}`)
      }
    }
    if (this.mirrorNotes.length > 0) {
      this.appendOut('\n[工作区同步] ' + this.mirrorNotes.join('；') + '\n')
    }
    if (this.spawnError !== '' && !this.out.includes(this.spawnError)) {
      this.appendOut((this.out === '' ? '' : '\n') + this.spawnError)
    }
    const bridge = shellBridge()
    if (bridge !== null && this.id !== '') {
      bridge.release(this.id)
    }
    this.settle()
  }

  private stopTimers(): void {
    if (this.holdTimer !== null) {
      clearTimeout(this.holdTimer)
      this.holdTimer = null
    }
    if (this.abortTimer !== null) {
      clearInterval(this.abortTimer)
      this.abortTimer = null
    }
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  private settle(): void {
    if (this.settled !== null) {
      return
    }
    this.settled = this.buildOutcome()
    const waiters = this.waiters.splice(0)
    for (const resolve of waiters) {
      resolve(this.settled)
    }
  }

  /** JS 侧同样限长：原生缓冲区会丢头，这里再丢一次，避免长任务把 WebView 内存吃满 */
  private appendOut(text: string): void {
    if (text === '') {
      return
    }
    this.out += text
    if (this.out.length > this.limit + 8192) {
      const cut = this.out.length - this.limit
      this.out = this.out.slice(cut)
      this.dropped += cut
    }
  }

  snapshot(from: number): string {
    this.refresh()
    return from >= this.out.length ? '' : this.out.slice(from)
  }

  get outputLength(): number {
    this.refresh()
    return this.out.length
  }

  get exited(): boolean {
    this.refresh()
    return this.closed
  }

  get exitCodeValue(): number {
    this.refresh()
    return this.exitCode
  }

  get wasKilled(): boolean {
    return this.killedByUser || this.timedOut || this.aborted
  }

  kill(): void {
    if (this.closed) {
      return
    }
    this.killedByUser = true
    const bridge = shellBridge()
    if (bridge !== null && this.id !== '') {
      bridge.kill(this.id)
    }
    // 原生侧会立刻把 running 置 false；下一次 refresh 结算。这里不直接 close，
    // 是为了让 kill 之前已经写进缓冲的输出仍能读到最后一次。
  }

  wait(timeoutMs: number, abortSignal: { aborted: boolean } | null): Promise<ShellOutcome> {
    if (this.settled !== null) {
      return Promise.resolve(this.settled)
    }
    this.refresh()
    if (this.closed) {
      return Promise.resolve(this.settled as ShellOutcome)
    }
    return new Promise<ShellOutcome>((resolve) => {
      this.waiters.push(resolve)
      if (timeoutMs > 0) {
        this.holdTimer = setTimeout(() => {
          this.timedOut = true
          this.kill()
        }, timeoutMs)
      }
      if (abortSignal !== null) {
        this.abortTimer = setInterval(() => {
          if (abortSignal.aborted) {
            this.aborted = true
            this.kill()
          }
        }, 200)
      }
    })
  }

  private buildOutcome(): ShellOutcome {
    const outcome = new ShellOutcome()
    outcome.started = true
    outcome.exitCode = this.exitCode
    outcome.signal = this.aborted ? 'aborted' : this.timedOut ? 'timeout' : ''
    outcome.timedOut = this.timedOut
    outcome.killed = this.wasKilled
    outcome.output = this.out
    outcome.droppedChars = this.dropped
    outcome.durationMs = Date.now() - this.startTime
    return outcome
  }
}

/** 浏览器 / 桌面预览路径：原来的内置 JS Shell，行为保持不变 */
class JsShellTask {
  pid: number = -1
  alive: boolean = false
  readonly command: string
  readonly cwd: string
  readonly startedAt: number = Date.now()

  private out: string = ''
  private err: string = ''
  private limitPerStream: number = 256 * 1024
  private closed: boolean = false
  private exitCode: number = -1
  private killedByUser: boolean = false
  private startTime: number = Date.now()
  private settled: ShellOutcome | null = null

  constructor(command: string, cwd: string) {
    this.command = command
    this.cwd = cwd
  }

  start(env: Record<string, string>, limitPerStream: number): ShellOutcome | null {
    this.limitPerStream = Math.max(4096, limitPerStream)
    this.startTime = Date.now()
    try {
      const result = runShell(this.command, this.cwd, env)
      this.out = result.stdout
      this.err = result.stderr
      this.exitCode = result.code
      this.alive = false
      this.closed = true
      this.pid = 1
      this.settle()
    } catch (e) {
      const failed = new ShellOutcome()
      failed.error = e instanceof Error ? e.message : String(e)
      this.closed = true
      this.alive = false
      this.settled = failed
      return failed
    }
    return null
  }

  snapshot(from: number): string {
    const all = this.merged()
    return from >= all.length ? '' : all.slice(from)
  }

  get outputLength(): number {
    return this.merged().length
  }

  get exited(): boolean {
    return this.closed
  }

  get exitCodeValue(): number {
    return this.exitCode
  }

  get wasKilled(): boolean {
    return this.killedByUser
  }

  kill(): void {
    this.killedByUser = true
  }

  wait(_timeoutMs: number, abortSignal: { aborted: boolean } | null): Promise<ShellOutcome> {
    if (abortSignal !== null && abortSignal.aborted) {
      this.killedByUser = true
    }
    if (this.settled === null) {
      this.settle()
    }
    return Promise.resolve(this.settled as ShellOutcome)
  }

  private settle(): void {
    const outcome = new ShellOutcome()
    outcome.started = true
    outcome.exitCode = this.exitCode
    outcome.signal = this.killedByUser ? 'killed' : ''
    outcome.killed = this.killedByUser
    outcome.output = this.merged()
    outcome.durationMs = Date.now() - this.startTime
    this.settled = outcome
  }

  private merged(): string {
    if (this.err === '') {
      return this.out
    }
    if (this.out === '') {
      return this.err
    }
    return this.out + (this.out.endsWith('\n') ? '' : '\n') + this.err
  }
}

/**
 * 门面：CommandService 只认这个类型。真机走原生，浏览器预览走 JS。
 * 注意 start() 是同步的：镜像写入和拉起进程都在这一帧完成，wait() 再异步等退出。
 */
export class ShellTask {
  readonly command: string
  readonly cwd: string
  readonly startedAt: number = Date.now()

  private inner: NativeShellTask | JsShellTask | null = null

  constructor(command: string, cwd: string) {
    this.command = command
    this.cwd = cwd
  }

  start(env: Record<string, string>, limitPerStream: number): ShellOutcome | null {
    if (shellBridge() !== null) {
      const task = new NativeShellTask(this.command, this.cwd)
      this.inner = task
      return task.start(env, limitPerStream)
    }
    const task = new JsShellTask(this.command, this.cwd)
    this.inner = task
    return task.start(env, limitPerStream)
  }

  get pid(): number {
    return this.inner === null ? -1 : this.inner.pid
  }

  get alive(): boolean {
    return this.inner !== null && this.inner.alive
  }

  snapshot(from: number): string {
    return this.inner === null ? '' : this.inner.snapshot(from)
  }

  get outputLength(): number {
    return this.inner === null ? 0 : this.inner.outputLength
  }

  get exited(): boolean {
    return this.inner === null || this.inner.exited
  }

  get exitCodeValue(): number {
    return this.inner === null ? -1 : this.inner.exitCodeValue
  }

  get wasKilled(): boolean {
    return this.inner !== null && this.inner.wasKilled
  }

  kill(): void {
    if (this.inner !== null) {
      this.inner.kill()
    }
  }

  wait(timeoutMs: number, abortSignal: { aborted: boolean } | null): Promise<ShellOutcome> {
    if (this.inner === null) {
      const failed = new ShellOutcome()
      failed.error = '命令尚未启动'
      return Promise.resolve(failed)
    }
    return this.inner.wait(timeoutMs, abortSignal)
  }
}

export function killProcessTree(_pid: number): void {
  // 真机上由 ShellManager 递归杀 /proc 里的子孙进程
}
