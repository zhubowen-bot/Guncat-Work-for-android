// 桌面端的 PDF 后端：用 PDF.js（pdfjs-dist）实现 @kit.PDFKit 的能力。
//
// 为什么必须有这个文件（用户报障「parse_document / search_pdf / pdf_to_images 对 3 个不同来源的
// PDF 均报『文档结构损坏』」）：平台适配层的 PDFKit 只把接口搭好了，后端从来没人装 ——
//   PdfDocument.loadDocument() 看到 backend === null 就直接返回 PARSE_ERROR_FORMAT，
//   而它的文案正是「PDF 格式解析失败(文档结构损坏)」。
// 于是**任何** PDF、任何来源都得到同一句话，看起来像文件坏了，其实是后端缺席。
//
// 三处平台差异的落点：
//   1. 异步 —— PDF.js 从打开到取内容全是异步的，而鸿蒙是同步原生调用。
//      这里不改整条移植调用链，只在 PDFKit 上开一个 loadDocumentAsync 入口，
//      并把「页内容要等」显式化成 PdfPage.prepare()。
//   2. 渲染 —— PDF.js 要一个 canvas，而主进程没有 DOM。
//      用 @napi-rs/canvas（预编译二进制，免编译）补上；取不到时不报「文件损坏」，
//      而是如实说明缺的是渲染能力（文本抽取照样可用）。
//   3. 随包数据 —— PDF.js 解析 CJK 文档要 CMap、渲染标准字体要 standard_fonts。
//      打包脚本把它们拷进 resources/pdfjs 下（见 package-portable.mjs），
//      开发态则直接指 node_modules。
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { pdfService } from '../kit/PDFKit'
import { image } from '../kit/ImageKit'
import { resource } from '../appPaths'
import { loadCanvasModule, type CanvasModule, CANVAS_UNAVAILABLE } from './canvas'
import { itemsToObjects, itemsToText, type PdfJsTextItem } from '../pdfTextLayout'
const nodeRequire = createRequire(import.meta.url)

// 文本拼装（itemsToText / itemsToObjects）已抽到 ../pdfTextLayout.ts，与 Android 端共用。
// 这里重新导出，保持桌面端既有调用点（scripts/smoke.ts 等）不变。
export { itemsToObjects, itemsToText }

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
  getDocument(source: Record<string, unknown>): { promise: Promise<PdfJsRawDocument> }
}

// PDF.js 体积不小（解析器 + 内嵌 worker）。用动态 import 惰性加载：
// 没人碰 PDF 的会话不该为它付出启动成本。
let pdfjsPromise: Promise<PdfJsModule> | null = null

function loadPdfjs(): Promise<PdfJsModule> {
  if (pdfjsPromise === null) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs').then(
      (mod) => mod as unknown as PdfJsModule
    )
  }
  return pdfjsPromise
}

/** PDF.js 的随包数据目录（standard_fonts / cmaps / wasm），返回 file:// URL 前缀 */
export function assetUrl(sub: string): string | undefined {
  const candidates: string[] = []
  try {
    // 打包态：package-portable.mjs 拷到 resources/resources/pdfjs 下
    candidates.push(resource('pdfjs', sub))
  } catch {
    // 路径尚未初始化（无头测试里可能如此）—— 忽略这一条候选
  }
  // 开发态：从本文件所在目录往上找 node_modules。
  // 刻意不用 process.cwd()：打包后用户可能从任意目录双击启动，cwd 完全不可靠。
  try {
    const here: string = path.dirname(fileURLToPath(import.meta.url))
    candidates.push(path.resolve(here, '..', '..', '..', '..', 'node_modules', 'pdfjs-dist', sub))
  } catch {
    // 忽略
  }
  candidates.push(path.join(process.cwd(), 'node_modules', 'pdfjs-dist', sub))
  for (const dir of candidates) {
    try {
      if (fs.existsSync(dir)) {
        return pathToFileURL(dir + path.sep).href
      }
    } catch {
      // 忽略单个候选的探测失败
    }
  }
  return undefined
}

// ===== canvas（与 SVG 栅格化共用同一份加载器，见 native/canvas.ts） =====

/** 渲染能力不可用时的统一文案：说清缺的是什么，而不是让人以为文件坏了 */
export const PDF_RENDER_UNAVAILABLE =
  `${CANVAS_UNAVAILABLE}（PDF 页面转图依赖它；文本抽取与全文搜索不受影响。）`

/**
 * 把一页渲染成 PNG 字节。
 *
 * 抽成独立函数有两个好处：
 *   1. 渲染与「Electron 的 nativeImage」解耦 —— 无头验证里可以直接断言渲染结果，
 *      不必先有一整个 Electron 运行时；
 *   2. 目标尺寸的换算（保持纵横比、封顶）只写一次，两种调用路径不会有分歧。
 */
export async function renderRawPageToPng(
  raw: PdfJsRawPage,
  canvasMod: CanvasModule,
  width: number,
  height: number
): Promise<Buffer> {
  const base = raw.getViewport({ scale: 1 })
  // width 是目标像素宽；由它反推缩放比再算高，保持纵横比
  const scale: number =
    width > 0 && base.width > 0
      ? width / base.width
      : height > 0 && base.height > 0
        ? height / base.height
        : 2
  const viewport = raw.getViewport({ scale })
  const canvas = canvasMod.createCanvas(
    Math.max(1, Math.ceil(viewport.width)),
    Math.max(1, Math.ceil(viewport.height))
  )
  const ctx = canvas.getContext('2d') as {
    fillStyle: string
    fillRect(x: number, y: number, w: number, h: number): void
  }
  // 先铺白底：PDF 页面默认透明，直接编码成 JPEG 会得到一张黑图
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  await raw.render({ canvasContext: ctx, viewport, canvas }).promise
  return canvas.encodeSync('png')
}

/** 打开 PDF 并渲染指定页为 PNG（1-based 页码）。渲染后端缺失时抛错。 */
export async function renderPdfPageToPng(
  absPath: string,
  pageIndex: number,
  targetWidth: number
): Promise<Buffer> {
  const canvasMod: CanvasModule | null = await loadCanvasModule()
  if (canvasMod === null) {
    throw new Error(PDF_RENDER_UNAVAILABLE)
  }
  const pdfjs: PdfJsModule = await loadPdfjs()
  const doc: PdfJsRawDocument = await pdfjs
    .getDocument(buildSource(absPath))
    .promise
  try {
    const raw: PdfJsRawPage = await doc.getPage(pageIndex)
    return await renderRawPageToPng(raw, canvasMod, targetWidth, 0)
  } finally {
    void doc.destroy()
  }
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

  /** 取页 + 宽高（渲染只需要这些，不碰文字层） */
  private async preparePage(): Promise<PdfJsRawPage> {
    if (this.raw !== null) {
      return this.raw
    }
    const raw: PdfJsRawPage = await this.doc.getPage(this.index + 1)
    this.raw = raw
    const viewport = raw.getViewport({ scale: 1 })
    this.width = viewport.width
    this.height = viewport.height
    return raw
  }

  /** 取页并抽好文本 —— 之后所有同步访问器才有数据（见 PDFKit 里 prepare 的说明） */
  async prepare(): Promise<void> {
    if (this.text !== null) {
      return
    }
    const raw: PdfJsRawPage = await this.preparePage()
    const content = await raw.getTextContent()
    this.text = itemsToText(content.items)
    this.objects = itemsToObjects(content.items)
  }

  /** 渲染前只准备页对象与宽高；文字层坏了也不影响转图 */
  async prepareForRender(): Promise<void> {
    await this.preparePage()
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
    const canvasMod: CanvasModule | null = await loadCanvasModule()
    if (canvasMod === null) {
      throw new Error(PDF_RENDER_UNAVAILABLE)
    }
    await this.prepareForRender()
    if (this.raw === null) {
      throw new Error('PDF 页面尚未准备完成')
    }
    const png: Buffer = await renderRawPageToPng(this.raw, canvasMod, width, height)
    return image.createPixelMapFromBuffer(png)
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
  // PdfTextExtractor 已经写好了 fallbackSearch，缺了 searchKey 它会自动走那条；
  // 在这里再实现一遍只会多出一份要同步维护的相同逻辑。

  release(): void {
    void this.doc.destroy()
  }
}

// ===== 后端本体 =====

export class PdfJsBackend implements pdfService.PdfBackend {
  /**
   * 同步打开：Node 侧没有这条路径。
   * 保留实现是为了满足接口，并让误用时报出可读的原因，而不是静默变成「文件损坏」。
   */
  open(_absPath: string): pdfService.PdfDocumentBackend | null {
    throw new Error('桌面端 PDF 后端是异步的，请调用 PdfDocument.loadDocumentAsync()')
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
        // 交给 PdfDocument 归因为 PARSE_ERROR_PASSWORD
        const err = new Error('PDF 已加密，需要密码')
        ;(err as { code?: number }).code = pdfService.ParseResult.PARSE_ERROR_PASSWORD
        throw err
      }
      // 其余一律当格式问题，但把底层原因带出来 —— 只说「结构损坏」太笼统，无从排查
      throw new Error(`PDF 解析失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

/**
 * 组装 PDF.js 的文档来源参数。
 * 抽出来是为了让「取文本」和「渲染成图」两条路用完全相同的解析配置 ——
 * 字体/CMap 设置只要有一处不一致，同一份 PDF 就会一条路读得出、另一条读不出。
 */
function buildSource(absPath: string): Record<string, unknown> {
  const source: Record<string, unknown> = {
    // 传一份拷贝：PDF.js 会接管这段字节并在文档销毁时释放
    data: new Uint8Array(fs.readFileSync(absPath)),
    // 主进程里没有 Worker 可取，走 PDF.js 的「假 worker」回退
    useWorkerFetch: false,
    isEvalSupported: false,
    // 标准字体用随包数据；缺失时 PDF.js 会退回内置兜底字体，只是度量略差
    useSystemFonts: false,
    // 只报错、不报警告。Node 里 PDF.js 没有「按文件路径读标准字体 / CMap」的工厂，
    // 它只会对 file:// 走 fetch 然后失败，再退回内置度量 —— 结果是正确的，
    // 但那两行 "Unable to load font data at: file:///..." 会一直往应用日志里灌噪音。
    // 真正的解析错误仍然会抛出（本文件把它们包装成可读文案）。
    verbosity: 0
  }
  const fonts = assetUrl('standard_fonts')
  if (fonts !== undefined) {
    source.standardFontDataUrl = fonts
  }
  const cmaps = assetUrl('cmaps')
  if (cmaps !== undefined) {
    // CJK 文档（这个应用的主要场景）里用到的预定义 CMap 要靠它
    source.cMapUrl = cmaps
    source.cMapPacked = true
  }
  const wasm = assetUrl('wasm')
  if (wasm !== undefined) {
    // JPEG2000 / JBIG2 这类图片解码器是 wasm 的，缺了它们含此类图的页面会渲染失败
    source.wasmUrl = wasm
  }
  return source
}

/** 装上后端。应用启动时调用一次；重复调用无副作用。 */
export function installPdfJsBackend(): void {
  pdfService.setPdfBackend(new PdfJsBackend())
}

/** PDF.js 的版本（启动日志里记一笔，排查解析差异时有用） */
export async function pdfjsVersion(): Promise<string> {
  try {
    return (await loadPdfjs()).version
  } catch {
    return '(未加载)'
  }
}
