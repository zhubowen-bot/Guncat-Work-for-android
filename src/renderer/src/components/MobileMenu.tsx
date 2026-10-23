// 手机端「更多」面板：把桌面顶栏里塞不下的控制项收进一张底部抽屉。
// 这不是把桌面顶栏缩小 —— 手机上顶栏只保留标题与两个入口，其余操作按
// 「底部抽屉 + 大触控区」的移动端习惯重新排布。
import { useEffect } from 'react'
import type { ReactElement } from 'react'
import type { AgentMode } from '@ipc/contract'
import { useStore } from '../store'
import { MODE_HINT, agentById } from '../conversations'
import { IconClose, IconFolder, IconSettings, IconTable } from '../icons'

const MODES: Array<{ id: AgentMode; label: string }> = [
  { id: 'chat', label: '聊天' },
  { id: 'interactive', label: '交互' },
  { id: 'work', label: '工作' }
]

export function MobileMenu({ open, onClose }: { open: boolean; onClose: () => void }): ReactElement | null {
  const mode = useStore((s) => s.mode)
  const setMode = useStore((s) => s.setMode)
  const running = useStore((s) => s.running)
  const engines = useStore((s) => s.engines)
  const activeAgentId = useStore((s) => s.activeAgentId)
  const settings = useStore((s) => s.settings)
  const reloadSettings = useStore((s) => s.reloadSettings)
  const pushNotice = useStore((s) => s.pushNotice)
  const thinkingEnabled = useStore((s) => s.thinkingEnabled)
  const setThinking = useStore((s) => s.setThinking)
  const webSearchEnabled = useStore((s) => s.webSearchEnabled)
  const setWebSearch = useStore((s) => s.setWebSearch)
  const reasoningEffort = useStore((s) => s.reasoningEffort)
  const setReasoningEffort = useStore((s) => s.setReasoningEffort)
  const interactiveEffort = useStore((s) => s.interactiveEffort)
  const setInteractiveEffort = useStore((s) => s.setInteractiveEffort)
  const openSettings = useStore((s) => s.openSettings)
  const toggleWorkspace = useStore((s) => s.toggleWorkspace)
  const openTableOcr = useStore((s) => s.openTableOcr)
  const engine = agentById(engines, activeAgentId)

  useEffect(() => {
    if (!open) {
      return
    }
    const handler = (): void => onClose()
    window.addEventListener('popstate', handler)
    return () => window.removeEventListener('popstate', handler)
  }, [open, onClose])

  if (!open) {
    return null
  }

  const profiles = settings?.apiProfiles ?? []

  async function switchProfile(profileId: string): Promise<void> {
    if (profileId === settings?.currentApiProfileId) {
      return
    }
    try {
      await window.guncat.settings.selectApiProfile(profileId)
      await reloadSettings()
    } catch (e) {
      pushNotice('error', `切换配置失败：${String(e)}`)
    }
  }

  return (
    <div className="mobile-sheet-layer" onClick={onClose}>
      <div className="mobile-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="mobile-sheet__grabber" />
        <div className="mobile-sheet__head">
          <div>
            <strong>{engine?.name ?? '会话设置'}</strong>
            <small>{MODE_HINT[mode] ?? ''}</small>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            <IconClose size={18} />
          </button>
        </div>

        <div className="mobile-sheet__section">
          <span className="mobile-sheet__label">模式</span>
          <div className="segmented">
            {MODES.map((item) => (
              <button
                key={item.id}
                data-active={mode === item.id}
                disabled={running}
                onClick={() => {
                  setMode(item.id)
                  onClose()
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        {profiles.length > 0 ? (
          <label className="mobile-field">
            <span>模型配置</span>
            <select
              value={settings?.currentApiProfileId ?? ''}
              disabled={running}
              onChange={(e) => void switchProfile(e.target.value)}
            >
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.config.model !== '' ? `${profile.config.model} · ${profile.name}` : profile.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {mode !== 'chat' ? (
          <label className="mobile-field">
            <span>推理强度</span>
            <select
              value={mode === 'interactive' ? interactiveEffort : reasoningEffort}
              disabled={running}
              onChange={(e) =>
                mode === 'interactive'
                  ? setInteractiveEffort(e.target.value)
                  : setReasoningEffort(e.target.value)
              }
            >
              {mode === 'interactive' ? (
                <>
                  <option value="high">均衡</option>
                  <option value="low">快速</option>
                  <option value="off">关闭</option>
                </>
              ) : (
                <>
                  <option value="max">极高</option>
                  <option value="high">均衡</option>
                  <option value="low">快速</option>
                </>
              )}
            </select>
          </label>
        ) : null}

        <div className="mobile-switches">
          {mode === 'chat' ? (
            <button
              className="mobile-switch"
              data-on={thinkingEnabled}
              onClick={() => setThinking(!thinkingEnabled)}
            >
              <span>深度思考</span>
              <small>按协议显式控制</small>
            </button>
          ) : null}
          <button
            className="mobile-switch"
            data-on={webSearchEnabled}
            onClick={() => setWebSearch(!webSearchEnabled)}
          >
            <span>联网搜索</span>
            <small>服务端搜索能力</small>
          </button>
        </div>

        <div className="mobile-sheet__actions">
          <button
            onClick={() => {
              toggleWorkspace(true)
              onClose()
            }}
          >
            <IconFolder size={18} />
            工作区
          </button>
          <button
            onClick={() => {
              openTableOcr(true)
              onClose()
            }}
          >
            <IconTable size={18} />
            表格提取
          </button>
          <button
            onClick={() => {
              openSettings(true)
              onClose()
            }}
          >
            <IconSettings size={18} />
            设置
          </button>
        </div>
      </div>
    </div>
  )
}
