// guncat-ui lang 的元素树 → React 组件树。
//
// 解析、参数映射、$绑定与动作求值全部由移植过来的 GuncatUiLang / GuncatUiRuntime 完成，
// 本文件只负责「画」和「把用户操作写回 state」。
//
// 对应鸿蒙版的 views/GuncatUiView.ets（2807 行）+ GuncatUiCharts.ets + GuncatUiIcons.ets，
// 在 Web 端用 SVG + DOM 表达同一套组件契约。
import type { ReactNode } from 'react'
import { useState } from 'react'
import { UiNode, UiElement, UiActionStep } from '@core/common/GuncatUiLang'
import { GuncatUiRuntime, GuncatUiState } from '@core/common/GuncatUiRuntime'
import { UiNum } from '@core/common/GuncatUiPaint'
import { Markdown } from '../components/Markdown'
import {
  BarChartView,
  LineChartView,
  HorizontalBarChartView,
  PieChartView,
  RadarChartView,
  RadialChartView,
  StackedBarChartView,
  type SeriesData
} from './charts'

export interface RenderCtx {
  state: GuncatUiState
  /** 绑定值发生变化：调用方需要重新物化程序并重渲染 */
  refresh(): void
  /** 把一段文案回传给模型 */
  send(text: string): void
  /** 打开外部链接 */
  openUrl(url: string): void
  stale: boolean
}

// ===== 图标 =====
//
// 界面程序里的 Icon(name) 原先映射到 emoji / Unicode 符号（放大镜、垃圾桶、带圈 i 之类）。
// 这类「图标」的实际长相由机器上的字体决定，同一个程序在两台机器上观感完全不同，
// 也和界面其余部分不是一套笔画。这里换成与主界面同一套规格的行内 SVG：
// viewBox 0 0 24 24、fill none、stroke currentColor、stroke-width 1.6，
// 尺寸用 em 表达，跟着 .gui-icon 的字号走。
//
// 注意：只换图标本身，Icon 节点的尺寸/排版/交互一律不动。
function GuiSvg({ children }: { children: ReactNode }): ReactNode {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ verticalAlign: '-0.125em' }}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

const GUI_ICONS: Record<string, ReactNode> = {
  check: (
    <GuiSvg>
      <path d="m5.4 12.6 4.4 4.4 8.8-9.6" />
    </GuiSvg>
  ),
  close: (
    <GuiSvg>
      <path d="M6.2 6.2l11.6 11.6M17.8 6.2 6.2 17.8" />
    </GuiSvg>
  ),
  add: (
    <GuiSvg>
      <path d="M12 5.2v13.6M5.2 12h13.6" />
    </GuiSvg>
  ),
  remove: (
    <GuiSvg>
      <path d="M5.2 12h13.6" />
    </GuiSvg>
  ),
  'arrow-right': (
    <GuiSvg>
      <path d="M4.6 12h14.2M13.6 6.8 18.8 12l-5.2 5.2" />
    </GuiSvg>
  ),
  'arrow-left': (
    <GuiSvg>
      <path d="M19.4 12H5.2M10.4 6.8 5.2 12l5.2 5.2" />
    </GuiSvg>
  ),
  'arrow-up': (
    <GuiSvg>
      <path d="M12 19.4V5.2M6.8 10.4 12 5.2l5.2 5.2" />
    </GuiSvg>
  ),
  'arrow-down': (
    <GuiSvg>
      <path d="M12 4.6v14.2M6.8 13.6 12 18.8l5.2-5.2" />
    </GuiSvg>
  ),
  chart: (
    <GuiSvg>
      <path d="M4.4 19.6V14M10.2 19.6V6.4M16 19.6v-8" />
      <path d="M20.6 19.6H3.4" />
    </GuiSvg>
  ),
  table: (
    <GuiSvg>
      <rect x="3.6" y="5.4" width="16.8" height="13.2" rx="2" />
      <path d="M3.6 10h16.8M9.6 10v8.6M15 10v8.6" />
    </GuiSvg>
  ),
  list: (
    <GuiSvg>
      <path d="M9.4 6.6h10.2M9.4 12h10.2M9.4 17.4h10.2" />
      <path d="M5 6.6h.01M5 12h.01M5 17.4h.01" />
    </GuiSvg>
  ),
  search: (
    <GuiSvg>
      <circle cx="10.8" cy="10.8" r="6.4" />
      <path d="m15.6 15.6 4.2 4.2" />
    </GuiSvg>
  ),
  star: (
    <GuiSvg>
      <path d="m12 4 2.5 5.1 5.6.8-4.1 4 1 5.6-5-2.7-5 2.7 1-5.6-4.1-4 5.6-.8L12 4Z" />
    </GuiSvg>
  ),
  heart: (
    <GuiSvg>
      <path d="M12 19.6S4.2 15 4.2 9.7A4.1 4.1 0 0 1 12 7.4a4.1 4.1 0 0 1 7.8 2.3c0 5.3-7.8 9.9-7.8 9.9Z" />
    </GuiSvg>
  ),
  share: (
    <GuiSvg>
      <path d="M12 15.4V4.2" />
      <path d="m8.2 8 3.8-3.8L15.8 8" />
      <path d="M6 13.4v5.2a1.8 1.8 0 0 0 1.8 1.8h8.4a1.8 1.8 0 0 0 1.8-1.8v-5.2" />
    </GuiSvg>
  ),
  download: (
    <GuiSvg>
      <path d="M12 3.8v11.4" />
      <path d="m7.6 10.8 4.4 4.4 4.4-4.4" />
      <path d="M4.4 20.2h15.2" />
    </GuiSvg>
  ),
  edit: (
    <GuiSvg>
      <path d="M4.4 19.6h4.1L19.9 8.2a2.2 2.2 0 0 0-3.1-3.1L4.4 16.5v3.1Z" />
      <path d="m14.9 6.9 3.2 3.2" />
    </GuiSvg>
  ),
  delete: (
    <GuiSvg>
      <path d="M4.4 6.9h15.2" />
      <path d="M9.6 6.9V5.4a1.2 1.2 0 0 1 1.2-1.2h2.4a1.2 1.2 0 0 1 1.2 1.2v1.5" />
      <path d="M6.4 6.9l.8 11.3a1.6 1.6 0 0 0 1.6 1.5h6.4a1.6 1.6 0 0 0 1.6-1.5l.8-11.3" />
      <path d="M10.4 10.6v5.6M13.6 10.6v5.6" />
    </GuiSvg>
  ),
  info: (
    <GuiSvg>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M12 10.8v5.4M12 7.9h.01" />
    </GuiSvg>
  ),
  warning: (
    <GuiSvg>
      <path d="M12 4.2 20.6 19.4H3.4L12 4.2Z" />
      <path d="M12 9.8v4.4M12 17h.01" />
    </GuiSvg>
  ),
  success: (
    <GuiSvg>
      <circle cx="12" cy="12" r="8.4" />
      <path d="m8.2 12.4 2.6 2.6 5-5.4" />
    </GuiSvg>
  ),
  error: (
    <GuiSvg>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6" />
    </GuiSvg>
  ),
  clock: (
    <GuiSvg>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M12 7.4V12l3.2 2" />
    </GuiSvg>
  ),
  calendar: (
    <GuiSvg>
      <rect x="3.8" y="5.4" width="16.4" height="14.2" rx="2" />
      <path d="M3.8 10h16.4M8.4 3.6v3.4M15.6 3.6v3.4" />
    </GuiSvg>
  ),
  user: (
    <GuiSvg>
      <circle cx="12" cy="8.6" r="3.6" />
      <path d="M5.2 20a6.8 6.8 0 0 1 13.6 0" />
    </GuiSvg>
  ),
  home: (
    <GuiSvg>
      <path d="M4.2 10.4 12 4l7.8 6.4v8.2a1.8 1.8 0 0 1-1.8 1.8H6a1.8 1.8 0 0 1-1.8-1.8v-8.2Z" />
      <path d="M9.8 20.4v-6h4.4v6" />
    </GuiSvg>
  ),
  settings: (
    <GuiSvg>
      <circle cx="12" cy="12" r="2.7" />
      <path d="M19.1 14.6a1.6 1.6 0 0 0 .3 1.8l.1.1a1.9 1.9 0 1 1-2.7 2.7l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.3a1.9 1.9 0 1 1-3.8 0v-.2a1.6 1.6 0 0 0-2.8-1.1l-.1.1a1.9 1.9 0 1 1-2.7-2.7l.1-.1a1.6 1.6 0 0 0-1.1-2.7h-.3a1.9 1.9 0 1 1 0-3.8h.2a1.6 1.6 0 0 0 1.1-2.8l-.1-.1a1.9 1.9 0 1 1 2.7-2.7l.1.1A1.6 1.6 0 0 0 9.4 4.6V4.3a1.9 1.9 0 1 1 3.8 0v.2a1.6 1.6 0 0 0 2.7 1.1l.1-.1a1.9 1.9 0 1 1 2.7 2.7l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.3a1.9 1.9 0 1 1 0 3.8h-.2a1.6 1.6 0 0 0-1.4.9Z" />
    </GuiSvg>
  ),
  sparkle: (
    <GuiSvg>
      <path d="M12 3.4 13.7 8.3 18.6 10 13.7 11.7 12 16.6 10.3 11.7 5.4 10 10.3 8.3 12 3.4Z" />
      <path d="M18.4 16.2l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7.7-1.9Z" />
    </GuiSvg>
  ),
  refresh: (
    <GuiSvg>
      <path d="M20 12a8 8 0 1 1-2.4-5.7" />
      <path d="M20.2 4.4v5h-5" />
    </GuiSvg>
  ),
  filter: (
    <GuiSvg>
      <path d="M4.2 5.6h15.6l-6.2 7.4v5.4l-3.2 1.8v-7.2L4.2 5.6Z" />
    </GuiSvg>
  ),
  sort: (
    <GuiSvg>
      <path d="M8.2 5.6v12.8M5 15.2l3.2 3.2 3.2-3.2" />
      <path d="M15.8 18.4V5.6M12.6 8.8 15.8 5.6l3.2 3.2" />
    </GuiSvg>
  ),
  trendUp: (
    <GuiSvg>
      <path d="m4.6 15.4 5.2-5.2 3.2 3.2 6.4-6.4" />
      <path d="M14.6 6.9h4.8v4.8" />
    </GuiSvg>
  ),
  trendDown: (
    <GuiSvg>
      <path d="m4.6 8.6 5.2 5.2 3.2-3.2 6.4 6.4" />
      <path d="M14.6 17.1h4.8v-4.8" />
    </GuiSvg>
  )
}

function iconGlyph(name: string): ReactNode {
  return GUI_ICONS[name] ?? (
    <GuiSvg>
      <circle cx="12" cy="12" r="4" />
    </GuiSvg>
  )
}

// ===== 读取辅助 =====

function str(el: UiElement | null, name: string, fallback = ''): string {
  return el === null ? fallback : UiNode.str(el, name, fallback)
}

function bool(el: UiElement | null, name: string, fallback = false): boolean {
  return el === null ? fallback : UiNode.bool(el, name, fallback)
}

function num(el: UiElement | null, name: string, fallback = 0): number {
  return el === null ? fallback : UiNode.num(el, name, fallback)
}

function normalizeVariant(raw: string, fallback: string): string {
  const v = raw.trim().toLowerCase()
  return v === '' ? fallback : v
}

function sizeClass(size: string): string {
  const v = size.trim().toLowerCase()
  if (v === 'sm' || v === 'small') {
    return ' gui-text--sm'
  }
  if (v === 'lg' || v === 'large') {
    return ' gui-text--lg'
  }
  return ''
}

function variantClass(variant: string, prefix: string): string {
  const v = normalizeVariant(variant, '')
  return v === '' ? '' : ` ${prefix}--${v}`
}

function children(el: UiElement, name: string): UiElement[] {
  return UiNode.elementList(el, name)
}

/** 控件写回绑定值：写入后由调用方重新物化整棵树 */
function writeBinding(ctx: RenderCtx, key: string, value: unknown): void {
  if (key === '') {
    return
  }
  ctx.state.set(key, value as object)
  ctx.refresh()
}

/** 读取控件当前值（优先绑定，其次默认值） */
function readBinding(ctx: RenderCtx, el: UiElement, name = 'value'): { key: string; value: unknown } {
  const key = GuncatUiRuntime.stateKeyOf(el)
  const bound = UiNode.bindOf(el, name)
  if (bound !== '') {
    return { key, value: ctx.state.get(bound) }
  }
  const current = ctx.state.get(key)
  if (current !== null) {
    return { key, value: current }
  }
  return { key, value: UiNode.raw(el, 'defaultValue') }
}

function asStringArray(value: unknown): string[] {
  if (value instanceof Array) {
    return (value as unknown[]).map((v) => String(v))
  }
  if (typeof value === 'string' && value !== '') {
    return [value]
  }
  return []
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !(value instanceof Array)) {
    return value as Record<string, unknown>
  }
  return {}
}

/** 执行动作：本地动作改 state，回传动作交给上层发给模型 */
function runAction(el: UiElement, actionName: string, ctx: RenderCtx): void {
  const steps: UiActionStep[] = UiNode.actionSteps(el, actionName)
  if (steps.length === 0) {
    return
  }
  const changed = GuncatUiRuntime.applySteps(steps, ctx.state)
  if (changed) {
    ctx.refresh()
  }
  const url = GuncatUiRuntime.urlOf(steps)
  if (url !== '') {
    ctx.openUrl(url)
  }
  const messages = GuncatUiRuntime.collectMessages(steps)
  if (messages.length > 0) {
    ctx.send(messages.join('\n'))
  }
}

// ===== 基础排版 =====

function renderChildren(list: UiElement[], ctx: RenderCtx): ReactNode[] {
  return list.map((child, i) => renderNode(child, ctx, `${child.key || child.type}-${i}`))
}

function CardHeader({ el }: { el: UiElement }) {
  const title = str(el, 'title')
  const subtitle = str(el, 'subtitle')
  if (title === '' && subtitle === '') {
    return null
  }
  return (
    <div className="gui-card-header">
      {title !== '' ? <div className="gui-card-header__title">{title}</div> : null}
      {subtitle !== '' ? <div className="gui-card-header__sub">{subtitle}</div> : null}
    </div>
  )
}

function CalloutBlock({ el }: { el: UiElement }) {
  const variant = normalizeVariant(str(el, 'variant'), 'info')
  return (
    <div className={`gui-callout${variantClass(variant, 'gui-callout')}`}>
      {str(el, 'title') !== '' ? <div className="gui-callout__title">{str(el, 'title')}</div> : null}
      {str(el, 'description') !== '' ? <div>{str(el, 'description')}</div> : null}
    </div>
  )
}

function TagView({ el, ctx }: { el: UiElement; ctx: RenderCtx }) {
  const icon = UiNode.element(el, 'icon')
  return (
    <span className={`gui-tag${variantClass(str(el, 'variant'), 'gui-tag')}`}>
      {icon !== null ? <span className="gui-icon">{iconGlyph(str(icon, 'name'))}</span> : null}
      {str(el, 'text')}
    </span>
  )
}

function TrendBadge({ trend }: { trend: unknown }) {
  const rec = asRecord(trend)
  const direction = String(rec['direction'] ?? 'flat')
  const value = rec['value']
  const arrow =
    direction === 'up' ? (
      <GuiSvg>
        <path d="m4.6 15.4 5.2-5.2 3.2 3.2 6.4-6.4" />
        <path d="M14.6 6.9h4.8v4.8" />
      </GuiSvg>
    ) : direction === 'down' ? (
      <GuiSvg>
        <path d="m4.6 8.6 5.2 5.2 3.2-3.2 6.4 6.4" />
        <path d="M14.6 17.1h4.8v-4.8" />
      </GuiSvg>
    ) : (
      <GuiSvg>
        <path d="M5.2 12h13.6" />
      </GuiSvg>
    )
  const label = value === undefined ? '' : ` ${String(value)}`
  return (
    <span className={`gui-trend gui-trend--${direction}`}>
      {arrow}
      {label}
    </span>
  )
}

function MetricView({ el }: { el: UiElement }) {
  const trend = UiNode.raw(el, 'trend')
  const previous = str(el, 'previousValue')
  return (
    <div className="gui-metric">
      {previous !== '' ? <span className="gui-metric__prev">{previous}</span> : null}
      <span className="gui-metric__value">{str(el, 'value')}</span>
      {trend !== null ? <TrendBadge trend={trend} /> : null}
      {str(el, 'subtext') !== '' ? (
        <span className="gui-metric__sub">{str(el, 'subtext')}</span>
      ) : null}
    </div>
  )
}

function IconTextView({ el, ctx }: { el: UiElement; ctx: RenderCtx }) {
  const icon = UiNode.element(el, 'icon')
  const layout = normalizeVariant(str(el, 'layout'), 'horizontal')
  return (
    <div
      className={`gui-icontext${layout === 'vertical' ? ' gui-icontext--column' : ''}${
        bool(el, 'bold') ? ' gui-icontext--bold' : ''
      }`}
    >
      {icon !== null ? <span className="gui-icon">{iconGlyph(str(icon, 'name'))}</span> : null}
      <div>
        <div className="gui-icontext__title">{str(el, 'title')}</div>
        {str(el, 'subtitle') !== '' ? (
          <div className="gui-icontext__sub">{str(el, 'subtitle')}</div>
        ) : null}
      </div>
    </div>
  )
}

function ImageTextView({ el }: { el: UiElement }) {
  const src = str(el, 'src')
  const layout = normalizeVariant(str(el, 'layout'), 'horizontal')
  return (
    <div
      className={`gui-icontext${layout === 'vertical' ? ' gui-icontext--column' : ''}${
        bool(el, 'bold') ? ' gui-icontext--bold' : ''
      }`}
    >
      {src !== '' ? (
        <img className="gui-list__thumb" src={src} alt="" loading="lazy" />
      ) : null}
      <div>
        <div className="gui-icontext__title">{str(el, 'title')}</div>
        {str(el, 'subtitle') !== '' ? (
          <div className="gui-icontext__sub">{str(el, 'subtitle')}</div>
        ) : null}
      </div>
    </div>
  )
}

// ===== 表格 =====

function TableView({ el, ctx }: { el: UiElement; ctx: RenderCtx }) {
  const cols = children(el, 'columns')
  if (cols.length === 0) {
    return <div className="gui-empty">（空表格）</div>
  }
  // Col(label, data, type?) —— data 是该列自上而下的取值数组（列存）
  const headers = cols.map((c) => str(c, 'label'))
  const columnValues: unknown[][] = cols.map((c) => {
    const raw = UiNode.raw(c, 'data')
    if (raw instanceof Array) {
      return raw as unknown[]
    }
    if (raw !== null && raw !== undefined) {
      return [raw]
    }
    return []
  })
  const rowCount = Math.max(...columnValues.map((v) => v.length), 0)

  return (
    <div className="gui-table-wrap">
      <table className="gui-table">
        <thead>
          <tr>
            {headers.map((h, i) => (
              <th key={i}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rowCount }, (_, r) => (
            <tr key={r}>
              {cols.map((c, ci) => {
                const cell = columnValues[ci][r]
                const type = normalizeVariant(str(c, 'type'), '')
                const text = typeof cell === 'number' ? UiNum.value(cell) : String(cell ?? '')
                return (
                  <td
                    key={ci}
                    style={type === 'number' ? { textAlign: 'right', fontVariantNumeric: 'tabular-nums' } : undefined}
                  >
                    {text}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function EntityListView({ el }: { el: UiElement }) {
  const rows = UiNode.objList(el, 'rows')
  const header = UiNode.obj(el, 'header')
  const footer = UiNode.obj(el, 'footer')

  const renderRow = (row: Record<string, unknown>, i: number, bold: boolean): ReactNode => (
    <div
      key={i}
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: 12,
        padding: '6px 0',
        borderBottom: bold ? 'none' : '1px solid var(--border)',
        fontWeight: bold ? 600 : 400,
        fontSize: 13
      }}
    >
      <span>{String(row['left'] ?? row['label'] ?? '')}</span>
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>
        {String(row['right'] ?? row['value'] ?? '')}
      </span>
    </div>
  )

  return (
    <div>
      {header !== null ? renderRow(header, -1, true) : null}
      {rows.map((row, i) => renderRow(row, i, false))}
      {footer !== null ? renderRow(footer, -2, true) : null}
    </div>
  )
}

// ===== 图表 =====

function seriesOf(el: UiElement): SeriesData[] {
  return children(el, 'series')
    .filter((s) => s.type === 'Series')
    .map((s) => ({
      category: str(s, 'category'),
      values: UiNode.numList(s, 'values')
    }))
}

function ChartView({ el }: { el: UiElement }) {
  const labels = UiNode.strList(el, 'labels')
  const variant = str(el, 'variant')
  const height = Math.max(120, Math.min(420, num(el, 'height', 200)))

  switch (el.type) {
    case 'BarChart':
      return <BarChartView labels={labels} series={seriesOf(el)} variant={variant} height={height} />
    case 'LineChart':
      return <LineChartView labels={labels} series={seriesOf(el)} variant={variant} height={height} />
    case 'AreaChart':
      return <LineChartView labels={labels} series={seriesOf(el)} variant={variant} area height={height} />
    case 'HorizontalBarChart':
      return <HorizontalBarChartView labels={labels} series={seriesOf(el)} />
    case 'PieChart':
      return <PieChartView labels={labels} values={UiNode.numList(el, 'values')} variant={variant} />
    case 'RadialChart':
      return <RadialChartView labels={labels} values={UiNode.numList(el, 'values')} />
    case 'RadarChart':
      // 多维对比：series 里的每个序列画成一个多边形（归一化在视图内部做，与上游同口径）
      return <RadarChartView labels={labels} series={seriesOf(el)} />
    case 'SingleStackedBarChart':
      return <StackedBarChartView labels={labels} values={UiNode.numList(el, 'values')} />
    default:
      return <div className="gui-empty">（未知图表 {el.type}）</div>
  }
}

// ===== 表单控件 =====

function SliderControl({ el, ctx }: { el: UiElement; ctx: RenderCtx }) {
  const { key, value } = readBinding(ctx, el)
  const min = num(el, 'min', 0)
  const max = num(el, 'max', 100)
  const step = num(el, 'step', 1)
  const current = typeof value === 'number' ? value : GuncatUiRuntime.sliderDefault(el)
  return (
    <div className="gui-control">
      <input
        className="gui-slider"
        type="range"
        min={min}
        max={max}
        step={step > 0 ? step : 1}
        value={current}
        disabled={ctx.stale}
        onChange={(e) => writeBinding(ctx, key, Number(e.target.value))}
      />
      <span className="gui-slider__value">{UiNum.value(current)}</span>
    </div>
  )
}

function InputControl({ el, ctx, multiline }: { el: UiElement; ctx: RenderCtx; multiline?: boolean }) {
  const { key, value } = readBinding(ctx, el)
  const text = value === null || value === undefined ? '' : String(value)
  const placeholder = str(el, 'placeholder')
  if (multiline === true) {
    return (
      <textarea
        className="gui-textarea"
        rows={num(el, 'rows', 3)}
        placeholder={placeholder}
        value={text}
        disabled={ctx.stale}
        onChange={(e) => writeBinding(ctx, key, e.target.value)}
      />
    )
  }
  return (
    <input
      className="gui-input"
      type={str(el, 'type', 'text') === 'number' ? 'number' : 'text'}
      placeholder={placeholder}
      value={text}
      disabled={ctx.stale}
      onChange={(e) => writeBinding(ctx, key, e.target.value)}
    />
  )
}

function SelectControl({ el, ctx }: { el: UiElement; ctx: RenderCtx }) {
  const { key, value } = readBinding(ctx, el)
  const items = children(el, 'items').filter((i) => i.type === 'SelectItem')
  const current = value === null || value === undefined ? '' : String(value)
  return (
    <select
      className="gui-select"
      value={current}
      disabled={ctx.stale}
      onChange={(e) => writeBinding(ctx, key, e.target.value)}
    >
      <option value="">{str(el, 'placeholder', '请选择')}</option>
      {items.map((item, i) => (
        <option key={i} value={str(item, 'value')}>
          {str(item, 'label')}
        </option>
      ))}
    </select>
  )
}

function RadioControl({ el, ctx }: { el: UiElement; ctx: RenderCtx }) {
  const { key, value } = readBinding(ctx, el)
  const items = children(el, 'items').filter((i) => i.type === 'RadioItem')
  const fallback = str(el, 'defaultValue')
  const current = value === null || value === undefined || value === '' ? fallback : String(value)
  return (
    <div className="gui-choice">
      {items.map((item, i) => {
        const v = str(item, 'value')
        return (
          <button
            key={i}
            type="button"
            className="gui-choice__item"
            data-active={current === v}
            disabled={ctx.stale}
            onClick={() => writeBinding(ctx, key, v)}
          >
            <span>
              {current === v ? (
                <GuiSvg>
                  <circle cx="12" cy="12" r="8.4" />
                  <circle cx="12" cy="12" r="3.6" fill="currentColor" stroke="none" />
                </GuiSvg>
              ) : (
                <GuiSvg>
                  <circle cx="12" cy="12" r="8.4" />
                </GuiSvg>
              )}
            </span>
            <span>
              {str(item, 'label')}
              {str(item, 'description') !== '' ? (
                <span className="gui-choice__desc">{str(item, 'description')}</span>
              ) : null}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function CheckBoxControl({ el, ctx }: { el: UiElement; ctx: RenderCtx }) {
  const key = GuncatUiRuntime.stateKeyOf(el)
  const current = ctx.state.get(key)
  const items = children(el, 'items').filter((i) => i.type === 'CheckBoxItem')
  return (
    <div className="gui-choice">
      {items.map((item, i) => {
        const name = str(item, 'name', str(item, 'label'))
        const checked = GuncatUiRuntime.boolMapValue(current, name) || bool(item, 'defaultChecked')
        return (
          <label key={i} className="gui-check">
            <input
              type="checkbox"
              checked={checked}
              disabled={ctx.stale}
              onChange={(e) => {
                GuncatUiRuntime.setMapValue(ctx.state, key, name, e.target.checked)
                ctx.refresh()
              }}
            />
            <span>
              {str(item, 'label')}
              {str(item, 'description') !== '' ? (
                <span className="gui-choice__desc">{str(item, 'description')}</span>
              ) : null}
            </span>
          </label>
        )
      })}
    </div>
  )
}

function SwitchControl({ el, ctx }: { el: UiElement; ctx: RenderCtx }) {
  const key = GuncatUiRuntime.stateKeyOf(el)
  const items = children(el, 'items').filter((i) => i.type === 'SwitchItem')
  return (
    <div>
      {items.map((item, i) => {
        const name = str(item, 'name', str(item, 'label'))
        const on = GuncatUiRuntime.switchValue(ctx.state, key, name, item)
        return (
          <button
            key={i}
            type="button"
            className="gui-switch"
            data-on={on}
            disabled={ctx.stale}
            onClick={() => {
              GuncatUiRuntime.setMapValue(ctx.state, key, name, !on)
              ctx.refresh()
            }}
          >
            <span className="gui-switch__track">
              <span className="gui-switch__knob" />
            </span>
            <span>
              {str(item, 'label')}
              {str(item, 'description') !== '' ? (
                <span className="gui-choice__desc">{str(item, 'description')}</span>
              ) : null}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function ChipsControl({ el, ctx }: { el: UiElement; ctx: RenderCtx }) {
  const { key, value } = readBinding(ctx, el)
  const multi = normalizeVariant(str(el, 'type'), 'single') !== 'single'
  const fallback = UiNode.raw(el, 'defaultValue')
  const raw = value === null || value === undefined ? fallback : value
  const selected = asStringArray(raw)
  const items = children(el, 'items').filter((i) => i.type === 'ChipItem')

  const toggle = (v: string): void => {
    if (!multi) {
      writeBinding(ctx, key, v)
      return
    }
    const next = selected.includes(v) ? selected.filter((s) => s !== v) : [...selected, v]
    writeBinding(ctx, key, next)
  }

  return (
    <div className="gui-chips">
      {items.map((item, i) => {
        const v = str(item, 'value')
        return (
          <button
            key={i}
            type="button"
            className="gui-chip"
            data-active={selected.includes(v)}
            disabled={ctx.stale || bool(item, 'disabled')}
            onClick={() => toggle(v)}
          >
            {str(item, 'label', v)}
          </button>
        )
      })}
    </div>
  )
}

function OptionCardsControl({ el, ctx }: { el: UiElement; ctx: RenderCtx }) {
  const { key, value } = readBinding(ctx, el)
  const multi = normalizeVariant(str(el, 'type'), 'single') !== 'single'
  const fallback = UiNode.raw(el, 'defaultValue')
  const raw = value === null || value === undefined ? fallback : value
  const selected = asStringArray(raw)
  const items = children(el, 'items').filter((i) => i.type === 'OptionCard')

  const toggle = (v: string): void => {
    if (!multi) {
      writeBinding(ctx, key, v)
      return
    }
    const next = selected.includes(v) ? selected.filter((s) => s !== v) : [...selected, v]
    writeBinding(ctx, key, next)
  }

  return (
    <div className="gui-optioncards">
      {items.map((item, i) => {
        const v = str(item, 'value')
        return (
          <button
            key={i}
            type="button"
            className="gui-optioncard"
            data-active={selected.includes(v)}
            disabled={ctx.stale || bool(item, 'disabled')}
            onClick={() => toggle(v)}
          >
            <div className="gui-optioncard__title">{str(item, 'title')}</div>
            {str(item, 'subtitle') !== '' ? (
              <div className="gui-optioncard__sub">{str(item, 'subtitle')}</div>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

function DatePickerControl({ el, ctx }: { el: UiElement; ctx: RenderCtx }) {
  const { key, value } = readBinding(ctx, el)
  const mode = normalizeVariant(str(el, 'mode'), 'date')
  const inputType = mode === 'month' ? 'month' : mode === 'time' ? 'time' : 'date'
  return (
    <input
      className="gui-input"
      type={inputType}
      value={value === null || value === undefined ? '' : String(value)}
      disabled={ctx.stale}
      onChange={(e) => writeBinding(ctx, key, e.target.value)}
    />
  )
}

function renderControl(input: UiElement, ctx: RenderCtx): ReactNode {
  switch (input.type) {
    case 'Slider':
      return <SliderControl el={input} ctx={ctx} />
    case 'TextArea':
      return <InputControl el={input} ctx={ctx} multiline />
    case 'Input':
      return <InputControl el={input} ctx={ctx} />
    case 'Select':
      return <SelectControl el={input} ctx={ctx} />
    case 'RadioGroup':
      return <RadioControl el={input} ctx={ctx} />
    case 'CheckBoxGroup':
      return <CheckBoxControl el={input} ctx={ctx} />
    case 'SwitchGroup':
      return <SwitchControl el={input} ctx={ctx} />
    case 'Chips':
      return <ChipsControl el={input} ctx={ctx} />
    case 'OptionCards':
      return <OptionCardsControl el={input} ctx={ctx} />
    case 'DatePicker':
      return <DatePickerControl el={input} ctx={ctx} />
    default:
      return <span className="gui-empty">（未知控件 {input.type}）</span>
  }
}

function FormView({ el, ctx }: { el: UiElement; ctx: RenderCtx }) {
  const fields = children(el, 'fields').filter((f) => f.type === 'FormControl')
  const buttons = UiNode.element(el, 'buttons')

  const submit = (): void => {
    // 有显式 action 的按钮走它；否则按「表单提交」把全部字段值打包回传
    const actionSteps = buttons === null ? [] : UiNode.actionSteps(buttons, 'action')
    const messages = GuncatUiRuntime.collectMessages(actionSteps)
    if (messages.length > 0) {
      const body = GuncatUiRuntime.formMessage(el, ctx.state)
      ctx.send(GuncatUiRuntime.interactionText(str(el, 'name'), [body, ...messages].filter(Boolean).join('\n')))
      return
    }
    const body = GuncatUiRuntime.formMessage(el, ctx.state)
    ctx.send(GuncatUiRuntime.interactionText(str(el, 'name'), body))
  }

  return (
    <div className="gui-form">
      {fields.map((field, i) => {
        const input = UiNode.element(field, 'input')
        return (
          <div className="gui-field" key={i}>
            <label className="gui-field__label">{str(field, 'label')}</label>
            {input !== null ? renderControl(input, ctx) : null}
            {str(field, 'hint') !== '' ? (
              <div className="gui-field__hint">{str(field, 'hint')}</div>
            ) : null}
          </div>
        )
      })}
      {buttons !== null ? (
        <div className="gui-buttons" style={{ marginTop: 4 }}>
          {(buttons.type === 'Buttons' ? children(buttons, 'buttons') : [buttons]).map((btn, i) => (
            <button
              key={i}
              type="button"
              className={`gui-btn${variantClass(str(btn, 'variant'), 'gui-btn')}`}
              disabled={ctx.stale}
              onClick={submit}
            >
              {str(btn, 'label')}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

// ===== 选项卡 / 折叠 / 步骤 =====

function TabsView({ el, ctx }: { el: UiElement; ctx: RenderCtx }) {
  const items = children(el, 'items').filter((i) => i.type === 'TabItem')
  const [active, setActive] = useLocalState(0)
  if (items.length === 0) {
    return null
  }
  const index = Math.min(active, items.length - 1)
  return (
    <div>
      <div className="gui-tabs__bar">
        {items.map((item, i) => (
          <button
            key={i}
            type="button"
            className="gui-tabs__tab"
            data-active={i === index}
            onClick={() => setActive(i)}
          >
            {str(item, 'trigger', str(item, 'value'))}
          </button>
        ))}
      </div>
      {renderChildren(children(items[index], 'content'), ctx)}
    </div>
  )
}

function AccordionView({ el, ctx }: { el: UiElement; ctx: RenderCtx }) {
  const items = children(el, 'items').filter((i) => i.type === 'AccordionItem')
  const [open, setOpen] = useLocalState<number[]>([])
  return (
    <div>
      {items.map((item, i) => {
        const isOpen = open.includes(i)
        return (
          <div key={i}>
            <button
              type="button"
              className="gui-acc__head"
              onClick={() => setOpen(isOpen ? open.filter((x) => x !== i) : [...open, i])}
            >
              <span
                className="disclosure__caret"
                style={{ transform: isOpen ? 'rotate(180deg)' : 'none' }}
              >
                <GuiSvg>
                  <path d="m6.6 9.4 5.4 5.4 5.4-5.4" />
                </GuiSvg>
              </span>
              <span>{str(item, 'trigger', str(item, 'value'))}</span>
            </button>
            {isOpen ? <div className="gui-acc__body">{renderChildren(children(item, 'content'), ctx)}</div> : null}
          </div>
        )
      })}
    </div>
  )
}

function StepsView({ el }: { el: UiElement }) {
  const items = children(el, 'items').filter((i) => i.type === 'StepsItem')
  return (
    <div className="gui-steps">
      {items.map((item, i) => (
        <div className="gui-step" key={i}>
          <div className="gui-step__rail">
            <span className="gui-step__dot">{i + 1}</span>
            {i < items.length - 1 ? <span className="gui-step__line" /> : null}
          </div>
          <div className="gui-step__body">
            <div className="gui-step__title">{str(item, 'title')}</div>
            {str(item, 'details') !== '' ? (
              <div className="gui-step__details">{str(item, 'details')}</div>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  )
}

// 局部 UI 状态（选项卡选中项、折叠展开项）：不进 $绑定，也不需要回传模型
function useLocalState<T>(initial: T): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(initial)
  return [value, setValue]
}

// ===== 列表 =====

function ListBlockView({ el, ctx }: { el: UiElement; ctx: RenderCtx }) {
  const items = children(el, 'items').filter((i) => i.type === 'ListItem')
  return (
    <div className="gui-list">
      {items.map((item, i) => {
        const image = UiNode.obj(item, 'image')
        const src = image === null ? '' : String(image['src'] ?? '')
        const actionLabel = str(item, 'actionLabel')
        const hasAction = UiNode.actionSteps(item, 'action').length > 0
        return (
          <div className="gui-list__item" key={i}>
            {src !== '' ? <img className="gui-list__thumb" src={src} alt="" loading="lazy" /> : null}
            <div className="gui-list__body">
              <div className="gui-list__title">{str(item, 'title')}</div>
              {str(item, 'subtitle') !== '' ? (
                <div className="gui-list__sub">{str(item, 'subtitle')}</div>
              ) : null}
            </div>
            {actionLabel !== '' || hasAction ? (
              <button
                type="button"
                className="gui-btn gui-btn--sm"
                disabled={ctx.stale}
                onClick={() => {
                  if (hasAction) {
                    runAction(item, 'action', ctx)
                  } else {
                    ctx.send(actionLabel)
                  }
                }}
              >
                {actionLabel || '查看'}
              </button>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

// ===== 卡片块 =====

function CardBlockView({ el, ctx }: { el: UiElement; ctx: RenderCtx }) {
  const items = children(el, 'items')
  const layout = normalizeVariant(str(el, 'layout'), 'row')
  const gap = num(el, 'gap', 10)
  return (
    <div
      className={`gui-cardblock gui-cardblock--${layout === 'column' || layout === 'col' ? 'col' : 'row'}`}
      style={{ gap }}
    >
      {items.map((item, i) => renderCardItem(item, ctx, i))}
    </div>
  )
}

function renderCardItem(item: UiElement, ctx: RenderCtx, key: number): ReactNode {
  switch (item.type) {
    case 'SnippetCardItem':
      return (
        <div className="gui-carditem" key={key}>
          <div className="gui-carditem__body">{renderNode(UiNode.element(item, 'lhs'), ctx, `${key}-lhs`)}</div>
          {UiNode.element(item, 'rhs') !== null ? (
            <div style={{ marginTop: 6 }}>{renderNode(UiNode.element(item, 'rhs'), ctx, `${key}-rhs`)}</div>
          ) : null}
        </div>
      )
    case 'OverviewCardItem':
      return (
        <div className="gui-carditem" key={key}>
          {renderNode(UiNode.element(item, 'top'), ctx, `${key}-top`)}
          {UiNode.element(item, 'bottom') !== null ? (
            <div style={{ marginTop: 4 }}>{renderNode(UiNode.element(item, 'bottom'), ctx, `${key}-bottom`)}</div>
          ) : null}
        </div>
      )
    case 'ContextCardItem':
      return (
        <div
          className="gui-carditem"
          key={key}
          style={str(item, 'bgColor') !== '' ? { background: str(item, 'bgColor') } : undefined}
        >
          <div className="gui-carditem__title">{str(item, 'title')}</div>
          {str(item, 'body') !== '' ? <div className="gui-carditem__body">{str(item, 'body')}</div> : null}
        </div>
      )
    case 'CompositeCardItem': {
      const footer = UiNode.obj(item, 'footer')
      return (
        <div className="gui-carditem" key={key}>
          {renderNode(UiNode.element(item, 'header'), ctx, `${key}-header`)}
          {children(item, 'body').length > 0 ? (
            <div style={{ marginTop: 6 }}>{renderChildren(children(item, 'body'), ctx)}</div>
          ) : null}
          {footer !== null ? (
            <div className="gui-carditem__body" style={{ marginTop: 6 }}>
              {String(footer['text'] ?? '')}
            </div>
          ) : null}
        </div>
      )
    }
    case 'VisualCardItem': {
      const bg = str(item, 'bgImageSrc')
      const tag = UiNode.element(item, 'tag')
      return (
        <div
          className="gui-carditem gui-carditem--visual"
          key={key}
          style={bg !== '' ? { backgroundImage: `url(${bg})` } : undefined}
        >
          {tag !== null ? <div className="gui-carditem__tag">{renderNode(tag, ctx, `${key}-tag`)}</div> : null}
          {renderNode(UiNode.element(item, 'body'), ctx, `${key}-body`)}
        </div>
      )
    }
    default:
      // 未知卡片项：把内容原样渲染，避免整块消失
      return (
        <div className="gui-carditem" key={key}>
          {renderNode(item, ctx, `${key}-raw`)}
        </div>
      )
  }
}

// ===== 分派 =====

export function renderNode(el: UiElement | null, ctx: RenderCtx, key: string): ReactNode {
  if (el === null) {
    return null
  }
  const type = el.type

  switch (type) {
    case 'Card':
      return (
        <div className="gui-col" key={key}>
          {renderChildren(children(el, 'children'), ctx)}
        </div>
      )
    case 'CardHeader':
      return <CardHeader el={el} key={key} />
    case 'TextContent':
      return (
        <div className={`gui-text${sizeClass(str(el, 'size'))}`} key={key}>
          {str(el, 'text')}
        </div>
      )
    case 'MarkDownRenderer':
      return (
        <div className="gui-text" key={key}>
          <Markdown text={str(el, 'textMarkdown')} />
        </div>
      )
    case 'Text':
    case 'BoldText': {
      const subtext = str(el, 'subtext')
      return (
        <div className={type === 'BoldText' ? 'gui-bold' : ''} key={key}>
          <div className={`gui-text${sizeClass(str(el, 'size'))}`}>{str(el, 'value')}</div>
          {subtext !== '' ? <div className="gui-text__sub">{subtext}</div> : null}
        </div>
      )
    }
    case 'InlineHeader':
      return (
        <div key={key}>
          <div className="gui-inline-header__title">{str(el, 'heading')}</div>
          {str(el, 'description') !== '' ? (
            <div className="gui-inline-header__desc">{str(el, 'description')}</div>
          ) : null}
        </div>
      )
    case 'Callout':
    case 'TextCallout':
      return <CalloutBlock el={el} key={key} />
    case 'CodeBlock':
      return (
        <div key={key}>
          {str(el, 'language') !== '' ? (
            <div className="gui-code__lang">{str(el, 'language')}</div>
          ) : null}
          <pre className="gui-code">{str(el, 'codeString')}</pre>
        </div>
      )
    case 'Separator':
      return (
        <hr
          className={`gui-sep${normalizeVariant(str(el, 'orientation'), 'horizontal') === 'vertical' ? ' gui-sep--vertical' : ''}`}
          key={key}
        />
      )
    case 'Tag':
      return <TagView el={el} ctx={ctx} key={key} />
    case 'TagBlock':
      return (
        <div className="gui-tags" key={key}>
          {UiNode.strList(el, 'tags').map((t, i) => (
            <span className="gui-tag" key={i}>
              {t}
            </span>
          ))}
        </div>
      )
    case 'Image':
    case 'ImageBlock': {
      const src = str(el, 'src')
      const alt = str(el, 'alt')
      if (src === '') {
        return <div className="gui-empty" key={key}>{alt || '（无图）'}</div>
      }
      return <img className="gui-img" src={src} alt={alt} key={key} loading="lazy" />
    }
    case 'ImageGallery': {
      const images = UiNode.objList(el, 'images')
      return (
        <div className="gui-gallery" key={key}>
          {images.map((img, i) => (
            <img key={i} src={String(img['src'] ?? '')} alt={String(img['alt'] ?? '')} loading="lazy" />
          ))}
        </div>
      )
    }
    case 'Table':
      return <TableView el={el} ctx={ctx} key={key} />
    case 'EntityList':
      return <EntityListView el={el} key={key} />
    case 'BarChart':
    case 'LineChart':
    case 'AreaChart':
    case 'HorizontalBarChart':
    case 'PieChart':
    case 'RadialChart':
    case 'RadarChart':
    case 'SingleStackedBarChart':
      return <ChartView el={el} key={key} />
    case 'Series':
      return null
    case 'MetricIndicatorInline':
    case 'MetricIndicatorWithStrikethrough':
      return <MetricView el={el} key={key} />
    case 'Icon':
      return (
        <span className="gui-icon" key={key} title={str(el, 'name')}>
          {iconGlyph(str(el, 'name'))}
        </span>
      )
    case 'IconText':
      return <IconTextView el={el} ctx={ctx} key={key} />
    case 'ImageText':
      return <ImageTextView el={el} key={key} />
    case 'IconButton': {
      const icon = UiNode.element(el, 'icon')
      return (
        <button
          className="gui-icon-btn"
          key={key}
          title={str(el, 'name')}
          disabled={ctx.stale}
          onClick={() => runAction(el, 'action', ctx)}
        >
          <span className="gui-icon">{iconGlyph(str(icon ?? el, 'name'))}</span>
        </button>
      )
    }
    case 'Tabs':
      return <TabsView el={el} ctx={ctx} key={key} />
    case 'Accordion':
      return <AccordionView el={el} ctx={ctx} key={key} />
    case 'Steps':
      return <StepsView el={el} key={key} />
    case 'SectionBlock': {
      const sections = children(el, 'sections').filter((s) => s.type === 'SectionItem')
      if (bool(el, 'isFoldable')) {
        return (
          <AccordionView
            el={
              {
                ...el,
                type: 'Accordion',
                props: {
                  items: sections.map((s) => ({
                    ...s,
                    type: 'AccordionItem'
                  }))
                }
              } as UiElement
            }
            ctx={ctx}
            key={key}
          />
        )
      }
      return (
        <div className="gui-col" key={key}>
          {sections.map((s, i) => (
            <div key={i}>
              <div className="gui-inline-header__title">{str(s, 'trigger')}</div>
              <div style={{ marginTop: 6 }}>{renderChildren(children(s, 'content'), ctx)}</div>
            </div>
          ))}
        </div>
      )
    }
    case 'Carousel': {
      const items = children(el, 'children')
      return (
        <div className="gui-carousel" key={key}>
          {items.map((item, i) => (
            <div className="gui-carditem" key={i}>
              {renderNode(item, ctx, `${key}-c${i}`)}
            </div>
          ))}
        </div>
      )
    }
    case 'ListBlock':
      return <ListBlockView el={el} ctx={ctx} key={key} />
    case 'FollowUpBlock':
      return (
        <div className="gui-cardblock gui-cardblock--row" key={key}>
          {children(el, 'items').map((item, i) => (
            <button
              key={i}
              type="button"
              className="gui-optioncard"
              disabled={ctx.stale}
              onClick={() => ctx.send(str(item, 'text'))}
            >
              <div className="gui-optioncard__title">{str(item, 'text')}</div>
            </button>
          ))}
        </div>
      )
    case 'SnippetCardBlock':
    case 'OverviewCardBlock':
    case 'ContextCardBlock':
    case 'CompositeCardBlock':
    case 'VisualCardBlock':
      return <CardBlockView el={el} ctx={ctx} key={key} />
    case 'Col':
      return <span key={key}>{String(UiNode.raw(el, 'data') ?? '')}</span>
    case 'Form':
      return <FormView el={el} ctx={ctx} key={key} />
    case 'FormControl': {
      const input = UiNode.element(el, 'input')
      return (
        <div className="gui-field" key={key}>
          <label className="gui-field__label">{str(el, 'label')}</label>
          {input !== null ? renderControl(input, ctx) : null}
          {str(el, 'hint') !== '' ? <div className="gui-field__hint">{str(el, 'hint')}</div> : null}
        </div>
      )
    }
    case 'Slider':
    case 'Input':
    case 'TextArea':
    case 'Select':
    case 'RadioGroup':
    case 'CheckBoxGroup':
    case 'SwitchGroup':
    case 'Chips':
    case 'OptionCards':
    case 'DatePicker':
      return <div key={key}>{renderControl(el, ctx)}</div>
    case 'Buttons': {
      const items = children(el, 'buttons')
      const direction = normalizeVariant(str(el, 'direction'), 'row')
      return (
        <div className={`gui-buttons${direction === 'column' ? ' gui-buttons--column' : ''}`} key={key}>
          {items.map((btn, i) =>
            btn.type === 'Button' || btn.type === 'IconButton'
              ? renderNode(btn, ctx, `${key}-b${i}`)
              : null
          )}
        </div>
      )
    }
    case 'Button': {
      const label = str(el, 'label')
      const hasAction = UiNode.actionSteps(el, 'action').length > 0
      return (
        <button
          key={key}
          type="button"
          className={`gui-btn${variantClass(str(el, 'variant'), 'gui-btn')}${
            sizeClass(str(el, 'size')).replace('gui-text--sm', ' gui-btn--sm').replace('gui-text--lg', ' gui-btn--lg')
          }`}
          disabled={ctx.stale}
          onClick={() => {
            if (hasAction) {
              runAction(el, 'action', ctx)
            } else {
              // 无 action 的按钮：等价于把按钮文字发给助手（与参考实现一致）
              ctx.send(label)
            }
          }}
        >
          {label}
        </button>
      )
    }
    default:
      // 未知组件不丢弃：把可读文本渲染出来并标注，避免"整块消失"
      return (
        <div className="gui-text gui-text--sm" key={key}>
          {renderUnknown(el, ctx)}
        </div>
      )
  }
}

function renderUnknown(el: UiElement, ctx: RenderCtx): ReactNode {
  // 尽量把未知组件的子元素与文本参数渲染出来
  const parts: ReactNode[] = []
  const textKeys = ['text', 'value', 'title', 'body', 'label', 'description', 'content']
  for (const k of textKeys) {
    const v = UiNode.str(el, k, '')
    if (v !== '') {
      parts.push(<div key={k}>{v}</div>)
    }
  }
  for (const k of ['children', 'items', 'content', 'fields', 'sections']) {
    const list = children(el, k)
    if (list.length > 0) {
      parts.push(<div key={k}>{renderChildren(list, ctx)}</div>)
    }
  }
  if (parts.length === 0) {
    return <span className="gui-empty">（未支持的组件 {el.type}）</span>
  }
  return <>{parts}</>
}
