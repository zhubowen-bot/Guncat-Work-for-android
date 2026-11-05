// 用量与成本：独立页面。
//
// 数据来自主进程/移动宿主里的 UsageService 聚合快照，页面只在打开时读一次；
// 热力图、汇总、日明细都在渲染层用纯函数构建，不扫描会话历史、不轮询。
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import type {
  ApiConfigDto,
  AppSettingsDto,
  UsageDayDto,
  UsageMetricKey,
  UsageMetrics,
  UsageOverviewDto,
  UsageProvider,
  UsageWindow
} from '@ipc/contract'
import { Constants } from '@core/common/Constants'
import {
  addUsageMetrics,
  aggregateUsageDay,
  aggregateUsageRange,
  buildModelShares,
  buildUsageHeatmap,
  emptyUsageMetrics,
  metricCostValue,
  type HeatmapData,
  type UsageModelShare
} from '@core/common/UsageAggregate'
import {
  OPENCODE_GO_MONTHLY_USD,
  formatCnyAmount,
  formatCompactTokens,
  formatDateTime,
  formatInteger,
  formatUsdAmount,
  providerLabel,
  usdToCny
} from '@core/common/UsagePricing'
import { detectUsageProvider } from '@core/common/UsageProtocol'
import type {
  UsageDayBuckets,
  UsageDayProviderBuckets,
  UsageModelPeriods
} from '@core/common/UsageTypes'
import { useStore } from '../store'
import {
  IconArrowLeft,
  IconCalendar,
  IconChart,
  IconClock,
  IconClose,
  IconDownload,
  IconInfo,
  IconRefresh,
  IconTrendUp,
  IconWarning
} from '../icons'

type ProviderFilter = 'all' | UsageProvider
type UsageMetric = UsageMetricKey

const METRIC_LABEL: Record<UsageMetric, string> = {
  cost: '费用',
  tokens: 'Tokens',
  requests: '请求数'
}

const PROVIDER_FILTERS: Array<{ value: ProviderFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'opencode-go', label: 'OpenCode Go' }
]

const WEEKDAY_NAMES: string[] = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

const BILLING_SOURCE_LABEL: Record<string, string> = {
  go: 'Go 套餐',
  'go-plus': 'Go Plus',
  balance: '余额',
  byok: '自有 Key',
  free: '免费'
}

function billingSourceLabel(source: string): string {
  return BILLING_SOURCE_LABEL[source] ?? source
}

function pad2(value: number): string {
  return value < 10 ? '0' + value.toString() : value.toString()
}

function addDays(key: string, delta: number): string {
  const ms: number =
    Date.UTC(
      Number(key.substring(0, 4)),
      Number(key.substring(5, 7)) - 1,
      Number(key.substring(8, 10))
    ) + delta * 86400000
  const date: Date = new Date(ms)
  return (
    date.getUTCFullYear().toString() +
    '-' +
    pad2(date.getUTCMonth() + 1) +
    '-' +
    pad2(date.getUTCDate())
  )
}

function weekdayOf(key: string): string {
  const ms: number = Date.UTC(
    Number(key.substring(0, 4)),
    Number(key.substring(5, 7)) - 1,
    Number(key.substring(8, 10))
  )
  return WEEKDAY_NAMES[new Date(ms).getUTCDay()] ?? ''
}

function totalTokens(metrics: UsageMetrics): number {
  return metrics.inputHit + metrics.inputMiss + metrics.cacheWrite + metrics.output
}

function formatMetricValue(value: number, metric: UsageMetric): string {
  if (metric === 'tokens') {
    return formatCompactTokens(value) + ' tokens'
  }
  if (metric === 'requests') {
    return formatInteger(value) + ' 次请求'
  }
  return formatCnyAmount(usdToCny(value))
}

function bucketsFromDays(days: UsageDayDto[]): UsageDayBuckets {
  const out: UsageDayBuckets = {}
  for (const day of days) {
    const byProvider: UsageDayProviderBuckets = {}
    for (const model of day.models) {
      if (byProvider[model.provider] === undefined) {
        byProvider[model.provider] = {}
      }
      byProvider[model.provider][model.model] = {
        peak: model.peak,
        offpeak: model.offpeak
      }
    }
    out[day.date] = byProvider
  }
  return out
}

function sumPeriod(
  day: UsageDayProviderBuckets | undefined,
  filter: ProviderFilter,
  period: 'peak' | 'offpeak'
): UsageMetrics {
  const out: UsageMetrics = emptyUsageMetrics()
  if (day === undefined) {
    return out
  }
  for (const provider of Object.keys(day)) {
    if (filter !== 'all' && provider !== filter) {
      continue
    }
    const models: Record<string, UsageModelPeriods> = day[provider]
    for (const model of Object.keys(models)) {
      const bucket: UsageMetrics | undefined = models[model][period]
      if (bucket !== undefined) {
        addUsageMetrics(out, bucket)
      }
    }
  }
  return out
}

function configsOf(settings: AppSettingsDto | null): ApiConfigDto[] {
  if (settings === null) {
    return []
  }
  const out: ApiConfigDto[] = settings.apiProfiles.map((profile) => profile.config)
  if (settings.apiConfig !== null) {
    out.push(settings.apiConfig)
  }
  return out
}

function providerConfigured(settings: AppSettingsDto | null, provider: UsageProvider): boolean {
  return configsOf(settings).some(
    (config) =>
      detectUsageProvider(config.baseUrl) === provider && config.apiKey.trim() !== ''
  )
}

function monthDays(today: string): number {
  const year: number = Number(today.substring(0, 4))
  const month: number = Number(today.substring(5, 7))
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function SummaryCard({
  label,
  value,
  unit,
  sub,
  icon,
  accent
}: {
  label: string
  value: string
  unit: string
  sub: string
  icon: ReactNode
  accent?: boolean
}) {
  return (
    <div className="usage-summary-card" data-accent={accent === true}>
      <div className="usage-summary-card__label">
        <span className="usage-summary-card__icon">{icon}</span>
        {label}
      </div>
      <div className="usage-summary-card__value">
        <strong>{value}</strong>
        {unit !== '' ? <em>{unit}</em> : null}
      </div>
      <span>{sub}</span>
    </div>
  )
}

function summaryView(metrics: UsageMetrics, metric: UsageMetric): { value: string; unit: string; sub: string } {
  const cny: string = formatCnyAmount(usdToCny(metrics.equivalentUsd))
  const tokens: string = formatCompactTokens(totalTokens(metrics))
  const requests: string = formatInteger(metrics.requests)
  if (metric === 'tokens') {
    return { value: tokens, unit: 'tokens', sub: `${cny} · ${requests} 次请求` }
  }
  if (metric === 'requests') {
    return { value: requests, unit: '次', sub: `${cny} · ${tokens} tokens` }
  }
  return { value: cny, unit: '', sub: `${tokens} tokens · ${requests} 次请求` }
}

function MetricSwitch({
  metric,
  onChange
}: {
  metric: UsageMetric
  onChange: (metric: UsageMetric) => void
}) {
  return (
    <div className="usage-segmented" role="tablist" aria-label="指标">
      {(Object.keys(METRIC_LABEL) as UsageMetric[]).map((key) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={metric === key}
          data-active={metric === key}
          title={key === 'cost' ? '费用按固定汇率折算为人民币；OpenCode 使用等价按量成本' : undefined}
          onClick={() => onChange(key)}
        >
          {METRIC_LABEL[key]}
        </button>
      ))}
    </div>
  )
}

function ProviderSwitch({
  provider,
  onChange
}: {
  provider: ProviderFilter
  onChange: (provider: ProviderFilter) => void
}) {
  return (
    <div className="usage-segmented" role="tablist" aria-label="服务商">
      {PROVIDER_FILTERS.map((item) => (
        <button
          key={item.value}
          type="button"
          role="tab"
          aria-selected={provider === item.value}
          data-active={provider === item.value}
          onClick={() => onChange(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

function Heatmap({
  data,
  metric,
  selectedDate,
  onSelect,
  scrollRef
}: {
  data: HeatmapData
  metric: UsageMetric
  selectedDate: string
  onSelect: (date: string) => void
  scrollRef: RefObject<HTMLDivElement | null>
}) {
  const width: number = data.weeks.length * 15
  return (
    <div className="usage-heat">
      <div className="usage-heat__labels" aria-hidden="true">
        <div className="usage-heat__months-spacer" />
        {['周一', '', '周三', '', '周五', '', '周日'].map((label, index) => (
          <div className="usage-heat__weekday" key={index}>
            {label}
          </div>
        ))}
      </div>
      <div className="usage-heat__scroll" ref={scrollRef}>
        <div className="usage-heat__inner" style={{ width }}>
          <div className="usage-heat__months">
            {data.monthLabels.map((item) => (
              <span key={item.weekIndex + item.label} style={{ left: item.weekIndex * 15 }}>
                {item.label}
              </span>
            ))}
          </div>
          <div className="usage-heat__grid" role="grid" aria-label="每日用量热力图">
            {data.weeks.map((week) => (
              <div className="usage-heat__week" role="row" key={week.days[0].date}>
                {week.days.map((cell) => {
                  const label: string = cell.future
                    ? `${cell.date} · 未来`
                    : `${cell.date} · ${METRIC_LABEL[metric]} ${formatMetricValue(cell.value, metric)} · ${cell.requests} 次请求`
                  return (
                    <button
                      key={cell.date}
                      type="button"
                      role="gridcell"
                      className="usage-heat__cell"
                      data-level={cell.level}
                      data-future={cell.future}
                      data-selected={cell.date === selectedDate}
                      disabled={cell.future}
                      title={label}
                      aria-label={label}
                      onClick={() => onSelect(cell.date)}
                    />
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function HeatLegend() {
  return (
    <div className="usage-heat__legend" aria-label="热力图图例">
      <span>少</span>
      {[0, 1, 2, 3, 4].map((level) => (
        <i key={level} data-level={level} />
      ))}
      <span>多</span>
    </div>
  )
}

function TokenRow({
  label,
  value,
  total
}: {
  label: string
  value: number
  total: number
}) {
  const percent: number = total > 0 ? Math.min(100, (value / total) * 100) : 0
  return (
    <div className="usage-token-row">
      <span>{label}</span>
      <div className="usage-token-row__bar">
        <i style={{ width: percent + '%' }} />
      </div>
      <strong>{formatCompactTokens(value)}</strong>
    </div>
  )
}

function DayDetail({
  date,
  total,
  peak,
  offpeak,
  shares,
  metric,
  providerFilter,
  onClose
}: {
  date: string
  total: UsageMetrics
  peak: UsageMetrics
  offpeak: UsageMetrics
  shares: UsageModelShare[]
  metric: UsageMetric
  providerFilter: ProviderFilter
  onClose: () => void
}) {
  const totalValue: number = shares.reduce((sum, item) => sum + item.value, 0)
  const tokenTotal: number = totalTokens(total)
  return (
    <section className="usage-detail" aria-label={`${date} 明细`}>
      <header className="usage-detail__head">
        <div>
          <div className="usage-detail__date">
            {date}
            <span>{weekdayOf(date)}</span>
          </div>
          <div className="usage-detail__hint">
            {total.requests === 0
              ? '当天没有 API 调用'
              : `${formatInteger(total.requests)} 次请求 · ${formatCompactTokens(tokenTotal)} tokens`}
          </div>
        </div>
        <div className="usage-detail__head-right">
          {total.allowanceUsd > 0 ? (
            <span className="usage-badge">OpenCode 额度 {formatUsdAmount(total.allowanceUsd)}</span>
          ) : null}
          <button type="button" className="icon-btn" title="收起明细" onClick={onClose}>
            <IconClose size={17} />
          </button>
        </div>
      </header>

      <div className="usage-detail__stats">
        <div>
          <span>高峰费用</span>
          <strong>{formatCnyAmount(usdToCny(metricCostValue(peak)))}</strong>
          <small>{formatInteger(peak.requests)} 次请求</small>
        </div>
        <div>
          <span>空闲费用</span>
          <strong>{formatCnyAmount(usdToCny(metricCostValue(offpeak)))}</strong>
          <small>{formatInteger(offpeak.requests)} 次请求</small>
        </div>
        <div>
          <span>输入命中</span>
          <strong>{formatCompactTokens(total.inputHit)}</strong>
          <small>{total.inputHit + total.inputMiss > 0 ? Math.round((total.inputHit / (total.inputHit + total.inputMiss + total.cacheWrite)) * 100) + '% 命中率' : '—'}</small>
        </div>
        <div>
          <span>输出</span>
          <strong>{formatCompactTokens(total.output)}</strong>
          <small>{formatCompactTokens(total.inputMiss)} 未命中输入</small>
        </div>
      </div>

      <div className="usage-detail__columns">
        <div className="usage-detail__panel">
          <h3>Token 构成</h3>
          <TokenRow label="输入命中" value={total.inputHit} total={tokenTotal} />
          <TokenRow label="输入未命中" value={total.inputMiss} total={tokenTotal} />
          {total.cacheWrite > 0 ? (
            <TokenRow label="缓存写入" value={total.cacheWrite} total={tokenTotal} />
          ) : null}
          <TokenRow label="输出" value={total.output} total={tokenTotal} />
        </div>
        <div className="usage-detail__panel">
          <h3>模型占比</h3>
          {shares.length === 0 ? (
            <div className="usage-empty-inline">没有可展示的模型明细</div>
          ) : (
            shares.slice(0, 7).map((share) => {
              const percent: number = totalValue > 0 ? (share.value / totalValue) * 100 : 0
              return (
                <div className="usage-share-row" key={share.provider + ':' + share.model}>
                  <div className="usage-share-row__top">
                    <span title={share.model}>
                      {providerFilter === 'all' ? providerLabel(share.provider) + ' · ' : ''}
                      {share.model}
                    </span>
                    <strong>{formatMetricValue(share.value, metric)}</strong>
                  </div>
                  <div className="usage-share-row__bar">
                    <i style={{ width: Math.min(100, percent) + '%' }} />
                  </div>
                  <small>
                    {formatInteger(share.requests)} 次请求 · {formatCompactTokens(share.tokens)} tokens
                  </small>
                </div>
              )
            })
          )}
        </div>
      </div>
    </section>
  )
}

function WindowBar({ window }: { window: UsageWindow }) {
  const percent: number =
    window.limitUsd > 0 ? Math.min(100, (window.usedUsd / window.limitUsd) * 100) : 0
  return (
    <div className="usage-window-row">
      <div className="usage-window-row__top">
        <span>{window.label}</span>
        <span>
          {formatUsdAmount(window.usedUsd)}
          {window.limitUsd > 0 ? ` / ${formatUsdAmount(window.limitUsd)}` : ''}
        </span>
      </div>
      <div className="usage-window-row__bar">
        <i style={{ width: percent + '%' }} data-warn={percent >= 80} />
      </div>
    </div>
  )
}

export function UsagePage() {
  const openUsage = useStore((s) => s.openUsage)
  const settings = useStore((s) => s.settings)
  const reloadSettings = useStore((s) => s.reloadSettings)
  const pushNotice = useStore((s) => s.pushNotice)

  const [overview, setOverview] = useState<UsageOverviewDto | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>('all')
  const [metric, setMetric] = useState<UsageMetric>('cost')
  const [selectedDate, setSelectedDate] = useState('')
  const [budgetInput, setBudgetInput] = useState('')
  const [balanceRefreshing, setBalanceRefreshing] = useState(false)
  const [balance, setBalance] = useState<UsageOverviewDto['balance'] | null>(null)
  const heatScrollRef = useRef<HTMLDivElement | null>(null)

  const today: string = overview?.today ?? ''
  const dayBuckets = useMemo(
    () => (overview === null ? {} : bucketsFromDays(overview.days)),
    [overview]
  )
  const monthStart: string = today !== '' ? today.substring(0, 7) + '-01' : ''
  const weekStart: string = today !== '' ? addDays(today, -6) : ''

  const todayMetrics = useMemo(
    () => (today === '' ? emptyUsageMetrics() : aggregateUsageRange(dayBuckets, providerFilter, today, today)),
    [dayBuckets, providerFilter, today]
  )
  const weekMetrics = useMemo(
    () => (weekStart === '' ? emptyUsageMetrics() : aggregateUsageRange(dayBuckets, providerFilter, weekStart, today)),
    [dayBuckets, providerFilter, weekStart, today]
  )
  const monthMetrics = useMemo(
    () => (monthStart === '' ? emptyUsageMetrics() : aggregateUsageRange(dayBuckets, providerFilter, monthStart, today)),
    [dayBuckets, providerFilter, monthStart, today]
  )
  const allMonthMetrics = useMemo(
    () => (monthStart === '' ? emptyUsageMetrics() : aggregateUsageRange(dayBuckets, 'all', monthStart, today)),
    [dayBuckets, monthStart, today]
  )

  const forecast = useMemo(() => {
    if (today === '') {
      return { costUsd: 0, tokens: 0, requests: 0 }
    }
    const daysSoFar: number = Math.max(1, Number(today.substring(8, 10)))
    const factor: number = monthDays(today) / daysSoFar
    return {
      costUsd: monthMetrics.equivalentUsd * factor,
      tokens: totalTokens(monthMetrics) * factor,
      requests: monthMetrics.requests * factor
    }
  }, [monthMetrics, today])

  const forecastView = useMemo(() => {
    const cny: string = formatCnyAmount(usdToCny(forecast.costUsd))
    const tokens: string = formatCompactTokens(forecast.tokens)
    const requests: string = formatInteger(forecast.requests)
    if (metric === 'tokens') {
      return { value: tokens, unit: 'tokens', sub: `${cny} · ${requests} 次请求` }
    }
    if (metric === 'requests') {
      return { value: requests, unit: '次', sub: `${cny} · ${tokens} tokens` }
    }
    return { value: cny, unit: '', sub: `预计 ${tokens} tokens · ${requests} 次请求` }
  }, [forecast, metric])

  const todayView = summaryView(todayMetrics, metric)
  const weekView = summaryView(weekMetrics, metric)
  const monthView = summaryView(monthMetrics, metric)

  const heatmap = useMemo(
    () =>
      today === '' ? null : buildUsageHeatmap(dayBuckets, providerFilter, metric, today),
    [dayBuckets, providerFilter, metric, today]
  )

  const selectedBucket: UsageDayProviderBuckets | undefined =
    selectedDate !== '' ? dayBuckets[selectedDate] : undefined
  const selectedMetrics = useMemo(
    () =>
      selectedBucket === undefined
        ? emptyUsageMetrics()
        : aggregateUsageDay(selectedBucket, providerFilter),
    [selectedBucket, providerFilter]
  )
  const selectedPeak = useMemo(
    () => sumPeriod(selectedBucket, providerFilter, 'peak'),
    [selectedBucket, providerFilter]
  )
  const selectedOffpeak = useMemo(
    () => sumPeriod(selectedBucket, providerFilter, 'offpeak'),
    [selectedBucket, providerFilter]
  )
  const selectedShares = useMemo(
    () =>
      selectedBucket === undefined
        ? []
        : buildModelShares(selectedBucket, providerFilter, metric),
    [selectedBucket, providerFilter, metric]
  )

  const deepseekMonth = useMemo(
    () => (monthStart === '' ? emptyUsageMetrics() : aggregateUsageRange(dayBuckets, 'deepseek', monthStart, today)),
    [dayBuckets, monthStart, today]
  )
  const opencodeMonth = useMemo(
    () => (monthStart === '' ? emptyUsageMetrics() : aggregateUsageRange(dayBuckets, 'opencode-go', monthStart, today)),
    [dayBuckets, monthStart, today]
  )

  const deepseekEnabled: boolean = providerConfigured(settings, 'deepseek')
  const opencodeEnabled: boolean = providerConfigured(settings, 'opencode-go')
  const currentBalance = balance ?? overview?.balance ?? null
  const showBalance: boolean =
    deepseekEnabled && currentBalance !== null && currentBalance.fetchedAt > 0
  const budget: number = Number(budgetInput)
  const budgetValid: boolean = Number.isFinite(budget) && budget > 0
  const spentCny: number = usdToCny(allMonthMetrics.equivalentUsd)
  const budgetRatio: number = budgetValid ? spentCny / budget : 0

  useEffect(() => {
    let cancelled: boolean = false
    setLoading(true)
    window.guncat.usage
      .overview()
      .then((snapshot: UsageOverviewDto) => {
        if (cancelled) {
          return
        }
        setOverview(snapshot)
        setBalance(snapshot.balance)
        setSelectedDate((previous) => (previous !== '' ? previous : snapshot.today))
        setError('')
        if (snapshot.balance.configured) {
          void refreshBalance(false, true)
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(String(e instanceof Error ? e.message : e))
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
    // 只在页面打开时读一次；刷新由顶部按钮/余额按钮手动触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (settings === null) {
      void reloadSettings()
    }
  }, [settings, reloadSettings])

  useEffect(() => {
    setBudgetInput(settings?.prefs?.[Constants.LS_KEY_USAGE_BUDGET_CNY] ?? '')
  }, [settings])

  useEffect(() => {
    // 窄屏默认滚到最近一周；窗口从桌面宽度缩到手机宽度时也要重新对齐，
    // 否则会停在最早的月份（用户看到的是一片没有数据的空白）。
    const apply = (): void => {
      const element = heatScrollRef.current
      if (element !== null) {
        element.scrollLeft = element.scrollWidth
      }
    }
    const frame = window.requestAnimationFrame(apply)
    window.addEventListener('resize', apply)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', apply)
    }
  }, [overview, providerFilter, metric, loading])

  async function reloadOverview(): Promise<void> {
    setLoading(true)
    try {
      const snapshot: UsageOverviewDto = await window.guncat.usage.overview()
      setOverview(snapshot)
      setBalance(snapshot.balance)
      setSelectedDate((previous) => (previous !== '' ? previous : snapshot.today))
      setError('')
      if (snapshot.balance.configured) {
        // 仍受主进程 10 分钟节流：用户点刷新不会变成连续打余额接口
        void refreshBalance(false, true)
      }
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setLoading(false)
    }
  }

  async function refreshBalance(force: boolean, silent: boolean): Promise<void> {
    if (balanceRefreshing) {
      return
    }
    setBalanceRefreshing(true)
    try {
      const snapshot = await window.guncat.usage.refreshBalance(force)
      setBalance(snapshot)
      setOverview((previous) =>
        previous === null ? previous : { ...previous, balance: snapshot }
      )
      if (!silent && snapshot.error !== '') {
        pushNotice('warn', '余额刷新失败：' + snapshot.error)
      }
    } catch (e) {
      if (!silent) {
        pushNotice('error', '余额刷新失败：' + String(e instanceof Error ? e.message : e))
      }
    } finally {
      setBalanceRefreshing(false)
    }
  }

  async function saveBudget(): Promise<void> {
    const raw: string = budgetInput.trim()
    const value: number = raw === '' ? 0 : Number(raw)
    if (!Number.isFinite(value) || value < 0) {
      setBudgetInput(settings?.prefs?.[Constants.LS_KEY_USAGE_BUDGET_CNY] ?? '')
      return
    }
    const normalized: string = value > 0 ? String(Math.round(value * 100) / 100) : ''
    setBudgetInput(normalized)
    try {
      await window.guncat.settings.saveString(Constants.LS_KEY_USAGE_BUDGET_CNY, normalized)
      await reloadSettings()
    } catch (e) {
      pushNotice('error', '预算保存失败：' + String(e instanceof Error ? e.message : e))
    }
  }

  async function exportCsv(): Promise<void> {
    try {
      const result = await window.guncat.usage.exportCsv(providerFilter)
      if (result.status === 'saved') {
        pushNotice('info', '已导出 CSV：' + (result.path ?? '文件已保存'))
      } else if (result.status === 'error') {
        pushNotice('error', '导出失败：' + (result.message ?? '未知原因'))
      }
    } catch (e) {
      pushNotice('error', '导出失败：' + String(e instanceof Error ? e.message : e))
    }
  }

  const opencodeWindows: UsageWindow[] = overview?.opencode.windows ?? []
  const monthWindow: UsageWindow | undefined = opencodeWindows.find((item) => item.id === 'month')
  const opencodeLimit: number =
    monthWindow !== undefined && monthWindow.limitUsd > 0
      ? monthWindow.limitUsd
      : OPENCODE_GO_MONTHLY_USD
  const opencodePercent: number =
    opencodeLimit > 0 ? Math.min(100, (opencodeMonth.allowanceUsd / opencodeLimit) * 100) : 0

  return (
    <div className="usage-page">
      <header className="usage-page__head">
        <div className="usage-page__head-inner">
          <button
            type="button"
            className="icon-btn usage-page__back"
            title="返回"
            aria-label="返回"
            onClick={() => openUsage(false)}
          >
            <IconArrowLeft size={21} />
          </button>
          <div className="usage-page__heading">
            <strong>用量与成本</strong>
            <span>本地统计 · 不扫描会话历史 · 无后台轮询</span>
          </div>
        </div>
      </header>

      <div className="usage-page__body">
        {error !== '' ? (
          <div className="usage-error">
            <IconWarning size={18} />
            <span>读取用量数据失败：{error}</span>
            <button type="button" className="btn btn--ghost" onClick={() => void reloadOverview()}>
              重试
            </button>
          </div>
        ) : null}

        <div className="usage-toolbar">
          <div className="usage-toolbar__filters">
            <div className="usage-toolbar__group">
              <span className="usage-toolbar__label">服务商</span>
              <ProviderSwitch provider={providerFilter} onChange={setProviderFilter} />
            </div>
            <div className="usage-toolbar__group">
              <span className="usage-toolbar__label">主指标</span>
              <MetricSwitch metric={metric} onChange={setMetric} />
            </div>
          </div>
          <div className="usage-toolbar__actions">
            <button
              type="button"
              className="usage-action-link"
              title="重新读取本地用量账本"
              onClick={() => void reloadOverview()}
              disabled={loading}
            >
              <IconRefresh size={14} />
              刷新
            </button>
            <button
              type="button"
              className="usage-action-link"
              title="按日明细导出 CSV"
              onClick={() => void exportCsv()}
            >
              <IconDownload size={14} />
              导出 CSV
            </button>
          </div>
        </div>

        <section className="usage-summary" aria-label="用量汇总">
          <SummaryCard
            label="今日"
            value={todayView.value}
            unit={todayView.unit}
            sub={todayView.sub}
            icon={<IconCalendar size={16} />}
            accent
          />
          <SummaryCard
            label="近 7 天"
            value={weekView.value}
            unit={weekView.unit}
            sub={weekView.sub}
            icon={<IconClock size={16} />}
          />
          <SummaryCard
            label="本月"
            value={monthView.value}
            unit={monthView.unit}
            sub={monthView.sub}
            icon={<IconChart size={16} />}
          />
          <SummaryCard
            label="本月预计"
            value={forecastView.value}
            unit={forecastView.unit}
            sub={forecastView.sub}
            icon={<IconTrendUp size={16} />}
          />
        </section>

        <section className="usage-card usage-card--heat">
          <header className="usage-card__head usage-card__head--wrap">
            <div>
              <h2>每日用量</h2>
              <p>
                {providerFilter === 'all'
                  ? '全部服务商'
                  : providerLabel(providerFilter)}
                {' · '}
                最近 53 周
                {heatmap !== null ? ` · ${heatmap.start} 至 ${heatmap.end}` : ''}
                {' · '}
                按{METRIC_LABEL[metric]}着色
              </p>
            </div>
          </header>
          {heatmap === null || loading ? (
            <div className="usage-heat-skeleton" aria-label="正在加载热力图" />
          ) : (
            <>
              <Heatmap
                data={heatmap}
                metric={metric}
                selectedDate={selectedDate}
                onSelect={setSelectedDate}
                scrollRef={heatScrollRef}
              />
              <div className="usage-heat__foot">
                <span>
                  本区间合计 {formatMetricValue(heatmap.totalValue, metric)}
                </span>
                <HeatLegend />
              </div>
            </>
          )}
        </section>

        {selectedDate !== '' ? (
          <DayDetail
            date={selectedDate}
            total={selectedMetrics}
            peak={selectedPeak}
            offpeak={selectedOffpeak}
            shares={selectedShares}
            metric={metric}
            providerFilter={providerFilter}
            onClose={() => setSelectedDate('')}
          />
        ) : (
          <section className="usage-card usage-detail-empty">
            <IconInfo size={17} />
            <span>点击热力图上的任意一天，查看当天的高峰/空闲、token 构成与模型占比。</span>
          </section>
        )}

        <section className="usage-providers" aria-label="服务商">
          <article className="usage-provider" data-configured={deepseekEnabled}>
            <header className="usage-provider__head">
              <div>
                <h3>DeepSeek</h3>
                <p>官方价目 · 峰谷计价 · 按请求开始时间归属</p>
              </div>
              <span className="usage-status" data-enabled={deepseekEnabled}>
                {deepseekEnabled ? '已启用' : '未启用'}
              </span>
            </header>
            <div className="usage-provider__main">
              <div>
                <span>本月实付</span>
                <strong>{formatCnyAmount(usdToCny(deepseekMonth.costUsd))}</strong>
                <small>
                  {formatCompactTokens(totalTokens(deepseekMonth))} tokens ·{' '}
                  {formatInteger(deepseekMonth.requests)} 次请求
                </small>
              </div>
              <div className="usage-provider__side">
                <span>余额</span>
                <strong>
                  {showBalance && currentBalance !== null && currentBalance.infos.length > 0
                    ? currentBalance.infos
                        .map((info) =>
                          info.currency === 'USD'
                            ? formatUsdAmount(info.totalBalance)
                            : formatCnyAmount(info.totalBalance)
                        )
                        .join(' · ')
                    : '—'}
                </strong>
                <button
                  type="button"
                  className="usage-link-btn"
                  disabled={!deepseekEnabled || balanceRefreshing}
                  title="手动刷新 DeepSeek 余额（只作对账，不参与热力图）"
                  onClick={() => void refreshBalance(true, false)}
                >
                  <IconRefresh size={13} />
                  {balanceRefreshing ? '刷新中' : '刷新余额'}
                </button>
                <small>
                  {showBalance && currentBalance !== null
                    ? '更新于 ' + formatDateTime(currentBalance.fetchedAt)
                    : deepseekEnabled
                      ? '尚未刷新'
                      : '填写 API Key 后可用'}
                </small>
              </div>
            </div>
            {deepseekEnabled && currentBalance !== null && currentBalance.error !== '' ? (
              <div className="usage-provider__warn">
                <IconWarning size={14} />
                余额刷新失败：{currentBalance.error}
              </div>
            ) : null}
            <p className="usage-provider__note">余额仅作对账，不参与热力图与每日统计。</p>
          </article>

          <article className="usage-provider" data-configured={opencodeEnabled}>
            <header className="usage-provider__head">
              <div>
                <h3>OpenCode Go</h3>
                <p>套餐额度与等价按量成本均以网关返回为准</p>
              </div>
              <span className="usage-status" data-enabled={opencodeEnabled}>
                {opencodeEnabled ? '已启用' : '未启用'}
              </span>
            </header>
            <div className="usage-provider__main">
              <div>
                <span>本月额度消耗</span>
                <strong>{formatUsdAmount(opencodeMonth.allowanceUsd)}</strong>
                <small>≈ {formatCnyAmount(usdToCny(opencodeMonth.allowanceUsd))}</small>
              </div>
              <div className="usage-provider__side">
                <span>等价成本</span>
                <strong>{formatCnyAmount(usdToCny(opencodeMonth.equivalentUsd))}</strong>
                <small>
                  {formatCompactTokens(totalTokens(opencodeMonth))} tokens ·{' '}
                  {formatInteger(opencodeMonth.requests)} 次请求
                </small>
              </div>
            </div>
            {Object.keys(opencodeMonth.billingSources).length > 0 ? (
              <div className="usage-source-chips" aria-label="OpenCode 计费来源">
                {Object.keys(opencodeMonth.billingSources)
                  .sort()
                  .map((source) => (
                    <span key={source}>
                      {billingSourceLabel(source)}
                      <b>{formatInteger(opencodeMonth.billingSources[source])}</b>
                    </span>
                  ))}
              </div>
            ) : null}
            <div className="usage-window">
              <div className="usage-window-row">
                <div className="usage-window-row__top">
                  <span>本月额度（参考）</span>
                  <span>
                    {formatUsdAmount(opencodeMonth.allowanceUsd)} / {formatUsdAmount(opencodeLimit)}
                  </span>
                </div>
                <div className="usage-window-row__bar">
                  <i style={{ width: opencodePercent + '%' }} data-warn={opencodePercent >= 80} />
                </div>
              </div>
              {opencodeWindows.filter((item) => item.id !== 'month').map((item) => (
                <WindowBar key={item.id} window={item} />
              ))}
              {opencodeWindows.length === 0 ? (
                <p className="usage-provider__note">
                  5 小时 / 周窗口：当前网关响应未提供窗口数据，仅显示本月额度消耗。套餐上限以实际订阅为准。
                </p>
              ) : null}
            </div>
            <p className="usage-provider__note">
              Go 套餐内 cost 可能为 0；热力图使用 list_cost 作为等价按量成本，方便与 DeepSeek 比较。
            </p>
          </article>
        </section>

        <section className="usage-card usage-budget">
          <header className="usage-card__head usage-card__head--wrap">
            <div>
              <h2>本月预算</h2>
              <p>按全部服务商的等价成本计算，达到预算时只做非阻塞提示。</p>
            </div>
            <div className="usage-budget__input">
              <span>¥</span>
              <input
                type="number"
                min="0"
                step="1"
                inputMode="decimal"
                placeholder="例如 100"
                value={budgetInput}
                onChange={(e) => setBudgetInput(e.target.value)}
                onBlur={() => void saveBudget()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.currentTarget.blur()
                  }
                }}
                aria-label="本月预算（人民币）"
              />
            </div>
          </header>
          {budgetValid ? (
            <>
              <div className="usage-budget__bar" data-over={budgetRatio >= 1}>
                <i style={{ width: Math.min(100, budgetRatio * 100) + '%' }} />
              </div>
              <div className="usage-budget__meta">
                <span>
                  已用 {formatCnyAmount(spentCny)} / {formatCnyAmount(budget)}
                </span>
                <span data-over={budgetRatio >= 1}>
                  {budgetRatio >= 1
                    ? `已超出 ${formatCnyAmount(spentCny - budget)}`
                    : `剩余 ${formatCnyAmount(Math.max(0, budget - spentCny))}`}
                </span>
              </div>
              {budgetRatio >= 0.8 ? (
                <div className="usage-budget__alert" data-over={budgetRatio >= 1}>
                  <IconWarning size={14} />
                  {budgetRatio >= 1
                    ? '本月用量已超过预算，建议检查长上下文任务或切换更便宜的模型。'
                    : '本月用量已接近预算，后续调用请留意。'}
                </div>
              ) : null}
            </>
          ) : (
            <p className="usage-budget__hint">
              设置预算后会显示进度条；预算只保存在本机，不会上传。
            </p>
          )}
        </section>

        <footer className="usage-footnote">
          <p>
            价目表 {overview?.pricing.version ?? '—'}（更新于 {overview?.pricing.updatedAt ?? '—'}）；
            汇率 1 USD = ¥{overview?.pricing.exchangeRate ?? 7.2}，仅用于统一展示。
          </p>
          <p>
            高峰：周一至周五 09:00–12:00、14:00–18:00（北京时间）；周末、法定节假日与其余时段为空闲，空闲价为高峰价的一半。
          </p>
          <p>{overview?.pricing.holidayCoverage.note ?? ''}</p>
          <p>
            本地累计（不受 400 天展示窗口限制）：
            {formatCompactTokens(totalTokens(overview?.totals ?? emptyUsageMetrics()))} tokens ·{' '}
            {formatInteger(overview?.totals.requests ?? 0)} 次请求 ·{' '}
            {formatCnyAmount(usdToCny(overview?.totals.equivalentUsd ?? 0))}。
          </p>
          <p>
            缺失 usage 的请求：{formatInteger(overview?.totals.missingUsage ?? 0)} 个；这些请求只计入请求数，token 与费用按 0 处理。
            估算计价请求：{formatInteger(overview?.totals.estimatedRequests ?? 0)} 个。
          </p>
          <p>
            统计覆盖主对话、Agent Loop、子代理、会话标题、上下文压缩、UI 补救、多模态解析与表格识别。
            本地文件：应用私有目录 / {overview?.dataFile ?? 'usage/usage-ledger.json'}，保留最近约 {overview?.keepDays ?? 400} 天。
          </p>
          <p>
            其它服务商未收录价目，费用显示为 0；请求数与 tokens 仍会统计。OpenCode 的 5 小时/周窗口只在网关返回时显示。
          </p>
        </footer>
      </div>
    </div>
  )
}
