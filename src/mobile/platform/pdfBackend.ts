// Android/Web 端的 PDF 后端：用 PDF.js（pdfjs-dist）实现 @kit.PDFKit 的能力。
//
// 与桌面端（core/platform/native/pdfBackend.ts）是**同一套 PDFKit 接口**，
// 差别只在运行环境：
//   1. 渲染 —— 桌面端主进程没有 DOM，用 @napi-rs/canvas；WebView 里直接创建
//      <canvas>，PDF.js 的 render() 原生就支持。
//   2. Worker / 随包数据 —— 浏览器版 PDF.js 必须走 Web Worker，CMap、标准字体、
//      wasm 解码器也要通过 HTTP 取。构建期把 pdfjs-dist 的这几组数据拷到
//      assets/public/pdfjs/（见 vite.mobile.config.ts 的 guncat-pdfjs-assets），
//      运行时用 document.baseURI 拼出同源 URL；GuncatServer 会按静态资源返回。
//   3. 文件读取 —— 仍然走 node:fs 的浏览器替身（memfs），所以和桌面端一样用
//      fs.readFileSync(absPath) 把工作区文件读成字节，再交给 PDF.js。
//
// 其余语义与桌面端/鸿蒙侧一致：加密归因 PARSE_ERROR_PASSWORD、扫描件返回空文本、
// searchKey 不可用时由 PdfTextExtractor 逐页子串扫描兜底。
import fs from 'node:fs'
import { pdfService } from '@kit.PDFKit'
import { image } from '@kit.ImageKit'
import { itemsToObjects, itemsToText, type PdfJsTextItem } from '@core/platform/pdfTextLayout'

interface PdfJsViewport {
  width: number
  height: number
}

interface PdfJsRawPage {
  getViewport(params: { scale: number }): PdfJsViewport
  getTextContent(): Promise<{ items: PdfJsTextItem[] }>
  render(params: Record<string, unknown>): { promise: Promise<void> }
}

interface PdfJsRawDocument {
  numPages: number
  getPage(pageNumber: number): Promise<PdfJsRawPage>
  destroy(): Promise<void>
}

interface PdfJsModule {
  version: string
  GlobalWorkerOptions: { workerSrc: string }
  getDocument(source: Record<string, unknown>): { promise: Promise<PdfJsRawDocument> }
}

// PDF.js 体积不小（解析器 + worker）。动态 import，没人碰 PDF 的会话不付启动成本。
let pdfjsPromise: Promise<PdfJsModule> | null = null

/** 随包 PDF.js 数据的同源地址（assets/public/pdfjs/…） */
function assetUrl(sub: string): string {
  return new URL('pdfjs/' + sub, document.baseURI).href
}

function loadPdfjs(): Promise<PdfJsModule> {
  if (pdfjsPromise === null) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs')
      .then((mod) => {
        const lib: PdfJsModule = mod as unknown as PdfJsModule
        // 构建期把 pdf.worker.min.mjs 拷成 pdfjs/pdf.worker.mjs；加版本号避免
        // GuncatServer 的 max-age 缓存把旧 worker 留在 WebView 里。
        lib.GlobalWorkerOptions.workerSrc = assetUrl('pdf.worker.mjs') + '?v=' + __APP_VERSION__
        return lib
      })
      .catch((error) => {
        // 允许下次重试（例如 worker 资源尚未就绪）
        pdfjsPromise = null
        throw error
      })
  }
  return pdfjsPromise
}

// ===== 文本拼装（与桌面端共用 core/platform/pdfTextLayout.ts） =====

/**
 * 组装 PDF.js 的文档来源参数。
 * 与桌面端保持同一组配置：字体/CMap/wasm 只要有一处不一致，同一份 PDF
 * 就会出现「桌面读得出、手机读不出」。
 */
function buildSource(absPath: string): Record<string, unknown> {
  const source: Record<string, unknown> = {
    // 传一份拷贝：PDF.js 会接管这段字节并在文档销毁时释放
    data: new Uint8Array(fs.readFileSync(absPath)),
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: false,
    // 只报错、不报警告：缺字体数据时 PDF.js 会退回内置度量，结果仍然正确
    verbosity: 0,
    cMapUrl: assetUrl('cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: assetUrl('standard_fonts/'),
    wasmUrl: assetUrl('wasm/'),
    iccUrl: assetUrl('iccs/')
  }
  return source
}

// ===== 页 / 文档 =====

class PdfPage implements pdfService.PdfPageBackend {
  private readonly doc: PdfJsRawDocument
  private readonly index: number
  private raw: PdfJsRawPage | null = null
  private text: string | null = null
  private objects: pdfService.GraphicsObject[] | null = null
  private width: number = 0
  private height: number = 0

  constructor(doc: PdfJsRawDocument, index: number) {
    this.doc = doc
    this.index = index
  }

  /** 取页并抽好文本 —— 之后所有同步访问器才有数据（见 PDFKit 里 prepare 的说明） */
  async prepare(): Promise<void> {
    if (this.text !== null) {
      return
    }
    const raw: PdfJsRawPage = await this.doc.getPage(this.index + 1)
    this.raw = raw
    const viewport = raw.getViewport({ scale: 1 })
    this.width = viewport.width
    this.height = viewport.height
    const content = await raw.getTextContent()
    this.text = itemsToText(content.items)
    this.objects = itemsToObjects(content.items)
  }

  getTextContent(): string {
    return this.text ?? ''
  }

  getGraphicsObjects(): pdfService.GraphicsObject[] {
    return this.objects ?? []
  }

  getWidth(): number {
    return this.width
  }

  getHeight(): number {
    return this.height
  }

  async renderToPixelMap(width: number, height: number): Promise<image.PixelMap> {
    await this.prepare()
    if (this.raw === null) {
      throw new Error('PDF 页面尚未准备完成')
    }
    const canvas: HTMLCanvasElement = await renderRawPageToCanvas(this.raw, width, height)
    return image.createPixelMapFromCanvas(canvas)
  }
}

class PdfDocumentBackend implements pdfService.PdfDocumentBackend {
  private readonly doc: PdfJsRawDocument
  private readonly pages: Map<number, PdfPage> = new Map()

  constructor(doc: PdfJsRawDocument) {
    this.doc = doc
  }

  getPageCount(): number {
    return this.doc.numPages
  }

  getPage(index: number): pdfService.PdfPageBackend {
    let page: PdfPage | undefined = this.pages.get(index)
    if (page === undefined) {
      page = new PdfPage(this.doc, index)
      this.pages.set(index, page)
    }
    return page
  }

  // 刻意不实现 searchKey：PDF.js 没有原生全文检索，逐页扫描是唯一的路。
  // PdfTextExtractor 已经写好了 fallbackSearch，缺了 searchKey 它会自动走那条。

  release(): void {
    void this.doc.destroy()
  }
}

/**
 * 把一页渲染到浏览器 canvas。
 * 目标尺寸换算与桌面端一致：width 优先，其次 height，都没有时按 2 倍放大；
 * 先铺白底，否则透明背景编码成 JPEG 会变成黑图。
 */
async function renderRawPageToCanvas(
  raw: PdfJsRawPage,
  width: number,
  height: number
): Promise<HTMLCanvasElement> {
  const base = raw.getViewport({ scale: 1 })
  const scale: number =
    width > 0 && base.width > 0
      ? width / base.width
      : height > 0 && base.height > 0
        ? height / base.height
        : 2
  const viewport = raw.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.ceil(viewport.width))
  canvas.height = Math.max(1, Math.ceil(viewport.height))
  const ctx = canvas.getContext('2d')
  if (ctx === null) {
    throw new Error('浏览器不支持 canvas，无法渲染 PDF 页面')
  }
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  await raw.render({ canvasContext: ctx, viewport, canvas }).promise
  return canvas
}

// ===== 后端本体 =====

export class PdfJsBackend implements pdfService.PdfBackend {
  /** 同步打开：浏览器里没有同步解析路径，保留实现只为给出可读原因 */
  open(_absPath: string): pdfService.PdfDocumentBackend | null {
    throw new Error('Android 端 PDF 后端是异步的，请调用 PdfDocument.loadDocumentAsync()')
  }

  async openAsync(absPath: string): Promise<pdfService.PdfDocumentBackend | null> {
    if (!fs.existsSync(absPath)) {
      return null
    }
    const pdfjs: PdfJsModule = await loadPdfjs()
    try {
      const doc: PdfJsRawDocument = await pdfjs.getDocument(buildSource(absPath)).promise
      return new PdfDocumentBackend(doc)
    } catch (e: unknown) {
      const name: string = String((e as { name?: string }).name ?? '')
      if (name === 'PasswordException') {
        const err = new Error('PDF 已加密，需要密码')
        ;(err as { code?: number }).code = pdfService.ParseResult.PARSE_ERROR_PASSWORD
        throw err
      }
      throw new Error(`PDF 解析失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

/** 装上后端。boot 时调用一次；重复调用无副作用。 */
export function installPdfJsBackend(): void {
  pdfService.setPdfBackend(new PdfJsBackend())
}

/** PDF.js 的版本（排查解析差异时有用） */
export async function pdfjsVersion(): Promise<string> {
  try {
    return (await loadPdfjs()).version
  } catch {
    return '(未加载)'
  }
}
