// 朗读控制条：对应鸿蒙版可拖动的朗读控制条（这里固定在底部，桌面端不需要拖动）。
import { useSpeech } from '../speech/speechStore'
import { IconClose, IconPause, IconPlay, IconSpeaker } from '../icons'

export function SpeechBar() {
  const speaking = useSpeech((s) => s.speaking)
  const paused = useSpeech((s) => s.paused)
  const progress = useSpeech((s) => s.progress)
  const rate = useSpeech((s) => s.rate)
  const voices = useSpeech((s) => s.voices)
  const voiceURI = useSpeech((s) => s.voiceURI)
  const setRate = useSpeech((s) => s.setRate)
  const setVoice = useSpeech((s) => s.setVoice)
  const pause = useSpeech((s) => s.pause)
  const resume = useSpeech((s) => s.resume)
  const stop = useSpeech((s) => s.stop)
  const native = useSpeech((s) => s.native)

  if (!speaking) {
    return null
  }

  return (
    <div className="speech-bar">
      <span className="speech-bar__icon">
        <IconSpeaker size={16} />
      </span>

      {!native ? (
        <button
          className="icon-btn"
          title={paused ? '继续朗读' : '暂停朗读'}
          onClick={() => (paused ? resume() : pause())}
        >
          {paused ? <IconPlay size={16} /> : <IconPause size={16} />}
        </button>
      ) : null}

      <div className="speech-bar__progress">
        <div className="speech-bar__progress-fill" style={{ width: `${progress * 100}%` }} />
      </div>

      <label className="speech-bar__field" title="语速">
        <span>倍速</span>
        <input
          type="range"
          min="0.5"
          max="3"
          step="0.1"
          value={rate}
          onChange={(e) => setRate(Number(e.target.value))}
        />
        <span className="speech-bar__value">{rate.toFixed(1)}×</span>
      </label>

      {voices.length > 0 && !native ? (
        <label className="speech-bar__field" title="音色">
          <span>音色</span>
          <select
            className="speech-bar__select"
            value={voiceURI}
            onChange={(e) => setVoice(e.target.value)}
          >
            {voices.map((v) => (
              <option key={v.uri} value={v.uri}>
                {v.name} ({v.lang})
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <button className="icon-btn" title="关闭朗读" onClick={stop}>
        <IconClose size={15} />
      </button>
    </div>
  )
}
