// SVG → PNG 栅格化（桌面端）。
//
// 为什么单独有这一层（用户报障「write_svg 能保存 SVG 源码，但预览栅格化在本机失败，
// 导致 docx/pptx 也不能引用 svg」）：
//   鸿蒙侧把 SVG 交给设备图片引擎解码，那条路桌面端不存在 ——
//   Electron 的 nativeImage 只认 PNG / JPEG / WebP 等位图格式，喂它 SVG 必然失败。
//   于是 write_svg 存得下源码、预览 PNG 出不来，write_docx / write_pptx 里对 .svg 的引用
//   自然也跟着失败（它们都依赖同一份预览或同一段栅格化代码）。
//
// 桌面端可行的路是 @napi-rs/canvas 的 loadImage —— 它底层带 resvg，能把 SVG 当图片画到
// canvas 上，再编码成 PNG。实测圆角矩形、圆、多边形路径都渲染正确（见提交说明）。
import { requireCanvasModule, type CanvasLike, type CanvasImageLike } from './canvas'

/** 把 SVG 源码栅格化成 PNG 字节。width/height 是目标像素尺寸。 */
export async function rasterizeSvgToPng(
  svgText: string,
  width: number,
  height: number
): Promise<Buffer> {
  const canvasModule = await requireCanvasModule()
  const targetW: number = Math.max(1, Math.round(width))
  const targetH: number = Math.max(1, Math.round(height))
  const image: CanvasImageLike = await canvasModule.loadImage(Buffer.from(svgText, 'utf8'))
  const canvas: CanvasLike = canvasModule.createCanvas(targetW, targetH)
  const ctx = canvas.getContext('2d') as {
    fillStyle: string
    fillRect(x: number, y: number, w: number, h: number): void
    drawImage(img: CanvasImageLike, x: number, y: number, w: number, h: number): void
  }
  // 先铺白底：SVG 默认透明，直接编码成 JPEG 会得到一张黑图（与 PDF 渲染同一个坑）
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, targetW, targetH)
  ctx.drawImage(image, 0, 0, targetW, targetH)
  const png: Buffer = canvas.encodeSync('png')
  if (png.length < 8) {
    throw new Error('SVG 栅格化输出为空')
  }
  return png
}

/** 栅格化能力是否可用（供上层给出更准确的提示） */
export async function svgRasterAvailable(): Promise<boolean> {
  const { loadCanvasModule } = await import('./canvas')
  return (await loadCanvasModule()) !== null
}
