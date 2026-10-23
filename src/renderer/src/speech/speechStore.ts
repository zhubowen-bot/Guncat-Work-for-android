// 朗读（TTS）：桌面端用 Web Speech API（speechSynthesis）实现，
// 对应鸿蒙版的 CoreSpeechKit 朗读。
//
// 与鸿蒙版的差异（如实记录）：
//   - 音色来自系统/浏览器提供的 voice 列表，不再是 CoreSpeechKit 的设备音色；
//   - 不需要 AVSession 与后台长时任务 —— 桌面端没有这类概念；
//   - 进度用 onboundary（逐词）近似，粒度比 CoreSpeechKit 略粗。
import { create } from 'zustand'
import type { GuncatApi } from '../env'

export interface SpeechVoice {
  uri: string
  name: string
  lang: string
  isDefault: boolean
}

interface SpeechState {
  supported: boolean
  voices: SpeechVoice[]
  speaking: boolean
  paused: boolean
  /** 正在朗读的消息 id + 文本（用于高亮与「重播」） */
  messageId: string
  text: string
  /** 0..1，由 onboundary 的字符位置估算 */
  progress: number
  voiceURI: string
  rate: number
  loaded: boolean
  /**
   * 自动朗读：每轮回答结束后自动念一遍。
   * 对齐原版 ChatPage 的 autoReadEnabled 开关（持久化在 reader_enabled）。
   */
  autoRead: boolean
  /** 是否使用宿主提供的系统 TTS（Android）；false 时走 Web Speech API */
  native: boolean

  init(): Promise<void>
  setVoice(uri: string): void
  setRate(rate: number): void
  setAutoRead(value: boolean): void
  speak(messageId: string, text: string): void
  pause(): void
  resume(): void
  stop(): void
}

const PREF_VOICE = 'reader_voice'
const PREF_RATE = 'reader_rate'
const PREF_AUTO_READ = 'reader_enabled'

function api(): SpeechSynthesis | null {
  if (typeof window === 'undefined' || typeof window.speechSynthesis === 'undefined') {
    return null
  }
  return window.speechSynthesis
}

/** 剥掉 Markdown 语法，朗读时不要念出星号和井号 */
export function speechTextOf(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, '（代码块）')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\*([^*]*)\*/g, '$1')
    .replace(/~~([^~]*)~~/g, '$1')
    .replace(/\|/g, ' ')
    .replace(/\$\$?[^$]*\$\$?/g, '（公式）')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

let boundaryHandler: ((e: SpeechSynthesisEvent) => void) | null = null
let nativeTimer: ReturnType<typeof setInterval> | null = null

function clearNativeTimer(): void {
  if (nativeTimer !== null) {
    clearInterval(nativeTimer)
    nativeTimer = null
  }
}

function nativeTts(): NonNullable<GuncatApi['speech']> | null {
  const api = typeof window === 'undefined' ? undefined : window.guncat?.speech
  return api !== undefined && api.supported === true ? api : null
}

export const useSpeech = create<SpeechState>((set, get) => ({
  supported: false,
  voices: [],
  speaking: false,
  paused: false,
  messageId: '',
  text: '',
  progress: 0,
  voiceURI: '',
  rate: 1.5,
  loaded: false,
  autoRead: false,
  native: false,

  async init() {
    const native = nativeTts()
    if (native !== null) {
      let rate = 1.5
      let autoRead = false
      try {
        const settings = await window.guncat.settings.load()
        const savedRate = settings.prefs?.[PREF_RATE] ?? ''
        autoRead = settings.prefs?.[PREF_AUTO_READ] === 'true'
        if (savedRate !== '') {
          const parsed = Number(savedRate)
          if (!Number.isNaN(parsed) && parsed > 0) {
            rate = parsed
          }
        }
      } catch {
        // 默认值
      }
      set({
        supported: true,
        native: true,
        voices: [{ uri: 'system', name: '系统语音', lang: 'zh-CN', isDefault: true }],
        voiceURI: 'system',
        rate,
        autoRead,
        loaded: true
      })
      return
    }

    const synth = api()
    if (synth === null) {
      set({ supported: false, loaded: true })
      return
    }

    const loadVoices = (): SpeechVoice[] =>
      synth.getVoices().map((v) => ({
        uri: v.voiceURI,
        name: v.name,
        lang: v.lang,
        isDefault: v.default
      }))

    // 部分平台首次调用时音色列表为空，需要等 voiceschanged
    let voices: SpeechVoice[] = loadVoices()
    if (voices.length === 0) {
      voices = await new Promise<SpeechVoice[]>((resolve) => {
        const timer = window.setTimeout(() => resolve(loadVoices()), 1500)
        synth.addEventListener(
          'voiceschanged',
          () => {
            window.clearTimeout(timer)
            resolve(loadVoices())
          },
          { once: true }
        )
      })
    }

    // 读取上次保存的音色与语速
    let voiceURI = ''
    let rate = 1.5
    let autoRead = false
    try {
      const settings = await window.guncat.settings.load()
      const savedVoice = settings.prefs?.[PREF_VOICE] ?? ''
      const savedRate = settings.prefs?.[PREF_RATE] ?? ''
      // 缺省为关：自动朗读会在每轮回答后出声，必须由用户显式打开
      autoRead = settings.prefs?.[PREF_AUTO_READ] === 'true'
      if (savedVoice !== '') {
        voiceURI = savedVoice
      }
      if (savedRate !== '') {
        const parsed = Number(savedRate)
        if (!Number.isNaN(parsed) && parsed > 0) {
          rate = parsed
        }
      }
    } catch {
      // 读取失败就用默认值
    }

    // 偏好音色不在列表里时，回退到默认女声，再回退到第一个
    if (voiceURI !== '' && !voices.some((v) => v.uri === voiceURI)) {
      voiceURI = ''
    }
    if (voiceURI === '') {
      const female = voices.find((v) => /female|女|Xiaoxiao|Huihui|Zira|Samantha/i.test(v.name))
      voiceURI = (female ?? voices.find((v) => v.isDefault) ?? voices[0])?.uri ?? ''
    }

    set({ supported: true, voices, voiceURI, rate, loaded: true, autoRead })
  },

  setVoice(uri) {
    set({ voiceURI: uri })
    void window.guncat.settings.saveString(PREF_VOICE, uri)
  },

  setAutoRead(value) {
    set({ autoRead: value })
    void window.guncat.settings.saveString(PREF_AUTO_READ, value ? 'true' : 'false')
    // 关掉自动朗读时，正在念的这句也停掉 —— 否则「关了还在响」
    if (!value && get().speaking) {
      get().stop()
    }
  },

  setRate(rate) {
    const clamped = Math.max(0.5, Math.min(3, rate))
    set({ rate: clamped })
    void window.guncat.settings.saveString(PREF_RATE, String(clamped))
    // 朗读中改语速：重启当前这句以立即生效（Web Speech 不支持动态改 rate）
    if (get().speaking) {
      const { messageId, text } = get()
      get().speak(messageId, text)
    }
  },

  speak(messageId, text) {
    const native = nativeTts()
    if (native !== null) {
      if (text.trim() === '') {
        return
      }
      clearNativeTimer()
      native.stop()
      const { rate } = get()
      const startedAt = Date.now()
      const duration = Math.max(1500, (text.length / Math.max(1, rate * 4.5)) * 1000)
      set({ speaking: true, paused: false, messageId, text, progress: 0 })
      native.speak(text, rate)
      nativeTimer = setInterval(() => {
        const progress = Math.min(0.98, (Date.now() - startedAt) / duration)
        if (progress >= 0.98) {
          clearNativeTimer()
          set({ speaking: false, paused: false, progress: 1 })
          return
        }
        set({ progress })
      }, 400)
      return
    }

    const synth = api()
    if (synth === null || text.trim() === '') {
      return
    }
    synth.cancel()

    const utterance = new SpeechSynthesisUtterance(text)
    const { voiceURI, rate } = get()
    const voice = synth.getVoices().find((v) => v.voiceURI === voiceURI)
    if (voice !== undefined) {
      utterance.voice = voice
      utterance.lang = voice.lang
    }
    utterance.rate = rate

    if (boundaryHandler !== null) {
      synth.removeEventListener?.('boundary', boundaryHandler as EventListener)
      boundaryHandler = null
    }
    const handler = (e: SpeechSynthesisEvent): void => {
      const total = text.length
      if (total > 0 && typeof e.charIndex === 'number') {
        set({ progress: Math.max(0, Math.min(1, e.charIndex / total)) })
      }
    }
    boundaryHandler = handler
    utterance.onboundary = handler

    utterance.onend = (): void => {
      set({ speaking: false, paused: false, progress: 1 })
    }
    utterance.onerror = (): void => {
      set({ speaking: false, paused: false })
    }

    set({ speaking: true, paused: false, messageId, text, progress: 0 })
    synth.speak(utterance)
  },

  pause() {
    if (get().native) {
      // 系统 TTS 没有可靠的暂停/续播接口：按停止处理，界面收起朗读条
      get().stop()
      return
    }
    api()?.pause()
    set({ paused: true })
  },

  resume() {
    if (get().native) {
      return
    }
    api()?.resume()
    set({ paused: false })
  },

  stop() {
    clearNativeTimer()
    if (get().native) {
      window.guncat.speech?.stop()
    } else {
      api()?.cancel()
    }
    set({ speaking: false, paused: false, progress: 0 })
  }
}))
