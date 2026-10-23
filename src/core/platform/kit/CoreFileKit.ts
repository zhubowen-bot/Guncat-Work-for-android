// 平台适配层：鸿蒙 `@kit.CoreFileKit` 的等价实现（Node 侧）
//
// 端口代码对 fileIo 的用法收敛为三种打开模式 + 一组同步操作：
//   READ_ONLY / READ_WRITE|CREATE|TRUNC / READ_WRITE|CREATE|APPEND
// 这三种组合与 POSIX 常量一一对应，鸿蒙 OpenMode 的取值也照搬 POSIX，
// 因此直接用数值标志透传给 fs.openSync 即可，避免字符串标志的语义错配。
//
// picker 需要 Electron 的 dialog，这里只声明接口并由宿主注入实现
// （见 platform/host.ts 的 registerPickerHost），端口代码无需改动。
import fs from 'node:fs'
import path from 'node:path'
import type { FileHandle } from 'node:fs/promises'

export namespace fileIo {
  /** 对齐 @ohos.file.fs.OpenMode（取值与 POSIX 一致） */
  export enum OpenMode {
    READ_ONLY = 0o0,
    WRITE_ONLY = 0o1,
    READ_WRITE = 0o2,
    CREATE = 0o100,
    TRUNC = 0o1000,
    APPEND = 0o2000,
    NONBLOCK = 0o4000,
    DIR = 0o200000,
    NOFOLLOW = 0o400000,
    SYNC = 0o4010000
  }

  /** 对齐 @ohos.file.fs.File */
  export class File {
    fd: number
    path: string
    name: string

    constructor(fd: number, filePath: string) {
      this.fd = fd
      this.path = filePath
      this.name = path.basename(filePath)
    }
  }

  /** 对齐 @ohos.file.fs.Stat */
  export class Stat {
    size: number = 0
    mode: number = 0
    mtime: number = 0
    atime: number = 0
    ctime: number = 0
    private dir: boolean = false
    private file: boolean = false

    static from(s: fs.Stats): Stat {
      const out: Stat = new Stat()
      out.size = s.size
      out.mode = s.mode
      out.mtime = Math.floor(s.mtimeMs / 1000)
      out.atime = Math.floor(s.atimeMs / 1000)
      out.ctime = Math.floor(s.ctimeMs / 1000)
      out.dir = s.isDirectory()
      out.file = s.isFile()
      return out
    }

    isDirectory(): boolean {
      return this.dir
    }

    isFile(): boolean {
      return this.file
    }
  }

  export interface ReadOptions {
    /** 文件起始偏移（字节） */
    offset?: number
    /** 读取长度（字节），缺省为缓冲区长度 */
    length?: number
  }

  export interface WriteOptions {
    offset?: number
    length?: number
  }

  function fdOf(target: File | number): number {
    return typeof target === 'number' ? target : target.fd
  }

  function asUint8(input: ArrayBuffer | Uint8Array | DataView): Uint8Array {
    if (input instanceof Uint8Array) {
      return input
    }
    if (input instanceof DataView) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
    }
    return new Uint8Array(input as ArrayBuffer)
  }

  export function openSync(filePath: string, mode: number = OpenMode.READ_ONLY): File {
    const fd: number = fs.openSync(filePath, toNodeFlags(filePath, mode), 0o666)
    return new File(fd, filePath)
  }

  /**
   * 把鸿蒙 OpenMode 位组合翻译成 Node 的字符串标志。
   *
   * 为什么不能像最初设想那样直接把数值透传给 fs.openSync：
   * Windows 上 Node 会把数值标志交给 CRT 的 `_open`，而 CRT 的 `_O_CREAT`/`_O_TRUNC`
   * 取值与 POSIX 的 `O_CREAT`/`O_TRUNC` **并不相同**（0x0100 vs 0o100），
   * 于是同一组位在 Windows 上会解析成完全不同的语义并直接 `EINVAL`。
   * 字符串标志由 Node 自己跨平台归一，因此这里统一做一次翻译。
   */
  function toNodeFlags(filePath: string, mode: number): string {
    const access: number = mode & 0o3
    const readWrite: boolean = access === OpenMode.READ_WRITE
    const writeOnly: boolean = access === OpenMode.WRITE_ONLY
    const create: boolean = (mode & OpenMode.CREATE) !== 0
    const trunc: boolean = (mode & OpenMode.TRUNC) !== 0
    const append: boolean = (mode & OpenMode.APPEND) !== 0

    if (append) {
      return readWrite ? 'a+' : 'a'
    }
    if (readWrite) {
      if (trunc) {
        return 'w+'
      }
      if (create) {
        // 「存在则不截断、不存在则新建」没有对应的字符串标志，只能先探测
        return fs.existsSync(filePath) ? 'r+' : 'w+'
      }
      return 'r+'
    }
    if (writeOnly) {
      return 'w'
    }
    return 'r'
  }

  export function readSync(
    target: File | number,
    buffer: ArrayBuffer | Uint8Array,
    options?: ReadOptions
  ): number {
    const u8: Uint8Array = asUint8(buffer)
    const length: number = options?.length ?? u8.byteLength
    const position: number = options?.offset ?? 0
    if (length === 0) {
      return 0
    }
    return fs.readSync(fdOf(target), u8, 0, length, position)
  }

  export function writeSync(
    target: File | number,
    buffer: ArrayBuffer | Uint8Array | string,
    options?: WriteOptions
  ): number {
    const fd: number = fdOf(target)
    if (typeof buffer === 'string') {
      return fs.writeSync(fd, buffer)
    }
    const u8: Uint8Array = asUint8(buffer)
    const length: number = options?.length ?? u8.byteLength
    if (length === 0) {
      return 0
    }
    // position=null：沿当前文件位置顺序写入（APPEND 模式下由 O_APPEND 接管）
    return fs.writeSync(fd, u8, 0, length, null)
  }

  export function closeSync(target: File | number): void {
    fs.closeSync(fdOf(target))
  }

  export function statSync(filePath: string): Stat {
    return Stat.from(fs.statSync(filePath))
  }

  /** 鸿蒙语义：返回布尔，不抛异常 */
  export function accessSync(filePath: string): boolean {
    try {
      fs.accessSync(filePath)
      return true
    } catch {
      return false
    }
  }

  export function mkdirSync(dirPath: string, recursive: boolean = false): void {
    fs.mkdirSync(dirPath, { recursive })
  }

  export function unlinkSync(filePath: string): void {
    fs.unlinkSync(filePath)
  }

  export function rmdirSync(dirPath: string): void {
    fs.rmdirSync(dirPath)
  }

  export function renameSync(oldPath: string, newPath: string): void {
    fs.renameSync(oldPath, newPath)
  }

  export function moveFileSync(src: string, dest: string): void {
    moveSync(src, dest)
  }

  export function moveDirSync(src: string, dest: string): void {
    moveSync(src, dest)
  }

  function moveSync(src: string, dest: string): void {
    try {
      fs.renameSync(src, dest)
    } catch (e) {
      // Windows 上跨盘 rename 会抛 EXDEV，退化为复制后删除
      const code: string = (e as NodeJS.ErrnoException).code ?? ''
      if (code !== 'EXDEV') {
        throw e
      }
      fs.cpSync(src, dest, { recursive: true })
      fs.rmSync(src, { recursive: true, force: true })
    }
  }

  /** 对齐鸿蒙：返回目录下的**文件名**列表（不含父路径） */
  export function listFileSync(dirPath: string): string[] {
    return fs.readdirSync(dirPath)
  }

  export function copyFileSync(src: string, dest: string): void {
    fs.copyFileSync(src, dest)
  }

  export function readTextSync(filePath: string): string {
    return fs.readFileSync(filePath, 'utf8')
  }
}

/** 宿主注入的文件选择器实现（Electron dialog） */
export interface PickerHost {
  selectFiles(options: PickerSelectOptions): Promise<string[]>
  saveFile(options: PickerSaveOptions): Promise<string[]>
  /** 只挑图片（PhotoViewPicker 走这条） */
  selectImages(maxCount: number): Promise<string[]>
}

export interface PickerSelectOptions {
  /** 允许的扩展名，如 ['.png', '.jpg']；空数组表示不限 */
  extensions?: string[]
  maxCount?: number
}

export interface PickerSaveOptions {
  suggestedName?: string
  extensions?: string[]
}

let pickerHost: PickerHost | null = null

export function registerPickerHost(host: PickerHost): void {
  pickerHost = host
}

function requireHost(): PickerHost {
  if (pickerHost === null) {
    throw new Error('文件选择器宿主尚未注入（registerPickerHost）')
  }
  return pickerHost
}

export namespace picker {
  export class DocumentSelectOptions {
    maxSelectNumber: number = 1
    fileSuffixFilters: string[] = []
  }

  export class DocumentSaveOptions {
    newFileNames: string[] = []
    fileSuffixChoices: string[] = []
  }

  export class DocumentViewPicker {
    constructor(_context?: unknown) {}

    async select(options?: DocumentSelectOptions): Promise<string[]> {
      return requireHost().selectFiles({
        extensions: options?.fileSuffixFilters ?? [],
        maxCount: options?.maxSelectNumber ?? 1
      })
    }

    async save(options?: DocumentSaveOptions): Promise<string[]> {
      const names: string[] = options?.newFileNames ?? []
      return requireHost().saveFile({
        suggestedName: names.length > 0 ? names[0] : undefined,
        extensions: options?.fileSuffixChoices ?? []
      })
    }
  }

  /** 对齐 @ohos.file.picker.PhotoViewMIMETypes */
  export enum PhotoViewMIMETypes {
    IMAGE_TYPE = 'image/*',
    VIDEO_TYPE = 'video/*',
    IMAGE_VIDEO_TYPE = '*/*'
  }

  /** 对齐 @ohos.file.picker.PhotoSelectOptions */
  export class PhotoSelectOptions {
    MIMEType: PhotoViewMIMETypes = PhotoViewMIMETypes.IMAGE_TYPE
    maxSelectNumber: number = 1
  }

  /** 对齐 @ohos.file.picker.PhotoSelectResult */
  export class PhotoSelectResult {
    photoUris: string[] = []
    isOriginalPhoto: boolean = false
  }

  /** 对齐 @ohos.file.picker.PhotoViewPicker（桌面端落到系统图片选择对话框） */
  export class PhotoViewPicker {
    constructor(_context?: unknown) {}

    async select(options?: PhotoSelectOptions): Promise<PhotoSelectResult> {
      const uris: string[] = await requireHost().selectImages(options?.maxSelectNumber ?? 1)
      const result: PhotoSelectResult = new PhotoSelectResult()
      result.photoUris = uris
      return result
    }
  }
}

/** 供 Node 侧直接使用的文件句柄类型再导出（少数代码需要） */
export type { FileHandle }
