// 平台适配层：鸿蒙 `@kit.ImageKit` 的 Android/Web 实现。
//
// 桌面版靠 Electron 的 nativeImage；Android WebView 里没有它，改用浏览器
// createImageBitmap + canvas 解码/缩放/重新编码。接口语义（ImageSource / PixelMap /
// ImagePacker）与桌面版保持一致，core 里的调用点不需要任何改动。
import fs from 'node:fs'

function toU8(source: Buffer | ArrayBuffer | Uint8Array): Uint8Array {
  if (source instanceof Uint8Array) {
    return source
  }
  if (source instanceof ArrayBuffer) {
    return new Uint8Array(source)
  }
  return new Uint8Array(source as ArrayBuffer)
}

function sniffMime(data: Uint8Array): string {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return 'image/png'
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    data.length >= 12 &&
    String.fromCharCode(data[0], data[1], data[2], data[3]) === 'RIFF' &&
    String.fromCharCode(data[8], data[9], data[10], data[11]) === 'WEBP'
  ) {
    return 'image/webp'
  }
  if (data.length >= 6 && String.fromCharCode(data[0], data[1], data[2]) === 'GIF') {
    return 'image/gif'
  }
  if (data.length >= 2 && data[0] === 0x42 && data[1] === 0x4d) {
    return 'image/bmp'
  }
  return 'application/octet-stream'
}

/** 同步读尺寸（PNG/JPEG/GIF/BMP/WebP）。浏览器解码是异步的，但元信息可以同步取。 */
function dimensionsOf(data: Uint8Array): { width: number; height: number } | null {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
  try {
    if (data[0] === 0x89 && data[1] === 0x50) {
      return { width: dv.getUint32(16), height: dv.getUint32(20) }
    }
    if (data[0] === 0xff && data[1] === 0xd8) {
      let offset = 2
      while (offset + 9 < data.length) {
        if (data[offset] !== 0xff) {
          offset++
          continue
        }
        const marker = data[offset + 1]
        const length = dv.getUint16(offset + 2)
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: dv.getUint16(offset + 5), width: dv.getUint16(offset + 7) }
        }
        offset += 2 + length
      }
      return null
    }
    if (String.fromCharCode(data[0], data[1], data[2]) === 'GIF') {
      return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) }
    }
    if (data[0] === 0x42 && data[1] === 0x4d) {
      return { width: Math.abs(dv.getInt32(18, true)), height: Math.abs(dv.getInt32(22, true)) }
    }
    if (
      data.length >= 30 &&
      String.fromCharCode(data[0], data[1], data[2], data[3]) === 'RIFF' &&
      String.fromCharCode(data[8], data[9], data[10], data[11]) === 'WEBP'
    ) {
      const chunk = String.fromCharCode(data[12], data[13], data[14], data[15])
      if (chunk === 'VP8X') {
        return {
          width: 1 + (data[24] | (data[25] << 8) | (data[26] << 16)),
          height: 1 + (data[27] | (data[28] << 8) | (data[29] << 16))
        }
      }
      if (chunk === 'VP8 ') {
        return {
          width: dv.getUint16(26, true) & 0x3fff,
          height: dv.getUint16(28, true) & 0x3fff
        }
      }
      if (chunk === 'VP8L') {
        const b0 = data[21]
        const b1 = data[22]
        const b2 = data[23]
        const b3 = data[24]
        return {
          width: 1 + (((b1 & 0x3f) << 8) | b0),
          height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))
        }
      }
    }
  } catch {
    return null
  }
  return null
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

  function infoOf(size: Size, mimeType: string): ImageInfo {
    return {
      size,
      mimeType,
      density: 1,
      stride: size.width * 4,
      pixelFormat: 0,
      alphaType: 0,
      editable: false,
      isHdr: false
    }
  }

  async function decode(bytes: Uint8Array, desired?: Size): Promise<ImageBitmap> {
    const blob = new Blob([bytes.slice().buffer], { type: sniffMime(bytes) })
    const bitmap = await createImageBitmap(blob)
    if (
      desired === undefined ||
      desired.width <= 0 ||
      desired.height <= 0 ||
      (bitmap.width === desired.width && bitmap.height === desired.height)
    ) {
      return bitmap
    }
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(desired.width))
    canvas.height = Math.max(1, Math.round(desired.height))
    const ctx = canvas.getContext('2d')
    if (ctx === null) {
      return bitmap
    }
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()
    return await createImageBitmap(canvas)
  }

  export class PixelMap {
    readonly bitmap: ImageBitmap
    /** 原始编码字节（没有缩放时可直接原样打包，避免重新编码损失） */
    readonly source: Uint8Array | null

    constructor(bitmap: ImageBitmap, source: Uint8Array | null = null) {
      this.bitmap = bitmap
      this.source = source
    }

    async getImageInfo(): Promise<ImageInfo> {
      return infoOf({ width: this.bitmap.width, height: this.bitmap.height }, 'image/png')
    }

    async release(): Promise<void> {
      this.bitmap.close()
    }
  }

  export class ImageSource {
    private readonly data: Uint8Array

    constructor(data: Uint8Array) {
      this.data = data
    }

    async getImageInfo(): Promise<ImageInfo> {
      const dims = dimensionsOf(this.data)
      if (dims !== null) {
        return infoOf(dims, sniffMime(this.data))
      }
      const bitmap = await decode(this.data)
      const info = infoOf({ width: bitmap.width, height: bitmap.height }, sniffMime(this.data))
      bitmap.close()
      return info
    }

    async createPixelMap(options?: DecodingOptions): Promise<PixelMap> {
      const bitmap = await decode(this.data, options?.desiredSize)
      const scaled =
        options?.desiredSize !== undefined &&
        (bitmap.width !== options.desiredSize.width || bitmap.height !== options.desiredSize.height)
      return new PixelMap(bitmap, scaled ? null : this.data)
    }

    async release(): Promise<void> {
      // 没有原生句柄需要释放
    }

    isReleased(): boolean {
      return false
    }
  }

  function canvasOf(pixelMap: PixelMap): HTMLCanvasElement {
    const canvas = document.createElement('canvas')
    canvas.width = pixelMap.bitmap.width
    canvas.height = pixelMap.bitmap.height
    const ctx = canvas.getContext('2d')
    if (ctx !== null) {
      ctx.drawImage(pixelMap.bitmap, 0, 0)
    }
    return canvas
  }

  function canvasToBytes(canvas: HTMLCanvasElement, format: string, quality: number): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob === null) {
            reject(new Error('图片编码失败'))
            return
          }
          void blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject)
        },
        format,
        Math.max(0, Math.min(1, quality / 100))
      )
    })
  }

  export class ImagePacker {
    async packToData(pixelMap: PixelMap, option: PackingOption): Promise<ArrayBuffer> {
      const format = option.format.toLowerCase()
      const isPng = !format.includes('jpeg') && !format.includes('jpg')
      if (pixelMap.source !== null && isPng) {
        return pixelMap.source.slice().buffer
      }
      const bytes = await canvasToBytes(
        canvasOf(pixelMap),
        isPng ? 'image/png' : 'image/jpeg',
        option.quality
      )
      return bytes.slice().buffer
    }

    async packToFile(pixelMap: PixelMap, fd: number, option: PackingOption): Promise<void> {
      const buffer = await this.packToData(pixelMap, option)
      fs.writeSync(fd, new Uint8Array(buffer), 0, buffer.byteLength, null)
    }

    async release(): Promise<void> {
      // 无原生资源
    }
  }

  export function createImageSource(source: Uint8Array | ArrayBuffer | string | number): ImageSource {
    if (typeof source === 'string') {
      return new ImageSource(new Uint8Array(fs.readFileSync(source)))
    }
    if (typeof source === 'number') {
      const size = fs.fstatSync(source).size
      const buffer = new Uint8Array(size)
      fs.readSync(source, buffer, 0, size, 0)
      return new ImageSource(buffer)
    }
    return new ImageSource(toU8(source))
  }

  export function createImagePacker(): ImagePacker {
    return new ImagePacker()
  }

  export function createPixelMapFromBuffer(data: Uint8Array | ArrayBuffer): PixelMap {
    const bytes = toU8(data)
    // 同步接口拿不到 bitmap：先占位一个 1×1，真正解码在 getImageInfo/打包时发生。
    // 桌面端这个入口只用于 PDF 页面 PNG，移动端 PDF 渲染暂未启用。
    const placeholder = document.createElement('canvas')
    placeholder.width = 1
    placeholder.height = 1
    const dims = dimensionsOf(bytes)
    const promise = decode(bytes)
    const pixelMap = new PixelMap(
      {
        width: dims?.width ?? 1,
        height: dims?.height ?? 1,
        close: () => undefined
      } as ImageBitmap,
      bytes
    )
    void promise.catch((): void => undefined)
    return pixelMap
  }
}

export function isNativeDecoderAvailable(): boolean {
  return true
}

export function decodeImageSize(data: Uint8Array | ArrayBuffer): image.Size | null {
  return dimensionsOf(toU8(data))
}
