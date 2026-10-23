// 空态（对齐鸿蒙原版 ChatPage.buildEmptyState，1270-1324）：
//   图标 → 标题 → 说明，三件，**没有别的**。
//
// 说明文案的口径（原版 emptyDescriptionText，1220-1225）：
//   · 聊天智能体 → **它自己的 description**（agents.json 里那一段长介绍），
//     取不到时退回原版的兜底句「选择一个智能体开始对话」；
//   · 交互 / 工作模式 → loopEmptyDescription 的两句，且在**第一个句号后强制换行**
//     （原版用 replace('。', '。\n')；纯靠自动换行会断在句子中间，出来是「满行 + 半句」）。
//
// 这里刻意做成独立组件：一是空态文案被用户报障过（我曾在端口里自己编了一段
// 「三协议流式对话。配置好 API 后直接开始。」外加一行「提示：在左下角设置里配置…」，
// 原版根本没有），二是纯 props 才好做无头渲染断言。
import type { AgentDto, AgentMode } from '@ipc/contract'
import { AgentGlyph } from './AgentGlyph'

/** 交互 / 工作模式的两句说明（与 ChatViewModel.loopEmptyDescription 逐字一致） */
const LOOP_DESCRIPTION: Record<'interactive' | 'work', string> = {
  interactive: '回答即界面，可视可交互。适用于生活中的大部分场景。',
  work: '数十种工具和技能，端到端交付成果。适用于对质量要求较高的复杂长程任务。'
}

/** 空态说明文案（原版 emptyDescriptionText） */
export function emptyDescriptionText(mode: AgentMode, engine: AgentDto | null): string {
  if (mode === 'chat') {
    const description = (engine?.description ?? '').trim()
    return description !== '' ? description : '选择一个智能体开始对话'
  }
  return LOOP_DESCRIPTION[mode]
}

export function EmptyState({
  mode,
  engine
}: {
  mode: AgentMode
  engine: AgentDto | null
}) {
  const text = emptyDescriptionText(mode, engine)
  // Agent Loop 模式在第一个句号后强制换行；聊天智能体的长介绍交给自动换行
  const at = mode === 'chat' ? -1 : text.indexOf('。')

  return (
    <div className="empty">
      <div className="empty__hero">
        {/* 空态图标 = 当前智能体自己的标识（侧栏引擎区同一枚）。
            空态是唯一需要「视觉大小归一」的地方：各智能体图标的墨迹占比不同
            （满幅 PNG 是 1.0，轻简/效率那几个 96x96 只有 0.80），靠 inkNormalize 拉齐。 */}
        <AgentGlyph
          agent={engine}
          size={48}
          inkNormalize
          title={engine?.name ?? 'Guncat Work'}
        />
      </div>
      <h1>{engine?.name ?? 'Guncat Work'}</h1>
      <p>
        {at < 0 ? (
          text
        ) : (
          <>
            {text.slice(0, at + 1)}
            <br />
            {text.slice(at + 1)}
          </>
        )}
      </p>
    </div>
  )
}
