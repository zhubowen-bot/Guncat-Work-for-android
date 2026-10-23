// 平台适配层：鸿蒙 `@kit.PDFKit` 的等价实现（Node 侧）
//
// 落地状态：**后端已接**，实现在 core/platform/native/pdfBackend.ts（PDF.js / pdfjs-dist）。
// 后端不在这里直接 import 的原因：PDF.js 体积不小，且只在真的打开 PDF 时才需要 ——
// 由 core/platform/native/pdfBackend.ts 的 installPdfJsBackend() 在应用启动时注入。
//
// 与鸿蒙侧的两处平台差异（详见 pdfBackend.ts 的说明）：
//   1. 异步 —— 鸿蒙是同步原生调用；PDF.js 从打开到取内容全是异步的。
//      因此这里多开了一个 loadDocumentAsync 入口，并把「页内容要等」显式化成 PdfPage.prepare()。
//   2. 渲染 —— 主进程没有 DOM/canvas，PDF.js 的页面渲染依赖 @napi-rs/canvas。
//
// 其余语义与鸿蒙完全一致：加密归因 PARSE_ERROR_PASSWORD、扫描件返回空文本、
// searchKey 不可用时由 PdfTextExtractor 逐页子串扫描兜底。
import type { image } from './ImageKit'

export namespace pdfService {
  export enum ParseResult {
    PARSE_SUCCESS = 0,
    PARSE_ERROR_HANDLER = 1,
    PARSE_ERROR_FILE = 2,
    PARSE_ERROR_FORMAT = 3,
    PARSE_ERROR_PASSWORD = 4,
    PARSE_ERROR_CERT = 5
  }

  export enum GraphicsObjectType {
    OBJECT_UNKNOWN = 0,
    OBJECT_TEXT = 1,
    OBJECT_PATH = 2,
    OBJECT_IMAGE = 3,
    OBJECT_SHADING = 4,
    OBJECT_FORMXOBJECT = 5
  }

  export interface PdfRect {
    left: number
    top: number
    right: number
    bottom: number
  }

  export interface GraphicsObject {
    type: GraphicsObjectType
    x: number
    y: number
    width: number
    height: number
  }

  export interface TextObject extends GraphicsObject {
    text: string
    charRects: PdfRect[]
  }

  export interface SearchOptions {
    isMatchCase: boolean
    contextStringLength: number
  }

  export interface SearchResultData {
    pageIndex: number
    contextString: string
  }

  export type SearchKeyCallback = (results: SearchResultData[]) => boolean

  /**
   * 对齐鸿蒙 PDFKit 的 PdfMatrix：描述「页面坐标系里要渲染的矩形 + 旋转」。
   * 端口代码按 x/y/width/height/rotate 逐字段赋值（见 PdfTextExtractor.renderOnePage）。
   */
  export class PdfMatrix {
    x: number = 0
    y: number = 0
    width: number = 0
    height: number = 0
    rotate: number = 0
  }

  /** 单页抽象：由后端实现 */
  export interface PdfPageBackend {
    getTextContent(): string
    getGraphicsObjects(): GraphicsObject[]
    /** 页面原始宽高（点） */
    getWidth(): number
    getHeight(): number
    renderToPixelMap(width: number, height: number): Promise<image.PixelMap>
    /**
     * 把这一页的内容准备好，之后 getTextContent / getGraphicsObjects / getWidth 等
     * **同步**访问器才有数据。
     *
     * 为什么要有它：鸿蒙的 PDF Kit 是同步原生调用，而桌面端后端（PDF.js）一律是异步的。
     * 端口代码里「取第 i 页 → 取文本」这条链是同步的，于是把异步那一步显式提到
     * prepare() 上 —— 调用方先 await 一次，后面的同步访问器就都能成立。
     * 不实现（或已备好）的后端返回 resolved Promise 即可。
     */
    prepare?(): Promise<void>
  }

  /** 文档抽象：由后端实现 */
  export interface PdfDocumentBackend {
    getPageCount(): number
    getPage(index: number): PdfPageBackend
    searchKey?(
      keyword: string,
      listener: SearchKeyCallback,
      options: SearchOptions
    ): Promise<void>
    release(): void
  }

  export interface PdfBackend {
    /**
     * 打开文档。返回 null 表示无法解析（由 PdfDocument 归因为 PARSE_ERROR_FORMAT）。
     * 可通过抛出携带 code 的错误来表达加密等具体原因。
     */
    open(absPath: string): PdfDocumentBackend | null
    /**
     * 异步打开（桌面端 PDF.js 後端用）。
     * 鸿蒙的 loadDocument 是同步原生调用，Node 侧没有这条同步路可走，
     * 所以给后端留一个异步入口，由 PdfDocument.loadDocumentAsync 调用。
     */
    openAsync?(absPath: string): Promise<PdfDocumentBackend | null>
  }

  let backend: PdfBackend | null = null

  /** 由 bootstrap 调用（见 core/platform/native/pdfBackend.ts 的 installPdfJsBackend）；也便于测试注入假后端 */
  export function setPdfBackend(next: PdfBackend | null): void {
    backend = next
  }

  export function hasPdfBackend(): boolean {
    return backend !== null
  }

  export class PdfPage implements PdfPageBackend {
    private inner: PdfPageBackend

    constructor(inner: PdfPageBackend) {
      this.inner = inner
    }

    getTextContent(): string {
      return this.inner.getTextContent()
    }

    getGraphicsObjects(): GraphicsObject[] {
      return this.inner.getGraphicsObjects()
    }

    /** 对齐鸿蒙 PdfPage.getWidth() / getHeight()（页面原始尺寸，单位点） */
    getWidth(): number {
      return this.inner.getWidth()
    }

    getHeight(): number {
      return this.inner.getHeight()
    }

    /**
     * 对齐鸿蒙的 getPagePixelMap(默认分辨率)。
     * 桌面端请改用异步的 renderToPixelMap —— 主进程里没有同步可用的像素路径。
     */
    getPagePixelMap(): image.PixelMap {
      throw new Error('桌面端请使用异步的 renderToPixelMap（主进程没有同步像素路径）')
    }

    /** 对齐鸿蒙的 getAreaPixelMapWithOptions。同上，桌面端走 renderToPixelMap。 */
    getAreaPixelMapWithOptions(
      _matrix: PdfMatrix,
      _width: number,
      _height: number
    ): image.PixelMap {
      throw new Error('桌面端请使用异步的 renderToPixelMap（主进程没有同步像素路径）')
    }

    async renderToPixelMap(width: number, height: number): Promise<image.PixelMap> {
      return this.inner.renderToPixelMap(width, height)
    }

    /**
     * 准备这一页（桌面端后端是异步的，见 PdfPageBackend.prepare 的说明）。
     * 后端没实现或已经备好时是空操作。
     */
    async prepare(): Promise<void> {
      if (this.inner.prepare !== undefined) {
        await this.inner.prepare()
      }
    }

    release(): void {
      // 后端自行管理页对象生命周期
    }
  }

  export class PdfDocument {
    private inner: PdfDocumentBackend | null = null
    private opened: boolean = false

    loadDocument(absPath: string): ParseResult {
      if (backend === null) {
        return ParseResult.PARSE_ERROR_FORMAT
      }
      try {
        const doc: PdfDocumentBackend | null = backend.open(absPath)
        if (doc === null) {
          return ParseResult.PARSE_ERROR_FORMAT
        }
        this.inner = doc
        this.opened = true
        return ParseResult.PARSE_SUCCESS
      } catch (e) {
        const code: number | undefined = (e as { code?: number }).code
        if (code === ParseResult.PARSE_ERROR_PASSWORD || code === ParseResult.PARSE_ERROR_CERT) {
          return code
        }
        return ParseResult.PARSE_ERROR_FORMAT
      }
    }

    getPageCount(): number {
      return this.inner === null ? 0 : this.inner.getPageCount()
    }

    /**
     * 异步加载（桌面端 PDF.js 后端走这条）。
     *
     * 为什么必须有：鸿蒙的 loadDocument 是**同步**原生调用，端口代码里
     * 「loadDocument → getPageCount → getPage(i).getTextContent()」是一条同步链；
     * 而 Node 侧唯一的可用后端（PDF.js）从打开到取内容全是异步的。
     * 与其把整条链改成异步（会牵动大量移植代码），不如把异步只在这一个入口显式化：
     * 这里 await 一次，后面的同步访问器就都成立（页内容由 prepare() 预取）。
     */
    async loadDocumentAsync(absPath: string): Promise<ParseResult> {
      if (backend === null) {
        return ParseResult.PARSE_ERROR_FORMAT
      }
      try {
        const doc: PdfDocumentBackend | null =
          backend.openAsync !== undefined
            ? await backend.openAsync(absPath)
            : backend.open(absPath)
        if (doc === null) {
          return ParseResult.PARSE_ERROR_FORMAT
        }
        this.inner = doc
        this.opened = true
        return ParseResult.PARSE_SUCCESS
      } catch (e) {
        const code: number | undefined = (e as { code?: number }).code
        if (code === ParseResult.PARSE_ERROR_PASSWORD || code === ParseResult.PARSE_ERROR_CERT) {
          return code
        }
        return ParseResult.PARSE_ERROR_FORMAT
      }
    }

    getPage(index: number): PdfPage {
      if (this.inner === null) {
        throw new Error('PDF 文档尚未加载')
      }
      return new PdfPage(this.inner.getPage(index))
    }

    async searchKey(
      keyword: string,
      listener: SearchKeyCallback,
      options: SearchOptions
    ): Promise<void> {
      if (this.inner !== null && this.inner.searchKey !== undefined) {
        await this.inner.searchKey(keyword, listener, options)
        return
      }
      throw new Error('后端未实现 searchKey，请走逐页子串扫描兜底')
    }

    releaseDocument(): void {
      if (this.inner !== null && this.opened) {
        this.inner.release()
      }
      this.inner = null
      this.opened = false
    }
  }
}
