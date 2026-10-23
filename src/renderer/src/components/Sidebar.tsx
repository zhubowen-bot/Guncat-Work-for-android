// 侧边栏（对齐鸿蒙原版 views/DswSidebar.ets 的信息层级）：
//   品牌行 → 新建会话 → 引擎（智能体）区 → 会话区（带条数）→ 底部（工作区 / 设置）。
// 折叠态是 56px 图标栏（原版 dsh collapse rail 的等价物）。
import { useState } from 'react'
import type { AgentDto, ConversationSummaryDto } from '@ipc/contract'
import {
  MODE_LABEL,
  conversationMeta,
  conversationTitle
} from '../conversations'
import { useStore } from '../store'
import { APP_ICON_SRC, AgentGlyph } from './AgentGlyph'
import {
  IconChat,
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconFolder,
  IconInteractive,
  IconPlus,
  IconSettings,
  IconSidebar,
  IconTrash,
  IconWork
} from '../icons'

/**
 * 智能体头像：三种形态的判定统一收在 AgentGlyph（虚拟引擎 SVG / 真实智能体原图 / 首字兜底）。
 * 这里只负责给虚拟引擎补上侧栏专用的字号类。
 */
function AgentAvatar({ agent }: { agent: AgentDto }) {
  const virtual = agent.id === 'work' || agent.id === 'interactive'
  return <AgentGlyph agent={agent} size={20} className={virtual ? 'agent-item__glyph' : undefined} />
}

/**
 * 「引擎」区的一行（原版 buildAgentItem）。
 * 拆成纯 props 组件是为了能在无头环境里直接渲染断言（见 scripts/render-check.mjs）。
 */
export function AgentItem({
  agent,
  active,
  onSelect
}: {
  agent: AgentDto
  active: boolean
  onSelect: (id: string) => void
}) {
  return (
    <button
      className="agent-item"
      data-active={active}
      title={agent.description}
      onClick={() => onSelect(agent.id)}
    >
      <AgentAvatar agent={agent} />
      <span className="agent-item__name">{agent.name}</span>
      {agent.category !== '系统' ? (
        <span className="agent-item__tag">{agent.category.replace('智能体', '')}</span>
      ) : null}
    </button>
  )
}

/**
 * 会话条目（原版 buildConvItem）：标题 + 元信息 + 删除按钮。
 * 标题口径全在 conversationTitle 里 —— 那是用户报障「每条都叫轻简模式」的修复点。
 */
export function ConvItem({
  summary,
  engines,
  active,
  now,
  onSelect,
  onDelete
}: {
  summary: ConversationSummaryDto
  engines: AgentDto[]
  active: boolean
  now: number
  onSelect: (id: string) => void
  onDelete: (id: string) => void
}) {
  const title = conversationTitle(summary, engines)
  const meta = conversationMeta(summary, engines, now)
  return (
    <div className="conv-item" data-active={active}>
      <button
        className="conv-item__main"
        title={summary.lastPreview !== '' ? `${title}\n${summary.lastPreview}` : title}
        onClick={() => onSelect(summary.id)}
      >
        <span className="conv-item__title">{title}</span>
        {meta !== '' ? <span className="conv-item__meta">{meta}</span> : null}
      </button>
      <button
        className="icon-btn conv-item__del"
        title="删除会话"
        onClick={(e) => {
          e.stopPropagation()
          onDelete(summary.id)
        }}
      >
        <IconTrash size={14} />
      </button>
    </div>
  )
}

export function Sidebar() {
  const engines: AgentDto[] = useStore((s) => s.engines)
  const summaries: ConversationSummaryDto[] = useStore((s) => s.summaries)
  const activeId = useStore((s) => s.activeId)
  const activeAgentId = useStore((s) => s.activeAgentId)
  const mode = useStore((s) => s.mode)
  const selectAgent = useStore((s) => s.selectAgent)
  const setMode = useStore((s) => s.setMode)
  const selectConversation = useStore((s) => s.selectConversation)
  const createConversation = useStore((s) => s.createConversation)
  const deleteConversation = useStore((s) => s.deleteConversation)
  const openSettings = useStore((s) => s.openSettings)
  const running = useStore((s) => s.running)
  const workspaceOpen = useStore((s) => s.workspaceOpen)
  const toggleWorkspace = useStore((s) => s.toggleWorkspace)
  const closeSidebar = useStore((s) => s.closeSidebar)

  const [collapsed, setCollapsed] = useState(false)
  // 聊天引擎默认折叠（对齐原版 AgentDrawerView 的 chatEngineOpen = false）
  const [chatEngineOpen, setChatEngineOpen] = useState(false)
  const now = Date.now()

  const agentEngines = engines.filter((a) => a.id === 'work' || a.id === 'interactive')
  const chatEngines = engines.filter((a) => a.id !== 'work' && a.id !== 'interactive')

  if (collapsed) {
    return (
      <aside className="sidebar sidebar--rail">
        {/* 品牌行：原版折叠态也保留 36vp 的居中头像（DswSidebar.ets:26-58）——
            折叠的是文字与列表，不是品牌标识本身。 */}
        <div className="rail__brand" title="Guncat Work">
          <img className="rail__logo" src={APP_ICON_SRC} alt="Guncat Work" />
        </div>
        <button
          className="rail__btn"
          title="展开侧边栏"
          onClick={() => setCollapsed(false)}
        >
          <IconChevronRight size={19} />
        </button>
        <button
          className="rail__btn"
          title="新建会话"
          onClick={() => void createConversation()}
        >
          <IconPlus size={19} />
        </button>
        <div className="rail__spacer" />
        {/* 折叠后侧栏底部的「工作区」入口会整块消失，这里必须补一个 ——
            否则折叠态下**没有任何办法**打开工作区面板（原版 DswSidebar.ets:65 就有这一颗）。 */}
        <button
          className="rail__btn"
          title={workspaceOpen ? '收起工作区面板' : '展开工作区面板'}
          data-active={workspaceOpen}
          onClick={() => toggleWorkspace()}
        >
          <IconFolder size={19} />
        </button>
        <button className="rail__btn" title="设置" onClick={() => openSettings(true)}>
          <IconSettings size={19} />
        </button>
      </aside>
    )
  }

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        {/* 品牌行图标 = 原版 DswSidebar 的 Image($r('app.media.cat_avatar'))：28vp 圆形。
            这里用原图而不是自绘 SVG —— 品牌标识不该是「画得像」的替代品。 */}
        <img className="sidebar__logo" src={APP_ICON_SRC} alt="Guncat Work" title="Guncat Work" />
        <div className="sidebar__brand-text">
          <span>Guncat Work</span>
          <small>{MODE_LABEL[mode] ?? ''}</small>
        </div>
        <button className="icon-btn mobile-only" title="关闭" onClick={closeSidebar}>
          <IconClose size={18} />
        </button>
        <button className="icon-btn desktop-only" title="折叠侧边栏" onClick={() => setCollapsed(true)}>
          <IconSidebar size={18} />
        </button>
      </div>

      <div className="sidebar__section">
        <button
          className="btn btn--block sidebar__new"
          disabled={running}
          onClick={() => void createConversation()}
        >
          <IconPlus size={15} />
          新建会话
        </button>
      </div>

      {/* 引擎区分两段（对齐原版 AgentDrawerView 的「Agent引擎（推荐）」+「聊天引擎」）：
          work / interactive 是 Agent Loop 的两个形态，推荐位；其余是聊天智能体，
          整行可点、默认折叠 —— 9 个平铺会把侧栏撑得很长，也分不出主次。 */}
      <div className="sidebar__label sidebar__label--row">
        <span>Agent 引擎（推荐）</span>
      </div>
      <div className="sidebar__engines">
        {agentEngines.map((agent) => (
          <AgentItem
            key={agent.id}
            agent={agent}
            active={activeAgentId === agent.id}
            onSelect={(id) => void selectAgent(id)}
          />
        ))}
      </div>

      <button
        className="sidebar__label sidebar__label--row sidebar__label--toggle"
        title={chatEngineOpen ? '收起聊天引擎' : '展开聊天引擎'}
        onClick={() => setChatEngineOpen((v) => !v)}
      >
        <span>聊天引擎</span>
        <span className="sidebar__count">
          {chatEngines.length}
          <span className="sidebar__chevron" data-open={chatEngineOpen}>
            <IconChevronDown size={13} />
          </span>
        </span>
      </button>
      {chatEngineOpen ? (
        <div className="sidebar__engines">
          {chatEngines.map((agent) => (
            <AgentItem
              key={agent.id}
              agent={agent}
              active={activeAgentId === agent.id}
              onSelect={(id) => void selectAgent(id)}
            />
          ))}
        </div>
      ) : null}

      <div className="sidebar__label sidebar__label--row">
        <span>会话</span>
        <span className="sidebar__count">{summaries.length}</span>
      </div>

      <div className="sidebar__list">
        {summaries.length === 0 ? (
          <div className="sidebar__empty">还没有会话</div>
        ) : (
          summaries.map((s) => (
            <ConvItem
              key={s.id}
              summary={s}
              engines={engines}
              active={s.id === activeId}
              now={now}
              onSelect={(id) => void selectConversation(id)}
              onDelete={(id) => void deleteConversation(id)}
            />
          ))
        )}
      </div>

      <div className="sidebar__footer">
        <button
          className="foot-btn"
          title="切到聊天模式"
          data-active={mode === 'chat'}
          onClick={() => {
            setMode('chat')
            closeSidebar()
          }}
        >
          <IconChat size={17} />
          <span>聊天</span>
        </button>
        <button
          className="foot-btn"
          title="切到交互模式"
          data-active={mode === 'interactive'}
          onClick={() => {
            setMode('interactive')
            closeSidebar()
          }}
        >
          <IconInteractive size={17} />
          <span>交互</span>
        </button>
        <button
          className="foot-btn"
          title="切到工作模式"
          data-active={mode === 'work'}
          onClick={() => {
            setMode('work')
            closeSidebar()
          }}
        >
          <IconWork size={17} />
          <span>工作</span>
        </button>
        <button
          className="foot-btn"
          title={workspaceOpen ? '收起工作区面板' : '展开工作区面板'}
          data-active={workspaceOpen}
          onClick={() => {
            toggleWorkspace()
            closeSidebar()
          }}
        >
          <IconFolder size={17} />
          <span>工作区</span>
        </button>
        <button
          className="foot-btn"
          title="设置"
          onClick={() => {
            openSettings(true)
            closeSidebar()
          }}
        >
          <IconSettings size={17} />
          <span>设置</span>
        </button>
      </div>
    </aside>
  )
}
