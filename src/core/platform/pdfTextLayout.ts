// PDF.js 文本项 → 页面文本 / 版面对象（平台无关的纯函数）。
//
// 桌面端（core/platform/native/pdfBackend.ts）和 Android 端
// （mobile/platform/pdfBackend.ts）共用这一份拼装逻辑：
// 两边的 PDF.js 版本相同，但后端的运行环境不同（Node + @napi-rs/canvas
// vs. WebView + DOM canvas）。如果各写一份，同一份 PDF 在两端的换行与
// 版面兜底就可能出现分歧 —— 这正是「同一文件桌面读得出、手机读不出」的来源。
//
// 注意：这里 import 的是 `@kit.PDFKit`，由各平台的构建别名解析到对应实现；
// 本文件只用到其中的**枚举值**（OBJECT_TEXT）与类型，不碰任何后端状态。
import { pdfService } from '@kit.PDFKit'

/** PDF.js 的文本项（只声明用到的字段） */
export interface PdfJsTextItem {
  str: string
  hasEOL?: boolean
  /** PDF 用户空间变换矩阵 [a, b, c, d, e, f]；e/f 是字形原点（f = 距页面底部的距离） */
  transform?: number[]
  width?: number
  height?: number
}

/**
 * 把 PDF.js 的文本项拼成整页文本。
 * 关键在 hasEOL：只有它能表示「这一行结束了」。直接把各项的 str 连起来，
 * 相邻两行会被粘成一行（"第一行第二行"），读起来完全不对。
 */
export function itemsToText(items: PdfJsTextItem[]): string {
  let out: string = ''
  for (const item of items) {
    out += item.str
    if (item.hasEOL === true) {
      out += '\n'
    }
  }
  return out
}

/**
 * 把文本项转成版面对象（供 PdfTextExtractor 的 graphicsFallback 使用）。
 * 坐标系与鸿蒙侧一致：x 从左算，y 从**页面底部**算。
 */
export function itemsToObjects(items: PdfJsTextItem[]): pdfService.GraphicsObject[] {
  const out: pdfService.GraphicsObject[] = []
  for (const item of items) {
    if (item.str === '') {
      continue
    }
    const t: number[] = item.transform ?? []
    const obj: pdfService.TextObject = {
      type: pdfService.GraphicsObjectType.OBJECT_TEXT,
      x: t.length > 4 ? t[4] : 0,
      y: t.length > 5 ? t[5] : 0,
      width: item.width ?? 0,
      height: item.height ?? 0,
      text: item.str,
      charRects: []
    }
    out.push(obj)
  }
  return out
}
