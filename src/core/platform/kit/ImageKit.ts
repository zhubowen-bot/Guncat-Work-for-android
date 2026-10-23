// 平台适配层：鸿蒙 `@kit.ImageKit` 的等价实现（Node/Electron 侧）
//
// 端口代码用 image 做两件事：
//   1. 读图片元信息（尺寸 / MIME）
//   2. 解码 → 缩放 → 重新编码为 png/jpeg（缩略图、view_image、PDF 页面转图）
// 桌面端直接复用 Electron 内置的 nativeImage：零额外原生依赖，
// 且缩放质量与 Electron 自身一致。
//
// nativeImage 采用**延迟解析**：这样本模块（以及依赖它的 WorkFileService 等）
// 可以在纯 Node 环境下被导入做无头验证，只有真正做像素解码时才需要 Electron。
import fs from 'node:fs'
import { createRequire } from 'node:module'
import type { NativeImage } from 'electron'

const nodeRequire = createRequire(import.meta.url)

let nativeImageApi: { createFromBuffer(buffer: Buffer): NativeImage } | null = null

function nativeImage(): { createFromBuffer(buffer: Buffer): NativeImage } {
  if (nativeImageApi === null) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = nodeRequire('electron') as typeof import('electron')
    nativeImageApi = electron.nativeImage
  }
  return nativeImageApi
}

export namespace image {
  export interface Size {
    width: number
    height: number
  }

  export interface ImageInfo {
    size: Size
    mimeType: string
    density: number
    stride: number
    pixelFormat: number
    alphaType: number
    editable: boolean
    isHdr: boolean
  }

  export interface DecodingOptions {
    desiredSize?: Size
    rotate?: number
    editable?: boolean
    desiredPixelFormat?: number
    desiredDynamicRange?: number
  }

  export interface PackingOption {
    format: string
    quality: number
    bufferSize?: number
  }

  /** 对齐 @ohos.multimedia.image.PixelMap（只保留端口代码用到的方法） */
  export class PixelMap {
    readonly inner: NativeImage

    constructor(inner: NativeImage) {
      this.inner = inner
    }

    async getImageInfo(): Promise<ImageInfo> {
      const size: Size = this.inner.getSize()
      return {
        size,
        mimeType: 'image/png',
        density: 1,
        stride: size.width * 4,
        pixelFormat: 0,
        alphaType: 0,
        editable: false,
        isHdr: false
      }
    }

    async release(): Promise<void> {
      // nativeImage 由 GC 管理，无需显式释放
    }
  }

  function sniffMime(data: Buffer): string {
    if (data.length >= 8 && data.readUInt32BE(0) === 0x89504e47) {
      return 'image/png'
    }
    if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
      return 'image/jpeg'
    }
    if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
      return 'image/webp'
    }
    if (data.length >= 6 && data.toString('ascii', 0, 3) === 'GIF') {
      return 'image/gif'
    }
    if (data.length >= 2 && data[0] === 0x42 && data[1] === 0x4d) {
      return 'image/bmp'
    }
    return 'application/octet-stream'
  }

  function toBuffer(source: Buffer | ArrayBuffer | Uint8Array): Buffer {
    if (Buffer.isBuffer(source)) {
      return source
    }
    if (source instanceof Uint8Array) {
      return Buffer.from(source.buffer, source.byteOffset, source.byteLength)
    }
    return Buffer.from(source as ArrayBuffer)
  }

  /** 对齐 @ohos.multimedia.image.ImageSource */
  export class ImageSource {
    private readonly data: Buffer
    private released: boolean = false

    constructor(data: Buffer | ArrayBuffer | Uint8Array) {
      this.data = toBuffer(data)
    }

    async getImageInfo(): Promise<ImageInfo> {
      const img: NativeImage = nativeImage().createFromBuffer(this.data)
      const size: Size = img.getSize()
      return {
        size,
        mimeType: sniffMime(this.data),
        density: 1,
        stride: size.width * 4,
        pixelFormat: 0,
        alphaType: 0,
        editable: false,
        isHdr: false
      }
    }

    async createPixelMap(options?: DecodingOptions): Promise<PixelMap> {
      let img: NativeImage = nativeImage().createFromBuffer(this.data)
      const desired: Size | undefined = options?.desiredSize
      if (desired !== undefined && desired.width > 0 && desired.height > 0) {
        const current: Size = img.getSize()
        if (current.width !== desired.width || current.height !== desired.height) {
          img = img.resize({
            width: Math.max(1, Math.round(desired.width)),
            height: Math.max(1, Math.round(desired.height)),
            quality: 'good'
          })
        }
      }
      return new PixelMap(img)
    }

    async release(): Promise<void> {
      this.released = true
    }

    isReleased(): boolean {
      return this.released
    }
  }

  /** 对齐 @ohos.multimedia.image.ImagePacker */
  export class ImagePacker {
    private static encode(pixelMap: PixelMap, option: PackingOption): Buffer {
      const format: string = option.format.toLowerCase()
      if (format.includes('jpeg') || format.includes('jpg')) {
        return pixelMap.inner.toJPEG(Math.max(0, Math.min(100, option.quality)))
      }
      return pixelMap.inner.toPNG()
    }

    async packToData(pixelMap: PixelMap, option: PackingOption): Promise<ArrayBuffer> {
      const buf: Buffer = ImagePacker.encode(pixelMap, option)
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
    }

    async packToFile(pixelMap: PixelMap, fd: number, option: PackingOption): Promise<void> {
      const buf: Buffer = ImagePacker.encode(pixelMap, option)
      fs.writeSync(fd, buf, 0, buf.byteLength, null)
    }

    async release(): Promise<void> {
      // 无原生资源需要释放
    }
  }

  export function createImageSource(
    source: Buffer | ArrayBuffer | Uint8Array | string | number
  ): ImageSource {
    if (typeof source === 'string') {
      return new ImageSource(fs.readFileSync(source))
    }
    if (typeof source === 'number') {
      // 对齐鸿蒙：createImageSource 也接受已打开文件的 fd
      const size: number = fs.fstatSync(source).size
      const buf: Buffer = Buffer.alloc(size)
      fs.readSync(source, buf, 0, size, 0)
      return new ImageSource(buf)
    }
    return new ImageSource(source)
  }

  export function createImagePacker(): ImagePacker {
    return new ImagePacker()
  }

  /**
   * 从已编码的图片字节（PNG/JPEG）造一个 PixelMap。
   *
   * 为什么需要它：桌面端的 PDF 后端（PDF.js + @napi-rs/canvas）渲染出来的是 PNG 字节，
   * 而端口代码期望拿到 PixelMap（再交给 ImagePacker 编码落盘）。
   * 让 PixelMap 的构造只经由本模块，Electron（nativeImage）的依赖就不会漏到别处去。
   */
  export function createPixelMapFromBuffer(data: Buffer | Uint8Array): PixelMap {
    const buf: Buffer = Buffer.isBuffer(data) ? data : Buffer.from(data)
    return new PixelMap(nativeImage().createFromBuffer(buf))
  }
}

// 平台解码器是否可用：纯 Node（无头冒烟）里 require('electron') 只拿到一个路径字符串，
// 没有 nativeImage。调用方据此决定“跳过二次解码”还是“把解码失败当作坏图”。
let nativeDecoderAvailable: boolean | null = null

export function isNativeDecoderAvailable(): boolean {
  if (nativeDecoderAvailable === null) {
    try {
      const api = nativeImage()
      nativeDecoderAvailable = api !== null && api !== undefined &&
        typeof api.createFromBuffer === 'function'
    } catch {
      nativeDecoderAvailable = false
    }
  }
  return nativeDecoderAvailable
}

// 真正的像素解码（只用于 PNG/JPEG 这类 nativeImage 必然支持的格式）。
// 返回 null 表示解码失败或得到 0×0 的空图；平台不可用时请先看 isNativeDecoderAvailable()。
export function decodeImageSize(data: Buffer | Uint8Array | ArrayBuffer): image.Size | null {
  if (!isNativeDecoderAvailable()) {
    return null
  }
  try {
    const buf: Buffer = Buffer.isBuffer(data)
      ? data
      : data instanceof Uint8Array
        ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
        : Buffer.from(data)
    const img: NativeImage = nativeImage().createFromBuffer(buf)
    const size: image.Size = img.getSize()
    if (size.width > 0 && size.height > 0) {
      return size
    }
    return null
  } catch {
    return null
  }
}
