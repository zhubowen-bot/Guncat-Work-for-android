// 时间线：按形态决定呈现方式。
//
//   聊天模式  → 逐条气泡（MessageView）。
//   工作模式  → **一个用户请求 = 一个回合**，回合内每一轮 assistant 按发生顺序**直接陈列**：
//               思考条 → 正文 → 工具行，然后才是下一轮。轮与轮之间不做收纳，
//               思考与工具各自是可折叠的（默认收起），但它们本身就在时间线上占位。
//               —— 这正是原版 ChatPage.buildWorkTimeline + WorkTurnView 的 `section='full'`。
//   交互模式  → 一个用户请求 = 一个回合，回合里所有中间轮（思考 + 工具）**合并成一条**
//               活动折叠栏，正文只出最终答复。即原版的 `section='grouped'` / `'content'`。
//
// 为什么工作模式不能沿用交互模式那套归组（用户报障的原话：「工作模式却和交互模式一样就不对了」）：
//   交互模式的产物是**一张界面**，前面的推演过程对用户没有价值，浓缩成一条活动栏最干净；
//   工作模式的产物是**一串有序的步骤**（读文件 → 处理 → 落盘），每一步都有意义，
//   把它们糊进同一个折叠栏里，用户就再也看不出「先做了什么、后做了什么」。
//
// 为什么归组只发生在渲染层（见 turns.ts 顶部注释）：Agent Loop 的数据结构就是
// 「一条用户消息 → 若干条 assistant 消息」，把多轮并成一条会让模型看到
// 「一条 assistant 同时调了所有工具」，时序错乱。
import { useMemo, useState } from 'react'
import type { MessageDto } from '@ipc/contract'
import { AssistantBody, MessageActions, MessageView, ThinkingBar, ToolList, marqueeText } from './MessageView'
import { Disclosure } from './Disclosure'
import { AskUserCard } from './AskUserCard'
import { groupTurns, formatDuration, turnStats, finalRound, STOPPED_NOTE, type Turn } from '../turns'
import { useStore } from '../store'
import { copyText } from '../clipboard'
import { IconCheck, IconInteractive, IconWork } from '../icons'

interface Props {
  messages: MessageDto[]
  mode: string
  running: boolean
  /** 最新一条 assistant 的 id：交互模式只有它的界面可交互 */
  lastAssistantId: string
  onEditToInput: (text: string) => void
}

/**
 * 时间线末尾的提问卡片（原版 ChatPage:1383-1395 的渲染位置）。
 *
 * 为什么挂在时间线末尾、而不是某一条消息里：ask_user_question 是在**这一轮还在跑**的时候
 * 挂起的 —— 此刻正文可能只流了一半、甚至还没开始，它不属于任何一条已完成的 assistant 消息。
 * 三种形态共用同一条时间线，挂在末尾三种模式就都能看到。
 */
function AskAtTimelineEnd() {
  const pendingAsk = useStore((s) => s.pendingAsk)
  const activeId = useStore((s) => s.activeId)
  const answerAsk = useStore((s) => s.answerAsk)
  const cancelAsk = useStore((s) => s.cancelAsk)

  // 只认当前会话的提问：桌面端可以同时有别的会话在后台跑，那张卡不属于这里。
  if (pendingAsk === null || pendingAsk.conversationId !== activeId) {
    return null
  }

  return (
    <div className="askcard-slot">
      <AskUserCard
        ask={pendingAsk}
        onAnswer={(requestId, selections, note) => {
          void answerAsk(requestId, selections, note)
        }}
        onCancel={(requestId) => {
          void cancelAsk(requestId)
        }}
      />
    </div>
  )
}

export function Timeline({ messages, mode, running, lastAssistantId, onEditToInput }: Props) {
  const turns = useMemo(() => groupTurns(messages), [messages])

  if (mode === 'chat') {
    return (
      <>
        {messages.map((message) => (
          <MessageView
            key={message.id}
            message={message}
            // 聊天模式的可交互性只看「是否在流式」（原版 ChatPage:1372 `uiLocked: isStreaming`）：
            // 历史回答里的界面块同样可以继续操作 —— 每条回答是一个独立的卡片，
            // 没有「只有最新那条才算当前界面」这回事（那是交互模式的规则）。
            interactive={!running}
            streaming={running && message.id === lastAssistantId}
            onEditToInput={onEditToInput}
          />
        ))}
        <AskAtTimelineEnd />
      </>
    )
  }

  const interactiveMode = mode === 'interactive'

  return (
    <div className="loop-timeline">
      <div className="loop-head">
        <span className="loop-head__glyph">
          {interactiveMode ? <IconInteractive size={26} /> : <IconWork size={26} />}
        </span>
        <div className="loop-head__text">
          <strong>{interactiveMode ? '交互模式' : '工作模式'}</strong>
        </div>
      </div>

      {turns.map((turn) =>
        interactiveMode ? (
          <GroupedTurn
            key={turn.user?.id ?? `turn-${turn.index}`}
            turn={turn}
            running={running}
            lastAssistantId={lastAssistantId}
            onEditToInput={onEditToInput}
          />
        ) : (
          <WorkTurn
            key={turn.user?.id ?? `turn-${turn.index}`}
            turn={turn}
            running={running}
            onEditToInput={onEditToInput}
          />
        )
      )}

      {/* 提问卡片排在整条时间线之后 —— 与它「这一轮还没结束、还在等用户」的时序一致 */}
      <AskAtTimelineEnd />
    </div>
  )
}

/** 用户任务卡（原版 buildWorkTaskCard）：任务标签 + 请求原文 + 重新编辑/复制 */
function TaskCard({
  message,
  onEditToInput
}: {
  message: MessageDto
  onEditToInput: (text: string) => void
}) {
  const pushNotice = useStore((s) => s.pushNotice)
  return (
    <div className="task-card">
      <div className="task-card__row">
        <span className="task-card__tag">任务</span>
        <div className="task-card__text">
          {message.displayContent !== '' ? message.displayContent : message.content}
        </div>
      </div>
      <div className="task-card__actions">
        <button
          className="act"
          title="填入输入框，重新编辑"
          onClick={() => onEditToInput(message.content)}
        >
          重新编辑
        </button>
        <button
          className="act"
          title="复制任务原文"
          onClick={() => {
            void copyText(message.content).then((ok) => {
              pushNotice(ok ? 'info' : 'error', ok ? '已复制' : '复制失败：请长按选中文字后手动复制')
            })
          }}
        >
          复制
        </button>
      </div>
    </div>
  )
}

// ===== 工作模式：逐轮直接陈列（原版 section='full'） =====

export function WorkTurn({
  turn,
  running,
  onEditToInput
}: {
  turn: Turn
  running: boolean
  onEditToInput: (text: string) => void
}) {
  const thinkingExpected = useStore((s) => s.thinkingEnabled)
  const stats = turnStats(turn)

  if (turn.user === null && turn.rounds.length === 0) {
    return null
  }

  const last = turn.rounds.length > 0 ? turn.rounds[turn.rounds.length - 1] : null

  return (
    <section className="turn">
      {turn.user !== null ? <TaskCard message={turn.user} onEditToInput={onEditToInput} /> : null}

      {turn.rounds.map((round) => {
        const isLast = round === last
        const streaming = running && isLast
        const body = round.displayContent !== '' ? round.displayContent : round.content
        // 流式中即使思考还是空的，也先把思考条挂出来 —— 这样第一个字一到就能看见
        const showReasoning =
          round.reasoning.trim() !== '' || (streaming && thinkingExpected)
        const hasStats =
          round.tokenSpeed !== undefined ||
          round.cacheHitRate !== undefined ||
          round.toolCalls.length > 0

        return (
          <div className="work-round" key={round.id}>
            {showReasoning ? (
              <ThinkingBar
                reasoning={round.reasoning}
                streaming={streaming && round.toolCalls.length === 0}
                workMode
              />
            ) : null}

            {body.trim() !== '' ? (
              <div className="answer">
                {/* 工作模式同样只看是否在流式（原版 WorkTurnView 拿到的 uiLocked 就是 isStreaming）：
                    历史轮次的界面块也能继续操作，用户不必回到那轮重新跑一遍。 */}
                <AssistantBody message={round} interactive={!running} />
              </div>
            ) : null}

            {/* 工具行排在正文之后 —— 与发生顺序一致（原版 build() 里 buildSteps 在正文之后） */}
            {round.toolCalls.length > 0 ? (
              <div className="work-round__tools">
                <ToolList calls={round.toolCalls} variant="loop" streaming={streaming} />
              </div>
            ) : null}

            {isLast && !streaming && body.trim() !== '' ? (
              <MessageActions
                message={round}
                text={body}
                onEditToInput={onEditToInput}
                extra={
                  stats.toolCalls > 0 ? (
                    <span className="msg__stats">{`${stats.toolCalls} 次工具调用`}</span>
                  ) : null
                }
              />
            ) : null}

            {streaming && body.trim() !== '' && round.toolCalls.length === 0 ? (
              <div className="stream-cursor" aria-hidden="true" />
            ) : null}

            {isLast && streaming && body.trim() === '' && round.toolCalls.length === 0 ? (
              <div className="answer answer--pending">
                <span className="spinner" />
                正在执行…
              </div>
            ) : null}

            {isLast && !streaming && body.trim() === '' && round.toolCalls.length === 0 && hasStats ? (
              <div className="answer answer--pending answer--done">本轮没有正文</div>
            ) : null}
          </div>
        )
      })}

      {turn.rounds.length === 0 && running ? (
        <div className="answer answer--pending">
          <span className="spinner" />
          正在执行…
        </div>
      ) : null}
    </section>
  )
}

// ===== 交互模式：整个回合合并成一条活动折叠栏（原版 section='grouped'） =====

export function GroupedTurn({
  turn,
  running,
  lastAssistantId,
  onEditToInput
}: {
  turn: Turn
  running: boolean
  lastAssistantId: string
  onEditToInput: (text: string) => void
}) {
  const stats = turnStats(turn)
  const final = finalRound(turn)
  const prior = turn.rounds.slice(0, Math.max(0, turn.rounds.length - 1))
  const thinkingExpected = useStore((s) => s.thinkingEnabled)

  // 本轮是否还在产出（原版 isStreaming）
  const streaming = running && final !== null && final.id === lastAssistantId
  const bodyStarted =
    final !== null && (final.displayContent !== '' ? final.displayContent : final.content) !== ''

  // 开合是**纯派生**的（对齐原版 activityOpenNow）：
  //   正文还没开始输出时默认展开（让用户实时看到在思考、在调什么工具），
  //   正文一开始就自动收起；用户点过之后完全听用户的。
  //   刻意不因为「又有新工具在跑」而自动重新展开 —— 多轮之间来回开合很晃眼。
  const [touched, setTouched] = useState(false)
  const [manualOpen, setManualOpen] = useState(false)
  const open = touched ? manualOpen : streaming && !bodyStarted

  // 是否还有活在做（原版 activityRunning）
  const activityRunning =
    streaming &&
    (!bodyStarted ||
      (final?.toolCalls ?? []).some(
        (c) => c.durationMs < 0 && (streaming || c.preparing === true || c.started === true)
      ))

  if (turn.user === null && turn.rounds.length === 0) {
    return null
  }

  // 本回合的活动栏 = 一条**思考栏**，内容按时间顺序依次是：
  //   思考 → 工具 → 思考 → 工具 …（每轮的思考紧跟它那轮的工具），最后只剩最终回答在外面。
  // 这与工作模式的时间线口径一致，只是把历史轮整体折叠起来。
  //
  // 两次用户反馈把这里定死了：
  //   · 「思考这些应该放在思考栏里面啊，要不然拿来摆设啊」→ 折叠栏里必须真有思考，
  //     且标题不再写「已完成 · 思考」而展开是空的；
  //   · 「全部收一个思考栏里面…顺序还是一样的 思考-工具-思考-工具」→ 不要把思考与工具
  //     各自归堆（那是把时间顺序打乱），而是顺着来。
  const thinkingRounds = turn.rounds.filter((round) => round.reasoning.trim() !== '').length
  const priorHasContent = prior.some(
    (round) =>
      round.toolCalls.length > 0 ||
      (round.displayContent !== '' ? round.displayContent : round.content).trim() !== ''
  )
  const hasActivity = thinkingRounds > 0 || priorHasContent || (final?.toolCalls.length ?? 0) > 0

  // 被手动停止的轮次：主进程在收尾时往正文末尾追加了这句标注（原版 appendTurnNote）。
  // 折叠栏据此把「已完成」改成「已停止」—— 明明被打断却写着完成是误导。
  const stopped = (final?.content ?? '').includes(STOPPED_NOTE)

  // 折叠态摘要（原版 activitySummary 636-654）：`思考 ×N + M 个工具 · 12.4s`
  // 思考与工具之间是「 + 」，耗时前面是「 · 」—— 原版就是这么接的。
  const summaryParts: string[] = []
  if (stats.toolCalls > 0) {
    summaryParts.push(`${stats.toolCalls} 个工具`)
  }
  const totalMs = turn.rounds.reduce(
    (sum, round) =>
      sum +
      round.toolCalls.reduce(
        (s, c) => s + (c.durationMs > 0 ? c.durationMs : 0),
        0
      ),
    0
  )
  const summary = summaryParts.join(' + ')
  const summaryWithMs =
    totalMs > 0
      ? summary === ''
        ? formatDuration(totalMs)
        : `${summary} · ${formatDuration(totalMs)}`
      : summary

  // 折叠态在标题右侧显示**最后一段思考的末句**（思考栏的跑马灯）：
  // 收起时也看得见模型在想什么，不会出现「一整条折叠栏只有个标题」的空洞感。
  const lastReasoning =
    [...turn.rounds].reverse().find((round) => round.reasoning.trim() !== '')?.reasoning ?? ''
  const marquee = marqueeText(lastReasoning)

  return (
    <section className="turn">
      {turn.user !== null ? <TaskCard message={turn.user} onEditToInput={onEditToInput} /> : null}

      {hasActivity ? (
        <Disclosure
          // 这一条就是「思考栏」：跑动中转圈，完成后对勾；有思考时标题写「思考 ×N」。
          // 刻意不再用「已完成」当标题 —— 用户已经指出那样像摆设。
          title={
            activityRunning
              ? '正在处理…'
              : stopped
                ? '已停止'
                : thinkingRounds > 0
                  ? `思考${thinkingRounds > 1 ? ` ×${thinkingRounds}` : ''}`
                  : '已完成'
          }
          subtitle={summaryWithMs}
          trailing={!open && marquee !== '' ? <span className="thinking__marquee">{marquee}</span> : undefined}
          leading={
            activityRunning ? (
              <span className="spinner spinner--sm" />
            ) : (
              <span className="activity__check" data-stopped={stopped}>
                <IconCheck size={12} />
              </span>
            )
          }
          open={open}
          onToggle={(next) => {
            setManualOpen(next)
            setTouched(true)
          }}
        >
          {/* 历史轮：**按发生顺序**逐轮铺开（思考、工具、该轮正文依次排开） */}
          {prior.map((round) => (
            <div className="process-round" key={round.id}>
              {round.reasoning.trim() !== '' ? (
                <ThinkingBar reasoning={round.reasoning} streaming={false} workMode />
              ) : null}
              {round.toolCalls.length > 0 ? <ToolList calls={round.toolCalls} variant="loop" streaming={streaming} /> : null}
              {(round.displayContent !== '' ? round.displayContent : round.content).trim() !== '' ? (
                <div className="process-round__text">
                  {round.displayContent !== '' ? round.displayContent : round.content}
                </div>
              ) : null}
            </div>
          ))}
          {/* 本轮（最终回答那一轮）：思考与工具同样按顺序接在历史轮之后；
              它的**正文就是下面的最终回答**，所以这里不再重复渲染正文。 */}
          {final !== null && (final.reasoning.trim() !== '' || final.toolCalls.length > 0) ? (
            <div className="process-round" key={final.id}>
              {final.reasoning.trim() !== '' ? (
                <ThinkingBar
                  reasoning={final.reasoning}
                  streaming={streaming && !bodyStarted}
                  workMode
                />
              ) : null}
              {final.toolCalls.length > 0 ? (
                <ToolList calls={final.toolCalls} variant="loop" streaming={running} />
              ) : null}
            </div>
          ) : null}
        </Disclosure>
      ) : null}

      {final !== null ? (
        <div className="answer">
          <AssistantBody
            message={final}
            // 交互模式是唯一有「当前界面」概念的模式：只有**最新一轮**且不在执行中
            // 才可交互（原版 ChatPage:1521 `interactiveMode && (id !== pendingUiMessageId || isStreaming)`）
            // —— 历史界面块与执行中的界面置灰，防重复提交。
            interactive={!running && final.id === lastAssistantId}
          />
          {!running ? (
            <MessageActions
              message={final}
              text={final.displayContent !== '' ? final.displayContent : final.content}
              onEditToInput={onEditToInput}
              extra={
                stats.toolCalls > 0 ? (
                  <span className="msg__stats">{`${stats.toolCalls} 次工具调用`}</span>
                ) : null
              }
            />
          ) : null}
        </div>
      ) : running ? (
        <div className="answer answer--pending">
          <span className="spinner" />
          正在执行…
        </div>
      ) : null}
    </section>
  )
}

/** 兼容旧引用：工作模式与交互模式都已改用上面两个具体组件 */
export const TurnBlock = GroupedTurn
