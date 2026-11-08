// 设置 → 能力 → 个性化指令：列表与空态。
//
// 这里只做「列表 + 新建入口」：新建 / 编辑 / 删除都在独立的全屏编辑页
// （PersonalInstructionEditPage，经 store.instructionEditorOpen 打开），
// 所以本组件不持有草稿状态，每次渲染都从设置投影里重新解析列表 ——
// 编辑页保存后会 reloadSettings，列表与入口摘要随之刷新。
//
// 数据口径与鸿蒙版 f1da275c 一致：
//   · 指令 JSON 存在偏好键 Constants.LS_KEY_PERSONAL_INSTRUCTIONS 里；
//   · values 按存储顺序展示（新建追加在末尾、编辑不挪位），不额外按 updatedAt 排序 ——
//     列表顺序就是提示词里的拼接顺序，界面上看到的先后与模型收到的先后保持一致。
import { useMemo } from 'react'
import { Constants } from '@core/common/Constants'
import { PersonalInstruction } from '@core/model/PersonalInstruction'
import { PersonalInstructionPrompt } from '@core/common/PersonalInstructionPrompt'
import { useStore } from '../store'
import { IconChevronRight, IconPersonalInstruction, IconPlus } from '../icons'

/** 生效范围需要的最小引擎信息：id + 显示名（AgentDto 结构上满足它） */
export interface ScopeAgent {
  id: string
  name: string
}

/**
 * 生效范围的稳定顺序：交互模式 → 工作模式 → 各聊天引擎（按 agents 顺序）。
 * 与鸿蒙版 scopeOrder() 同口径，保存与展示都按这个顺序规范化。
 */
export function agentScopeOrder(agents: ScopeAgent[]): string[] {
  const order: string[] = [
    PersonalInstructionPrompt.SCOPE_INTERACTIVE,
    PersonalInstructionPrompt.SCOPE_WORK
  ]
  for (const agent of agents) {
    order.push(agent.id)
  }
  return order
}

/**
 * 单个范围的显示名：两个固定模式有中文名，其余按聊天引擎名匹配。
 * 未知范围（引擎已从 agents.json 移除）返回空串，由调用方跳过 —— 不展示裸 id。
 */
export function scopeLabel(scope: string, agents: ScopeAgent[]): string {
  const fixed = PersonalInstructionPrompt.fixedScopeLabel(scope)
  if (fixed !== '') {
    return fixed
  }
  const agent = agents.find((item) => item.id === scope)
  return agent === undefined ? '' : agent.name
}

/**
 * 生效范围摘要：「交互模式、工作模式、XXX」。
 * 入参 scopes 可以是任意勾选顺序，这里先按稳定顺序规范化再拼；
 * 未知范围跳过（它们仍留在数据里，只是界面上没有可读名）。
 */
export function instructionScopeSummary(scopes: string[], agents: ScopeAgent[]): string {
  const ordered = PersonalInstruction.sortScopesByOrder(scopes, agentScopeOrder(agents))
  const labels: string[] = []
  for (const scope of ordered) {
    const label = scopeLabel(scope, agents)
    if (label !== '' && !labels.includes(label)) {
      labels.push(label)
    }
  }
  return labels.join('、')
}

/** 从设置投影里的 JSON 解析列表；首帧 settings 为 null / 存档损坏都退回空列表 */
export function parseInstructionList(raw: string | undefined): PersonalInstruction[] {
  return PersonalInstruction.parseList(raw ?? '')
}

/** 列表项第二行：生效范围；没有可读范围时给一句占位而不是空行 */
function scopeTextOf(item: PersonalInstruction, agents: ScopeAgent[]): string {
  const text = instructionScopeSummary(item.scopes, agents)
  return text === '' ? '未选择生效范围' : text
}

export interface PersonalInstructionsPanelProps {
  /**
   * 覆盖列表数据，只用于 SSR / 预览：无头渲染时 store 读的是初始快照（settings=null），
   * 拿不到真实条目，列表状态就永远钉不住。平时不传，由 settings.prefs 解析。
   */
  items?: PersonalInstruction[]
  /** 覆盖聊天引擎列表，只用于 SSR / 预览；平时取 store.agents */
  agents?: ScopeAgent[]
}

export function PersonalInstructionsPanel({
  items: itemsOverride,
  agents: agentsOverride
}: PersonalInstructionsPanelProps = {}) {
  const settings = useStore((s) => s.settings)
  const storedAgents = useStore((s) => s.agents)
  const openInstructionEditor = useStore((s) => s.openInstructionEditor)
  const agents = agentsOverride ?? storedAgents
  const raw = settings?.prefs?.[Constants.LS_KEY_PERSONAL_INSTRUCTIONS]
  // 解析只跟原始 JSON 走：输入框每次按键都重渲染本组件，缓存住解析结果
  const parsed = useMemo(() => parseInstructionList(raw), [raw])
  const items = itemsOverride ?? parsed

  const create = (): void => openInstructionEditor('')

  if (items.length === 0) {
    return (
      <section className="instruction-empty">
        <span className="instruction-empty__icon" aria-hidden="true">
          <IconPersonalInstruction size={40} />
        </span>
        <h3>还没有个性化指令</h3>
        <p>
          {'把长期有效的回答偏好写在这里，例如语气、输出格式、常用术语。勾选生效范围后，'
            + '这些内容会自动拼进对应模式或聊天引擎的系统提示词末尾，从下一次请求开始生效；'
            + '指令只保存在本机。'}
        </p>
        <button type="button" className="btn instruction-empty__btn" onClick={create}>
          <IconPlus size={16} />
          新建个性化指令
        </button>
      </section>
    )
  }

  return (
    <div className="instruction-panel">
      <div className="instruction-toolbar">
        <span className="instruction-toolbar__count">
          共 {items.length} 条 · 自动拼进生效提示词
        </span>
        <button type="button" className="btn instruction-toolbar__add" onClick={create}>
          <IconPlus size={16} />
          新建
        </button>
      </div>

      <div className="instruction-list">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className="instruction-item"
            onClick={() => openInstructionEditor(item.id)}
          >
            <span className="instruction-item__text">
              <strong>{item.displayName()}</strong>
              <small className="instruction-item__scopes">{scopeTextOf(item, agents)}</small>
              <small className="instruction-item__summary">{item.summary()}</small>
            </span>
            <span className="instruction-item__go" aria-hidden="true">
              <IconChevronRight size={18} />
            </span>
          </button>
        ))}
      </div>

      <p className="instruction-panel__note">点击条目编辑指令与生效范围；删除在编辑页里进行。</p>
    </div>
  )
}
