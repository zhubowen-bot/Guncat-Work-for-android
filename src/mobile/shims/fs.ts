// Android/Web 端的 node:fs 替身：memfs（纯内存 POSIX 文件系统）+ IndexedDB 持久化。
//
// 为什么必须是同步 FS：端口代码（StorageManager / CoreFileKit / WorkFileService）
// 全部按 Node 的同步语义写，浏览器里没有同步文件系统的原生能力；memfs 提供完整的
// openSync/readSync/writeSync/statSync/readdirSync… 语义，因此 core 一行都不用改。
//
// 持久化策略：不是每次写都把整个卷快照一遍（流式回答时对话 JSON 每几百毫秒就落一次盘，
// 全量快照会把主线程拖垮），而是只标记真正变动的路径，400ms 防抖后逐文件写进 IndexedDB。
// 应用切到后台/页面卸载时再做一次全量快照兜底。
import { Volume, createFsFromVolume } from 'memfs'
import type * as NodeFs from 'node:fs'
import { notifyFsDelete } from './fsEvents'

const volume = new Volume()
const baseFs = createFsFromVolume(volume) as unknown as typeof NodeFs

const DB_NAME = 'guncat-android-fs'
const DB_VERSION = 1
const STORE = 'files'

interface FileRecord {
  path: string
  kind: 'file' | 'dir'
  data?: Uint8Array
  mtimeMs: number
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise !== null) {
    return dbPromise
  }
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'path' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 打开失败'))
  })
  return dbPromise
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 事务失败'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务中止'))
  })
}

/** 从 IndexedDB 把上次的卷读回内存。必须在任何 core 代码碰文件之前 await 一次。 */
export async function hydrateFs(): Promise<void> {
  try {
    const db = await openDb()
    const tx = db.transaction(STORE, 'readonly')
    const store = tx.objectStore(STORE)
    const records: FileRecord[] = await new Promise<FileRecord[]>((resolve, reject) => {
      const request = store.getAll()
      request.onsuccess = () => resolve(request.result as FileRecord[])
      request.onerror = () => reject(request.error)
    })
    await txDone(tx)
    for (const record of records) {
      try {
        if (record.kind === 'dir') {
          volume.mkdirSync(record.path, { recursive: true })
        } else if (record.data !== undefined) {
          const parent = record.path.slice(0, record.path.lastIndexOf('/'))
          if (parent !== '') {
            volume.mkdirSync(parent, { recursive: true })
          }
          volume.writeFileSync(record.path, Buffer.from(record.data))
        }
      } catch {
        // 单条记录坏了不阻塞启动
      }
    }
  } catch (e) {
    console.warn('[fs] IndexedDB 恢复失败，以空文件系统启动', e)
  }
}

function isDirectory(path: string): boolean {
  try {
    return baseFs.statSync(path).isDirectory()
  } catch {
    return false
  }
}

function collectSubtree(path: string): string[] {
  const out: string[] = []
  const walk = (current: string): void => {
    out.push(current)
    if (!isDirectory(current)) {
      return
    }
    try {
      for (const name of baseFs.readdirSync(current)) {
        walk(current.endsWith('/') ? current + name : current + '/' + name)
      }
    } catch {
      // 读不到就算了
    }
  }
  walk(path)
  return out
}

const pending = new Set<string>()
let flushTimer: ReturnType<typeof setTimeout> | null = null
let flushing: Promise<void> = Promise.resolve()

function mark(path: string): void {
  if (path === '' || path === '/') {
    return
  }
  pending.add(path)
  if (flushTimer === null) {
    flushTimer = setTimeout(() => {
      flushTimer = null
      const paths = Array.from(pending)
      pending.clear()
      flushing = flushing.then(() => persistPaths(paths)).catch((e) => {
        console.warn('[fs] 持久化失败', e)
      })
    }, 400)
  }
}

async function persistPaths(paths: string[]): Promise<void> {
  if (paths.length === 0) {
    return
  }
  const db = await openDb()
  const tx = db.transaction(STORE, 'readwrite')
  const store = tx.objectStore(STORE)
  const seen = new Set<string>()
  for (const path of paths) {
    for (const item of collectSubtree(path)) {
      if (seen.has(item)) {
        continue
      }
      seen.add(item)
      if (isDirectory(item)) {
        store.put({ path: item, kind: 'dir', mtimeMs: Date.now() } satisfies FileRecord)
        continue
      }
      try {
        const stat = baseFs.statSync(item)
        const data = baseFs.readFileSync(item)
        store.put({
          path: item,
          kind: 'file',
          data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
          mtimeMs: stat.mtimeMs
        } satisfies FileRecord)
      } catch {
        store.delete(item)
      }
    }
  }
  // 删除：一个路径不存在时，把它的整棵子树从 IndexedDB 里清掉
  for (const path of paths) {
    if (baseFs.existsSync(path)) {
      continue
    }
    const prefix = path.endsWith('/') ? path : path + '/'
    const range = IDBKeyRange.bound(path, prefix + '\uffff')
    const cursorRequest = store.openCursor(range)
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result
      if (cursor !== null) {
        cursor.delete()
        cursor.continue()
      }
    }
  }
  await txDone(tx)
}

const fds = new Map<number, string>()

function pathOfFd(fd: number): string {
  return fds.get(fd) ?? ''
}

function pathArg(target: unknown): string {
  if (typeof target === 'number') {
    return pathOfFd(target)
  }
  return typeof target === 'string' ? target : ''
}

function wrapMethod(name: string, fn: (...args: never[]) => unknown): (...args: never[]) => unknown {
  return (...args: never[]): unknown => {
    const result = fn(...args)
    if (name === 'openSync' || name === 'open') {
      const fd = result as unknown as number
      if (typeof fd === 'number' && typeof args[0] === 'string') {
        fds.set(fd, args[0])
      }
    }
    if (name === 'closeSync' || name === 'close') {
      fds.delete(args[0] as unknown as number)
    }
    if (name === 'writeSync') {
      mark(pathOfFd(args[0] as unknown as number))
    } else if (name === 'createWriteStream') {
      mark(pathArg(args[0]))
    } else {
      mark(pathArg(args[0]))
      if (name === 'renameSync' || name === 'rename' || name === 'copyFileSync' || name === 'copyFile') {
        mark(pathArg(args[1]))
      }
    }
    // 删除类操作触发镜像通知（设备上的副本必须跟着消失，否则就是幻影）
    if (name === 'rmSync' || name === 'rmdirSync' || name === 'unlinkSync') {
      notifyFsDelete(pathArg(args[0]))
    }
    return result
  }
}

const MUTATING = new Set([
  'writeFileSync',
  'appendFileSync',
  'mkdirSync',
  'rmSync',
  'rmdirSync',
  'unlinkSync',
  'renameSync',
  'copyFileSync',
  'truncateSync',
  'writeSync',
  'createWriteStream',
  'writeFile',
  'appendFile',
  'mkdir',
  'rm',
  'rmdir',
  'unlink',
  'rename',
  'copyFile',
  'truncate',
  'open',
  'openSync',
  'close',
  'closeSync'
])

export const fs = new Proxy(baseFs, {
  get(target, prop, receiver) {
    const value = Reflect.get(target, prop, receiver)
    if (typeof value === 'function' && typeof prop === 'string' && MUTATING.has(prop)) {
      return wrapMethod(prop, value.bind(target) as (...args: never[]) => unknown)
    }
    return value
  }
}) as typeof NodeFs

/** 直接写卷、不触发持久化：随包资源（只读、每次启动重建）走这条。 */
export function writeResource(path: string, data: string | Uint8Array): void {
  const parent = path.slice(0, path.lastIndexOf('/'))
  if (parent !== '') {
    baseFs.mkdirSync(parent, { recursive: true })
  }
  baseFs.writeFileSync(path, data)
}

export function mkdirResource(path: string): void {
  baseFs.mkdirSync(path, { recursive: true })
}

/** 全量快照（页面卸载 / 切后台时兜底）。 */
export async function flushAll(): Promise<void> {
  await flushing
  const paths: string[] = []
  const walk = (dir: string): void => {
    paths.push(dir)
    try {
      for (const name of baseFs.readdirSync(dir)) {
        const full = dir.endsWith('/') ? dir + name : dir + '/' + name
        if (isDirectory(full)) {
          walk(full)
        } else {
          paths.push(full)
        }
      }
    } catch {
      // 忽略
    }
  }
  walk('/')
  await persistPaths(paths)
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    void flushAll()
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      void flushAll()
    }
  })
}

export default fs
