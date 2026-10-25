// 与大请求体相关的 HTTP 超时口径。
//
// 为什么需要它（用户报障）：view_image 之后图片会以 base64 内联进下一条请求，
// 请求体可达 10MB+。端口代码里的 `connectTimeout` 在 fetch 实现下**不是纯 TCP 建连超时**：
// 它从请求开始计时，直到拿到响应头才撤销；上传请求体也在这段时间里。于是 30s 一到，
// AbortController 会在上传途中掐断请求，浏览器给出的错误是
// "The user aborted a request"（AbortError）。请求级重试又带着同一张图重发，
// 五次都卡在同一个 30s 上 —— 表现就是「image 工具之后一直重连不上」。
//
// 这里按请求体大小给上传留预算，并统一把 AbortError 翻译成可读的「传输超时」。

/** 请求体超过该大小时才增加上传预算，小请求维持原来的 30s */
const BODY_SLOW_PATH_BYTES: number = 256 * 1024
/** 上传预算按这个保守速率折算（手机上行常见 100KB/s 左右） */
const ASSUMED_UPLOAD_BYTES_PER_SECOND: number = 100 * 1024
/** 上限：再慢也不把一次请求拖过 3 分钟 */
const MAX_CONNECT_TIMEOUT_MS: number = 180_000

/**
 * 按请求体大小计算 connectTimeout。
 * 公式：基础 30s + 保守上传耗时，封顶 180s；小请求不受影响。
 */
export function connectTimeoutForBody(body: string, baseMs: number = 30_000): number {
  const bytes: number = body.length
  if (bytes <= BODY_SLOW_PATH_BYTES) {
    return baseMs
  }
  const uploadMs: number = Math.ceil((bytes / ASSUMED_UPLOAD_BYTES_PER_SECOND) * 1000)
  return Math.min(MAX_CONNECT_TIMEOUT_MS, baseMs + uploadMs)
}

/**
 * 把浏览器/undici 的 AbortError 翻译成人话。
 * 用户主动停止走的是 abortSignal，不会进到这里；能到这里的 abort 基本都是本机超时。
 */
export function describeTransportError(error: Error): string {
  const name: string = (error as unknown as { name?: string }).name ?? ''
  const message: string = error.message !== undefined ? error.message : ''
  if (name === 'AbortError' || /user aborted|aborted a request|aborted/i.test(message)) {
    return '请求在传输阶段超时被中止（请求体过大或网络过慢，已自动重试）'
  }
  return message !== '' ? message : '网络请求失败'
}
