// 语音输入（ASR）：桌面端的实现路径与鸿蒙侧不同，这里如实说明取舍。
//
// 鸿蒙版用 CoreSpeechKit 做**端侧**语音识别，不需要任何配置。
// 桌面端没有等价能力可用：
//   - Chromium 的 SpeechRecognition 在 Electron 里依赖 Google 语音服务凭据，默认不可用；
//   - 端侧识别模型（whisper.cpp 之类）又是另一个量级的依赖。
//
// 因此这里走**录音 + 服务商转写接口**：渲染进程用 MediaRecorder 录音，
// 主进程把音频 POST 到 OpenAI 兼容的 `/audio/transcriptions`。
// 配置默认复用「多模态预解析」那一组（baseUrl / apiKey），模型名可用偏好覆盖，
// 这样不需要用户再理解一套新的配置块；服务商不支持转写时，功能会明确报错而不是静默失败。
import { appContext } from '@core/platform/kit/AbilityKit'
import { StorageManager } from '@core/data/StorageManager'

export interface AsrConfig {
  baseUrl: string
  apiKey: string
  model: string
}

export interface AsrResult {
  ok: boolean
  text: string
  error: string
}

export const ASR_DEFAULT_MODEL = 'whisper-1'

/** 偏好键（与朗读偏好同样存在 Preferences 里） */
export const ASR_PREF_BASE_URL = 'asr_baseUrl'
export const ASR_PREF_API_KEY = 'asr_apiKey'
export const ASR_PREF_MODEL = 'asr_model'

/**
 * 拼转写端点。Base URL 可能写成：
 *   https://api.openai.com/v1        → https://api.openai.com/v1/audio/transcriptions
 *   https://api.openai.com/v1/       → 同上
 *   https://api.openai.com           → https://api.openai.com/audio/transcriptions
 *   https://x/v1/audio/transcriptions → 原样
 */
export function resolveTranscriptionUrl(baseUrl: string): string {
  const trimmed: string = baseUrl.trim().replace(/\/+$/, '')
  if (trimmed === '') {
    return ''
  }
  if (trimmed.endsWith('/audio/transcriptions')) {
    return trimmed
  }
  return `${trimmed}/audio/transcriptions`
}

/** 解析 ASR 配置：专用偏好优先，缺省回落到多模态预解析配置 */
export async function loadAsrConfig(): Promise<AsrConfig> {
  const ctx: Context = appContext()
  let baseUrl = ''
  let apiKey = ''
  let model = ''
  try {
    baseUrl = await StorageManager.loadString(ctx, ASR_PREF_BASE_URL, '')
    apiKey = await StorageManager.loadString(ctx, ASR_PREF_API_KEY, '')
    model = await StorageManager.loadString(ctx, ASR_PREF_MODEL, '')
  } catch {
    // 读取失败按未配置处理
  }

  if (baseUrl === '' || apiKey === '') {
    try {
      const mm = await StorageManager.loadMultimodalConfig(ctx)
      if (baseUrl === '') {
        baseUrl = mm.baseUrl
      }
      if (apiKey === '') {
        apiKey = mm.apiKey
      }
    } catch {
      // 多模态配置也不可用时保持空值
    }
  }

  return {
    baseUrl,
    apiKey,
    model: model !== '' ? model : ASR_DEFAULT_MODEL
  }
}

/** 文件扩展名 → MIME，供 multipart 使用 */
export function mimeForAudio(mime: string): string {
  return mime !== '' ? mime : 'audio/webm'
}

/**
 * 调用转写接口。audio 为原始音频字节。
 * 失败时返回可读原因，不抛异常（调用方是 UI，需要能显示）。
 */
export async function transcribeAudio(
  audio: Uint8Array,
  mime: string
): Promise<AsrResult> {
  if (audio.byteLength === 0) {
    return { ok: false, text: '', error: '没有录到音频' }
  }

  const config: AsrConfig = await loadAsrConfig()
  if (config.baseUrl === '' || config.apiKey === '') {
    return {
      ok: false,
      text: '',
      error: '尚未配置语音识别服务（请在设置里填写转写 Base URL 与 API Key，或先配好多模态预解析）'
    }
  }

  const url: string = resolveTranscriptionUrl(config.baseUrl)
  if (url === '') {
    return { ok: false, text: '', error: '语音识别服务地址无效' }
  }

  try {
    const form = new FormData()
    form.append('model', config.model)
    form.append('language', 'zh')
    // 注意：TS 里 Uint8Array 的 buffer 类型是 ArrayBufferLike（含 SharedArrayBuffer），
    // 不能直接当 BlobPart，需显式切出独立 ArrayBuffer。
    const payload: ArrayBuffer = audio.buffer.slice(
      audio.byteOffset,
      audio.byteOffset + audio.byteLength
    ) as ArrayBuffer
    form.append('file', new Blob([payload], { type: mimeForAudio(mime) }), 'audio.webm')

    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body: form
    })

    const raw: string = await response.text()
    if (response.status < 200 || response.status >= 300) {
      return {
        ok: false,
        text: '',
        error: `语音识别失败 (${response.status}): ${raw.slice(0, 200)}`
      }
    }

    let text = ''
    try {
      const parsed = JSON.parse(raw) as { text?: string }
      text = typeof parsed.text === 'string' ? parsed.text : ''
    } catch {
      // 非 JSON 响应：原样当作文本
      text = raw
    }
    text = text.trim()
    if (text === '') {
      return { ok: false, text: '', error: '语音识别返回为空' }
    }
    return { ok: true, text, error: '' }
  } catch (e) {
    return {
      ok: false,
      text: '',
      error: `语音识别请求失败: ${(e as Error)?.message ?? String(e)}`
    }
  }
}
