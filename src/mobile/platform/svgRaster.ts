// Android/Web 端 SVG → PNG 栅格化：浏览器原生 Image + canvas。
import fs from 'node:fs'

function loadSvgImage(svgText: string): Promise<HTMLImageElement> {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(url)
      resolve(image)
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('SVG 解码失败'))
    }
    image.src = url
  })
}

export async function rasterizeSvgToPng(
  svgText: string,
  width: number,
  height: number
): Promise<Buffer> {
  const targetW = Math.max(1, Math.round(width))
  const targetH = Math.max(1, Math.round(height))
  const image = await loadSvgImage(svgText)
  const canvas = document.createElement('canvas')
  canvas.width = targetW
  canvas.height = targetH
  const ctx = canvas.getContext('2d')
  if (ctx === null) {
    throw new Error('浏览器不支持 canvas')
  }
  // 先铺白底：SVG 默认透明，直接编码会得到黑底
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, targetW, targetH)
  ctx.drawImage(image, 0, 0, targetW, targetH)
  const bytes = await new Promise<Uint8Array>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) {
        reject(new Error('SVG 栅格化输出为空'))
        return
      }
      void blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject)
    }, 'image/png')
  })
  if (bytes.length < 8) {
    throw new Error('SVG 栅格化输出为空')
  }
  return bytes as unknown as Buffer
}

export async function svgRasterAvailable(): Promise<boolean> {
  return typeof document !== 'undefined'
}

export function writeRasterFile(path: string, bytes: Uint8Array): void {
  fs.writeFileSync(path, bytes)
}
