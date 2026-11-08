// 个性化指令编辑页：独立全屏二级页（新建与编辑共用）。
//
// 入口在 设置 → 能力 → 个性化指令；列表与跳转由 PersonalInstructionsPanel / SettingsPage 负责，
// 本页只编辑一条。打开方式跟鸿蒙版（f1da275c 的 PersonalInstructionEditPage.ets）一致：
// store.instructionEditorOpen 控制显隐、instructionEditingId 为空串表示新建；
// App 里编辑页的渲染优先级最高，关闭后回到设置页的列表（settingsOpen 一直保持 true）。
//
// 几条必须守住的口径：
//   · 保存的始终是用户原文 —— Markdown 预览只切换本页展示，不改变落盘内容；
//   · 名称可选，留空时列表按正文首行显示（PersonalInstruction.displayName）；
//   · 生效范围至少一项，未选不允许保存并在页内就地提示；新建默认勾选交互模式 + 工作模式；
//   · 删除、未保存离开都用**页内**确认 UI（WebView 里 window.confirm 可能被吞掉，不能用）。
import { useEffect, useRef, useState } from 'react'
import { Constants } from '@core/common/Constants'
import { PersonalInstruction } from '@core/model/PersonalInstruction'
import { PersonalInstructionPrompt } from '@core/common/PersonalInstructionPrompt'
import { useStore } from '../store'
import { Markdown } from './Markdown'
import {
  agentScopeOrder,
  instructionScopeSummary,
  parseInstructionList
} from './PersonalInstructionsPanel'
import type { ScopeAgent } from './PersonalInstructionsPanel'
import {
  IconArrowLeft,
  IconCheck,
  IconClose,
  IconEdit,
  IconFile,
  IconInfo,
  IconTrash
} from '../icons'

export interface PersonalInstructionEditPageProps {
  /**
   * 覆盖「是否打开」。平时不传，由 store 的 instructionEditorOpen 决定。
   * 提成 props 的原因与 SettingsPage.open 相同：SSR 里 zustand 只读到初始状态（false），
   * 整页不渲染就钉不住首帧口径。
   */
  open?: boolean
  /** 覆盖「编辑哪一条」：空串 = 新建（SSR / 预览用） */
  editId?: string
  /** 覆盖手机布局判定，只用于 SSR/预览；本页样式本身走 860px 断点。 */
  compact?: boolean
}

/** 新建时的默认生效范围：与鸿蒙版一致，交互模式 + 工作模式 */
const DEFAULT_SCOPES: string[] = [
  PersonalInstructionPrompt.SCOPE_INTERACTIVE,
  PersonalInstructionPrompt.SCOPE_WORK
]

interface ScopeRowProps {
  scope: string
  title: string
  subtitle: string
  selected: boolean
  onToggle: (scope: string) => void
}

/** 一行可多选的生效范围：勾选圈 + 标题 + 副标题，整行可点（复用 settings-option 视觉） */
function ScopeRow({ scope, title, subtitle, selected, onToggle }: ScopeRowProps) {
  return (
    <button
      type="button"
      className="settings-option instruction-scope"
      data-active={selected}
      role="checkbox"
      aria-checked={selected}
      onClick={() => onToggle(scope)}
    >
      <span className="settings-option__mark">
        {selected ? <IconCheck size={14} /> : null}
      </span>
      <span className="settings-option__text">
        <strong>{title}</strong>
        {subtitle.trim() !== '' ? <small>{subtitle}</small> : null}
      </span>
    </button>
  )
}

export function PersonalInstructionEditPage({
  open: openOverride,
  editId: editIdOverride,
  compact: compactOverride
}: PersonalInstructionEditPageProps = {}) {
  const storeOpen = useStore((s) => s.instructionEditorOpen)
  const storeEditId = useStore((s) => s.instructionEditingId)
  const open = openOverride ?? storeOpen
  const editId = editIdOverride ?? storeEditId
  const closeEditor = useStore((s) => s.closeInstructionEditor)
  const settings = useStore((s) => s.settings)
  const agents = useStore((s) => s.agents)
  const reloadSettings = useStore((s) => s.reloadSettings)
  const compact = compactOverride ?? false

  // ===== 编辑草稿 =====
  const [name, setName] = useState('')
  const [content, setContent] = useState('')
  const [scopes, setScopes] = useState<string[]>([...DEFAULT_SCOPES])
  // 默认关闭 = 原文编辑；打开只是切预览，落盘内容不变
  const [previewOn, setPreviewOn] = useState(false)
  // 页内就地提示（正文为空 / 没选生效范围 / 保存删除失败）
  const [error, setError] = useState('')
  // 页内自制确认弹窗：'discard' = 放弃未保存修改，'delete' = 删除二次确认（不用 window.confirm）
  const [confirm, setConfirm] = useState<'discard' | 'delete' | null>(null)
  const [saving, setSaving] = useState(false)

  // 打开时的原始快照（判断「有没有未保存修改」用；只比较、不参与渲染，所以放 ref）
  const originalRef = useRef<{ name: string; content: string; scopes: string }>({
    name: '',
    content: '',
    scopes: DEFAULT_SCOPES.join('|')
  })
  // 本次编辑会话的初始化标记：同一份草稿只从存储读一次，避免 settings 刷新把正在输入的内容冲掉
  const initKeyRef = useRef<string | null>(null)

  const raw = settings?.prefs?.[Constants.LS_KEY_PERSONAL_INSTRUCTIONS]

  /** 生效范围按稳定顺序规范化：交互模式 → 工作模式 → 各聊天引擎 */
  function scopesInOrder(list: string[]): string[] {
    return PersonalInstruction.sortScopesByOrder(list, agentScopeOrder(agents as ScopeAgent[]))
  }

  /** 记录「打开时的草稿」，用于未保存离开判断；范围用规范化后的集合做键 */
  function captureOriginal(nextName: string, nextContent: string, nextScopes: string[]): void {
    originalRef.current = {
      name: nextName,
      content: nextContent,
      scopes: scopesInOrder(nextScopes).join('|')
    }
  }

  // 进入编辑页（或切换编辑对象）时从设置投影里读一次条目：
  //   · 找得到 → 回填名称 / 正文 / 生效范围；
  //   · 新建、或原条目已被删除 → 按新建处理（默认勾选两个模式）。
  // settings 首帧为 null（SSR / 设置还没读回）时不初始化编辑态，避免把已有条目当成新建清空。
  useEffect(() => {
    if (!open) {
      // 关闭后清掉标记：下次打开（哪怕是同一条）重新从存储读，丢掉上次的草稿
      initKeyRef.current = null
      return
    }
    if (settings === null && editId !== '') {
      return
    }
    if (initKeyRef.current === editId) {
      return
    }
    initKeyRef.current = editId
    const list = parseInstructionList(raw)
    const index = editId === '' ? -1 : PersonalInstruction.indexOfId(list, editId)
    const item = index >= 0 ? list[index] : null
    if (item !== null) {
      const ordered = scopesInOrder(item.scopes)
      setName(item.name)
      setContent(item.content)
      setScopes(ordered.length === 0 ? [...DEFAULT_SCOPES] : ordered)
      captureOriginal(item.name, item.content, ordered.length === 0 ? DEFAULT_SCOPES : ordered)
    } else {
      setName('')
      setContent('')
      setScopes([...DEFAULT_SCOPES])
      captureOriginal('', '', DEFAULT_SCOPES)
    }
    setPreviewOn(false)
    setError('')
    setConfirm(null)
    // eslint 不参与本仓库校验；依赖列全是为了行为可推演：settings / raw 变化由 initKey 拦住重复初始化
  }, [open, editId, settings, raw, agents])

  if (!open) {
    return null
  }

  const isEditing = editId !== ''
  const orderedScopes = scopesInOrder(scopes)
  const scopeSummary = instructionScopeSummary(scopes, agents as ScopeAgent[])

  /** 有没有未保存修改：范围按规范化集合比较，「取消又勾上」不算修改 */
  function isDirty(): boolean {
    return (
      name !== originalRef.current.name ||
      content !== originalRef.current.content ||
      scopesInOrder(scopes).join('|') !== originalRef.current.scopes
    )
  }

  function toggleScope(scope: string): void {
    setScopes((current) =>
      current.includes(scope) ? current.filter((item) => item !== scope) : [...current, scope]
    )
    if (error !== '') {
      setError('')
    }
  }

  function handleBack(): void {
    if (!isDirty()) {
      closeEditor()
      return
    }
    setConfirm('discard')
  }

  /** 保存前的就地校验：返回空串表示通过 */
  function validate(): string {
    if (content.trim() === '') {
      return '请先输入指令正文'
    }
    if (scopes.length === 0) {
      return '请至少选择一个生效范围'
    }
    return ''
  }

  async function save(): Promise<void> {
    if (saving) {
      return
    }
    const message = validate()
    if (message !== '') {
      setError(message)
      return
    }
    setError('')
    setSaving(true)
    const list = parseInstructionList(raw)
    const item = PersonalInstruction.create(name, content, orderedScopes)
    if (isEditing) {
      // 编辑：保留原 id，只更新内容与保存时间（对齐鸿蒙版 save()）
      item.id = editId
      item.updatedAt = Date.now()
      const index = PersonalInstruction.indexOfId(list, editId)
      if (index >= 0) {
        list[index] = item
      } else {
        // 原条目已被删除：保存等效于重新创建，避免「编辑一个不存在的 id」静默丢内容
        list.push(item)
      }
    } else {
      list.push(item)
    }
    try {
      await window.guncat.settings.saveString(
        Constants.LS_KEY_PERSONAL_INSTRUCTIONS,
        JSON.stringify(list.map((one) => one.toJson()))
      )
      // 刷新 settings 投影：列表与本页下次打开都从这份数据读
      await reloadSettings()
      closeEditor()
    } catch (e) {
      setSaving(false)
      setError(`保存失败：${String(e)}`)
    }
  }

  async function doDelete(): Promise<void> {
    if (!isEditing || saving) {
      return
    }
    setConfirm(null)
    setSaving(true)
    setError('')
    const list = parseInstructionList(raw).filter((item) => item.id !== editId)
    try {
      await window.guncat.settings.saveString(
        Constants.LS_KEY_PERSONAL_INSTRUCTIONS,
        JSON.stringify(list.map((one) => one.toJson()))
      )
      await reloadSettings()
      closeEditor()
    } catch (e) {
      setSaving(false)
      setError(`删除失败：${String(e)}`)
    }
  }

  return (
    <div className="instruction-editor" data-compact={compact}>
      <header className="instruction-editor__head">
        <div className="instruction-editor__head-inner">
          <button
            type="button"
            className="icon-btn instruction-editor__back"
            title="返回设置"
            aria-label="返回设置"
            onClick={handleBack}
          >
            <IconArrowLeft size={21} />
          </button>
          <div className="instruction-editor__heading">
            <strong>{isEditing ? '编辑个性化指令' : '新建个性化指令'}</strong>
            <span>按生效范围自动附加到系统提示词末尾 · 只保存在本机</span>
          </div>
          {isEditing ? (
            <button
              type="button"
              className="icon-btn instruction-editor__delete"
              title="删除这条指令"
              aria-label="删除这条指令"
              disabled={saving}
              onClick={() => setConfirm('delete')}
            >
              <IconTrash size={18} />
            </button>
          ) : null}
        </div>
      </header>

      <div className="instruction-editor__body">
        <div className="instruction-editor__inner">
          <section className="settings-card">
            <header className="settings-card__head">
              <h3>名称（可选）</h3>
            </header>
            <div className="settings-card__body">
              <div className="field">
                <input
                  value={name}
                  maxLength={PersonalInstruction.MAX_NAME_CHARS}
                  placeholder="例如：英文回答、代码风格"
                  aria-label="指令名称（可选）"
                  onChange={(e) => setName(e.target.value)}
                />
                <div className="field__hint">不填时用指令正文第一行作为列表标题。</div>
              </div>
            </div>
          </section>

          <section className="settings-card">
            <header className="settings-card__head settings-card__head--row">
              <h3>指令正文</h3>
              {/* 预览开关：只影响本页展示，保存的始终是原文 */}
              <button
                type="button"
                className="instruction-preview-toggle"
                data-on={previewOn}
                aria-pressed={previewOn}
                onClick={() => setPreviewOn((on) => !on)}
              >
                {previewOn ? <IconEdit size={15} /> : <IconFile size={15} />}
                <span>{previewOn ? '返回编辑' : 'Markdown 渲染'}</span>
              </button>
            </header>
            <div className="settings-card__body">
              {previewOn ? (
                content.trim() === '' ? (
                  <p className="instruction-preview__empty">没有可预览的内容</p>
                ) : (
                  // 复用消息正文的 Markdown 配色（.msg__body），避免预览与聊天里长得不一样
                  <div className="msg__body instruction-preview">
                    <Markdown text={content} />
                  </div>
                )
              ) : (
                <div className="field">
                  <textarea
                    className="instruction-textarea"
                    value={content}
                    maxLength={PersonalInstruction.MAX_CONTENT_CHARS}
                    placeholder="写下你的指令、偏好或约束，例如语气、输出格式、常用术语，支持 Markdown。"
                    aria-label="指令正文"
                    onChange={(e) => {
                      setContent(e.target.value)
                      if (error !== '') {
                        setError('')
                      }
                    }}
                  />
                  <div className="instruction-content__foot">
                    <span className="field__hint">
                      渲染只影响这里的预览；保存的始终是原始文本，纯文本也能直接保存。
                    </span>
                    <span className="instruction-counter">
                      {content.length} / {PersonalInstruction.MAX_CONTENT_CHARS}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </section>

          <section className="settings-card">
            <header className="settings-card__head">
              <h3>生效范围</h3>
              <p>至少选择一项。</p>
            </header>
            <div className="settings-card__body">
              <div className="instruction-scopes" role="group" aria-label="生效范围（多选）">
                <div className="instruction-scopes__group">模式</div>
                <div className="settings-option-list">
                  <ScopeRow
                    scope={PersonalInstructionPrompt.SCOPE_INTERACTIVE}
                    title="交互模式"
                    subtitle="每轮回答直接交付可操作界面"
                    selected={scopes.includes(PersonalInstructionPrompt.SCOPE_INTERACTIVE)}
                    onToggle={toggleScope}
                  />
                  <ScopeRow
                    scope={PersonalInstructionPrompt.SCOPE_WORK}
                    title="工作模式"
                    subtitle="多轮工具循环，完成长程任务"
                    selected={scopes.includes(PersonalInstructionPrompt.SCOPE_WORK)}
                    onToggle={toggleScope}
                  />
                </div>

                <div className="instruction-scopes__group">聊天引擎</div>
                {agents.length === 0 ? (
                  <p className="instruction-scopes__empty">暂无可用的聊天引擎</p>
                ) : (
                  <div className="settings-option-list">
                    {agents.map((agent) => (
                      <ScopeRow
                        key={agent.id}
                        scope={agent.id}
                        title={agent.name}
                        subtitle={agent.description}
                        selected={scopes.includes(agent.id)}
                        onToggle={toggleScope}
                      />
                    ))}
                  </div>
                )}
              </div>

              {scopeSummary !== '' ? (
                <p className="instruction-scopes__summary">将附加到：{scopeSummary}</p>
              ) : (
                <p className="instruction-scopes__summary" data-warn="true">
                  尚未选择生效范围，保存后不会生效。
                </p>
              )}
            </div>
          </section>

          {/* 保存后的生效方式：对齐鸿蒙版页尾说明卡 */}
          <div className="settings-notice">
            <span className="settings-notice__icon" aria-hidden="true">
              <IconInfo size={16} />
            </span>
            <div>
              {'保存后，这些内容会作为「个性化指令」段落，附加到所选模式 / 聊天引擎的系统提示词末尾；'
                + '从下一次请求开始生效，不改变工具与权限。'}
            </div>
          </div>

          {error !== '' ? (
            <p className="instruction-editor__error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </div>

      <footer className="instruction-editor__foot">
        <button
          type="button"
          className="btn btn--primary instruction-editor__submit"
          disabled={saving}
          onClick={() => void save()}
        >
          {isEditing ? '保存' : '添加'}
        </button>
      </footer>

      {/* 页内确认弹窗：删除二次确认 / 未保存离开确认。
          不用 window.confirm —— Android WebView 可能吞掉原生对话框，用户点了没反应。
          挂 .overlay 类是为了让安卓硬件返回键能命中 MainActivity.onBackPressed 的
          「点掉最上层弹层」逻辑（它按 .overlay 找并点其中的 .icon-btn）。 */}
      {confirm !== null ? (
        <div
          className="overlay instruction-confirm"
          role="presentation"
          onClick={() => setConfirm(null)}
        >
          <div
            className="dialog instruction-confirm__dialog"
            role="dialog"
            aria-modal="true"
            aria-label={confirm === 'delete' ? '删除个性化指令' : '放弃编辑'}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="dialog__head">
              <span>{confirm === 'delete' ? '删除个性化指令' : '放弃编辑？'}</span>
              <button
                type="button"
                className="icon-btn"
                title={confirm === 'delete' ? '取消删除' : '继续编辑'}
                aria-label="关闭确认弹窗"
                onClick={() => setConfirm(null)}
              >
                <IconClose size={16} />
              </button>
            </div>
            <div className="dialog__body">
              <p className="instruction-confirm__text">
                {confirm === 'delete'
                  ? '删除后会立即从所有生效范围移除，且无法恢复。'
                  : '还有未保存的修改，返回后这些修改会丢失。'}
              </p>
            </div>
            <div className="dialog__foot">
              <button type="button" className="btn" onClick={() => setConfirm(null)}>
                {confirm === 'delete' ? '取消' : '继续编辑'}
              </button>
              <button
                type="button"
                className="btn btn--danger"
                disabled={saving}
                onClick={() => {
                  if (confirm === 'delete') {
                    void doDelete()
                  } else {
                    setConfirm(null)
                    closeEditor()
                  }
                }}
              >
                {confirm === 'delete' ? '删除' : '放弃修改'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
