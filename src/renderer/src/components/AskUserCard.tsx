// AskUserCard: ask_user_question 的提问卡片（逐条对齐原版 views/AskUserCard.ets）
//
// 为什么必须有这张卡：ask_user_question 的工具执行是**真的挂起**的 ——
// 主进程此刻 await 在 AskUserBridge 上，模型这一轮不会往下走。
// 没有作答入口的话，它只能一直挂到 5 分钟超时，用户看到的就是「卡住了」。
// 所以卡片和工具是同一件事的两半，缺一不可。
//
// 结构（原版 178 行的逐条对应）：
//   · 头部：「需要你的决定」+ 右侧「单选 / 可多选」；
//   · 问题正文；
//   · 选项 chips —— 单选是圆点、多选是方框，**都只做选择，由下方「提交」统一发送**
//     （原版注释：不直接发送，避免多选时点第一个就飞出去）；
//   · 可选的文字补充（原版是「补充说明(可空)」TextArea）；
//   · 两个动作：「跳过，由智能体自行决定」（幽灵按钮，走取消）/「提交(N 项)」（主题按钮）。
//
// 渲染位置在 Timeline 末尾（三种模式共用），因为它出现的那一刻这一轮还没结束，
// 正文可能还在流。
import { useState } from 'react'
import { IconInfo } from '../icons'

export interface AskUserQuestion {
  requestId: string
  question: string
  options: string[]
  multiSelect: boolean
}

interface Props {
  ask: AskUserQuestion
  /** 提交：勾选的选项（可空 = 只有文字补充）+ 补充文字 */
  onAnswer(requestId: string, selections: string[], note: string): void
  /** 跳过：由智能体自行决定（原版「跳过，由智能体自行决定」） */
  onCancel(requestId: string): void
}

/**
 * 单选 = 替换选中项；多选 = 切换勾选。**两个分支都不直接发送**
 * （原版 toggleOption 的注释：都只做选择，由下方「提交」统一发送）。
 *
 * 抽成纯函数是为了能被无头断言覆盖：多选时点第一个就飞出去、单选时能同时选中两项，
 * 这两类错误光看渲染产物是发现不了的（SSR 点不了按钮）。
 */
export function askToggle(selected: string[], option: string, multiSelect: boolean): string[] {
  if (selected.includes(option)) {
    return selected.filter((s) => s !== option)
  }
  return multiSelect ? [...selected, option] : [option]
}

/** 提交按钮文案（原版 confirmLabel）：多选且已勾选时把数量写进去 */
export function askConfirmLabel(multiSelect: boolean, count: number): string {
  return multiSelect && count > 0 ? `提交(${count} 项)` : '提交'
}

export function AskUserCard({ ask, onAnswer, onCancel }: Props) {
  const [selected, setSelected] = useState<string[]>([])
  const [note, setNote] = useState('')

  function toggleOption(option: string): void {
    setSelected((prev) => askToggle(prev, option, ask.multiSelect))
  }

  function submit(): void {
    onAnswer(ask.requestId, selected, note)
    setSelected([])
    setNote('')
  }

  const confirmLabel = askConfirmLabel(ask.multiSelect, selected.length)

  return (
    <div className="askcard">
      <div className="askcard__head">
        <span className="askcard__icon">
          <IconInfo size={17} />
        </span>
        <strong className="askcard__title">需要你的决定</strong>
        <span className="askcard__mode">{ask.multiSelect ? '可多选' : '单选'}</span>
      </div>

      <div className="askcard__question">{ask.question}</div>

      {ask.options.length > 0 ? (
        <div className="askcard__options">
          {ask.options.map((option) => {
            const on = selected.includes(option)
            return (
              <button
                key={option}
                className="askchip"
                data-selected={on}
                // 单选圆点 / 多选方框：形状本身就在说「这里能不能选多个」
                data-shape={ask.multiSelect ? 'box' : 'dot'}
                aria-pressed={on}
                onClick={() => toggleOption(option)}
              >
                <span className="askchip__mark" />
                <span className="askchip__text">{option}</span>
              </button>
            )
          })}
        </div>
      ) : null}

      <textarea
        className="askcard__note"
        placeholder="补充说明(可空)"
        value={note}
        rows={2}
        onChange={(e) => setNote(e.target.value)}
      />

      <div className="askcard__actions">
        <button className="askcard__skip" onClick={() => onCancel(ask.requestId)}>
          跳过，由智能体自行决定
        </button>
        <button className="askcard__submit" onClick={submit}>
          {confirmLabel}
        </button>
      </div>
    </div>
  )
}
