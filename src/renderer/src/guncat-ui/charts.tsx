// 交互模式图表：8 种图表全部用 SVG 绘制。
//
// 几何计算复用从鸿蒙版移植过来的 GuncatUiPaint（纯逻辑，含比例尺、路径生成、
// 调色板、数值格式化），所以两种形态的数据表现是一致的；
// 只有"画"这一步换成了 SVG。
import { useEffect, useRef, useState } from 'react'
import { UiChartGeom, UiBox, UiScale, UiPoint, UiPalette, UiNum } from '@core/common/GuncatUiPaint'

export interface SeriesData {
  category: string
  values: number[]
}

/** 量测容器宽度：让 SVG 用真实像素坐标系绘制，文字不会被 viewBox 缩放拉变形 */
function useWidth(fallback: number): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(fallback)
  useEffect(() => {
    const el = ref.current
    if (el === null) {
      return
    }
    const update = (): void => {
      const w = el.clientWidth
      if (w > 0) {
        setWidth(w)
      }
    }
    update()
    if (typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return [ref, width]
}

function Legend({ items }: { items: Array<{ label: string; color: string }> }) {
  if (items.length <= 1) {
    return null
  }
  return (
    <div className="gui-chart__legend">
      {items.map((it) => (
        <span className="gui-chart__legend-item" key={it.label}>
          <span className="gui-chart__swatch" style={{ background: it.color }} />
          {it.label}
        </span>
      ))}
    </div>
  )
}

function AxisLabels({ labels }: { labels: string[] }) {
  if (labels.length === 0) {
    return null
  }
  const first = labels[0]
  const last = labels[labels.length - 1]
  return (
    <div className="gui-chart__labels">
      <span>{first}</span>
      {labels.length > 2 ? <span>{labels[Math.floor(labels.length / 2)]}</span> : null}
      {labels.length > 1 ? <span>{last}</span> : null}
    </div>
  )
}

function Grid({ scale, box }: { scale: UiScale; box: UiBox }) {
  return (
    <g>
      {UiChartGeom.gridPaths(scale, 4, box).map((d, i) => (
        <path key={i} d={d} stroke={UiPalette.GRID} strokeWidth={1} fill="none" />
      ))}
    </g>
  )
}

function allValues(series: SeriesData[]): number[] {
  const out: number[] = []
  for (const s of series) {
    for (const v of s.values) {
      out.push(v)
    }
  }
  return out
}

// ===== 柱状图 =====

export function BarChartView({
  labels,
  series,
  variant,
  height = 200
}: {
  labels: string[]
  series: SeriesData[]
  variant?: string
  height?: number
}) {
  const [ref, width] = useWidth(480)
  if (series.length === 0 || labels.length === 0) {
    return <div className="gui-empty">（无数据）</div>
  }
  const box = UiBox.of(width, height)
  const scale = UiScale.of(allValues(series))
  const inner = box.innerW()
  const slot = inner / Math.max(1, labels.length)
  const groupCount = series.length
  const barW = Math.max(3, (slot * 0.66) / groupCount)
  const stacked = variant === 'stacked'

  let stackScale: UiScale | null = null
  if (stacked) {
    const totals: number[] = labels.map((_, i) =>
      series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0)
    )
    stackScale = UiScale.of(totals)
  }

  return (
    <div className="gui-chart" ref={ref}>
      <svg width={width} height={height}>
        <Grid scale={stacked && stackScale !== null ? stackScale : scale} box={box} />
        {labels.map((_, li) => {
          const slotStart = box.padL + slot * li
          let stackTop = box.baseY()
          return (
            <g key={li}>
              {series.map((s, si) => {
                const value = s.values[li] ?? 0
                const color = UiPalette.series(si)
                if (stacked && stackScale !== null) {
                  const h = (value / Math.max(stackScale.max, 1e-9)) * box.innerH()
                  const y = stackTop - h
                  stackTop = y
                  return (
                    <rect
                      key={si}
                      x={slotStart + slot * 0.17}
                      y={y}
                      width={slot * 0.66}
                      height={Math.max(0, h)}
                      fill={color}
                      rx={2}
                    >
                      <title>{`${s.category} · ${labels[li]}: ${UiNum.value(value)}`}</title>
                    </rect>
                  )
                }
                const h = (value / Math.max(scale.max, 1e-9)) * box.innerH()
                const x = slotStart + slot * 0.17 + barW * si
                return (
                  <rect
                    key={si}
                    x={x}
                    y={box.baseY() - h}
                    width={barW}
                    height={Math.max(0, h)}
                    fill={color}
                    rx={2}
                  >
                    <title>{`${s.category} · ${labels[li]}: ${UiNum.value(value)}`}</title>
                  </rect>
                )
              })}
            </g>
          )
        })}
      </svg>
      <Legend items={series.map((s, i) => ({ label: s.category, color: UiPalette.series(i) }))} />
      <AxisLabels labels={labels} />
    </div>
  )
}

// ===== 折线 / 面积 =====

export function LineChartView({
  labels,
  series,
  variant,
  area = false,
  height = 200
}: {
  labels: string[]
  series: SeriesData[]
  variant?: string
  area?: boolean
  height?: number
}) {
  const [ref, width] = useWidth(480)
  if (series.length === 0) {
    return <div className="gui-empty">（无数据）</div>
  }
  const box = UiBox.of(width, height)
  const scale = UiScale.of(allValues(series))
  const lineVariant = variant ?? 'linear'

  return (
    <div className="gui-chart" ref={ref}>
      <svg width={width} height={height}>
        <Grid scale={scale} box={box} />
        {series.map((s, si) => {
          const color = UiPalette.series(si)
          const d = area
            ? UiChartGeom.areaPath(s.values, scale, lineVariant, box)
            : UiChartGeom.linePath(s.values, scale, lineVariant, false, box)
          const dots: UiPoint[] = UiChartGeom.points(s.values, scale, box)
          return (
            <g key={si}>
              <path
                d={d}
                fill={area ? color : 'none'}
                fillOpacity={area ? 0.16 : 0}
                stroke={color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {dots.map((p, pi) => (
                <circle key={pi} cx={p.x} cy={p.y} r={2.6} fill={color}>
                  <title>{`${s.category} · ${labels[pi] ?? pi}: ${UiNum.value(s.values[pi] ?? 0)}`}</title>
                </circle>
              ))}
            </g>
          )
        })}
      </svg>
      <Legend items={series.map((s, i) => ({ label: s.category, color: UiPalette.series(i) }))} />
      <AxisLabels labels={labels} />
    </div>
  )
}

// ===== 横向条形图 =====

export function HorizontalBarChartView({
  labels,
  series
}: {
  labels: string[]
  series: SeriesData[]
}) {
  if (series.length === 0 || labels.length === 0) {
    return <div className="gui-empty">（无数据）</div>
  }
  const values = allValues(series)
  const max = Math.max(...values.map((v) => Math.abs(v)), 1e-9)
  const primary = series[0]

  return (
    <div className="gui-chart">
      <div className="gui-col" style={{ gap: 7 }}>
        {labels.map((label, i) => {
          const value = primary.values[i] ?? 0
          const pct = (Math.abs(value) / max) * 100
          return (
            <div key={i}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: 12,
                  marginBottom: 3
                }}
              >
                <span>{label}</span>
                <span style={{ fontWeight: 600 }}>{UiNum.value(value)}</span>
              </div>
              <div
                style={{
                  height: 9,
                  borderRadius: 5,
                  background: 'var(--bg-sunken)',
                  overflow: 'hidden'
                }}
              >
                <div
                  style={{
                    width: `${pct}%`,
                    height: '100%',
                    background: UiPalette.series(0),
                    borderRadius: 5
                  }}
                />
              </div>
            </div>
          )
        })}
      </div>
      <Legend items={series.map((s, i) => ({ label: s.category, color: UiPalette.series(i) }))} />
    </div>
  )
}

// ===== 饼 / 环 =====

export function PieChartView({
  labels,
  values,
  variant
}: {
  labels: string[]
  values: number[]
  variant?: string
}) {
  const [ref, width] = useWidth(320)
  if (values.length === 0) {
    return <div className="gui-empty">（无数据）</div>
  }
  const size = Math.min(width, 260)
  const cx = size / 2
  const cy = size / 2
  const outer = size / 2 - 6
  const donut = variant === 'donut' || variant === 'ring'
  const ratios = UiChartGeom.ratios(values)
  const starts = UiChartGeom.startRatios(ratios)
  const total = values.reduce((a, b) => a + b, 0)

  return (
    <div className="gui-chart" ref={ref}>
      <svg width={size} height={size}>
        {ratios.map((r, i) => {
          const color = UiPalette.category(i)
          const label = labels[i] ?? `#${i + 1}`
          return donut ? (
            <path
              key={i}
              d={UiChartGeom.arcAt(cx, cy, outer, starts[i], r)}
              stroke={color}
              strokeWidth={outer * 0.36}
              fill="none"
            >
              <title>{`${label}: ${UiNum.value(values[i])}（${UiNum.percent(values[i], total)}）`}</title>
            </path>
          ) : (
            <path key={i} d={UiChartGeom.wedgeAt(cx, cy, outer, starts[i], r)} fill={color}>
              <title>{`${label}: ${UiNum.value(values[i])}（${UiNum.percent(values[i], total)}）`}</title>
            </path>
          )
        })}
        {donut ? (
          <text
            x={cx}
            y={cy}
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize={15}
            fontWeight={600}
            fill="currentColor"
          >
            {UiNum.compact(total)}
          </text>
        ) : null}
      </svg>
      <div className="gui-chart__legend">
        {labels.map((label, i) => (
          <span className="gui-chart__legend-item" key={i}>
            <span
              className="gui-chart__swatch"
              style={{ background: UiPalette.category(i) }}
            />
            {label}
          </span>
        ))}
      </div>
    </div>
  )
}

// ===== 径向（半环仪表） =====

export function RadialChartView({
  labels,
  values
}: {
  labels: string[]
  values: number[]
}) {
  const [ref, width] = useWidth(320)
  if (values.length === 0) {
    return <div className="gui-empty">（无数据）</div>
  }
  const size = Math.min(width, 240)
  const cx = size / 2
  const cy = size / 2
  const outer = size / 2 - 10
  const total = values.reduce((a, b) => a + b, 0)
  const ratios = UiChartGeom.ratios(values)
  const starts = UiChartGeom.startRatios(ratios)

  return (
    <div className="gui-chart" ref={ref}>
      <svg width={size} height={size}>
        {ratios.map((r, i) => (
          <path
            key={i}
            d={UiChartGeom.arcAt(cx, cy, outer, starts[i], r)}
            stroke={UiPalette.category(i)}
            strokeWidth={11}
            fill="none"
          >
            <title>{`${labels[i] ?? ''}: ${UiNum.value(values[i])}`}</title>
          </path>
        ))}
        <text
          x={cx}
          y={cy}
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize={15}
          fontWeight={600}
          fill="currentColor"
        >
          {UiNum.compact(total)}
        </text>
      </svg>
      <div className="gui-chart__legend">
        {labels.map((label, i) => (
          <span className="gui-chart__legend-item" key={i}>
            <span className="gui-chart__swatch" style={{ background: UiPalette.category(i) }} />
            {label} {UiNum.percent(values[i], total)}
          </span>
        ))}
      </div>
    </div>
  )
}

// ===== 雷达图（多维对比） =====

/**
 * 雷达图：多个维度上的一张「多边形指纹」。
 *
 * 为什么补这个：内核早就有完整几何（`UiChartGeom.radarGrid / radarSpokes / radarPoints /
 * polygonPath`，见 GuncatUiPaint），提示词里也明确把 `RadarChart` 列为「多维对比」的推荐组件
 * （`GuncatUiPrompt` 的能力对照表），但**渲染层没有它、组件库也没注册它** ——
 * 于是模型照着提示词写出来的 `RadarChart` 会被当成未知组件丢掉（`GuncatUiLang` 的校验
 * 会记一条「未知组件 RadarChart, 已忽略」），用户看到的是一块空白。
 * 上游也有这个不一致（它的 GuncatUiCharts 里有 GuncatUiRadarChart，但 GuncatUiLibrary 没注册），
 * 所以这是**有意补上的**一处：让提示词里承诺的能力真的存在。
 *
 * 归一化口径与上游一致（`GuncatUiView.seriesNorm`）：取所有序列里的**全局最大值**除之，
 * 而不是每根轴各归各的 —— 后者会让同一张图里的不同轴失去可比性。
 */
export function RadarChartView({
  labels,
  series
}: {
  labels: string[]
  series: SeriesData[]
}) {
  const [ref, width] = useWidth(320)
  const count = labels.length
  if (count === 0 || series.length === 0) {
    return <div className="gui-empty">（无数据）</div>
  }
  const box = Math.min(width, 240)
  const radius = box / 2 - 20
  let max = 0
  for (const s of series) {
    for (const v of s.values) {
      if (v > max) {
        max = v
      }
    }
  }
  if (max <= 0) {
    max = 1
  }
  const norm = series.map((s) => s.values.map((v) => v / max))

  return (
    <div className="gui-chart" ref={ref}>
      {/* 用 viewBox + preserveAspectRatio 缩放：雷达图是**正方形**的，
          而 `.gui-chart svg { width: 100% }` 会把没有 viewBox 的固定宽高 SVG 拉成扁的
          （折线/柱状图是宽格式，拉伸不明显；正方形一拉就看得出走形）。
          图内没有文字，缩放不会把字拉变形。 */}
      <svg
        viewBox={`0 0 ${box} ${box}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ width: '100%', maxWidth: box, height: 'auto' }}
      >
        {UiChartGeom.radarGrid(count, radius, 4, box).map((d, i) => (
          <path key={`ring${i}`} d={d} stroke={UiPalette.GRID} strokeWidth={1} fill="none" />
        ))}
        {UiChartGeom.radarSpokes(count, radius, box).map((d, i) => (
          <path key={`spoke${i}`} d={d} stroke={UiPalette.GRID} strokeWidth={1} fill="none" />
        ))}
        {norm.map((values, si) => (
          <path
            key={`series${si}`}
            d={UiChartGeom.polygonPath(UiChartGeom.radarPoints(values, radius, box))}
            stroke={UiPalette.series(si)}
            strokeWidth={2}
            fill={UiPalette.series(si)}
            fillOpacity={0.18}
          />
        ))}
      </svg>
      {/* 每根轴的名字都要显示（不像折线图只给首/中/末三个刻度）—— 轴名是多维对比的语义本身 */}
      <div className="gui-chart__labels gui-chart__labels--wrap">
        {labels.map((label, i) => (
          <span key={i}>{label}</span>
        ))}
      </div>
      <Legend items={series.map((s, i) => ({ label: s.category, color: UiPalette.series(i) }))} />
    </div>
  )
}

// ===== 单条堆叠条 =====

export function StackedBarChartView({
  labels,
  values
}: {
  labels: string[]
  values: number[]
}) {
  if (values.length === 0) {
    return <div className="gui-empty">（无数据）</div>
  }
  const total = values.reduce((a, b) => a + b, 0)
  const ratios = UiChartGeom.ratios(values)

  return (
    <div className="gui-chart">
      <div
        style={{
          display: 'flex',
          height: 26,
          borderRadius: 7,
          overflow: 'hidden',
          background: 'var(--bg-sunken)'
        }}
      >
        {ratios.map((r, i) => (
          <div
            key={i}
            title={`${labels[i] ?? ''}: ${UiNum.value(values[i])}（${UiNum.percent(values[i], total)}）`}
            style={{ width: `${r * 100}%`, background: UiPalette.category(i) }}
          />
        ))}
      </div>
      <div className="gui-chart__legend">
        {labels.map((label, i) => (
          <span className="gui-chart__legend-item" key={i}>
            <span className="gui-chart__swatch" style={{ background: UiPalette.category(i) }} />
            {label} {UiNum.percent(values[i], total)}
          </span>
        ))}
      </div>
    </div>
  )
}
