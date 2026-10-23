// 「当前进程是否提权运行」的探测 —— 启动诊断里的一个观测项。
//
// 为什么不能靠 USERNAME / USERDOMAIN 判断：
//   在 UAC 下，管理员账号平时也是以**非提权令牌**运行的，用户名、域、%USERNAME% 与提权后
//   完全相同。身份信息说明不了权限。真正能区分的只有一件事：这个进程能不能做成
//   「只有提权进程才能做成」的操作。
//
// 探测方式：往 C:\Windows\System32 写一个临时文件，**立刻删掉**。
//   · 普通用户写不进去；「管理员但未提权」同样写不进去（System32 对二者都只读）；
//   · 提权进程能写。这正是我们要区分的两种状态。
// 不选 PowerShell 的 IsInRole：每次启动要多起一个子进程（几百毫秒，还可能被组策略或
// 杀软拦掉），而可靠性并不更高。
//
// 铁律（这条踩过坑）：探测过程**任何失败都只意味着「没提权」**，绝不允许抛异常，
// 也绝不允许留下垃圾文件 —— 一段诊断代码把应用搞崩是最得不偿失的事。
import fs from 'node:fs'
import path from 'node:path'

/** 只有提权进程可写的目录：这个选择本身就是探测的关键 */
export const ADMIN_PROBE_DIR = 'C:\\Windows\\System32'
const PROBE_PREFIX = 'guncat-elevation-probe'

/** 探测用到的文件操作。抽成接口是为了能在无头验证里注入成功/失败的假实现 */
export interface ProbeIo {
  writeFileSync(file: string, data: string): unknown
  rmSync(file: string, options: { force: boolean }): unknown
}

export interface ProbeOptions {
  dir?: string
  pid?: number
  nonce?: string
}

/** 探测文件名：带上 pid 与随机段，避免两个实例互相踩 */
export function adminProbePath(dir: string, pid: number, nonce: string): string {
  return path.join(dir, `${PROBE_PREFIX}-${pid}-${nonce}.tmp`)
}

/**
 * 探测是否提权。纯函数式的判定核心：所有 IO 由调用方注入，
 * 因此「写得进去 / 写不进去 / 删不掉」三种情况都能在无头验证里被覆盖。
 *
 * 语义很明确：写不进去 → false；写得进去 → true（删除失败也算 true，
 * 因为能不能删掉不改变令牌的权限等级；删除失败只是留下一个几十字节的文件）。
 */
export function probeElevated(io: ProbeIo, options: ProbeOptions = {}): boolean {
  const dir: string = options.dir ?? ADMIN_PROBE_DIR
  const file: string = adminProbePath(
    dir,
    options.pid ?? process.pid,
    options.nonce ?? String(Date.now())
  )
  try {
    io.writeFileSync(file, 'guncat elevation probe')
  } catch {
    // 写不进去 == 没提权（这是最常见的结果，不是错误）
    return false
  }
  try {
    io.rmSync(file, { force: true })
  } catch {
    // 删不掉也静默：下次启动会覆盖同名文件，且它不改变判定结果
  }
  return true
}

/**
 * 当前进程是否提权。
 *
 * GUNCAT_FORCE_ELEVATED=1/0 只用于**无头验证与现场诊断**：
 * 验证要求结果可复现，不能取决于跑测试的终端是不是管理员。
 */
export function isElevated(): boolean {
  const forced: string | undefined = process.env.GUNCAT_FORCE_ELEVATED
  if (forced === '1') {
    return true
  }
  if (forced === '0') {
    return false
  }
  return probeElevated(
    {
      writeFileSync: (file: string, data: string) => fs.writeFileSync(file, data),
      rmSync: (file: string, options: { force: boolean }) => fs.rmSync(file, options)
    },
    {}
  )
}

/** 用户身份（只用于日志，不用于判断权限） */
export function describeUser(env: NodeJS.ProcessEnv = process.env): string {
  const domain: string = env.USERDOMAIN ?? ''
  const name: string = env.USERNAME ?? env.USER ?? ''
  if (name === '') {
    return '(未知用户)'
  }
  return domain !== '' ? `${domain}\\${name}` : name
}

/** 进程位数的可读描述 */
export function describeBitness(arch: string = process.arch): string {
  if (arch === 'x64' || arch === 'arm64') {
    return `${arch}（64 位）`
  }
  if (arch === 'ia32' || arch === 'arm') {
    return `${arch}（32 位）`
  }
  return arch
}
