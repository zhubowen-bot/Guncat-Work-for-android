// 单条消息的呈现。
//
// 聊天模式 = 用户气泡 + 助手气泡（原版 ChatBubbleView 的信息层级：
//   助手侧：思考条 → 工具行 → 正文/界面 → 操作行 → 统计行；用户侧：气泡 + 编辑/复制）。
// 工作 / 交互模式不使用这里的整条气泡，而是由 Timeline 把一个用户请求下的多轮
// 组装成「任务卡 + 过程 + 最终答复」，这里只提供可复用的助手正文与操作行。
import { useEffect, useMemo, useRef, useState } from 'react'
import type { MessageDto } from '@ipc/contract'
import { GuncatUiParts } from '@core/common/GuncatUiParts'
import { GuncatUiTrailer } from '@core/common/GuncatUiRuntime'
import { Markdown } from './Markdown'
import { ToolCallRow } from './Disclosure'
import { GuncatUiBlock } from '../guncat-ui/GuncatUiBlock'
import { APP_ICON_SRC } from './AgentGlyph'
import { docxFileName } from '../fileName'
import { useSpeech, speechTextOf } from '../speech/speechStore'
import { useStore } from '../store'
import { formatStats, stripMarkdown } from '../turns'
import {
  IconBrain,
  IconChevronDown,
  IconCopy,
  IconDownload,
  IconEdit,
  IconRegenerate,
  IconSpeaker
} from '../icons'

interface Props {
  message: MessageDto
  /** 是否允许交互（只有最新一轮的界面可操作；历史界面控件禁用，但**不蒙灰**） */
  interactive: boolean
  /** 这条消息是否正在流式生成 */
  streaming?: boolean
  /** 是否是这一回合的最终答复（操作行只挂在最终答复上） */
  showActions?: boolean
  onEditToInput?: (text: string) => void
}

/** 助手正文里可能夹着 guncat-ui 界面程序，这里拆一次给正文与界面块共用 */
function useBody(message: MessageDto): { body: string; text: string; hasUi: boolean } {
  const body = message.displayContent !== '' ? message.displayContent : message.content
  const parts = useMemo(
    () => (message.role === 'user' ? null : GuncatUiParts.build(body, true)),
    [message.role, body]
  )
  const hasUi = parts !== null && parts.segments.some((s) => s.type === 'ui')
  return { body, text: hasUi && parts !== null ? parts.textOnly : body, hasUi }
}

/**
 * 思考条（原版 ChatBubbleView.buildReasoningBar / WorkTurnView.buildThinking 同款）。
 *
 * 关键点是「跑马灯」：折叠态下标题右侧那一行显示的是**思考文本的末尾 400 字**，
 * 随流式增量每帧更新 —— 这样思考从第一个字开始就能看见在长，而不是等一段想完了才整段蹦出来。
 * （桌面端早先的实现只在展开后显示完整思考，且工作模式把当前轮的思考整个丢掉，
 * 于是用户看到的就是「第一段思考完了，一下子蹦出来完的」。）
 *
 * 展开态显示完整思考文本；跑动中的标题给一个转圈，完成后固定缀「· 持续了几秒」。
 */
export function ThinkingBar({
  reasoning,
  streaming,
  rounds = 0,
  workMode = false
}: {
  reasoning: string
  streaming: boolean
  /** 汇总了几轮思考（>1 时标题上写「思考 ×N」）—— 汇总展示时用，单轮不用传 */
  rounds?: number
  workMode?: boolean
}) {
  const [open, setOpen] = useState(false)
  const tail = marqueeText(reasoning)
  const marqueeRef = useRef<HTMLSpanElement>(null)

  // 跑马灯跟随最新思考内容滚到末端（原版 ChatBubbleView.ets:441-450：每次刷新节拍
  // 调 scrollTo(xOffset 999999, 150ms EaseOut)）。
  // 这里用 scrollLeft 置到 scrollWidth，并以 CSS transition 呈现同样的缓动。
  useEffect(() => {
    const element = marqueeRef.current
    if (element === null) {
      return
    }
    element.scrollLeft = element.scrollWidth
  }, [tail])

  return (
    <div className="thinking" data-open={open}>
      <button className="thinking__head" onClick={() => setOpen((v) => !v)}>
        <span className="thinking__leading">
          <IconBrain size={13} />
        </span>
        <span className="thinking__label">
          {(workMode ? '思考' : '深度思考') + (rounds > 1 ? ` ×${rounds}` : '')}
        </span>
        {streaming ? <span className="spinner spinner--sm" /> : null}
        {/* 折叠态**始终**显示思考内容的末段（不再只在流式中显示）。
            用户报障：交互模式下不调工具时，思考一个字都看不见 ——
            因为折叠态此前只在流式期间挂跑马灯，跑完就只剩一个标题，
            而那一轮的思考如果没被折叠进活动栏，就等于彻底不可见。
            现在折叠态也带一段末段摘录（点开看全文），思考永远看得见。 */}
        {!open && tail !== '' ? (
          <span className="thinking__marquee" title={tail} ref={marqueeRef}>
            {tail}
          </span>
        ) : (
          <span className="thinking__gap" />
        )}
        <span className="thinking__caret">
          <IconChevronDown size={13} />
        </span>
      </button>
      {open ? <div className="thinking__body reasoning">{reasoning}</div> : null}
    </div>
  )
}

/** 思考跑马灯取文本末尾 400 字并压成单行（原版 getMarqueeText 口径） */
export function marqueeText(raw: string): string {
  const tail = raw.length > 400 ? `…${raw.slice(raw.length - 400)}` : raw
  return tail.replace(/[\r\n\t]+/g, ' ').trim()
}


/**
 * 工具调用列表。
 * `variant` 决定用哪套行规格（聊天紧凑 / 工作与交互模式更宽松）——
 * 原版这两个模式是两套独立的 @Builder，参数不同。
 */
export function ToolList({
  calls,
  variant = 'chat',
  streaming = false
}: {
  calls: MessageDto['toolCalls']
  variant?: 'chat' | 'loop'
  streaming?: boolean
}) {
  return (
    <>
      {calls.map((call) => (
        <ToolCallRow
          key={call.id || call.name}
          call={call}
          variant={variant}
          streaming={streaming}
        />
      ))}
    </>
  )
}

/** 助手回答的操作行：文本 / MD / 朗读 / Word / 重答（对齐原版 buildAIActions） */
export function MessageActions({
  message,
  text,
  onEditToInput,
  extra
}: {
  message: MessageDto
  text: string
  onEditToInput?: (text: string) => void
  extra?: React.ReactNode
}) {
  const conversationId = useStore((s) => s.activeId)
  const pushNotice = useStore((s) => s.pushNotice)
  const regenerate = useStore((s) => s.regenerate)
  const speak = useSpeech((s) => s.speak)
  const speechSupported = useSpeech((s) => s.supported)
  const stats = formatStats(message)

  function copy(value: string, label: string): void {
    void navigator.clipboard
      .writeText(value)
      .then(() => pushNotice('info', label))
      .catch((e: unknown) => pushNotice('error', `复制失败：${String(e)}`))
  }

  return (
    <div className="msg__actions">
      {stats !== '' ? <span className="msg__stats">{stats}</span> : null}
      {extra}
      <button
        className="act"
        title="复制纯文本（剥掉 Markdown 标记）"
        onClick={() => copy(stripMarkdown(text), '已复制')}
      >
        <IconCopy size={14} />
        文本
      </button>
      <button
        className="act"
        title="复制 Markdown 原文"
        onClick={() => copy(text, '已复制 Markdown')}
      >
        <IconCopy size={14} />
        MD
      </button>
      <button
        className="act"
        title="朗读这条回答"
        disabled={speechSupported === false}
        onClick={() => speak(message.id, speechTextOf(text))}
      >
        <IconSpeaker size={14} />
        朗读
      </button>
      <button
        className="act"
        title="导出为 Word（含 LaTeX 转原生公式）"
        onClick={() => {
          void window.guncat.messages
            .exportDocx(conversationId ?? '', message.id, docxFileName(text))
            .then((r) => {
              if (r.saved) {
                pushNotice('info', `已导出到 ${r.path ?? ''}`)
              }
            })
            .catch((e: unknown) => pushNotice('error', `导出失败：${String(e)}`))
        }}
      >
        <IconDownload size={14} />
        Word
      </button>
      <button
        className="act"
        title="重新生成这条回答"
        onClick={() => void regenerate()}
      >
        <IconRegenerate size={14} />
        重答
      </button>
      {onEditToInput !== undefined ? (
        <button
          className="act"
          title="把这条回答填回输入框"
          onClick={() => onEditToInput(text)}
        >
          <IconEdit size={14} />
          填入
        </button>
      ) : null}
    </div>
  )
}

/** 助手正文块（Markdown + 界面程序）。工作模式的最终答复也复用它 ——
 *  工具行不在这里渲染：聊天模式由 MessageView 排在上面，工作模式收进「过程」区。 */
export function AssistantBody({
  message,
  interactive
}: {
  message: MessageDto
  interactive: boolean
}) {
  const send = useStore((s) => s.send)
  const patchMessageContent = useStore((s) => s.patchMessageContent)
  const freezeAutoScroll = useStore((s) => s.freezeAutoScroll)
  const { body, text, hasUi } = useBody(message)

  return (
    <>
      {text.trim() !== '' ? (
        <div className="msg__body">
          <Markdown text={text} />
        </div>
      ) : null}
      {hasUi ? (
        <GuncatUiBlock
          content={body}
          interactive={interactive}
          onSend={(value) => void send(value)}
          onStateChange={(stateJson) => {
            // 本地状态回传（拖动/勾选/填表）：先冻结自动置底 —— 用户正在卡片里操作时
            // 页面被拽到底部是原版专门修过的问题（见 ChatPage.ets:1523-1526 的注释）。
            // 把控件状态以尾标记追加到正文并落盘：滚动、切会话、重启后仍在。
            // GuncatUiTrailer.append 会先剥掉旧尾标记再写新的，不会重复叠加。
            freezeAutoScroll(600)
            void patchMessageContent(message.id, GuncatUiTrailer.append(body, stateJson))
          }}
        />
      ) : null}
    </>
  )
}

/** 聊天模式下的一条消息 */
export function MessageView({
  message,
  interactive,
  streaming = false,
  showActions = true,
  onEditToInput
}: Props) {
  const { body, text } = useBody(message)
  const isUser = message.role === 'user'
  const pushNotice = useStore((s) => s.pushNotice)
  const openLightbox = useStore((s) => s.openLightbox)
  // 原版 ChatBubbleView：思考条在「流式中」或「已有思考内容」时出现；
  // 关掉深度思考时不挂空的思考条（否则那条永远不填内容，看起来像卡住）。
  const thinkingExpected = useStore((s) => s.thinkingEnabled)

  if (isUser) {
    return (
      <div className="msg msg--user">
        <div className="bubble bubble--user">
          <div className="bubble__text">{body}</div>
          {message.attachments.length > 0 ? (
            <div className="attachments">
              {message.attachments.map((att) => (
                <span className="attachment" key={att.id} title={att.name}>
                  {att.type === 'image' && (att.dataUrl !== '' || att.thumbnail !== '') ? (
                    /* 点开看大图：用**原图 dataUrl** 而不是缩略图
                       （缩略图只有 68×68，放大后是一片糊）。原版 ChatBubbleView 也是
                       `onImageTap(dataUrl !== '' ? dataUrl : thumbnail)`。 */
                    <img
                      className="attachment__img"
                      src={att.thumbnail !== '' ? att.thumbnail : att.dataUrl}
                      alt={att.name}
                      title="点击查看大图"
                      onClick={() =>
                        openLightbox(att.dataUrl !== '' ? att.dataUrl : att.thumbnail)
                      }
                    />
                  ) : (
                    <>
                      <span className="attachment__tag">FILE</span>
                      <span className="attachment__name">{att.name}</span>
                    </>
                  )}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        <div className="msg__actions msg__actions--right">
          {onEditToInput !== undefined ? (
            <button
              className="act"
              title="填入输入框，重新编辑"
              onClick={() => {
                onEditToInput(body)
                pushNotice('info', '已填入输入框')
              }}
            >
              <IconEdit size={14} />
              编辑
            </button>
          ) : null}
          <button
            className="act"
            title="复制这条消息"
            onClick={() => {
              void navigator.clipboard.writeText(body).then(
                () => pushNotice('info', '已复制'),
                (e: unknown) => pushNotice('error', `复制失败：${String(e)}`)
              )
            }}
          >
            <IconCopy size={14} />
            复制
          </button>
        </div>
      </div>
    )
  }

  const hasReasoning = message.reasoning.trim() !== ''

  // 原版 ChatBubbleView 的助手侧层级：头像 + 一列（思考条 → 工具行 → 气泡正文 → 操作行）
  return (
    <div className="msg msg--assistant">
      {/* 头像 = 原版 ChatBubbleView.buildAIMessage 的 Image($r('app.media.cat_avatar'))：
          38vp 圆形原图，不是自绘 SVG。 */}
      <img className="avatar" src={APP_ICON_SRC} alt="" title="Guncat Work" />
      <div className="msg__col">
        {hasReasoning || (streaming && thinkingExpected) ? (
          <ThinkingBar
            reasoning={message.reasoning}
            streaming={streaming && message.toolCalls.length === 0}
          />
        ) : null}
        {message.toolCalls.length > 0 ? (
          /* 工具行直接陈列，**不套折叠栏边框卡** —— 原版 ChatBubbleView.buildToolSteps
             就是一组裸行（CLI 式观感）；套一层 .disclosure 会在气泡里多出一个框，
             与「工具行是正文的一部分」这个观感冲突。 */
          <ToolList calls={message.toolCalls} variant="chat" streaming={streaming} />
        ) : null}
        <div className="bubble bubble--ai">
          <AssistantBody message={message} interactive={interactive} />
          {/* 操作行只在**回答结束后**出现（原版 ChatBubbleView 的条件是
              `!isStreaming && content !== '' && (!isWork || isLastAssistant)`）：
              流式时给一排还没意义的按钮，既闪又容易误点。 */}
          {!streaming && text.trim() !== '' && showActions ? (
            <MessageActions message={message} text={text} onEditToInput={onEditToInput} />
          ) : null}
          {/* 流式光标：气泡底部一条 2×14 的 brand 竖条（原版 ChatBubbleView.ets:656-668，
              只在「正在流式且已有正文」时出现，左缩进 12）。
              竖条本身复用 Timeline 已有的 .stream-cursor，这里只加它与气泡的关系。 */}
          {streaming && text !== '' ? (
            <div className="cursor-row">
              <span className="stream-cursor" aria-hidden="true" />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
