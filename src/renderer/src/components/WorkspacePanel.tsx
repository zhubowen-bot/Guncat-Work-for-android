// 工作区面板（对齐原版 WorkspaceBar：标题 + 上传/导出 + 文件清单 + 底部统计）。
//
// 用户报障「工作区上传文件有问题，找不到入口」的根因很具体：
// 桌面版此前只有「拖拽文件到窗口」这一条导入路径，而拖拽在界面上**没有任何提示**，
// 用户不可能猜到。原版 WorkspaceBar 的头部就有一颗看得见的「上传」按钮，
// 空态文案更是直接写着「工作区为空, 点击"上传"添加文件」。
// 这里把那个入口补回来，并且空态也给一颗按钮 —— 空工作区恰恰是最需要它的时候。
import { Fragment, useEffect, useRef, useState } from 'react'
import type {
  ConversationDto,
  ConversationStatsDto,
  GoalDto,
  WorkspaceEntryDto,
  WorkspaceInfoDto
} from '@ipc/contract'
import { Constants } from '@core/common/Constants'
import { useStore } from '../store'
import {
  IconAudio,
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconCode,
  IconDot,
  IconDownload,
  IconFile,
  IconFolder,
  IconImage,
  IconPdf,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconVideo,
  IconZip
} from '../icons'

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 目标状态的短标签（对齐原版 GoalService 的四种状态） */
const GOAL_STATUS_LABEL: Record<string, string> = {
  active: '推进中',
  paused: '已暂停',
  done: '已完成',
  blocked: '受阻'
}

/**
 * 任务用时：原版是**整数秒**（`elapsedSec + ' 秒'`，见 DetailsPanelView.ets:148）。
 * 这里收的是一个「秒」计数而不是毫秒时间戳 —— 与原版的 workElapsedSec 同口径。
 */
export function formatElapsedSec(seconds: number): string {
  return `${Math.max(0, Math.trunc(seconds))} 秒`
}

/**
 * 本轮统计卡（逐条对齐原版 DetailsPanelView.ets:143-157）：
 * 标题「本轮统计」+ 四行「标签在左、值在右」，卡片 padding 12 / 圆角 12 / 1px 描边。
 *
 * 与原版的四点一致性与差异：
 *   · 任务用时 = 整数秒（原版是 workElapsedSec 这个每秒 +1 的计数）；
 *   · 输出速度取最后一条 assistant 的 tokenSpeed 并 **Math.round**，无数据显示「—」；
 *   · 缓存命中同理；工具调用轮数 = **会话内所有 assistant 轮的 toolCalls 之和**
 *     （原版 detailToolCallTotal 的口径：只看最后一条会恒为 0，因为收尾轮是纯文本）。
 *   · 原版恒显示这张卡（没数据时值就是「—」），这里也恒显示。
 */
export function TaskStatsCard({
  elapsedSec,
  speed,
  cacheHit,
  toolCalls
}: {
  elapsedSec: number
  speed: number
  cacheHit: number
  toolCalls: number
}) {
  return (
    <div className="statcard">
      <div className="statcard__title">本轮统计</div>
      <StatRow label="任务用时" value={formatElapsedSec(elapsedSec)} />
      <StatRow label="输出速度" value={speed > 0 ? `${Math.round(speed)} 字符/秒` : '—'} />
      <StatRow label="缓存命中" value={cacheHit >= 0 ? `${Math.round(cacheHit * 100)}%` : '—'} />
      <StatRow label="工具调用轮数" value={String(toolCalls)} />
    </div>
  )
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="statrow">
      <span className="statrow__label">{label}</span>
      <span className="statrow__value">{value}</span>
    </div>
  )
}

/**
 * 底部统计行（对齐原版 WorkspaceBar.ets:205-227）：
 * 会话工作时间 `MM:SS`（≥1 小时给 `HH:MM:SS`，未跑过不显示）、生成速度 `N.N tok/s`、
 * 缓存命中 `缓存命中 N%`（**只在非流式时**显示）。
 * 前两项在流式中用次要色、停止后转三级色。
 */
export function WorkFooterStats({
  elapsedSec,
  speed,
  cacheHit,
  streaming
}: {
  elapsedSec: number
  speed: number
  cacheHit: number
  streaming: boolean
}) {
  if (elapsedSec <= 0 && speed <= 0 && (streaming || cacheHit < 0)) {
    return null
  }
  return (
    <div className="workstats">
      {elapsedSec > 0 ? (
        <span className="workstats__item" data-streaming={streaming}>
          {formatWorkTime(elapsedSec)}
        </span>
      ) : null}
      {speed > 0 ? (
        <span className="workstats__item" data-streaming={streaming}>
          {`${speed.toFixed(1)} tok/s`}
        </span>
      ) : null}
      {!streaming && cacheHit >= 0 ? (
        <span className="workstats__item">{`缓存命中 ${Math.round(cacheHit * 100)}%`}</span>
      ) : null}
    </div>
  )
}

/** 会话工作时间：MM:SS，超过一小时给 HH:MM:SS（原版 formatWorkTime） */
export function formatWorkTime(totalSec: number): string {
  const total = Math.max(0, Math.trunc(totalSec))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = m < 10 ? `0${m}` : String(m)
  const ss = s < 10 ? `0${s}` : String(s)
  if (h > 0) {
    const hh = h < 10 ? `0${h}` : String(h)
    return `${hh}:${mm}:${ss}`
  }
  return `${mm}:${ss}`
}

/** 当前目标卡（对齐原版 DetailsPanelView 的目标卡）；没有目标时整张卡不显示 */
export function TaskGoalCard({ goal }: { goal: GoalDto | null }) {
  if (goal === null || goal.objective === '') {
    return null
  }
  return (
    <div className="taskgoal">
      <div className="taskgoal__head">
        <span>当前目标</span>
        <span className="taskgoal__status" data-status={goal.status}>
          {GOAL_STATUS_LABEL[goal.status] ?? goal.status}
        </span>
      </div>
      <div className="taskgoal__text">{goal.objective}</div>
      <div className="taskgoal__meta">
        第 {goal.rounds} / {goal.maxRounds} 轮
      </div>
    </div>
  )
}

/**
 * 按扩展名映射类别图标（逐组取自原版 WorkspaceFileIcons.iconFor）。
 * 未知类型回退通用文档图标 —— 一行文件列表里，能一眼分出「这是图还是表」很有用。
 */
export function workspaceFileIcon(path: string, size = 15): React.ReactElement {
  const dot = path.lastIndexOf('.')
  const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : ''
  switch (ext) {
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
    case 'bmp':
    case 'svg':
    case 'heic':
      return <IconImage size={size} />
    case 'pdf':
      return <IconPdf size={size} />
    case 'zip':
    case 'rar':
    case '7z':
    case 'tar':
    case 'gz':
    case 'tgz':
      return <IconZip size={size} />
    case 'docx':
    case 'doc':
    case 'rtf':
    case 'odt':
    case 'pptx':
    case 'ppt':
    case 'xlsx':
    case 'xls':
    case 'csv':
    case 'tsv':
    case 'md':
    case 'markdown':
    case 'txt':
    case 'log':
      return <IconFile size={size} />
    case 'json':
    case 'xml':
    case 'html':
    case 'htm':
    case 'css':
    case 'js':
    case 'jsx':
    case 'ts':
    case 'tsx':
    case 'py':
    case 'java':
    case 'kt':
    case 'kts':
    case 'swift':
    case 'c':
    case 'cpp':
    case 'h':
    case 'hpp':
    case 'cs':
    case 'go':
    case 'rs':
    case 'rb':
    case 'php':
    case 'sql':
    case 'sh':
    case 'bat':
    case 'gradle':
    case 'yaml':
    case 'yml':
    case 'toml':
      return <IconCode size={size} />
    case 'mp3':
    case 'wav':
    case 'm4a':
    case 'aac':
    case 'flac':
    case 'ogg':
      return <IconAudio size={size} />
    case 'mp4':
    case 'mov':
    case 'avi':
    case 'mkv':
    case 'webm':
      return <IconVideo size={size} />
    default:
      return <IconFile size={size} />
  }
}

/**
 * 会话工作时间：Agent Loop 形态下每秒 +1，切会话归零。
 *
 * 原版把这个计数放在**页面的常驻定时器**里（`ChatPage.ets:227-253`），因为详情面板
 * 随开随关、计时不能因为关面板而中断。桌面端的面板同样可以收起，所以这里用一个
 * 基于**会话开始时间**的派生值：只要还在跑，就按「从本轮开始到现在」算秒数；
 * 跑完则定格在最后一轮的用时上。这样收起再展开也不会丢时间。
 */
function useWorkElapsed(activeId: string | null): number {
  const running = useStore((s) => s.running)
  const [seconds, setSeconds] = useState(0)
  const startedAtRef = useRef(0)
  const frozenRef = useRef(0)

  useEffect(() => {
    // 切会话：计时归零（原版 lastWorkConvId 变化时 workElapsedSec = 0）
    startedAtRef.current = 0
    frozenRef.current = 0
    setSeconds(0)
  }, [activeId])

  useEffect(() => {
    if (running) {
      if (startedAtRef.current === 0) {
        startedAtRef.current = Date.now() - frozenRef.current * 1000
      }
      const tick = (): void => setSeconds(Math.floor((Date.now() - startedAtRef.current) / 1000))
      tick()
      const timer = window.setInterval(tick, 1000)
      return () => window.clearInterval(timer)
    }
    // 停止：定格（原版「任务执行中每秒走字, 停止后定格」）
    if (startedAtRef.current !== 0) {
      frozenRef.current = Math.floor((Date.now() - startedAtRef.current) / 1000)
      setSeconds(frozenRef.current)
      startedAtRef.current = 0
    }
    return undefined
  }, [running])

  return seconds
}

/** 取最后一条「有值」的 assistant 指标（原版是倒着找第一条有值的） */
function lastAssistantValue(
  messages: WorkspacePanelMessage[],
  pick: (m: WorkspacePanelMessage) => number
): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'assistant') {
      continue
    }
    const value = pick(messages[i])
    if (value > 0 || (value >= 0 && value !== 0)) {
      return value
    }
  }
  return -1
}

type WorkspacePanelMessage = ConversationDto['messages'][number]

export function WorkspacePanel() {
  const workspace = useStore((s) => s.workspace)
  const stats = useStore((s) => s.stats)
  const activeId = useStore((s) => s.activeId)
  const active = useStore((s) => s.active)
  const running = useStore((s) => s.running)
  const deleteEntry = useStore((s) => s.deleteWorkspaceEntry)
  const clear = useStore((s) => s.clearWorkspace)
  const exportZip = useStore((s) => s.exportWorkspace)
  const openFolder = useStore((s) => s.openWorkspaceFolder)
  const loadWorkspace = useStore((s) => s.loadWorkspace)
  const pickFiles = useStore((s) => s.pickWorkspaceFiles)
  const pushNotice = useStore((s) => s.pushNotice)
  const openWorkspaceFile = useStore((s) => s.openWorkspaceFile)
  const previewPath = useStore((s) => s.workspacePreview?.path ?? '')
  const closeWorkspace = useStore((s) => s.toggleWorkspace)

  // 懒加载文件树：根目录常刷，展开过的目录跟着刷，未展开的不读。
  // key 是目录相对路径（'' = 根；core 给的目录路径带尾 '/'，原样作 key）。
  const [tree, setTree] = useState<Record<string, WorkspaceEntryDto[]>>({})
  const [expanded, setExpanded] = useState<string[]>([])
  const treeSeq = useRef(0)
  const expandedRef = useRef<string[]>([])
  expandedRef.current = expanded

  useEffect(() => {
    treeSeq.current += 1
    setTree({})
    setExpanded([])
    setRootInfo(null)
    void loadRoot()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])

  // 工作区根状态（默认沙箱 / 用户自选目录 / 目录已失效）
  const [rootInfo, setRootInfo] = useState<WorkspaceInfoDto | null>(null)

  async function loadRoot(): Promise<void> {
    if (activeId === null) {
      setRootInfo(null)
      return
    }
    try {
      setRootInfo(await window.guncat.workspace.info(activeId))
    } catch {
      setRootInfo(null)
    }
  }

  async function switchRoot(): Promise<void> {
    if (activeId === null) {
      return
    }
    const dir = await window.guncat.workspace.pickDirectory()
    if (dir === null) {
      return
    }
    try {
      const info = await window.guncat.workspace.setCustom(activeId, dir)
      setRootInfo(info)
      treeSeq.current += 1
      setTree({})
      setExpanded([])
      void loadWorkspace()
      pushNotice('info', `本会话工作区已切换到 ${info.root}`)
    } catch (e) {
      pushNotice('warn', String(e instanceof Error ? e.message : e))
    }
  }

  async function restoreSandbox(): Promise<void> {
    if (activeId === null) {
      return
    }
    try {
      const info = await window.guncat.workspace.setCustom(activeId, null)
      setRootInfo(info)
      treeSeq.current += 1
      setTree({})
      setExpanded([])
      void loadWorkspace()
      pushNotice('info', '已恢复为应用托管的沙箱工作区')
    } catch (e) {
      pushNotice('warn', String(e instanceof Error ? e.message : e))
    }
  }

  /** 命令审批档位：改完立刻刷新这一行（主进程返回的就是新的 info） */
  async function applyPermission(permission: string): Promise<void> {
    if (activeId === null) {
      return
    }
    try {
      const info = await window.guncat.workspace.setCommandPermission(activeId, permission)
      setRootInfo(info)
      const picked = COMMAND_PERMISSIONS.find((p) => p.value === info.commandPermission)
      pushNotice('info', `命令审批：${picked !== undefined ? picked.label : info.commandPermission}`)
    } catch (e) {
      pushNotice('warn', String(e instanceof Error ? e.message : e))
    }
  }

  async function refreshTree(): Promise<void> {
    if (activeId === null) {
      setTree({})
      return
    }
    const seq = treeSeq.current
    const dirs: string[] = Array.from(new Set(['', ...expandedRef.current]))
    try {
      const loaded = await Promise.all(
        dirs.map(async (dir) => [dir, await window.guncat.workspace.listDir(activeId, dir)] as const)
      )
      if (seq !== treeSeq.current) {
        return
      }
      const next: Record<string, WorkspaceEntryDto[]> = {}
      for (const [dir, items] of loaded) {
        next[dir] = items
      }
      setTree(next)
    } catch {
      // 刷新失败保持现状（工作区目录偶发被占用/删除时不把面板打回空态）
    }
  }

  async function toggleDir(dir: string): Promise<void> {
    if (expanded.includes(dir)) {
      setExpanded(expanded.filter((d) => d !== dir))
      return
    }
    setExpanded([...expanded, dir])
    if (tree[dir] === undefined && activeId !== null) {
      try {
        const items = await window.guncat.workspace.listDir(activeId, dir)
        setTree((prev) => ({ ...prev, [dir]: items }))
      } catch {
        setTree((prev) => ({ ...prev, [dir]: [] }))
      }
    }
  }

  function removeEntry(path: string): void {
    void deleteEntry(path).then(() => {
      pushNotice('info', `已删除 ${path}`)
      void refreshTree()
    })
  }

  function renderTreeRows(dir: string, depth: number): React.ReactNode {
    const items = tree[dir]
    if (items === undefined) {
      return null
    }
    const pad: React.CSSProperties = { paddingLeft: `${8 + depth * 14}px` }
    return items.map((entry) =>
      entry.isDirectory ? (
        <Fragment key={entry.path}>
          <div className="file-item file-item--dir" style={pad} onClick={() => void toggleDir(entry.path)}>
            <span className="file-item__chevron">
              {expanded.includes(entry.path) ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
            </span>
            <span className="file-item__icon">
              <IconFolder size={15} />
            </span>
            <span className="file-item__name" title={entry.path}>
              {entry.name}
            </span>
            <button
              className="icon-btn file-item__del"
              title="删除目录（递归）"
              disabled={running}
              onClick={(e) => {
                e.stopPropagation()
                removeEntry(entry.path)
              }}
            >
              <IconTrash size={14} />
            </button>
          </div>
          {expanded.includes(entry.path) ? renderTreeRows(entry.path, depth + 1) : null}
        </Fragment>
      ) : (
        <div className="file-item" key={entry.path} style={pad}>
          <span className="file-item__chevron file-item__chevron--placeholder" />
          <span className="file-item__icon">{workspaceFileIcon(entry.path)}</span>
          {/* 点文件名按类型打开（图片渲染 / Markdown 排版 / 代码着色 / 其余走外部程序） */}
          <button
            className="file-item__name file-item__name--link"
            title={`${entry.path}\n点击打开（图片/Markdown/代码会按类型渲染）`}
            disabled={running}
            onClick={() => openWorkspaceFile(entry.path)}
          >
            {entry.name}
          </button>
          <span className="file-item__size">
            {previewPath === entry.path ? '读取中…' : formatSize(entry.size)}
          </span>
          <button
            className="icon-btn file-item__del"
            title="删除"
            disabled={running}
            onClick={() => removeEntry(entry.path)}
          >
            <IconTrash size={14} />
          </button>
        </div>
      )
    )
  }

  // 会话工作时间（原版 ChatPage 的 workTickTimer）：只在 Agent Loop 形态下计时、
  // 流式期间每秒 +1、切换会话归零。原版把它挂在页面上（面板随开随关，计时不能中断），
  // 桌面端面板只在展开时挂载，所以这里在「没展开时也继续走」这件事上等价处理：
  // 计时状态放在组件里，展开面板时从会话开始时间起算即可（见下面 elapsedFrom）。
  const workElapsedSec = useWorkElapsed(activeId)

  // 兜底刷新：原版在这个 1 秒定时器里每 3 拍刷一次工作区文件列表
  // （`ChatPage.ets:243-247`：流式中或面板可见时），用来覆盖工具结果之外的写入
  // ——定时任务、外部程序往工作区里丢文件这类变化不会发事件。
  // 面板本身就是「可见」的条件，所以这里只要面板挂载着就按 3 秒兜底。
  useEffect(() => {
    const tick = (): void => {
      void loadWorkspace()
      void refreshTree()
      void loadRoot()
    }
    tick()
    const timer = window.setInterval(tick, 3000)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadWorkspace, activeId])

  const messages = active?.messages ?? []
  const toolCalls = messages.reduce((sum, m) => sum + m.toolCalls.length, 0)
  // 速度与命中取**最后一条有值的** assistant（原版 WorkspaceBar 的 getSpeedText/getCacheHitText）
  const lastSpeed = lastAssistantValue(messages, (m) => (m.tokenSpeed > 0 ? m.tokenSpeed : 0))
  const lastCacheHit = lastAssistantValue(messages, (m) => m.cacheHitRate)
  const files = workspace.filter((e) => !e.isDirectory).length

  // 原版 WorkspaceBar：任务执行中禁掉上传/导出，避免和正在跑的工具抢工作区
  const uploadDisabled = running

  return (
    <aside className="workspace">
      <div className="workspace__head">
        <span className="workspace__glyph">
          <IconFolder size={15} />
        </span>
        <strong>工作区</strong>
        <span className="workspace__live" title="会话工作区变化会实时刷新">
          <IconDot size={9} />
          实时
        </span>
        {/* 「上传」就是用户一直在找的那个入口（原版 WorkspaceBar.buildHeaderButton('上传')） */}
        <button
          className="btn btn--ghost btn--sm workspace__upload"
          disabled={uploadDisabled}
          title={uploadDisabled ? '任务执行中，稍后再上传' : '选择文件加入工作区'}
          onClick={() => void pickFiles()}
        >
          <IconPlus size={13} />
          上传
        </button>
        <button
          className="icon-btn"
          disabled={activeId === null}
          title="刷新"
          onClick={() => {
            void loadWorkspace()
            void refreshTree()
          }}
        >
          <IconRefresh size={15} />
        </button>
        <button
          className="icon-btn"
          disabled={activeId === null}
          title="在文件管理器中打开"
          onClick={() => void openFolder()}
        >
          <IconFolder size={15} />
        </button>
        <button
          className="icon-btn"
          disabled={activeId === null || workspace.length === 0 || running}
          title="打包导出为 zip"
          onClick={() => void exportZip()}
        >
          <IconDownload size={15} />
        </button>
        <button className="icon-btn mobile-only" title="关闭工作区" onClick={() => closeWorkspace(false)}>
          <IconClose size={18} />
        </button>
      </div>

      {/* 工作区根路径行：让人一眼知道文件到底落在哪 —— 默认沙箱 or 自选目录。
          「打开…」把任意文件夹接进来作本会话工作区（工具链/面板/导出全局跟随）。 */}
      {rootInfo !== null ? (
        <div className="workspace__root" title={rootInfo.root}>
          <span className={`workspace__root-path${rootInfo.exists ? '' : ' workspace__root-path--stale'}`}>
            {rootInfo.exists
              ? `位置：${rootLabel(rootInfo)}`
              : `位置：${rootLabel(rootInfo)}（目录已失效）`}
          </span>
          <button
            className="filecard__action"
            disabled={running}
            title={running ? '任务执行中，稍后再切换' : '打开任意文件夹作为本会话的工作区'}
            onClick={() => void switchRoot()}
          >
            打开…
          </button>
          {rootInfo.isCustom ? (
            <button
              className="filecard__action"
              disabled={running}
              title="恢复为应用托管的沙箱目录（不会删除你目录里的文件）"
              onClick={() => void restoreSandbox()}
            >
              恢复沙箱
            </button>
          ) : null}
        </div>
      ) : null}

      {/* 命令审批档位（见 COMMAND_PERMISSIONS 的说明）：智能体能跑命令了，
          「哪些要先问你」这一行必须摆在用户看得见的位置。 */}
      {rootInfo !== null ? (
        <div className="workspace__perm">
          <span className="workspace__perm-label">命令审批</span>
          <select
            className="workspace__perm-select"
            disabled={running}
            value={rootInfo.commandPermission}
            title={running ? '任务执行中，稍后再改' : COMMAND_PERMISSIONS.find((p) => p.value === rootInfo.commandPermission)?.hint}
            onChange={(e) => void applyPermission(e.target.value)}
          >
            {COMMAND_PERMISSIONS.map((p) => (
              <option key={p.value} value={p.value} title={p.hint}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {/* 项目指令：放在工作区根目录的 AGENTS.md / CLAUDE.md / GUNCAT.md 会被逐轮读给智能体
          （见 core/service/WorkspaceInstructionsService，随运行时快照注入）。
          这一行的意义是「可见」——用户必须能确认自己写的约定真的生效了，而不是靠猜。 */}
      {rootInfo !== null ? (
        <div className="workspace__instr">
          <span className="workspace__perm-label">项目指令</span>
          {rootInfo.instructionFiles.length > 0 ? (
            rootInfo.instructionFiles.map((name) => (
              <button
                key={name}
                className="file-item__name file-item__name--link workspace__instr-file"
                disabled={running}
                title={`已生效：智能体每轮都会读入 ${name} 并遵守其中的项目约定（点击看内容）`}
                onClick={() => openWorkspaceFile(name)}
              >
                {name}
              </button>
            ))
          ) : (
            <span
              className="workspace__instr-none"
              title={instructionSetupHint()}
            >
              未设置
            </span>
          )}
        </div>
      ) : null}

      {/* 本轮统计卡（对齐原版 DetailsPanelView.ets:143-157）。
          任务用时用「会话工作秒数」这个每秒 +1 的计数（原版 workElapsedSec 同口径），
          所以它会**逐秒走字**；速度/命中取最后一条 assistant；
          工具调用轮数是会话内所有 assistant 轮的调用之和（原版 detailToolCallTotal）。 */}
      <TaskStatsCard
        elapsedSec={workElapsedSec}
        speed={lastSpeed}
        cacheHit={lastCacheHit}
        toolCalls={toolCalls}
      />

      {/* 当前目标卡（对齐原版 DetailsPanelView 的目标卡）。
          目标是模型用 create_goal 建的，存在工作区 .goal.json 里。 */}
      {stats !== null ? <TaskGoalCard goal={stats.goal} /> : null}

      {/* 文件卡头（原版是「文件 (N)」+ 上传 / 导出 两个文字按钮） */}
      <div className="filecard__head">
        <span className="statcard__title">{`文件 (${files})`}</span>
        <button
          className="filecard__action"
          disabled={uploadDisabled}
          title={uploadDisabled ? '任务执行中，稍后再上传' : '选择文件加入工作区'}
          onClick={() => void pickFiles()}
        >
          上传
        </button>
        <button
          className="filecard__action"
          disabled={activeId === null || workspace.length === 0 || running}
          title="打包导出为 zip"
          onClick={() => void exportZip()}
        >
          导出
        </button>
      </div>

      <div className="workspace__list">
        {workspace.length === 0 ? (
          <div className="workspace__empty">
            {running ? (
              '任务执行中…'
            ) : (
              <>
                <span>工作区为空</span>
                <span className="workspace__empty-sub">
                  点上面的「上传」添加文件，或把文件直接拖进窗口
                </span>
                <button className="btn btn--block workspace__empty-btn" onClick={() => void pickFiles()}>
                  <IconPlus size={14} />
                  上传文件
                </button>
              </>
            )}
          </div>
        ) : (
          renderTreeRows('', 0)
        )}
      </div>

      {workspace.length > 0 && rootInfo?.isCustom !== true ? (
        <div className="workspace__foot">
          <button
            className="btn btn--ghost btn--block btn--danger"
            disabled={running}
            onClick={() => void clear()}
          >
            <IconTrash size={14} />
            清空工作区
          </button>
        </div>
      ) : null}

      {/* 底部统计行（原版 WorkspaceBar 左下角）：会话工作时间 / tok/s / 缓存命中 */}
      <WorkFooterStats
        elapsedSec={workElapsedSec}
        speed={lastSpeed}
        cacheHit={lastCacheHit}
        streaming={running}
      />
    </aside>
  )
}

/** 工作区根路径的短标签：沙箱说「沙箱目录」，自选目录显示目录名（完整路径放 tooltip） */
function rootLabel(info: WorkspaceInfoDto): string {
  if (!info.isCustom) {
    return '沙箱目录（应用托管）'
  }
  const trimmed: string = info.root.replace(/[\\/]+$/, '')
  const segs: string[] = trimmed.split(/[\\/]/)
  return segs[segs.length - 1] !== '' ? segs[segs.length - 1] : trimmed
}

/**
 * 命令审批档位（取值与 core 的 CommandGuard.PERMISSIONS 一致）。
 *
 * 这一行存在的理由：智能体现在能在本机跑命令了，「跑到哪一步要先问你」必须由用户说了算，
 * 而不是由模型决定。四档改的只是**危险命令由谁裁决**；格式化磁盘、关机这类毁灭性操作
 * 在任何档位下都会被直接拒绝，连批准的机会都没有。
 */
export const COMMAND_PERMISSIONS: { value: string; label: string; hint: string }[] = [
  {
    value: 'ask-risk',
    label: '危险命令需批准',
    hint: '默认档。删除文件、改系统配置或服务、安装全局包、git push、从网络下载等有风险命令会先请你批准，其余直接执行'
  },
  {
    value: 'ask',
    label: '每条都批准',
    hint: '每条命令执行前都要你批准，包括看起来无害的'
  },
  {
    value: 'auto',
    label: '自动审批',
    hint: '危险命令先交给模型审阅一轮：它判定安全的直接执行（结果里写明是自动审阅放行），判危险的仍然弹卡请你批准；审阅失败一律按危险处理'
  },
  {
    value: 'full-access',
    label: '完全权限',
    hint: '危险命令不审阅也不询问，由智能体自行执行。毁灭性操作（格式化磁盘、关机等）在任何档位下都会被直接拒绝'
  }
]

/**
 * 项目指令未设置时的提示文案。
 *
 * 文件名清单**必须**取自 core 的 Constants.WORK_INSTRUCTION_FILES（渲染进程只允许引用
 * @core/common，所以这里引的是常量而不是那个会读盘的服务）——界面不能承诺「放任何说明文件都算」，
 * 而内核其实只认根目录这几个名字。
 */
export function instructionSetupHint(): string {
  return `在工作区根目录放一份 ${Constants.WORK_INSTRUCTION_FILES.join(' / ')}（也可以直接让智能体帮你写），智能体每轮都会读入并遵守里面的项目约定`
}