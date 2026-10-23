// 会话列表 / 智能体选择的纯逻辑。
//
// 这里刻意不碰 React：侧边栏需要「标题从哪来」「时间怎么显示」「某个会话属于哪个引擎」
// 这类判断，把它们抽成纯函数就能在无头环境（scripts/render-check.mjs）里逐条断言 ——
// 而这恰恰是用户报障最集中的地方（每一条会话都顶着一个引擎名当标题）。
//
// 对齐鸿蒙原版（viewmodel/ChatViewModel.ets + views/DswSidebar.ets）：
//   · 会话标题只由「第一条用户消息」推导，新建时是空串；
//   · 标题为空时，侧栏回退显示「与 X 的对话」，再兜底「新会话」；
//   · 工作模式 / 交互模式在原版里是**两个虚拟智能体**（id = work / interactive），
//     和 agents.json 里的真实智能体并排出现在侧栏的「引擎」区，选中即切换会话模式。
import type { AgentDto, AgentMode, ConversationSummaryDto } from '@ipc/contract'

export const WORK_AGENT_ID = 'work'
export const INTERACTIVE_AGENT_ID = 'interactive'

/** 模式的中文名（形态胶囊、会话元信息共用） */
export const MODE_LABEL: Record<string, string> = {
  chat: '聊天模式',
  work: '工作模式',
  interactive: '交互模式'
}

/** 模式的一句话说明（对应原版 loopModeHint） */
export const MODE_HINT: Record<string, string> = {
  chat: '纯对话 · 三协议流式输出',
  work: 'Harness 就绪 · 配合数十种工具和技能交付结果',
  interactive: 'Canvas 就绪 · 生成可交互的卡片和面板'
}

function virtualAgent(id: string, name: string, description: string, shortDescription: string): AgentDto {
  return {
    id,
    name,
    description,
    shortDescription,
    icon: '',
    category: '系统',
    prompt: ''
  }
}

/** 工作模式虚拟智能体（原版 buildWorkAgent） */
export const VIRTUAL_WORK_AGENT: AgentDto = virtualAgent(
  WORK_AGENT_ID,
  '工作模式',
  'Agent Loop 工作台：自动调用工具、读写沙箱工作区文件，完成复杂长程任务',
  'Guncat Harness'
)

/** 交互模式虚拟智能体（原版 buildInteractiveAgent） */
export const VIRTUAL_INTERACTIVE_AGENT: AgentDto = virtualAgent(
  INTERACTIVE_AGENT_ID,
  '交互模式',
  'Intelligent UI 交互台：每一轮回答都交付成一个可操作界面，拖动参数即时重算',
  'Guncat Canvas'
)

export function isVirtualAgentId(id: string): boolean {
  return id === WORK_AGENT_ID || id === INTERACTIVE_AGENT_ID
}

/**
 * 侧栏「引擎」列表：两个虚拟智能体排在最前（原版 unshift + splice(1)），
 * 其后是 agents.json 里的真实智能体。
 */
export function buildAgentList(agents: AgentDto[]): AgentDto[] {
  const real = agents.filter((a) => !isVirtualAgentId(a.id))
  return [VIRTUAL_INTERACTIVE_AGENT, VIRTUAL_WORK_AGENT, ...real]
}

/** 形态 → 引擎 id（聊天形态保留当前真实智能体） */
export function agentIdForMode(mode: AgentMode, agents: AgentDto[], current: string): string {
  if (mode === 'work') {
    return WORK_AGENT_ID
  }
  if (mode === 'interactive') {
    return INTERACTIVE_AGENT_ID
  }
  if (current !== '' && !isVirtualAgentId(current)) {
    return current
  }
  const first = agents.find((a) => !isVirtualAgentId(a.id))
  return first === undefined ? '' : first.id
}

/** 引擎 id → 形态（真实智能体一律落到聊天形态） */
export function modeForAgentId(agentId: string): AgentMode {
  if (agentId === WORK_AGENT_ID) {
    return 'work'
  }
  if (agentId === INTERACTIVE_AGENT_ID) {
    return 'interactive'
  }
  return 'chat'
}

/**
 * 会话该按哪个形态打开 —— **智能体是唯一真相来源**。
 *
 * 为什么需要这么一条：形态与会话的 agentId 是两个字段，一旦哪一侧写错，
 * 就会出现「交互模式智能体 + 聊天模式」这种组合。它的后果非常难看出来：
 *   · 界面走聊天分支（纯气泡、连空态提示语都是聊天那一段）；
 *   · 发送走 `chat:send`，而聊天路径的系统提示词取自**智能体自己的 prompt** ——
 *     两个虚拟智能体（work / interactive）根本没有 prompt（它们的提示词是主进程
 *     按 mode 现拼的），于是模型拿到的是一份**空提示词**，直接当裸 API 用。
 * 所以这里以 agentId 为准：虚拟智能体的 id 本身就是形态，真实智能体才是「聊天形态」。
 *
 * `convMode` 只在智能体是真实智能体时参与决定（会话自己记的形态仍然算数，
 * 例如真实智能体上开着的工作模式会话）。
 */
export function resolveConversationMode(agentId: string, convMode: string): AgentMode {
  if (isVirtualAgentId(agentId)) {
    return modeForAgentId(agentId)
  }
  if (convMode === 'work' || convMode === 'interactive' || convMode === 'chat') {
    return convMode
  }
  return 'chat'
}

export function agentById(agents: AgentDto[], id: string): AgentDto | undefined {
  return agents.find((a) => a.id === id)
}

/**
 * 会话实际归属的引擎。
 *
 * 形态优先于 agentId：工作 / 交互形态在原版里就是那两个虚拟智能体，而移植早期
 * 建出来的工作会话 agentId 仍是真实智能体（这是脏数据），只看 agentId 会把它们
 * 显示成「轻简模式」。剩余情况按 agentId 精确匹配。
 */
export function agentOfConversation(
  summary: { agentId: string; mode: string },
  agents: AgentDto[]
): AgentDto | undefined {
  if (summary.mode === 'work') {
    return VIRTUAL_WORK_AGENT
  }
  if (summary.mode === 'interactive') {
    return VIRTUAL_INTERACTIVE_AGENT
  }
  if (summary.agentId === WORK_AGENT_ID) {
    return VIRTUAL_WORK_AGENT
  }
  if (summary.agentId === INTERACTIVE_AGENT_ID) {
    return VIRTUAL_INTERACTIVE_AGENT
  }
  return agentById(agents, summary.agentId)
}

/** 会话归属的引擎 id（侧栏高亮用；与 agentOfConversation 同一套判断） */
export function engineIdOfConversation(summary: { agentId: string; mode: string }): string {
  const agent = agentOfConversation(summary, [])
  return agent === undefined ? summary.agentId : agent.id
}

/**
 * 会话条目标题。
 *
 * 关键（原版 getConvTitle + ChatViewModel 新建时 title = ''）：
 *   1. 有标题就用标题；
 *   2. 标题为空 —— 或**恰好等于该会话引擎的名字** —— 视为「还没有标题」。
 *      后者是移植早期的脏数据：Conversation.create(agentId, agent.name, mode) 把引擎名
 *      写进了 title，而标题推导的守卫只认 ''/'新对话'，于是每条会话都永远顶着「轻简模式」。
 *   3. 回退到「与 {引擎名} 的对话」，再兜底「新会话」。
 */
export function conversationTitle(
  summary: Pick<ConversationSummaryDto, 'title' | 'agentId' | 'mode'>,
  agents: AgentDto[]
): string {
  const title = summary.title.trim()
  const agent = agentOfConversation(summary, agents)
  if (title !== '' && (agent === undefined || title !== agent.name)) {
    return title
  }
  if (agent !== undefined) {
    return `与 ${agent.name} 的对话`
  }
  return '新会话'
}

/**
 * 会话条目右侧元信息：引擎名 · 时间 · 消息数。
 * 原版侧栏只有一行标题；桌面端宽屏有余量，补上这三个字段（都不需要新数据，
 * ConversationSummaryDto 里本来就有 agentId / updatedAt / messageCount）。
 */
export function conversationMeta(
  summary: Pick<ConversationSummaryDto, 'agentId' | 'mode' | 'updatedAt' | 'messageCount'>,
  agents: AgentDto[],
  now: number
): string {
  const agent = agentOfConversation(summary, agents)
  const name = agent !== undefined ? agent.name : MODE_LABEL[summary.mode] ?? ''
  const parts: string[] = []
  if (name !== '') {
    parts.push(name)
  }
  const time = formatTimeLabel(summary.updatedAt, now)
  if (time !== '') {
    parts.push(time)
  }
  if (summary.messageCount > 0) {
    parts.push(`${summary.messageCount} 条`)
  }
  return parts.join(' · ')
}

/** 时间显示：今天只给 时:分，今年给 月/日，更早给 年/月/日 */
export function formatTimeLabel(ts: number, now: number): string {
  if (!Number.isFinite(ts) || ts <= 0) {
    return ''
  }
  const date = new Date(ts)
  const base = new Date(now)
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n))
  const sameDay =
    date.getFullYear() === base.getFullYear() &&
    date.getMonth() === base.getMonth() &&
    date.getDate() === base.getDate()
  if (sameDay) {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`
  }
  if (date.getFullYear() === base.getFullYear()) {
    return `${date.getMonth() + 1}/${date.getDate()}`
  }
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
}

/**
 * 会话别名（空标题会话用；供 title 悬浮提示与无障碍标签使用）。
 * 与标题同一套回退规则，但始终给出非空字符串。
 */
export function conversationFallbackTitle(agents: AgentDto[], agentId: string, mode: string): string {
  const agent = agentOfConversation({ agentId, mode }, agents)
  return agent === undefined ? '新会话' : `与 ${agent.name} 的对话`
}
