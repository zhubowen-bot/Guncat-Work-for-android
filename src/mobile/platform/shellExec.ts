// Android 端命令执行适配层：接口与 desktop 的 shellExec.ts 完全一致，
// 但底下不是 child_process，而是 mobile/platform/shell.ts 的内置 POSIX 子集。
//
// CommandService（安全判定、审批、后台任务）因此可以原样复用；只有「怎么跑」换了。
import { runShell } from './shell'

const ENV_ALLOWLIST: string[] = ['HOME', 'PWD', 'LANG', 'TMPDIR']
const ENV_FORCED: Record<string, string> = {
  TERM: 'dumb',
  NO_COLOR: '1',
  FORCE_COLOR: '0'
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

export class ShellTask {
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
  private waiters: Array<(o: ShellOutcome) => void> = []

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
      this.settled = this.buildOutcome()
      const waiters = this.waiters.splice(0)
      for (const resolve of waiters) {
        resolve(this.settled)
      }
    }
    return Promise.resolve(this.settled)
  }

  private buildOutcome(): ShellOutcome {
    const outcome = new ShellOutcome()
    outcome.started = true
    outcome.exitCode = this.exitCode
    outcome.signal = this.killedByUser ? 'killed' : ''
    outcome.killed = this.killedByUser
    outcome.output = this.merged()
    outcome.durationMs = Date.now() - this.startTime
    return outcome
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

export function killProcessTree(_pid: number): void {
  // 内置 Shell 没有真实进程可杀
}
