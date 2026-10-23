import { useEffect, useMemo, useRef, useState } from 'react'
import type { PickedAttachmentDto, WorkspaceEntryDto } from '@ipc/contract'
import { useAutoResize } from '../hooks/useAutoResize'
import { useVoiceInput } from '../speech/useVoiceInput'
import { useStore } from '../store'
import { MODE_HINT } from '../conversations'
import { AttachmentBar } from './AttachmentBar'
import {
  detectMention,
  MentionPopup,
  MENTION_MAX_ROWS,
  rankMentionCandidates,
  type MentionQuery
} from './MentionPopup'
import {
  IconCamera,
  IconGlobe,
  IconMic,
  IconPaperclip,
  IconRefresh,
  IconSend,
  IconSteer,
  IconStop,
  IconStopCircle
} from '../icons'

interface Props {
  running: boolean
  mode: string
  /** 发送。附件只在聊天模式有意义（工作/交互模式走的是工作区，不是附件直传） */
  onSend(text: string, attachmentPaths: string[]): void
  /** 执行中插话（工作/交互模式）；返回是否被接受 */
  onSteer(text: string): Promise<boolean>
  onAbort(): void
}

export function Composer({ running, mode, onSend, onSteer, onAbort }: Props) {
  const [text, setText] = useState('')
  // 已选附件。原版输入区就是这样一条预览带：缩略图 + 文件名 + 逐项删除。
  // 状态改为三态（解析中 / 已就绪 / 解析失败）：pick 立刻返回的是「解析中」，
  // 真正的解析结果由主进程的 attachment:parsed 事件推进（见下面的订阅）。
  // 附件仍然只放在这里，不进 store —— 它只在这个组件里被消费。
  const [attachments, setAttachments] = useState<PickedAttachmentDto[]>([])
  // @ 文件引用的输入态：null = 当前没有正在敲的引用
  const [mention, setMention] = useState<MentionQuery | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [wsFiles, setWsFiles] = useState<WorkspaceEntryDto[]>([])
  // 选完文件要把光标放回插入点之后，setText 之后在 effect 里落地（那时 DOM 才是新值）
  const pendingCaret = useRef<number | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)
  useAutoResize(ref, text)

  const pendingDraft = useStore((s) => s.pendingDraft)
  const consumeDraft = useStore((s) => s.consumeDraft)
  const pushNotice = useStore((s) => s.pushNotice)
  const activeId = useStore((s) => s.activeId)
  const pickWorkspaceFiles = useStore((s) => s.pickWorkspaceFiles)
  const settings = useStore((s) => s.settings)
  const reloadSettings = useStore((s) => s.reloadSettings)
  const reasoningEffort = useStore((s) => s.reasoningEffort)
  const setReasoningEffort = useStore((s) => s.setReasoningEffort)
  const interactiveEffort = useStore((s) => s.interactiveEffort)
  const setInteractiveEffort = useStore((s) => s.setInteractiveEffort)
  const webSearchEnabled = useStore((s) => s.webSearchEnabled)
  const setWebSearch = useStore((s) => s.setWebSearch)
  const thinkingEnabled = useStore((s) => s.thinkingEnabled)
  const setThinking = useStore((s) => s.setThinking)
  const profiles = settings?.apiProfiles ?? []

  // 消息操作行的「编辑 / 重新编辑」把文本塞进这里，并聚焦回输入框
  useEffect(() => {
    if (pendingDraft === null) {
      return
    }
    setText(pendingDraft.text)
    consumeDraft()
    const element = ref.current
    if (element !== null) {
      element.focus()
      element.setSelectionRange(element.value.length, element.value.length)
    }
  }, [pendingDraft, consumeDraft])

  // 订阅主进程的附件解析结果：选完文件返回的是「解析中」，解析是后台逐个做的，
  // 不订阅这条事件，卡片会永远停在「解析中...」（既发不出去，也没有失败原因）。
  useEffect(() => {
    return window.guncat.onEvent((event) => {
      if (event.type !== 'attachment:parsed') {
        return
      }
      setAttachments((prev) =>
        prev.map((a) =>
          a.path === event.path ? { ...a, status: event.status, error: event.error } : a
        )
      )
    })
  }, [])

  const voice = useVoiceInput((spoken) => {
    setText((prev) => (prev.trim() === '' ? spoken : `${prev}${spoken}`))
  })

  // 切模式时清空草稿与附件，避免误发到别的会话
  useEffect(() => {
    setText('')
    setAttachments([])
    setMention(null)
  }, [mode])

  // @ 引用只在有工作区的形态给：聊天模式的素材入口是附件直传，跟工作区文件不是一条路
  const mentionEnabled = mode !== 'chat'
  const mentionStart = mention === null ? -1 : mention.start
  const mentionRows = useMemo(
    () => (mention === null ? [] : rankMentionCandidates(wsFiles, mention.query, MENTION_MAX_ROWS)),
    [mention, wsFiles]
  )

  // 一次 @ 只打一次 IPC：列出这个会话工作区里的文件作为候选（不随每次按键重拉）
  useEffect(() => {
    if (mentionStart < 0 || activeId === null) {
      return
    }
    let alive = true
    window.guncat.workspace
      .list(activeId)
      .then((list) => {
        if (alive) {
          setWsFiles(list)
        }
      })
      .catch(() => {
        if (alive) {
          setMention(null)
        }
      })
    return () => {
      alive = false
    }
  }, [mentionStart, activeId])

  // 插入文件名之后把光标放回引用串末尾，用户可以直接接着打字
  useEffect(() => {
    const target = pendingCaret.current
    if (target === null) {
      return
    }
    pendingCaret.current = null
    const element = ref.current
    if (element !== null) {
      element.focus()
      element.setSelectionRange(target, target)
    }
  }, [text])

  /** 每次文本或光标变化都要重判：还在敲引用就开着弹层，敲完/移开就收掉 */
  function syncMention(next: string, caret: number): void {
    if (!mentionEnabled) {
      setMention(null)
      return
    }
    const found = detectMention(next, caret)
    setMention(found)
    setMentionIndex(0)
  }

  /** 把选中的路径接进文本，替换掉 @ 到光标之间已敲的片段 */
  function applyMention(path: string): void {
    if (mention === null) {
      return
    }
    const inserted = '@' + path + ' '
    const next = text.slice(0, mention.start) + inserted + text.slice(mention.caret)
    pendingCaret.current = mention.start + inserted.length
    setText(next)
    setMention(null)
  }

  async function pickAttachments(source: 'file' | 'camera' = 'file'): Promise<void> {
    try {
      const picked = await window.guncat.attachments.pick(source)
      if (picked.length === 0) {
        return
      }
      // 同名同路径去重，避免重复点两次加进来两份
      setAttachments((prev) => {
        const seen = new Set(prev.map((a) => a.path))
        return [...prev, ...picked.filter((a) => !seen.has(a.path))]
      })
    } catch (e) {
      pushNotice('error', `选择附件失败：${String(e)}`)
    }
  }

  /** 手机输入区的上传入口：聊天模式进附件，工作/交互模式进工作区 */
  async function pickUpload(source: 'file' | 'camera' = 'file'): Promise<void> {
    if (mode === 'chat') {
      await pickAttachments(source)
      return
    }
    await pickWorkspaceFiles(source)
  }

  /** 顶栏模型胶囊的等价物：切换配置方案后重读设置 */
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

  /** 还有附件在主进程后台解析时：既不能发，也不能再叠加新文件 */
  const parsing = attachments.some((a) => a.status === 'parsing')

  function submit(): void {
    const value = text.trim()
    if (value === '' && attachments.length === 0) {
      return
    }
    // 原版 sendMessage 的守卫：文件还在解析时不允许发送（提示语逐字一致）。
    // 「解析失败」的仍然带上：主进程对它做过兜底（先行解析失败会退回 Base64 内联），
    // 真正不可用的（文件没了/读不出来）由主进程跳过并给出提示 —— 这里看不出来是哪一种，
    // 一律丢掉会让用户连一张本来能直传的图片都发不出去。
    if (parsing) {
      pushNotice('warn', '文件解析中，请稍候')
      return
    }
    // 执行中按回车也要有意义（对齐原版 sendMessage）：工作模式会变成插话，
    // 其他形态由 store 提示「AI 正在回复中，请稍候」。所以这里不再因为 running 直接吞掉输入。
    onSend(
      value,
      attachments.map((a) => a.path)
    )
    setText('')
    setAttachments([])
  }

  /**
   * 执行中插话：文本进插话队列，在**下一轮开始前**并入消息（不打断当前请求）。
   * 主进程说「当前没在跑」时就退回普通发送，免得文本挂在队列里等下一次任务。
   */
  async function steer(): Promise<void> {
    const value = text.trim()
    if (value === '') {
      return
    }
    // 与发送同一道守卫：解析中不插话（插话会立刻并入下一轮，附件却还没就绪）
    if (parsing) {
      pushNotice('warn', '文件解析中，请稍候')
      return
    }
    const accepted = await onSteer(value)
    setText('')
    if (!accepted) {
      onSend(value, [])
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    const composing: boolean = e.nativeEvent.isComposing
    // 弹层开着时先接管导航键：这里的 Enter 是「插入选中的文件」，不是发送
    // （输入法正在候选确认中的 Enter 不参与，交给 IME 自己吃掉）
    if (mention !== null && mentionRows.length > 0 && !composing) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionIndex((i) => (i + 1) % mentionRows.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionIndex((i) => (i - 1 + mentionRows.length) % mentionRows.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        applyMention(mentionRows[Math.min(mentionIndex, mentionRows.length - 1)])
        return
      }
    }
    if (e.key === 'Escape' && mention !== null) {
      e.preventDefault()
      setMention(null)
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && !composing) {
      e.preventDefault()
      submit()
    }
  }

  // 手机输入框的字数很少：占位符一长就换行，把输入区顶得很高。
  // 详细说明留给 `MODE_HINT`（桌面底部提示），这里只留动作本身。
  const placeholder =
    mode === 'chat' ? '发消息…' : mode === 'interactive' ? '描述界面…' : '交代任务…'

  return (
    <div className="composer">
      <AttachmentBar
        attachments={attachments}
        onRemove={(target) => setAttachments((prev) => prev.filter((a) => a.path !== target))}
      />

      {mention !== null && mentionRows.length > 0 ? (
        <MentionPopup
          paths={mentionRows}
          active={Math.min(mentionIndex, mentionRows.length - 1)}
          onPick={(index) => applyMention(mentionRows[index])}
        />
      ) : null}

      {/* 手机上把顶栏的模型 / 推理 / 联网收进输入框上方的胶囊，避免顶栏挤成一排 */}
      <div className="composer__chips">
        {profiles.length > 0 ? (
          <label className="composer-chip" title="当前模型配置（切换即换模型与接入地址）">
            <select
              value={settings?.currentApiProfileId ?? ''}
              disabled={running}
              onChange={(e) => void switchProfile(e.target.value)}
            >
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.config.model !== '' ? profile.config.model : profile.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {mode !== 'chat' ? (
          <label className="composer-chip" title="推理强度">
            <span>推理</span>
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

        {mode === 'chat' ? (
          <button
            type="button"
            className="composer-chip composer-chip--toggle"
            data-on={thinkingEnabled}
            onClick={() => setThinking(!thinkingEnabled)}
          >
            思考
          </button>
        ) : null}

        <button
          type="button"
          className="composer-chip composer-chip--toggle"
          data-on={webSearchEnabled}
          onClick={() => setWebSearch(!webSearchEnabled)}
        >
          <IconGlobe size={13} />
          联网
        </button>
      </div>

      <div className="composer__inner">
        <div className="composer__field">
          <textarea
            ref={ref}
            value={text}
            placeholder={placeholder}
            onChange={(e) => {
              setText(e.target.value)
              syncMention(e.target.value, e.target.selectionStart ?? e.target.value.length)
            }}
            onClick={(e) => syncMention(text, e.currentTarget.selectionStart ?? text.length)}
            onBlur={() => setMention(null)}
            onKeyDown={onKeyDown}
            rows={1}
          />
        </div>

        <div className="composer__actions">
          <button
            type="button"
            className="composer__mic"
            data-recording={voice.state === 'recording'}
            title={
              voice.state === 'recording'
                ? '点击结束录音并转写'
                : voice.state === 'transcribing'
                  ? '正在转写…'
                  : running
                    ? '生成中，暂不能录音'
                    : parsing
                      ? '文件解析中，暂不能录音'
                      : '语音输入（点击开始录音）'
            }
            // 原版的门禁是 `!isStreaming && !isParsing`（MessageInputView.ets:83）：
            // 生成中与解析中都不该再起一段录音，否则转写结果会插到正在跑的轮次里
            disabled={voice.state === 'transcribing' || running || parsing}
            onClick={voice.toggle}
          >
            {voice.state === 'recording' ? <IconStop size={18} /> : <IconMic size={18} />}
          </button>

          {/* 手机上的上传/拍照：聊天模式进附件，工作/交互模式进工作区 */}
          <button
            type="button"
            className="composer__tool composer__upload"
            title={mode === 'chat' ? '添加图片或文档' : '上传文件到工作区'}
            disabled={running || parsing || voice.state !== 'idle'}
            onClick={() => void pickUpload('file')}
          >
            <IconPaperclip size={18} />
          </button>
          <button
            type="button"
            className="composer__tool composer__camera"
            title={mode === 'chat' ? '拍照发送' : '拍照并加入工作区'}
            disabled={running || parsing || voice.state !== 'idle'}
            onClick={() => void pickUpload('camera')}
          >
            <IconCamera size={18} />
          </button>

          {/* 附件入口只在聊天模式给：工作/交互模式的素材入口是工作区（上传/拖拽），
              那两条路本来就是「文件进沙箱、模型用工具读」，与附件直传是两件事。 */}
          {mode === 'chat' ? (
            <button
              type="button"
              className={`composer__clip${parsing ? ' composer__clip--parsing' : ''}`}
              title={parsing ? '文件解析中，请稍候' : '添加图片或文档（发送给模型直接查看）'}
              // 解析中不可点（对齐原版 buildUploadButton 的 `!isParsing`）：此时再加一批文件
              // 只会让「哪张卡对应哪次解析」变得难懂，也让解析队列越排越长。
              // 录音中同样不可点（原版还多一个 `!isListening`）。
              disabled={running || parsing || voice.state !== 'idle'}
              onClick={() => void pickAttachments('file')}
            >
              {/* 解析中：回形针变成旋转的刷新图标 + 品牌浅底（原版是 16ms 转 6° 的旋转） */}
              {parsing ? (
                <IconRefresh size={18} className="icon-spin" />
              ) : (
                <IconPaperclip size={18} />
              )}
            </button>
          ) : null}

          <span className="composer__grow" />

          {running ? (
            <>
              {/* 插话只在 Agent Loop 的两种形态给：聊天模式的请求是「一问一答」，
                  中途补话没有「下一轮」可挂，只能中止重来（原版也是这么分的）。 */}
              {mode !== 'chat' ? (
                <button
                  className="composer__send composer__send--steer"
                  title="插话（不打断当前执行，在下一轮生效）"
                  aria-label="插话"
                  disabled={text.trim() === ''}
                  onClick={() => void steer()}
                >
                  <IconSteer size={18} />
                  <span className="composer__send-label">插话</span>
                </button>
              ) : null}
              <button
                className="composer__send composer__send--stop"
                title="停止生成"
                aria-label="停止生成"
                onClick={onAbort}
              >
                <IconStopCircle size={20} />
                <span className="composer__send-label">停止</span>
              </button>
            </>
          ) : (
            <button
              className="composer__send"
              title="发送（Enter）"
              aria-label="发送"
              onClick={submit}
              // 解析中/转写中不给发（原版发送钮同条件变灰，点击也直接 return）
              disabled={parsing || voice.state !== 'idle' || (text.trim() === '' && attachments.length === 0)}
            >
              <IconSend size={18} />
              <span className="composer__send-label">发送</span>
            </button>
          )}
        </div>
      </div>
      {voice.error !== '' ? (
        <div className="composer__hint" style={{ color: 'var(--warn)' }}>
          {voice.error}
        </div>
      ) : null}
      <div className="composer__hint">
        <span>
          {MODE_HINT[mode] ?? ''}
          {mode !== 'chat' ? ' · @ 引用工作区文件' : ''}
        </span>
        <span>
          {attachments.length > 0 ? `${attachments.length} 个附件 · ` : ''}
          {text.length > 0 ? `${text.length} 字` : ''}
        </span>
      </div>
    </div>
  )
}