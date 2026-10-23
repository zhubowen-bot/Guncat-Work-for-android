import type { WorkspaceEntryDto } from '@ipc/contract'

/** 一次正在输入的 @ 引用：@ 的位置、光标位置、@ 与光标之间已输入的片段 */
export interface MentionQuery {
  /** '@' 字符本身的下标 */
  start: number
  caret: number
  /** @ 之后已经敲下的路径片段（可为空串 = 刚敲下 @，要列全部） */
  query: string
}

/**
 * 从光标往回找一个还没写完的 @ 引用。
 *
 * 邮箱与 URL 不该被当成文件引用，所以 @ 前面是 ASCII 词字符/点/斜杠/连字符时不算引用起点
 * （与内核 WorkspaceMentionService.extract 同一口径，中文紧挨着 @ 是允许的 —— 「这个@src/a.ts」
 * 本来就是最常见的写法）。引用中间出现空白即认为引用已经结束。
 */
export function detectMention(text: string, caret: number): MentionQuery | null {
  const end: number = Math.max(0, Math.min(caret, text.length))
  const before: string = text.slice(0, end)
  const matched: RegExpExecArray | null = /(^|[^\w./-])@([^\s]*)$/.exec(before)
  if (matched === null) {
    return null
  }
  // 匹配可能吃掉了 @ 前面的那个分隔字符，所以起点要按整段长度回推
  const start: number = before.length - matched[2].length - 1
  return { start, caret: end, query: matched[2] }
}

/**
 * 候选排序：先按文件名前缀，再按文件名包含，最后按整条路径包含。
 * 空查询给工作区里的前 limit 个文件（按层级浅的先），刚敲 @ 时最想要的通常在最上面。
 */
export function rankMentionCandidates(
  files: WorkspaceEntryDto[],
  query: string,
  limit: number
): string[] {
  const paths: string[] = files.filter((f) => !f.isDirectory).map((f) => f.path)
  const q: string = query.trim().toLowerCase()
  if (q === '') {
    return paths.sort((a, b) => depth(a) - depth(b) || a.localeCompare(b)).slice(0, limit)
  }
  const scored: { path: string; score: number }[] = []
  for (const path of paths) {
    const lower: string = path.toLowerCase()
    const base: string = baseName(lower)
    let score: number = -1
    if (base.startsWith(q)) {
      score = 0
    } else if (base.includes(q)) {
      score = 1
    } else if (lower.includes(q)) {
      score = 2
    }
    if (score >= 0) {
      scored.push({ path, score })
    }
  }
  scored.sort((a, b) => a.score - b.score || a.path.localeCompare(b.path))
  return scored.slice(0, limit).map((s) => s.path)
}

function baseName(path: string): string {
  const slash: number = path.lastIndexOf('/')
  return slash < 0 ? path : path.slice(slash + 1)
}

function depth(path: string): number {
  let n: number = 0
  for (let i = 0; i < path.length; i++) {
    if (path.charAt(i) === '/') {
      n++
    }
  }
  return n
}

interface PopupProps {
  paths: string[]
  active: number
  onPick(index: number): void
}

const MENTION_MAX_ROWS_INTERNAL = 0

export const MENTION_MAX_ROWS: number = 8

export function MentionPopup({ paths, active, onPick }: PopupProps) {
  const rows: string[] = paths.slice(0, MENTION_MAX_ROWS)
  if (rows.length === 0) {
    return null
  }
  return (
    <div className="mention" role="listbox" aria-label="工作区文件">
      {rows.map((path, index) => (
        <button
          key={path}
          type="button"
          className={`mention__row${index === active ? ' mention__row--active' : ''}`}
          // 按下就要选中，不能让 textarea 先失焦把弹层关掉
          onMouseDown={(e) => {
            e.preventDefault()
            onPick(index)
          }}
          role="option"
          aria-selected={index === active}
        >
          <span className="mention__at">@</span>
          <span className="mention__path">{path}</span>
        </button>
      ))}
      <div className="mention__hint">上下键选择 · Enter/Tab 插入 · Esc 关闭</div>
    </div>
  )
}
