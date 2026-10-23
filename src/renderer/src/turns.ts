// 消息 → 回合（turn）的重组，以及工具行/统计的展示纯函数。
//
// 为什么要在渲染层重组（对齐鸿蒙原版 ChatPage.buildWorkTimeline 的注释）：
//   Agent Loop 的既定结构就是「一个用户请求 → 若干条 assistant 消息」，
//   每条 assistant 带自己的 toolCalls。下一轮请求的历史由 messages 重建，
//   把多轮并成一条会让模型看到「一条 assistant 同时调了所有工具」，时序错乱。
//   所以**数据保持原样，只在渲染层归组**：一个用户请求下的多轮工具/回复是同一个视觉整体。
import { GuncatUiParts } from '@core/common/GuncatUiParts'
import type { MessageDto, ToolCallRecordDto } from '@ipc/contract'

export interface Turn {
  /** 第几个回合（0 起） */
  index: number
  /** 触发这一回合的用户消息；极端情况（历史数据从 assistant 开始）为 null */
  user: MessageDto | null
  /** 该用户请求之后、下一个用户请求之前的所有 assistant 消息 */
  rounds: MessageDto[]
}

/**
 * 把线性消息数组切成回合。
 * 前导的 assistant（没有对应 user）会各自成为一个 user=null 的回合，不会被丢弃。
 */
export function groupTurns(messages: MessageDto[]): Turn[] {
  const turns: Turn[] = []
  let current: Turn | null = null
  for (const message of messages) {
    if (message.role === 'user') {
      current = { index: turns.length, user: message, rounds: [] }
      turns.push(current)
      continue
    }
    if (current === null) {
      current = { index: turns.length, user: null, rounds: [] }
      turns.push(current)
    }
    current.rounds.push(message)
  }
  return turns
}

export interface TurnStats {
  rounds: number
  toolCalls: number
  failedTools: number
  /** 本回合正文总字数（含中间轮，用于「过程」摘要） */
  chars: number
  running: boolean
}

export function turnStats(turn: Turn): TurnStats {
  let toolCalls = 0
  let failedTools = 0
  let chars = 0
  let running = false
  for (const round of turn.rounds) {
    chars += (round.displayContent !== '' ? round.displayContent : round.content).length
    for (const call of round.toolCalls) {
      toolCalls++
      if (call.status === 'error') {
        failedTools++
      }
      if (call.status === 'running') {
        running = true
      }
    }
  }
  return { rounds: turn.rounds.length, toolCalls, failedTools, chars, running }
}

/** 回合的最终答复：最后一条 assistant 消息（原版把这一条当主体呈现） */
export function finalRound(turn: Turn): MessageDto | null {
  return turn.rounds.length === 0 ? null : turn.rounds[turn.rounds.length - 1]
}

/** 回合里需要收进「过程」区的中间轮 */
export function priorRounds(turn: Turn): MessageDto[] {
  return turn.rounds.slice(0, Math.max(0, turn.rounds.length - 1)).filter((m) => (m.displayContent !== '' ? m.displayContent : m.content).trim() !== '' || m.reasoning.trim() !== '' || m.toolCalls.length > 0)
}

/** 「过程」区标题：过程 · N 轮 · M 次工具调用 */
export function processTitle(stats: TurnStats): string {
  const parts: string[] = ['过程']
  if (stats.rounds > 1) {
    parts.push(`${stats.rounds} 轮`)
  }
  if (stats.toolCalls > 0) {
    parts.push(`${stats.toolCalls} 次工具调用`)
  }
  if (stats.failedTools > 0) {
    parts.push(`${stats.failedTools} 次失败`)
  }
  return parts.join(' · ')
}

/**
 * 单条回答的统计行。
 *
 * 逐字对齐原版 WorkTurnView.buildStatsLine / ChatBubbleView 的统计行：
 *   「（速度图标）N 字符/秒」 + `缓存命中 N%` + `工具 N 项 · 总耗时`
 * 三段的出现条件各自独立；速度用 **Math.round**（原版就是整数，不是一位小数），
 * 缓存命中同样取整；总耗时只累计「正数」的单步耗时（还在跑的那一步不计）。
 *
 * 一处有意差异：原版速度前面有一个文字符号前缀，本项目的渲染层禁用符号字符
 * （统一改用 SVG 图标；见 scripts/check-emoji.mjs），这里就只用文字表达同一件事。
 */
export function formatStats(message: MessageDto): string {
  const parts: string[] = []
  if (message.tokenSpeed !== undefined && message.tokenSpeed > 0) {
    parts.push(`${Math.round(message.tokenSpeed)} 字符/秒`)
  }
  if (message.cacheHitRate !== undefined && message.cacheHitRate >= 0) {
    parts.push(`缓存命中 ${Math.round(message.cacheHitRate * 100)}%`)
  }
  const calls = message.toolCalls ?? []
  if (calls.length > 0) {
    const totalMs = calls.reduce((sum, c) => sum + (c.durationMs > 0 ? c.durationMs : 0), 0)
    parts.push(`工具 ${calls.length} 项 · ${formatDuration(totalMs)}`)
  }
  return parts.join(' · ')
}

/** 耗时：< 1s 用 ms（原版 WorkStepFormat.formatDuration 口径） */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return ''
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`
  }
  return `${(ms / 1000).toFixed(1)}s`
}

// ===== 工具行 =====

/** 工具名 → 短标题（逐字取自原版 WorkStepFormat.displayName） */
export function toolDisplayName(toolName: string): string {
  switch (toolName) {
    case 'read_file':
    case 'read_ppt':
      return 'Read'
    case 'parse_document':
      return 'Parse'
    case 'write_file':
    case 'write_docx':
    case 'write_xlsx':
    case 'write_pptx':
    case 'write_csv':
    case 'write_svg':
      return 'Write'
    case 'append_file':
      return 'Append'
    case 'edit_ppt':
      return 'Edit'
    case 'transform_file':
      return 'Transform'
    case 'search_files':
    case 'search_pdf':
    case 'record_search':
      return 'Search'
    case 'local_web_search':
    case 'search_web':
      return 'Local Search'
    case 'glob':
      return 'Glob'
    case 'grep':
      return 'Grep'
    case 'edit':
    case 'str_replace_editor':
      return 'Edit'
    case 'web_fetch':
      return 'Fetch'
    case 'ask_user_question':
      return 'Ask'
    case 'schedule_create':
    case 'schedule_delete':
    case 'schedule_list':
      return 'Schedule'
    case 'goal_create':
    case 'goal_get':
    case 'goal_update':
      return 'Goal'
    case 'subagent':
      return 'Spawn'
    case 'session_search':
      return 'Log'
    case 'list_files':
      return 'List'
    case 'list_skills':
      return 'Skills'
    case 'load_skill':
      return 'Skill'
    case 'create_dir':
      return 'Mkdir'
    case 'delete_file':
      return 'Delete'
    case 'move_file':
      return 'Move'
    case 'download_file':
      return 'Download'
    case 'view_image':
    case 'pdf_to_images':
      return 'Image'
    case 'todo_write':
      return 'Todo'
    case 'bash':
      return 'Bash'
    case 'run_js':
      return 'JS'
    default:
      return toolName
  }
}

/** 工具行的参数摘要：挑常见参数名，单参数时省略键名（原版 summarizeArgs 口径） */
export function toolArgsSummary(argsJson: string): string {
  const trimmed = argsJson.trim()
  if (trimmed === '') {
    return ''
  }
  // 流式生成中的参数不是完整 JSON：不整段解析，直接截断展示
  if (!trimmed.endsWith('}')) {
    return capText(trimmed.replace(/\s+/g, ' '), 80)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return capText(trimmed.replace(/\s+/g, ' '), 80)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return capText(trimmed.replace(/\s+/g, ' '), 80)
  }
  const rec = parsed as Record<string, unknown>
  const keys = [
    'path',
    'from',
    'to',
    'query',
    'url',
    'pattern',
    'command',
    'objective',
    'description',
    'message',
    'question',
    'content'
  ]
  const parts: string[] = []
  for (const key of keys) {
    const value = rec[key]
    if (typeof value !== 'string' || value === '') {
      continue
    }
    parts.push(key === 'content' ? `content=${capText(value.replace(/\s+/g, ' '), 48)}` : `${key}=${capText(value, 80)}`)
  }
  if (parts.length === 1) {
    const eq = parts[0].indexOf('=')
    return eq >= 0 ? parts[0].substring(eq + 1) : parts[0]
  }
  if (parts.length > 1) {
    return capText(parts.join(' '), 96)
  }
  return capText(trimmed.replace(/\s+/g, ' '), 80)
}

export function capText(text: string, max: number): string {
  if (text.length <= max) {
    return text
  }
  return `${text.substring(0, max)}…`
}

/**
 * 手动停止的轮次会被追加这句标注（内核 `Constants.WORK_STOPPED_NOTE`）。
 * 折叠栏据此把「已完成」改成「已停止」—— 明明被打断却写着完成是误导。
 */
export const STOPPED_NOTE = '任务已手动停止'

/**
 * 取文本首行（并压掉多余空白）。
 * 原版用它把「工具出错时的结果首行」当成摘要显示（WorkTurnView 的 firstLineOf）：
 * 出错时参数摘要没意义，用户要看的是哪儿错了。
 */
export function firstLineOf(text: string): string {
  const line = text.split('\n')[0] ?? ''
  return line.replace(/\s+/g, ' ').trim()
}

/**
 * 剥掉 Markdown 标记，得到可复制的纯文本。
 *
 * 逐字移植原版 ChatViewModel 里的 stripMarkdown：先抽掉界面程序
 * （否则整份 guncat-ui 程序源码会被当成「正文」复制出去），再去掉代码块、
 * 行内代码、图片、链接、标题、粗斜体、引用与表格竖线、分割线。
 */
export function stripMarkdown(markdown: string): string {
  let text = GuncatUiParts.plainSummary(markdown)
  if (text.trim() === '') {
    text = markdown
  }
  text = text.replace(/```[\s\S]*?```/g, '')
  text = text.replace(/`([^`]+)`/g, '$1')
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  text = text.replace(/^#{1,6}\s+/gm, '')
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1')
  text = text.replace(/\*([^*]+)\*/g, '$1')
  text = text.replace(/^>\s?/gm, '')
  text = text.replace(/\|/g, '')
  text = text.replace(/^-{3,}$/gm, '')
  return text.trim()
}

export interface ToolStatus {
  state: 'running' | 'ok' | 'error'
  label: string
}

export function toolStatus(call: Pick<ToolCallRecordDto, 'status'>): ToolStatus {
  if (call.status === 'error') {
    return { state: 'error', label: '失败' }
  }
  if (call.status === 'running') {
    return { state: 'running', label: '执行中' }
  }
  return { state: 'ok', label: '完成' }
}

/** 工具行左侧图标分类（对应原版按工具名映射 sys.symbol） */
export type ToolIconKind =
  | 'read'
  | 'write'
  | 'edit'
  | 'search'
  | 'web'
  | 'fetch'
  | 'ask'
  | 'schedule'
  | 'goal'
  | 'spawn'
  | 'skill'
  | 'image'
  | 'shell'
  | 'list'
  | 'trash'
  | 'move'
  | 'download'
  | 'check'

export function toolIconKind(toolName: string): ToolIconKind {
  switch (toolName) {
    case 'read_file':
    case 'read_ppt':
    case 'parse_document':
      return 'read'
    case 'write_file':
    case 'write_docx':
    case 'write_xlsx':
    case 'write_pptx':
    case 'write_csv':
    case 'write_svg':
    case 'append_file':
      return 'write'
    case 'edit':
    case 'str_replace_editor':
    case 'edit_ppt':
    case 'transform_file':
      return 'edit'
    case 'search_files':
    case 'search_pdf':
    case 'record_search':
    case 'glob':
    case 'grep':
    case 'session_search':
      return 'search'
    case 'local_web_search':
    case 'search_web':
      return 'web'
    case 'web_fetch':
      return 'fetch'
    case 'ask_user_question':
      return 'ask'
    case 'schedule_create':
    case 'schedule_delete':
    case 'schedule_list':
      return 'schedule'
    case 'goal_create':
    case 'goal_get':
    case 'goal_update':
      return 'goal'
    case 'subagent':
      return 'spawn'
    case 'list_skills':
    case 'load_skill':
      return 'skill'
    case 'view_image':
    case 'pdf_to_images':
      return 'image'
    case 'bash':
    case 'run_js':
      return 'shell'
    case 'list_files':
      return 'list'
    case 'delete_file':
      return 'trash'
    case 'move_file':
    case 'create_dir':
      return 'move'
    case 'download_file':
      return 'download'
    case 'todo_write':
      return 'check'
    default:
      return 'shell'
  }
}
