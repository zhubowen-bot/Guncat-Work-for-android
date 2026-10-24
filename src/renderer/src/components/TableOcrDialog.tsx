// TableOcrDialog: 表格提取（对齐原版 pages/TableOcrPage.ets）
//
// 这是原版**唯一一个不依赖大模型对话的独立工具页**：选一张表格图片 →
// 用配置方案里的视觉模型识别 → 输出 HTML 表格。桌面端此前完全没有这个功能
// （`TableOcrService` 零引用，也没有任何界面入口）。
//
// 与原版的差异（如实记录）：
//   · 原版整页是一个独立路由页面；桌面端做成弹层，入口在顶栏 —— 桌面端没有 pages/ 概念。
//   · 原版用 ArkWeb 渲染预览；桌面端把清洗过的 HTML 片段挂进 DOM
//     （模型输出不可直接信任，主进程按白名单重建过，见 src/main/sanitizeHtml.ts）。
//
// 结构上拆成两层：`TableOcrPanel` 是纯展示（状态全由 props 给），
// `TableOcrDialog` 只负责读 store 与持有状态 —— 这样面板本身可以直接被渲染验证。
import { useEffect, useState } from 'react'
import type { TableOcrImageDto, TableOcrResultDto } from '@ipc/contract'
import { useStore } from '../store'
import { IconClose, IconCopy, IconImage, IconTable } from '../icons'
import { copyText } from '../clipboard'

const PREF_MODEL = 'table_ocr_provider'

export interface TableOcrModelOption {
  id: string
  label: string
}

interface PanelProps {
  models: TableOcrModelOption[]
  model: string
  image: TableOcrImageDto | null
  result: TableOcrResultDto | null
  busy: boolean
  onModelChange(model: string): void
  onPick(): void
  onRecognize(): void
  onCopy(): void
  onClose(): void
}

/** 纯展示层：不碰 store、不碰 IPC，便于直接渲染验证 */
export function TableOcrPanel({
  models,
  model,
  image,
  result,
  busy,
  onModelChange,
  onPick,
  onRecognize,
  onCopy,
  onClose
}: PanelProps) {
  return (
    <div className="preview-overlay" onClick={onClose}>
      <div className="dialog tableocr" onClick={(e) => e.stopPropagation()}>
        <div className="dialog__head">
          <strong>表格提取</strong>
          <button className="icon-btn" title="关闭" onClick={onClose}>
            <IconClose size={16} />
          </button>
        </div>

        <div className="dialog__body">
          <div className="field__hint" style={{ marginBottom: 10 }}>
            选一张表格图片，用视觉模型识别成 HTML 表格。数据不进入对话上下文，
            与当前会话无关。
          </div>

          <div className="field field--row">
            <div>
              <label>识别模型</label>
              <select value={model} onChange={(e) => onModelChange(e.target.value)}>
                {models.length === 0 ? <option value="">（先在设置里配置 API）</option> : null}
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label>图片</label>
              <button className="btn" onClick={onPick}>
                <IconImage size={15} />
                {image === null ? '选择图片' : '重新选择'}
              </button>
            </div>
          </div>

          {image !== null ? (
            <div className="tableocr__picked">
              {image.thumbnail !== '' ? (
                <img className="tableocr__thumb" src={image.thumbnail} alt={image.name} />
              ) : (
                <span className="tableocr__thumb tableocr__thumb--empty">
                  <IconImage size={18} />
                </span>
              )}
              <span className="tableocr__name" title={image.path}>
                {image.name}
              </span>
              <button className="btn btn--primary" disabled={busy || model === ''} onClick={onRecognize}>
                <IconTable size={15} />
                {busy ? '识别中…' : '开始识别'}
              </button>
            </div>
          ) : (
            <div className="tableocr__empty">还没有选择图片</div>
          )}

          {result !== null ? (
            <div className="tableocr__result">
              <div className="tableocr__resulthead">
                <span>{`识别结果（${result.model}）`}</span>
                <button className="btn" onClick={onCopy}>
                  <IconCopy size={14} />
                  复制 HTML
                </button>
              </div>
              {/* 内容是主进程按白名单重建过的 <table> 片段（只保留表格结构与
                  colspan/rowspan），所以这里挂进 DOM 是安全的 */}
              <div className="tableocr__table" dangerouslySetInnerHTML={{ __html: result.html }} />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/** 可选模型：来自「配置方案」里的全部模型 + 多模态解析的模型（原版 TableOcrPage 就是这么列的） */
export function tableOcrModelOptions(
  profiles:
    | Array<{ name: string; config: { apiKey: string; model: string; models?: string[] } }>
    | undefined,
  multimodalModel: string
): TableOcrModelOption[] {
  const options: TableOcrModelOption[] = []
  for (const profile of profiles ?? []) {
    // 没填 Key 的方案只是预置模板，不列入可用模型
    if (profile.config.apiKey.trim() === '') {
      continue
    }
    const names =
      profile.config.models !== undefined && profile.config.models.length > 0
        ? profile.config.models
        : profile.config.model !== ''
          ? [profile.config.model]
          : []
    for (const name of names) {
      if (!options.some((o) => o.id === name)) {
        options.push({ id: name, label: `${name}（${profile.name}）` })
      }
    }
  }
  if (multimodalModel !== '' && !options.some((o) => o.id === multimodalModel)) {
    options.push({ id: multimodalModel, label: `${multimodalModel}（多模态解析）` })
  }
  return options
}

export function TableOcrDialog() {
  const open = useStore((s) => s.tableOcrOpen)
  const openDialog = useStore((s) => s.openTableOcr)
  const settings = useStore((s) => s.settings)
  const pushNotice = useStore((s) => s.pushNotice)

  const [image, setImage] = useState<TableOcrImageDto | null>(null)
  const [model, setModel] = useState('')
  const [result, setResult] = useState<TableOcrResultDto | null>(null)
  const [busy, setBusy] = useState(false)

  const models = tableOcrModelOptions(
    settings?.apiProfiles,
    settings?.multimodalConfig.model ?? ''
  )

  // 打开时恢复上次选的模型（原版 TableOcrPage 的 findSavedModelIndex）
  useEffect(() => {
    if (!open) {
      return
    }
    setResult(null)
    setImage(null)
    const saved = settings?.prefs?.[PREF_MODEL] ?? ''
    setModel(saved !== '' ? saved : (models[0]?.id ?? ''))
    // models 每次渲染都是新数组，这里只依赖打开状态与保存值
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open) {
    return null
  }

  async function pick(): Promise<void> {
    try {
      const picked = await window.guncat.tableOcr.pickImage()
      if (picked === null) {
        return
      }
      setImage(picked)
      setResult(null)
    } catch (e) {
      pushNotice('error', `选择图片失败：${String(e)}`)
    }
  }

  async function recognize(): Promise<void> {
    if (image === null || busy) {
      return
    }
    setBusy(true)
    setResult(null)
    try {
      await window.guncat.settings.saveString(PREF_MODEL, model)
      const output = await window.guncat.tableOcr.run(image.path, model)
      setResult(output)
    } catch (e) {
      pushNotice('error', `表格识别失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <TableOcrPanel
      models={models}
      model={model}
      image={image}
      result={result}
      busy={busy}
      onModelChange={setModel}
      onPick={() => void pick()}
      onRecognize={() => void recognize()}
      onCopy={() => {
        if (result !== null) {
          void copyText(result.html).then((ok) => {
            pushNotice(
              ok ? 'info' : 'error',
              ok ? '表格 HTML 已复制' : '复制失败：请长按选中表格 HTML 后手动复制'
            )
          })
        }
      }}
      onClose={() => openDialog(false)}
    />
  )
}
