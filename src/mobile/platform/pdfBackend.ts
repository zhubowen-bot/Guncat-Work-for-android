// Android/Web 端的 PDF 后端：用 PDF.js（pdfjs-dist）实现 @kit.PDFKit 的能力。
//
// 与桌面端（core/platform/native/pdfBackend.ts）是**同一套 PDFKit 接口**，
// 差别只在运行环境：
//   1. 渲染 —— 桌面端主进程没有 DOM，用 @napi-rs/canvas；WebView 里直接创建
//      <canvas>，PDF.js 的 render() 原生就支持。
//   2. 引擎运行方式 —— **刻意不用 Web Worker**。Android WebView 上 `new Worker`
//      + module worker 的组合并不可靠：worker 脚本加载失败时 PDF.js 会等不到
//      "ready" 消息，`getDocument()` 永远不 settle，界面就一直转圈。
//      这里把 pdf.worker 模块也 import 进主线程并挂到 `globalThis.pdfjsWorker`，
//      PDF.js 会走官方的 fake worker（LoopbackPort）路径，完全不创建 Worker。
//      代价是解析在主线程执行；PdfTextExtractor 本来就逐页 await，可接受。
//   3. 随包数据 —— CMap、标准字体、wasm 解码器通过同源 HTTP 取。构建期把
//      pdfjs-dist 的这几组数据拷到 assets/public/pdfjs/（见 vite.mobile.config.ts
//      的 guncat-pdfjs-assets），运行时用 document.baseURI 拼出同源 URL。
//   4. 文件读取 —— 仍然走 node:fs 的浏览器替身（memfs），所以和桌面端一样用
//      fs.readFileSync(absPath) 把工作区文件读成字节，再交给 PDF.js。
//
// 另外，每个可能挂住的阶段都有超时（引擎加载 / 打开 / 取页 / 渲染）。
// 宁可返回一条明确的「PDF 引擎无响应」，也不让工具无限转圈。
//
// 其余语义与桌面端/鸿蒙侧一致：加密归因 PARSE_ERROR_PASSWORD、扫描件返回空文本、
// searchKey 不可用时由 PdfTextExtractor 逐页子串扫描兜底。
import fs from 'node:fs'
import { pdfService } from '@kit.PDFKit'
import { image } from '@kit.ImageKit'
import { itemsToObjects, itemsToText, type PdfJsTextItem } from '@core/platform/pdfTextLayout'

/**
 * 老 Android WebView 的 ReadableStream 没有 `Symbol.asyncIterator`。
 *
 * PDF.js 5.x 的 `page.getTextContent()` 内部是：
 *   `for await (const value of readableStream) { ... }`
 * 缺少这个符号时直接抛 `TypeError: e is not async iterable` —— 这正是真机上
 * parse_document / search_pdf 报的那条错（桌面 Chromium 支持异步迭代，所以冒烟
 * 发现不了）。标准语义就是 getReader() 循环，这里补一个最小 polyfill。
 */
function installReadableStreamAsyncIterator(): void {
  const ctor = (globalThis as { ReadableStream?: typeof ReadableStream }).ReadableStream
  if (ctor === undefined) {
    return
  }
  const proto = ctor.prototype as unknown as {
    [Symbol.asyncIterator]?: () => AsyncIterator<unknown>
  }
  if (typeof proto[Symbol.asyncIterator] === 'function') {
    return
  }
  Object.defineProperty(proto, Symbol.asyncIterator, {
    configurable: true,
    writable: true,
    value: function (this: ReadableStream<unknown>): AsyncIterator<unknown> {
      const reader = this.getReader()
      return {
        next: (): Promise<IteratorResult<unknown>> => reader.read(),
        return: async (): Promise<IteratorResult<unknown>> => {
          try {
            await reader.cancel()
          } catch {
            // 已关闭/已取消时忽略
          }
          try {
            reader.releaseLock()
          } catch {
            // 还有未完成的 read 时 release 会抛，忽略即可
          }
          return { done: true, value: undefined }
        },
        [Symbol.asyncIterator](): AsyncIterator<unknown> {
          return this
        }
      } as AsyncIterator<unknown>
    }
  })
}

// 必须在加载 PDF.js 之前装好（boot 时本模块就会被 import）
installReadableStreamAsyncIterator()

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

interface PdfJsLoadingTask {
  promise: Promise<PdfJsRawDocument>
  destroy(): Promise<void>
}

interface PdfJsModule {
  version: string
  getDocument(source: Record<string, unknown>): PdfJsLoadingTask
}

/** PDF 引擎（两个 JS chunk）加载上限 */
const PDF_ENGINE_TIMEOUT_MS = 20_000
/** 打开文档（解析 trailer/xref）上限 */
const PDF_OPEN_TIMEOUT_MS = 30_000
/** 单页取页/取文字上限 */
const PDF_PAGE_TIMEOUT_MS = 20_000
/** 单页渲染上限 */
const PDF_RENDER_TIMEOUT_MS = 30_000

/** 给一个可能永远不 settle 的 Promise 加硬超时，避免工具无限转圈 */
function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      reject(new Error(message))
    }, ms)
    work.then(
      (value) => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

// PDF.js 体积不小（解析器 + worker 模块）。动态 import，没人碰 PDF 的会话不付启动成本。
let pdfjsPromise: Promise<PdfJsModule> | null = null

/** 随包 PDF.js 数据的同源地址（assets/public/pdfjs/…） */
function assetUrl(sub: string): string {
  return new URL('pdfjs/' + sub, document.baseURI).href
}

/**
 * 加载 PDF.js 主模块 + worker 模块。
 *
 * worker 模块只作为「主线程实现」导入：它的末尾会把 `WorkerMessageHandler`
 * 挂到 `globalThis.pdfjsWorker`，PDF.js 看到它就直接用 LoopbackPort，不再
 * `new Worker(...)`。这一步是 Android 上不转圈的关键。
 */
function loadPdfjs(): Promise<PdfJsModule> {
  if (pdfjsPromise === null) {
    pdfjsPromise = withTimeout(
      (async () => {
        const [main, worker] = await Promise.all([
          import('pdfjs-dist/legacy/build/pdf.mjs'),
          import('pdfjs-dist/legacy/build/pdf.worker.min.mjs')
        ])
        const lib: PdfJsModule = main as unknown as PdfJsModule
        const handler = (worker as { WorkerMessageHandler?: unknown }).WorkerMessageHandler
        if (handler === undefined) {
          throw new Error('PDF worker 模块未导出 WorkerMessageHandler')
        }
        ;(globalThis as typeof globalThis & { pdfjsWorker?: unknown }).pdfjsWorker = {
          WorkerMessageHandler: handler
        }
        return lib
      })(),
      PDF_ENGINE_TIMEOUT_MS,
      'PDF 引擎加载超时（JS 资源没有就绪）'
    ).catch((error) => {
      // 允许下次重试
      pdfjsPromise = null
      throw error
    })
  }
  return pdfjsPromise
}

/** 启动后后台预热 PDF 引擎：第一次真正打开 PDF 时不再等 chunk 下载/解析 */
export function preloadPdfJs(): void {
  void loadPdfjs().catch((error) => {
    console.warn('[pdf] 预加载失败', error)
  })
}

// ===== 文本拼装（与桌面端共用 core/platform/pdfTextLayout.ts） =====

/**
 * 组装 PDF.js 的文档来源参数。
 * 与桌面端保持同一组配置：字体/CMap/wasm 只要有一处不一致，同一份 PDF
 * 就会出现「桌面读得出、手机读不出」。
 */
function buildSource(absPath: string): Record<string, unknown> {
  return {
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
    const raw: PdfJsRawPage = await withTimeout(
      this.doc.getPage(this.index + 1),
      PDF_PAGE_TIMEOUT_MS,
      'PDF 取页超时（第 ' + (this.index + 1) + ' 页）'
    )
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
    const content = await withTimeout(
      raw.getTextContent(),
      PDF_PAGE_TIMEOUT_MS,
      'PDF 文字层读取超时（第 ' + (this.index + 1) + ' 页）'
    )
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
    await this.prepareForRender()
    if (this.raw === null) {
      throw new Error('PDF 页面尚未准备完成')
    }
    const canvas: HTMLCanvasElement = await withTimeout(
      renderRawPageToCanvas(this.raw, width, height),
      PDF_RENDER_TIMEOUT_MS,
      'PDF 页面渲染超时（第 ' + (this.index + 1) + ' 页）'
    )
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
    const task: PdfJsLoadingTask = pdfjs.getDocument(buildSource(absPath))
    try {
      const doc: PdfJsRawDocument = await withTimeout(
        task.promise,
        PDF_OPEN_TIMEOUT_MS,
        'PDF 打开超时（引擎无响应）'
      )
      return new PdfDocumentBackend(doc)
    } catch (e: unknown) {
      // 超时/损坏时把底层加载任务一并销毁，避免后台继续占资源
      void task.destroy().catch((): void => undefined)
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
