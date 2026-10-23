// WebView 里直接 fetch 第三方 API 会被 CORS 拦住（很多模型服务不返回
// Access-Control-Allow-Origin，或者不允许自定义 Authorization 预检）。
// Android 外壳在 127.0.0.1 上起了一个同源代理：/__fetch?url=...
// 这里把跨域请求改道到它。代理保留流式响应，SSE 照常逐块到达。
import { androidBridge } from './bridge'

const rawFetch = typeof window !== 'undefined' ? window.fetch.bind(window) : fetch

function shouldProxy(url: string): boolean {
  if (androidBridge() === null) {
    return false
  }
  try {
    const parsed = new URL(url, location.href)
    if (parsed.origin === location.origin) {
      return false
    }
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

export function installFetchProxy(): void {
  if (androidBridge() === null) {
    return
  }
  const token = window.__GUNCAT_NATIVE__?.token ?? ''
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let url: string
    if (typeof input === 'string') {
      url = input
    } else if (input instanceof URL) {
      url = input.toString()
    } else {
      url = input.url
    }
    if (!shouldProxy(url)) {
      return rawFetch(input as RequestInfo, init)
    }
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    headers.set('X-Guncat-Token', token)
    const proxied = `${location.origin}/__fetch?url=${encodeURIComponent(url)}`
    return rawFetch(proxied, {
      method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
      headers,
      body: init?.body ?? (input instanceof Request ? input.body : undefined),
      redirect: 'follow',
      signal: init?.signal ?? (input instanceof Request ? input.signal : undefined),
      duplex: 'half'
    } as RequestInit)
  }
}
