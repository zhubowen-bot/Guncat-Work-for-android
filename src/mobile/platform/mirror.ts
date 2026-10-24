// 工作区镜像：真实命令不认 memfs，所以执行前把会话工作区写进应用私有目录，
// 执行后再把命令行改过的文件读回 memfs。没有这层，`ls` / `grep` 看到的是空目录，
// 「真 Shell」就只是个假装能用的壳。
//
// 边界（与 docs/ANDROID.md 一致）：
//   · 只镜像 /guncat/data/files/workspaces/<会话>，不同步设置、会话历史与 API Key；
//   · 单文件 8MB、单次同步 32MB 封顶，超出的文件留在设备上并在结果里明确说明；
//   · memfs 仍是一等公民：文件工具的写入一定会在下一次命令前落盘，命令行的改动会在
//     命令结束后读回；后台任务与文件工具同时改同一个文件时按「后写覆盖」处理。
import fs from 'node:fs'
import path from 'node:path'
import { bytesToBase64, base64ToBytes } from '../native/bridge'
import { parseJson, shellBridge } from '../native/shellBridge'

export const WORKSPACES_ROOT = '/guncat/data/files/workspaces'
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_TOTAL_BYTES = 32 * 1024 * 1024
const MAX_ENTRIES = 20_000

interface LocalEntry {
  vpath: string
  dir: boolean
  size: number
  mtimeMs: number
}

interface RemoteEntry {
  vpath: string
  dir: boolean
  size: number
  mtimeMs: number
}

interface MirrorState {
  /** 本地（memfs）最后同步时的签名，签名 = mtime:size */
  localSigs: Map<string, string>
  /** 设备上最后同步时的签名，签名 = mtime:size */
  remoteSigs: Map<string, string>
  /** 已经确保存在的设备目录 */
  dirs: Set<string>
  /** 超过大小上限、本次没有镜像的文件（每个文件只提示一次） */
  skipped: Set<string>
}

const states = new Map<string, MirrorState>()

function stateOf(root: string): MirrorState {
  let state = states.get(root)
  if (state === undefined) {
    state = { localSigs: new Map(), remoteSigs: new Map(), dirs: new Set(), skipped: new Set() }
    states.set(root, state)
  }
  return state
}

/**
 * 从 cwd 推会话工作区根：任意前缀下的 /workspaces/<conv>/... → 该会话根。
 *
 * 注意：filesDir 在 Android 上是 /guncat/data/files，所以真实工作区是
 * /guncat/data/files/workspaces/<conv>。旧实现写死了 /guncat/data/workspaces，
 * 结果镜像目录和文件工具的工作区是两个不同目录，终端里看不到工作区文件。
 */
export function mirrorRootFor(cwd: string): string {
  const marker = '/workspaces/'
  const at = cwd.indexOf(marker)
  if (at >= 0) {
    const rest = cwd.slice(at + marker.length)
    const conv = rest.split('/')[0]
    if (conv !== '') {
      return cwd.slice(0, at + marker.length + conv.length)
    }
  }
  return WORKSPACES_ROOT
}

function sigOf(size: number, mtimeMs: number): string {
  return `${Math.round(mtimeMs)}:${size}`
}

function listLocal(root: string): { files: LocalEntry[]; dirs: string[]; truncated: boolean } {
  const files: LocalEntry[] = []
  const dirs: string[] = []
  let truncated = false
  const walk = (dir: string): void => {
    if (truncated) {
      return
    }
    dirs.push(dir)
    let names: string[]
    try {
      names = fs.readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      const full = path.posix.join(dir, name)
      let stat: fs.Stats
      try {
        stat = fs.statSync(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        walk(full)
        continue
      }
      if (!stat.isFile()) {
        continue
      }
      if (files.length >= MAX_ENTRIES) {
        truncated = true
        return
      }
      files.push({ vpath: full, dir: false, size: stat.size, mtimeMs: stat.mtimeMs })
    }
  }
  try {
    walk(root)
  } catch {
    // 根不存在（工作区还没建）时当作空目录
  }
  return { files, dirs, truncated }
}

function listRemote(root: string): { files: RemoteEntry[]; dirs: string[]; truncated: boolean; error: string } {
  const bridge = shellBridge()
  if (bridge === null) {
    return { files: [], dirs: [], truncated: false, error: '没有原生桥' }
  }
  const parsed = parseJson(bridge.fsList(root))
  if (parsed.ok !== true) {
    return {
      files: [],
      dirs: [],
      truncated: false,
      error: typeof parsed.error === 'string' ? parsed.error : '列目录失败'
    }
  }
  const entries = Array.isArray(parsed.entries) ? (parsed.entries as unknown[]) : []
  const files: RemoteEntry[] = []
  const dirs: string[] = []
  for (const raw of entries) {
    if (!Array.isArray(raw) || raw.length < 4) {
      continue
    }
    const rel = String(raw[0] ?? '')
    const kind = String(raw[1] ?? '')
    const size = Number(raw[2] ?? 0)
    const mtime = Number(raw[3] ?? 0)
    if (rel === '') {
      continue
    }
    const vpath = path.posix.join(root, rel)
    if (kind === 'd') {
      dirs.push(vpath)
    } else if (kind === 'f') {
      files.push({ vpath, dir: false, size, mtimeMs: mtime })
    }
  }
  return { files, dirs, truncated: parsed.truncated === true, error: '' }
}

export class WorkspaceMirror {
  readonly root: string
  private readonly state: MirrorState
  /** 本轮的提示（超限、写失败等），由 ShellTask 拼进 stderr 给模型看 */
  warnings: string[] = []

  constructor(root: string) {
    this.root = root
    this.state = stateOf(root)
  }

  private warn(message: string): void {
    if (!this.warnings.includes(message)) {
      this.warnings.push(message)
    }
  }

  /** memfs → 设备。返回失败提示（已写进 warnings）。 */
  syncDown(): void {
    const bridge = shellBridge()
    if (bridge === null) {
      return
    }
    this.warnings = []
    const local = listLocal(this.root)
    if (local.truncated) {
      this.warn(`工作区文件超过 ${MAX_ENTRIES} 个，只镜像了前 ${MAX_ENTRIES} 个`)
    }

    const mkdir = (vpath: string): void => {
      if (this.state.dirs.has(vpath)) {
        return
      }
      const result = parseJson(bridge.fsMkdir(vpath))
      if (result.ok === true) {
        this.state.dirs.add(vpath)
      } else {
        this.warn(`创建目录失败: ${vpath}`)
      }
    }

    mkdir(this.root)
    for (const dir of local.dirs) {
      mkdir(dir)
    }

    let total = 0
    for (const entry of local.files) {
      const sig = sigOf(entry.size, entry.mtimeMs)
      if (this.state.localSigs.get(entry.vpath) === sig && this.state.remoteSigs.has(entry.vpath)) {
        continue
      }
      if (entry.size > MAX_FILE_BYTES) {
        if (!this.state.skipped.has(entry.vpath)) {
          this.state.skipped.add(entry.vpath)
          this.warn(`文件 ${entry.vpath} 有 ${(entry.size / 1024 / 1024).toFixed(1)}MB，超过镜像上限，未同步到设备`)
        }
        continue
      }
      if (total + entry.size > MAX_TOTAL_BYTES) {
        this.warn('本次要同步的文件超过 32MB，剩余文件没有写进设备（命令可能看不到它们）')
        break
      }
      let bytes: Uint8Array
      try {
        bytes = new Uint8Array(fs.readFileSync(entry.vpath))
      } catch {
        this.warn(`读取工作区文件失败: ${entry.vpath}`)
        continue
      }
      const result = parseJson(bridge.fsWrite(entry.vpath, bytesToBase64(bytes)))
      if (result.ok !== true) {
        this.warn(
          `写入设备失败: ${entry.vpath}` +
            (typeof result.error === 'string' ? `（${result.error}）` : '')
        )
        continue
      }
      total += entry.size
      this.state.localSigs.set(entry.vpath, sig)
      this.state.remoteSigs.set(
        entry.vpath,
        sigOf(Number(result.size ?? entry.size), Number(result.mtime ?? entry.mtimeMs))
      )
    }

    // memfs 里删掉的文件，设备上也要删：ls 才不会看见幽灵文件
    const localPaths = new Set(local.files.map((entry) => entry.vpath))
    for (const vpath of Array.from(this.state.remoteSigs.keys())) {
      if (localPaths.has(vpath) || !vpath.startsWith(this.root + '/')) {
        continue
      }
      parseJson(bridge.fsDelete(vpath))
      this.state.remoteSigs.delete(vpath)
      this.state.localSigs.delete(vpath)
    }
  }

  /** 设备 → memfs。命令新建/修改/删除的文件在这里回到工作区。 */
  syncUp(): void {
    const bridge = shellBridge()
    if (bridge === null) {
      return
    }
    const remote = listRemote(this.root)
    if (remote.error !== '') {
      this.warn(`读取设备工作区失败: ${remote.error}`)
      return
    }
    if (remote.truncated) {
      this.warn(`设备上的文件超过 ${MAX_ENTRIES} 个，只读回了前 ${MAX_ENTRIES} 个`)
    }
    for (const dir of remote.dirs) {
      try {
        fs.mkdirSync(dir, { recursive: true })
      } catch {
        // 目录已存在或无权限，后面写文件时会报
      }
    }

    const remotePaths = new Set(remote.files.map((entry) => entry.vpath))
    let total = 0
    for (const entry of remote.files) {
      const sig = sigOf(entry.size, entry.mtimeMs)
      const known = this.state.remoteSigs.get(entry.vpath)
      if (known === sig && fs.existsSync(entry.vpath)) {
        continue
      }
      if (entry.size > MAX_FILE_BYTES) {
        if (!this.state.skipped.has(entry.vpath)) {
          this.state.skipped.add(entry.vpath)
          this.warn(`命令生成了 ${entry.vpath}（${(entry.size / 1024 / 1024).toFixed(1)}MB），超过镜像上限，没有读回工作区`)
        }
        this.state.remoteSigs.set(entry.vpath, sig)
        continue
      }
      if (total + entry.size > MAX_TOTAL_BYTES) {
        this.warn('本次设备上的新文件超过 32MB，剩余文件没有读回工作区')
        break
      }
      const parsed = parseJson(bridge.fsRead(entry.vpath))
      if (parsed.ok !== true) {
        this.warn(
          `读取设备文件失败: ${entry.vpath}` +
            (typeof parsed.error === 'string' ? `（${parsed.error}）` : '')
        )
        continue
      }
      try {
        const bytes = base64ToBytes(String(parsed.data ?? ''))
        fs.mkdirSync(path.posix.dirname(entry.vpath), { recursive: true })
        fs.writeFileSync(entry.vpath, bytes)
        total += entry.size
        const stat = fs.statSync(entry.vpath)
        this.state.localSigs.set(entry.vpath, sigOf(stat.size, stat.mtimeMs))
        this.state.remoteSigs.set(entry.vpath, sig)
      } catch (e) {
        this.warn(`写回工作区失败: ${entry.vpath}（${e instanceof Error ? e.message : String(e)}）`)
      }
    }

    // 命令删掉的文件，工作区里也要消失
    for (const vpath of Array.from(this.state.remoteSigs.keys())) {
      if (remotePaths.has(vpath) || !vpath.startsWith(this.root + '/')) {
        continue
      }
      try {
        if (fs.existsSync(vpath) && fs.statSync(vpath).isFile()) {
          fs.rmSync(vpath, { force: true })
        }
      } catch {
        // 忽略：最多留一个幽灵文件，下次同步会再试
      }
      this.state.remoteSigs.delete(vpath)
      this.state.localSigs.delete(vpath)
    }
  }
}

/** 把设备上的真实路径换回 /guncat/data，避免模型看见 /data/user/0/... 这种噪声 */
export function translateNativePaths(text: string, nativeRoot: string): string {
  if (nativeRoot === '' || text === '' || !text.includes(nativeRoot)) {
    return text
  }
  return text.split(nativeRoot).join('/guncat/data')
}
