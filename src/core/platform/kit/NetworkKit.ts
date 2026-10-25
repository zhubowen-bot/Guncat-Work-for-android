// 平台适配层：鸿蒙 `@kit.NetworkKit` 的等价实现（Node 侧）
//
// 端口代码对 http 的用法分两类：
//   1. request(url, opts)            → 一次性请求，Promise<HttpResponse>
//   2. requestInStream(url, opts)    → 流式请求，先 on('dataReceive'/'dataEnd') 再调用，
//                                      Promise 以状态码兑现
// SSE 链路只依赖这两条语义。这里用全局 fetch（Node 内置 undici）实现，
// 并把响应体按 Web Streams 逐块读出来派发成 dataReceive 事件。
//
// 顺序兼容性说明：鸿蒙侧 requestInStream 的状态码回调与 dataEnd 事件先后顺序
// 没有保证，端口代码用 dataEnded 标志做了双向兼容，因此这里先派发 dataEnd
// 再让 Promise 兑现（或反之）都不会丢事件。
import { util } from './ArkTS'

export namespace http {
  export enum HttpDataType {
    STRING = 0,
    OBJECT = 1,
    ARRAY_BUFFER = 2
  }

  export enum RequestMethod {
    OPTIONS = 'OPTIONS',
    GET = 'GET',
    HEAD = 'HEAD',
    POST = 'POST',
    PUT = 'PUT',
    DELETE = 'DELETE',
    TRACE = 'TRACE',
    CONNECT = 'CONNECT'
  }

  export enum HttpProtocol {
    HTTP1_1 = 0,
    HTTP2 = 1,
    HTTP3 = 2
  }

  export enum ResponseCode {
    OK = 200,
    CREATED = 201,
    BAD_REQUEST = 400,
    UNAUTHORIZED = 401,
    FORBIDDEN = 403,
    NOT_FOUND = 404,
    TOO_MANY_REQUESTS = 429,
    INTERNAL_ERROR = 500
  }

  export type HttpHeader = Record<string, string>

  export interface HttpRequestOptions {
    method?: RequestMethod | string
    header?: HttpHeader | object
    extraData?: string | ArrayBuffer | Uint8Array | object
    expectDataType?: HttpDataType
    usingProtocol?: HttpProtocol
    connectTimeout?: number
    readTimeout?: number
    /** 允许自签名证书（端口代码未使用，保留以对齐签名） */
    caPath?: string
  }

  export interface HttpResponse {
    responseCode: number
    result: string | ArrayBuffer | object
    /** 响应头。端口代码按小写名直接索引（header['content-type']），故用 Record 对齐 */
    header: Record<string, string>
  }

  export type DataReceiveCallback = (data: ArrayBuffer) => void
  export type DataEndCallback = () => void
  export type HeadersReceiveCallback = (header: object) => void
  export type RequestCallback = (err: Error | null, data: HttpResponse) => void

  type StreamEvent = 'dataReceive' | 'dataEnd' | 'headersReceive'

  function headerToRecord(header: HttpHeader | object | undefined): Record<string, string> {
    const out: Record<string, string> = {}
    if (header === undefined || header === null) {
      return out
    }
    for (const key of Object.keys(header as Record<string, unknown>)) {
      const value: unknown = (header as Record<string, unknown>)[key]
      out[key] = String(value)
    }
    return out
  }

  function bodyToUint8(extraData: HttpRequestOptions['extraData']): Uint8Array | undefined {
    if (extraData === undefined || extraData === null) {
      return undefined
    }
    if (typeof extraData === 'string') {
      return new util.TextEncoder().encodeInto(extraData)
    }
    if (extraData instanceof Uint8Array) {
      return extraData
    }
    if (extraData instanceof ArrayBuffer) {
      return new Uint8Array(extraData)
    }
    // 对象：按 JSON 发送（鸿蒙侧同样行为）
    return new util.TextEncoder().encodeInto(JSON.stringify(extraData))
  }

  export class HttpRequest {
    private handlers: Map<StreamEvent, Array<(...args: never[]) => void>> = new Map()
    private controller: AbortController | null = null
    private destroyed: boolean = false
    /** 读空闲超时的预算（毫秒，0 = 不限）与当前计时器 */
    private readTimeoutMs: number = 0
    private readTimer: ReturnType<typeof setTimeout> | null = null
    /** 连接超时计时器（拿到响应头即撤） */
    private connectTimer: ReturnType<typeof setTimeout> | null = null

    on(event: StreamEvent, callback: (...args: never[]) => void): void {
      const list: Array<(...args: never[]) => void> = this.handlers.get(event) ?? []
      list.push(callback)
      this.handlers.set(event, list)
    }

    off(event: StreamEvent, callback?: (...args: never[]) => void): void {
      if (callback === undefined) {
        this.handlers.delete(event)
        return
      }
      const list: Array<(...args: never[]) => void> = this.handlers.get(event) ?? []
      const idx: number = list.indexOf(callback)
      if (idx >= 0) {
        list.splice(idx, 1)
      }
      this.handlers.set(event, list)
    }

    destroy(): void {
      this.destroyed = true
      this.clearTimers()
      if (this.controller !== null) {
        this.controller.abort()
        this.controller = null
      }
      this.handlers.clear()
    }

    private emit(event: StreamEvent, ...args: unknown[]): void {
      const list: Array<(...a: never[]) => void> = this.handlers.get(event) ?? []
      for (const fn of list.slice()) {
        try {
          ;(fn as (...a: unknown[]) => void)(...args)
        } catch {
          // 事件回调里的异常不应打断流读取
        }
      }
    }

    private buildSignal(options: HttpRequestOptions | undefined): AbortSignal {
      const controller: AbortController = new AbortController()
      this.controller = controller
      const readTimeout: number = options?.readTimeout ?? 0
      const connectTimeout: number = options?.connectTimeout ?? 0
      this.readTimeoutMs = readTimeout
      // 连接超时在 fetch 实现下覆盖的是「请求开始 → 拿到响应头」，
      // 上传请求体也在这段里，不只是 TCP 建连。大请求体（图片 base64）必须由
      // 调用方用 connectTimeoutForBody 放大预算，否则会在上传途中被 abort。
      if (connectTimeout > 0) {
        this.connectTimer = setTimeout(() => controller.abort(), connectTimeout)
        this.connectTimer.unref?.()
      }
      // 读超时是**读空闲**超时，不是整段超时：每收到一块数据都会重置（见 refreshReadTimer）。
      //
      // 这里曾经是一个一次性 setTimeout：只要请求开始后 N 毫秒就无条件掐断。
      // 而端口代码传的是鸿蒙的读空闲语义（工作模式 AgentLoopService 传 300000、
      // 聊天 ChatService 传 180000），于是**只要一轮流式超过 5 分钟就必然以网络错误中断** ——
      // 哪怕数据一直在流。长程工具任务最容易撞上，用户看到的是「回答跑到一半突然报错」。
      this.refreshReadTimer()
      controller.signal.addEventListener('abort', () => this.clearTimers(), { once: true })
      return controller.signal
    }

    /** 重新起表（读到数据 / 请求开始）。没设读超时就是空操作。 */
    private refreshReadTimer(): void {
      if (this.readTimeoutMs <= 0 || this.controller === null) {
        return
      }
      if (this.readTimer !== null) {
        clearTimeout(this.readTimer)
      }
      this.readTimer = setTimeout(() => {
        this.readTimer = null
        this.controller?.abort()
      }, this.readTimeoutMs)
      this.readTimer.unref?.()
    }

    private clearTimers(): void {
      if (this.readTimer !== null) {
        clearTimeout(this.readTimer)
        this.readTimer = null
      }
      if (this.connectTimer !== null) {
        clearTimeout(this.connectTimer)
        this.connectTimer = null
      }
    }

    private buildInit(options: HttpRequestOptions | undefined): RequestInit {
      const init: RequestInit = {
        method: String(options?.method ?? RequestMethod.GET),
        headers: headerToRecord(options?.header),
        signal: this.buildSignal(options)
      }
      const body: Uint8Array | undefined = bodyToUint8(options?.extraData)
      if (body !== undefined && init.method !== 'GET' && init.method !== 'HEAD') {
        // 复制到独立 ArrayBuffer，避免 undici 对共享 buffer 的视图报错
        init.body = body.slice().buffer as ArrayBuffer
      }
      return init
    }

    /** 一次性请求 */
    async request(
      url: string,
      options?: HttpRequestOptions,
      callback?: RequestCallback
    ): Promise<HttpResponse> {
      if (callback !== undefined) {
        // 回调形态：错误只交给回调，绝不产生未处理的 Promise 拒绝
        try {
          const response: HttpResponse = await this.request(url, options)
          callback(null, response)
        } catch (e) {
          callback(e as Error, { responseCode: 0, result: '', header: {} })
        }
        return { responseCode: 0, result: '', header: {} }
      }

      const response: Response = await fetch(url, this.buildInit(options))
      const wantBuffer: boolean = options?.expectDataType === HttpDataType.ARRAY_BUFFER
      let result: string | ArrayBuffer | object
      if (wantBuffer) {
        const buf: ArrayBuffer = await response.arrayBuffer()
        result = buf
      } else {
        result = await response.text()
      }
      const header: Record<string, string> = {}
      response.headers.forEach((value: string, key: string) => {
        header[key] = value
      })
      return {
        responseCode: response.status,
        result,
        header
      }
    }

    /**
     * 流式请求：边收边派发 dataReceive，结束时派发 dataEnd，Promise 兑现状态码。
     * 第三参数为可选回调形态（端口代码里 .request 用过，这里一并支持）。
     */
    async requestInStream(
      url: string,
      options?: HttpRequestOptions,
      callback?: RequestCallback
    ): Promise<number> {
      let statusCode: number = 0
      let header: Record<string, string> = {}
      let captured: Error | null = null

      try {
        const response: Response = await fetch(url, this.buildInit(options))
        statusCode = response.status
        response.headers.forEach((value: string, key: string) => {
          header[key] = value
        })
        // 拿到响应头说明连接早已建立，连接超时这一档可以撤了
        if (this.connectTimer !== null) {
          clearTimeout(this.connectTimer)
          this.connectTimer = null
        }
        this.emit('headersReceive', header)

        if (response.body !== null) {
          const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader()
          try {
            for (;;) {
              const chunk: ReadableStreamReadResult<Uint8Array> = await reader.read()
              if (chunk.done) {
                break
              }
              if (this.destroyed) {
                break
              }
              const value: Uint8Array = chunk.value
              // 切出独立 ArrayBuffer：端口代码会把它拼进累积缓冲
              const ab: ArrayBuffer = value.buffer.slice(
                value.byteOffset,
                value.byteOffset + value.byteLength
              ) as ArrayBuffer
              this.emit('dataReceive', ab)
              // 收到数据即重置读空闲计时（见 buildSignal 里对这次改动的说明）
              this.refreshReadTimer()
            }
          } finally {
            reader.releaseLock()
          }
        }
        this.emit('dataEnd')
      } catch (e) {
        captured = e as Error
        // 即便失败也要派发 dataEnd，避免端口代码停在半途
        this.emit('dataEnd')
      }

      if (callback !== undefined) {
        if (captured !== null) {
          callback(captured, { responseCode: statusCode, result: '', header })
        } else {
          callback(null, {
            responseCode: statusCode,
            result: '',
            header
          })
        }
        return statusCode
      }

      if (captured !== null) {
        throw captured
      }
      return statusCode
    }
  }

  export function createHttp(): HttpRequest {
    return new HttpRequest()
  }

  /** 供宿主下载二进制（PptxImage / WebFetch 等）使用的便捷封装 */
  export async function fetchBuffer(url: string, headers?: HttpHeader): Promise<ArrayBuffer> {
    const request: HttpRequest = createHttp()
    try {
      const resp: HttpResponse = await request.request(url, {
        method: RequestMethod.GET,
        header: headers,
        expectDataType: HttpDataType.ARRAY_BUFFER,
        readTimeout: 60000
      })
      if (resp.responseCode < 200 || resp.responseCode >= 300) {
        throw new Error('HTTP ' + String(resp.responseCode))
      }
      return resp.result as ArrayBuffer
    } finally {
      request.destroy()
    }
  }
}
