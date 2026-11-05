// 用量日聚合、裁剪、热力图数据与 CSV 导出（纯逻辑，可单测）。
//
// 这里只接触「已经归一化 + 计价」的 UsageRecord / 日桶，不做任何网络或文件 IO。
// 页面打开时才由渲染层调用聚合函数，不在每次聊天渲染时扫描历史。

import { HOLIDAY_COVERAGE } from './ChineseHolidays'
import {
  USAGE_PRICE_SOURCE,
  USAGE_PRICE_TABLE_UPDATED_AT,
  USAGE_PRICE_TABLE_VERSION,
  USD_CNY_RATE,
  csvNumber,
  formatInteger,
  providerLabel,
  usagePeriodLabel
} from './UsagePricing'
import { metricsTotalTokens } from './UsageProtocol'
import type {
  UsageDayBuckets,
  UsageDayDto,
  UsageDayModelDto,
  UsageDayProviderBuckets,
  UsageLedgerFile,
  UsageMetricKey,
  UsageMetrics,
  UsageModelPeriods,
  UsageOverviewDto,
  UsagePeriod,
  UsageProvider,
  UsageRecord
} from './UsageTypes'

export const USAGE_LEDGER_VERSION: number = 1
export const USAGE_KEEP_DAYS: number = 400
export const USAGE_HEATMAP_WEEKS: number = 53

/** 空白账本：文件结构、版本号与元信息只在这里定义一次。 */
export function createEmptyUsageLedger(): UsageLedgerFile {
  return {
    version: USAGE_LEDGER_VERSION,
    updatedAt: 0,
    priceTableVersion: USAGE_PRICE_TABLE_VERSION,
    exchangeRate: USD_CNY_RATE,
    days: {},
    totals: emptyUsageMetrics(),
    providerTotals: {},
    meta: {
      opencode: { lastSeenAt: 0, billingSources: {}, windows: [] },
      balance: {
        configured: false,
        available: false,
        infos: [],
        fetchedAt: 0,
        error: ''
      },
      lastBalanceAttemptAt: 0
    }
  }
}

export function emptyUsageMetrics(): UsageMetrics {
  return {
    requests: 0,
    inputHit: 0,
    inputMiss: 0,
    cacheWrite: 0,
    output: 0,
    searchCount: 0,
    allowanceUsd: 0,
    costUsd: 0,
    listCostUsd: 0,
    equivalentUsd: 0,
    missingUsage: 0,
    estimatedRequests: 0,
    billingSources: {}
  }
}

function roundCost(value: number): number {
  return Math.round((Number.isFinite(value) ? value : 0) * 1000000) / 1000000
}

/** 指标累加（原地修改 target；source 不会被改） */
export function addUsageMetrics(target: UsageMetrics, source: UsageMetrics): void {
  target.requests += source.requests
  target.inputHit += source.inputHit
  target.inputMiss += source.inputMiss
  target.cacheWrite += source.cacheWrite
  target.output += source.output
  target.searchCount += source.searchCount
  target.allowanceUsd = roundCost(target.allowanceUsd + source.allowanceUsd)
  target.costUsd = roundCost(target.costUsd + source.costUsd)
  target.listCostUsd = roundCost(target.listCostUsd + source.listCostUsd)
  target.equivalentUsd = roundCost(target.equivalentUsd + source.equivalentUsd)
  target.missingUsage += source.missingUsage
  target.estimatedRequests += source.estimatedRequests
  for (const key of Object.keys(source.billingSources ?? {})) {
    target.billingSources[key] = (target.billingSources[key] ?? 0) + source.billingSources[key]
  }
}

export function cloneUsageMetrics(source: UsageMetrics | undefined): UsageMetrics {
  const out: UsageMetrics = emptyUsageMetrics()
  if (source !== undefined && source !== null) {
    addUsageMetrics(out, normalizeMetrics(source))
  }
  return out
}

/** 兼容旧版本/缺字段的日桶 */
function normalizeMetrics(source: UsageMetrics): UsageMetrics {
  const out: UsageMetrics = emptyUsageMetrics()
  out.requests = numberOrZero(source.requests)
  out.inputHit = numberOrZero(source.inputHit)
  out.inputMiss = numberOrZero(source.inputMiss)
  out.cacheWrite = numberOrZero(source.cacheWrite)
  out.output = numberOrZero(source.output)
  out.searchCount = numberOrZero(source.searchCount)
  out.allowanceUsd = numberOrZero(source.allowanceUsd)
  out.costUsd = numberOrZero(source.costUsd)
  out.listCostUsd = numberOrZero(source.listCostUsd)
  out.equivalentUsd =
    numberOrZero(source.equivalentUsd) ||
    (numberOrZero(source.listCostUsd) || numberOrZero(source.costUsd))
  out.missingUsage = numberOrZero(source.missingUsage)
  out.estimatedRequests = numberOrZero(source.estimatedRequests)
  out.billingSources = { ...(source.billingSources ?? {}) }
  return out
}

function numberOrZero(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function metricsFromRecord(record: UsageRecord): UsageMetrics {
  const out: UsageMetrics = emptyUsageMetrics()
  out.requests = 1
  out.inputHit = Math.max(0, Math.round(record.inputHit))
  out.inputMiss = Math.max(0, Math.round(record.inputMiss))
  out.cacheWrite = Math.max(0, Math.round(record.cacheWrite))
  out.output = Math.max(0, Math.round(record.output))
  out.searchCount = Math.max(0, Math.round(record.searchCount))
  out.allowanceUsd = roundCost(record.allowanceUsd)
  out.costUsd = roundCost(record.costUsd)
  out.listCostUsd = roundCost(record.listCostUsd)
  out.equivalentUsd = roundCost(record.equivalentUsd)
  out.missingUsage = record.missingUsage ? 1 : 0
  out.estimatedRequests = record.estimated ? 1 : 0
  if (record.billingSource !== '') {
    out.billingSources[record.billingSource] = 1
  }
  return out
}

function getOrCreateDayProvider(
  ledger: UsageLedgerFile,
  dateKey: string,
  provider: string
): UsageDayProviderBuckets {
  let day: UsageDayProviderBuckets | undefined = ledger.days[dateKey]
  if (day === undefined) {
    day = {}
    ledger.days[dateKey] = day
  }
  let providerBucket: Record<string, UsageModelPeriods> | undefined = day[provider]
  if (providerBucket === undefined) {
    providerBucket = {}
    day[provider] = providerBucket
  }
  return day
}

function getOrCreateModelPeriods(
  day: UsageDayProviderBuckets,
  provider: string,
  model: string
): UsageModelPeriods {
  const providerBucket: Record<string, UsageModelPeriods> = day[provider] ?? (day[provider] = {})
  let periods: UsageModelPeriods | undefined = providerBucket[model]
  if (periods === undefined) {
    periods = {}
    providerBucket[model] = periods
  }
  return periods
}

/** 把一条临时请求记录聚合成日桶 + 全量累计值。O(1) 级操作。 */
export function addUsageRecordToLedger(
  ledger: UsageLedgerFile,
  record: UsageRecord,
  dateKey: string,
  period: UsagePeriod
): void {
  const day: UsageDayProviderBuckets = getOrCreateDayProvider(ledger, dateKey, record.provider)
  const periods: UsageModelPeriods = getOrCreateModelPeriods(day, record.provider, record.model)
  let bucket: UsageMetrics | undefined = periods[period]
  if (bucket === undefined) {
    bucket = emptyUsageMetrics()
    if (period === 'peak') {
      periods.peak = bucket
    } else {
      periods.offpeak = bucket
    }
  }
  const contribution: UsageMetrics = metricsFromRecord(record)
  addUsageMetrics(bucket, contribution)
  if (ledger.totals === undefined) {
    ledger.totals = emptyUsageMetrics()
  }
  addUsageMetrics(ledger.totals, contribution)
  if (ledger.providerTotals === undefined) {
    ledger.providerTotals = {}
  }
  let providerTotal: UsageMetrics | undefined = ledger.providerTotals[record.provider]
  if (providerTotal === undefined) {
    providerTotal = emptyUsageMetrics()
    ledger.providerTotals[record.provider] = providerTotal
  }
  addUsageMetrics(providerTotal, contribution)
}

/** 重新计算全量累计值（旧文件迁移 / 字段缺失时用） */
export function recomputeUsageTotals(ledger: UsageLedgerFile): void {
  const totals: UsageMetrics = emptyUsageMetrics()
  const providerTotals: Record<string, UsageMetrics> = {}
  const dates: string[] = Object.keys(ledger.days ?? {}).sort()
  for (const dateKey of dates) {
    const day: UsageDayProviderBuckets = ledger.days[dateKey]
    for (const provider of Object.keys(day)) {
      let providerTotal: UsageMetrics | undefined = providerTotals[provider]
      if (providerTotal === undefined) {
        providerTotal = emptyUsageMetrics()
        providerTotals[provider] = providerTotal
      }
      const models: Record<string, UsageModelPeriods> = day[provider]
      for (const model of Object.keys(models)) {
        const periods: UsageModelPeriods = models[model]
        for (const period of ['peak', 'offpeak'] as UsagePeriod[]) {
          const bucket: UsageMetrics | undefined = periods[period]
          if (bucket === undefined) {
            continue
          }
          const normalized: UsageMetrics = normalizeMetrics(bucket)
          if (period === 'peak') {
            periods.peak = normalized
          } else {
            periods.offpeak = normalized
          }
          addUsageMetrics(totals, normalized)
          addUsageMetrics(providerTotal, normalized)
        }
      }
    }
  }
  ledger.totals = totals
  ledger.providerTotals = providerTotals
}

/** 只保留最近 keepDays 天（含今天）。全量累计值不受影响。 */
export function cropUsageLedger(
  ledger: UsageLedgerFile,
  todayKey: string,
  keepDays: number = USAGE_KEEP_DAYS
): number {
  const cutoffMs: number = dateKeyToUtc(todayKey) - (keepDays - 1) * 86400000
  let removed: number = 0
  for (const key of Object.keys(ledger.days ?? {})) {
    if (dateKeyToUtc(key) < cutoffMs) {
      delete ledger.days[key]
      removed++
    }
  }
  return removed
}

function dateKeyToUtc(key: string): number {
  return Date.UTC(
    Number(key.substring(0, 4)),
    Number(key.substring(5, 7)) - 1,
    Number(key.substring(8, 10))
  )
}

function addDateDays(key: string, delta: number): string {
  const ms: number = dateKeyToUtc(key) + delta * 86400000
  const date: Date = new Date(ms)
  const year: number = date.getUTCFullYear()
  const month: number = date.getUTCMonth() + 1
  const day: number = date.getUTCDate()
  return year.toString() + '-' + pad2(month) + '-' + pad2(day)
}

function pad2(value: number): string {
  return value < 10 ? '0' + value.toString() : value.toString()
}

export type UsageProviderFilter = 'all' | UsageProvider

function collectDayMetrics(
  day: UsageDayProviderBuckets | undefined,
  providerFilter: UsageProviderFilter,
  target: UsageMetrics
): void {
  if (day === undefined) {
    return
  }
  for (const provider of Object.keys(day)) {
    if (providerFilter !== 'all' && provider !== providerFilter) {
      continue
    }
    const models: Record<string, UsageModelPeriods> = day[provider]
    for (const model of Object.keys(models)) {
      const periods: UsageModelPeriods = models[model]
      for (const period of ['peak', 'offpeak'] as UsagePeriod[]) {
        const bucket: UsageMetrics | undefined = periods[period]
        if (bucket !== undefined) {
          addUsageMetrics(target, normalizeMetrics(bucket))
        }
      }
    }
  }
}

/** 按日期范围聚合（含起止日期）。 */
export function aggregateUsageRange(
  days: UsageDayBuckets,
  providerFilter: UsageProviderFilter,
  fromKey: string,
  toKey: string
): UsageMetrics {
  const out: UsageMetrics = emptyUsageMetrics()
  for (const dateKey of Object.keys(days ?? {})) {
    if (dateKey < fromKey || dateKey > toKey) {
      continue
    }
    collectDayMetrics(days[dateKey], providerFilter, out)
  }
  return out
}

export function aggregateUsageDay(
  day: UsageDayProviderBuckets | undefined,
  providerFilter: UsageProviderFilter
): UsageMetrics {
  const out: UsageMetrics = emptyUsageMetrics()
  collectDayMetrics(day, providerFilter, out)
  return out
}

export function metricCostValue(metrics: UsageMetrics): number {
  return metrics.equivalentUsd > 0
    ? metrics.equivalentUsd
    : metrics.listCostUsd > 0
      ? metrics.listCostUsd
      : metrics.costUsd
}

export function metricValue(metrics: UsageMetrics, metric: UsageMetricKey): number {
  if (metric === 'tokens') {
    return metricsTotalTokens(metrics)
  }
  if (metric === 'requests') {
    return metrics.requests
  }
  return metricCostValue(metrics)
}

export interface HeatmapCell {
  date: string
  value: number
  level: number
  future: boolean
  requests: number
  costUsd: number
  tokens: number
}

export interface HeatmapWeek {
  days: HeatmapCell[]
}

export interface HeatmapMonthLabel {
  weekIndex: number
  label: string
}

export interface HeatmapData {
  weeks: HeatmapWeek[]
  start: string
  end: string
  monthLabels: HeatmapMonthLabel[]
  thresholds: number[]
  maxValue: number
  totalValue: number
}

/** 构建 GitHub 风格 53 周 × 7 天热力图（周一为第一行）。只在页面打开时调用。 */
export function buildUsageHeatmap(
  days: UsageDayBuckets,
  providerFilter: UsageProviderFilter,
  metric: UsageMetricKey,
  todayKey: string,
  weeksCount: number = USAGE_HEATMAP_WEEKS
): HeatmapData {
  const weekday: number = new Date(dateKeyToUtc(todayKey)).getUTCDay()
  const mondayOffset: number = weekday === 0 ? 6 : weekday - 1
  const thisMonday: string = addDateDays(todayKey, -mondayOffset)
  const start: string = addDateDays(thisMonday, -(weeksCount - 1) * 7)
  const end: string = addDateDays(start, weeksCount * 7 - 1)

  const weekList: HeatmapWeek[] = []
  const values: number[] = []
  let totalValue: number = 0
  let maxValue: number = 0
  for (let week: number = 0; week < weeksCount; week++) {
    const cells: HeatmapCell[] = []
    for (let dayIndex: number = 0; dayIndex < 7; dayIndex++) {
      const dateKey: string = addDateDays(start, week * 7 + dayIndex)
      const future: boolean = dateKey > todayKey
      const metrics: UsageMetrics = future
        ? emptyUsageMetrics()
        : aggregateUsageDay(days[dateKey], providerFilter)
      const value: number = future ? 0 : metricValue(metrics, metric)
      if (!future && value > 0) {
        values.push(value)
        totalValue += value
        if (value > maxValue) {
          maxValue = value
        }
      }
      cells.push({
        date: dateKey,
        value,
        level: 0,
        future,
        requests: future ? 0 : metrics.requests,
        costUsd: future ? 0 : metrics.equivalentUsd,
        tokens: future ? 0 : metricsTotalTokens(metrics)
      })
    }
    weekList.push({ days: cells })
  }

  const sorted: number[] = values.slice().sort((a, b) => a - b)
  const quantile = (q: number): number => {
    if (sorted.length === 0) {
      return 0
    }
    const index: number = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)))
    return sorted[index]
  }
  const thresholds: number[] = [quantile(0.25), quantile(0.5), quantile(0.75)]
  const minNonZero: number = sorted.length > 0 ? sorted[0] : 0
  for (const week of weekList) {
    for (const cell of week.days) {
      if (cell.future || cell.value <= 0) {
        cell.level = 0
        continue
      }
      if (maxValue > 0 && minNonZero === maxValue) {
        cell.level = 4
      } else if (cell.value <= thresholds[0]) {
        cell.level = 1
      } else if (cell.value <= thresholds[1]) {
        cell.level = 2
      } else if (cell.value <= thresholds[2]) {
        cell.level = 3
      } else {
        cell.level = 4
      }
    }
  }

  // 月份标签：放在包含“当月 1 日”的那一列（与 GitHub 一致）
  const monthLabels: HeatmapMonthLabel[] = []
  let lastLabel: string = ''
  for (let week: number = 0; week < weekList.length; week++) {
    for (const cell of weekList[week].days) {
      if (cell.date.substring(8, 10) !== '01') {
        continue
      }
      const label: string = Number(cell.date.substring(5, 7)).toString() + '月'
      if (label !== lastLabel) {
        monthLabels.push({ weekIndex: week, label })
        lastLabel = label
      }
      break
    }
  }

  return {
    weeks: weekList,
    start,
    end,
    monthLabels,
    thresholds,
    maxValue,
    totalValue
  }
}

function csvEscape(value: string): string {
  const text: string = value ?? ''
  if (/[",\n\r]/.test(text)) {
    return '"' + text.replace(/"/g, '""') + '"'
  }
  return text
}

/** 按日明细 CSV（UTF-8 BOM，Excel 打开中文不乱码） */
export function buildUsageCsv(
  ledger: UsageLedgerFile,
  providerFilter: UsageProviderFilter = 'all',
  exchangeRate: number = USD_CNY_RATE
): string {
  const lines: string[] = []
  lines.push(
    [
      '日期',
      '服务商',
      '模型',
      '时段',
      '请求数',
      '输入命中',
      '输入未命中',
      '缓存写入',
      '输出',
      '搜索次数',
      '实付(USD)',
      '等价成本(USD)',
      '额度消耗(USD)',
      '折算费用(CNY)',
      '计费来源',
      '缺失Usage',
      '预估请求'
    ]
      .map(csvEscape)
      .join(',')
  )
  const dates: string[] = Object.keys(ledger.days ?? {}).sort()
  for (const dateKey of dates) {
    const day: UsageDayProviderBuckets = ledger.days[dateKey]
    for (const provider of Object.keys(day).sort()) {
      if (providerFilter !== 'all' && provider !== providerFilter) {
        continue
      }
      const models: Record<string, UsageModelPeriods> = day[provider]
      for (const model of Object.keys(models).sort()) {
        const periods: UsageModelPeriods = models[model]
        for (const period of ['peak', 'offpeak'] as UsagePeriod[]) {
          const bucket: UsageMetrics | undefined = periods[period]
          if (bucket === undefined) {
            continue
          }
          const metrics: UsageMetrics = normalizeMetrics(bucket)
          const sources: string = Object.keys(metrics.billingSources)
            .map((key) => key + ':' + metrics.billingSources[key].toString())
            .join(' ')
          lines.push(
            [
              dateKey,
              providerLabel(provider),
              model,
              usagePeriodLabel(period),
              formatInteger(metrics.requests),
              formatInteger(metrics.inputHit),
              formatInteger(metrics.inputMiss),
              formatInteger(metrics.cacheWrite),
              formatInteger(metrics.output),
              formatInteger(metrics.searchCount),
              csvNumber(metrics.costUsd, 6),
              csvNumber(metrics.listCostUsd, 6),
              csvNumber(metrics.allowanceUsd, 6),
              csvNumber(metrics.equivalentUsd * exchangeRate, 4),
              sources,
              formatInteger(metrics.missingUsage),
              formatInteger(metrics.estimatedRequests)
            ]
              .map(csvEscape)
              .join(',')
          )
        }
      }
    }
  }
  return '\ufeff' + lines.join('\r\n') + '\r\n'
}

/** 生成页面 DTO（只在打开用量页时调用一次） */
export function buildUsageOverview(ledger: UsageLedgerFile, nowMs: number): UsageOverviewDto {
  const days: UsageDayDto[] = []
  const dates: string[] = Object.keys(ledger.days ?? {}).sort()
  for (const dateKey of dates) {
    const day: UsageDayProviderBuckets = ledger.days[dateKey]
    const models: UsageDayModelDto[] = []
    for (const provider of Object.keys(day).sort()) {
      const modelMap: Record<string, UsageModelPeriods> = day[provider]
      for (const model of Object.keys(modelMap).sort()) {
        const periods: UsageModelPeriods = modelMap[model]
        const peak: UsageMetrics | undefined =
          periods.peak !== undefined ? normalizeMetrics(periods.peak) : undefined
        const offpeak: UsageMetrics | undefined =
          periods.offpeak !== undefined ? normalizeMetrics(periods.offpeak) : undefined
        if (peak === undefined && offpeak === undefined) {
          continue
        }
        models.push({
          provider: provider as UsageProvider,
          model,
          peak,
          offpeak
        })
      }
    }
    if (models.length > 0) {
      days.push({ date: dateKey, models })
    }
  }

  const providerTotals: Partial<Record<UsageProvider, UsageMetrics>> = {}
  for (const key of Object.keys(ledger.providerTotals ?? {})) {
    providerTotals[key as UsageProvider] = cloneUsageMetrics(ledger.providerTotals[key])
  }

  return {
    generatedAt: nowMs,
    today: beijingToday(nowMs),
    days,
    totals: cloneUsageMetrics(ledger.totals),
    providerTotals,
    opencode: {
      lastSeenAt: ledger.meta?.opencode?.lastSeenAt ?? 0,
      billingSources: { ...(ledger.meta?.opencode?.billingSources ?? {}) },
      windows: (ledger.meta?.opencode?.windows ?? []).slice()
    },
    balance: {
      configured: ledger.meta?.balance?.configured === true,
      available: ledger.meta?.balance?.available === true,
      infos: (ledger.meta?.balance?.infos ?? []).slice(),
      fetchedAt: ledger.meta?.balance?.fetchedAt ?? 0,
      error: ledger.meta?.balance?.error ?? ''
    },
    pricing: {
      version: USAGE_PRICE_TABLE_VERSION,
      updatedAt: USAGE_PRICE_TABLE_UPDATED_AT,
      currency: 'CNY',
      exchangeRate: ledger.exchangeRate > 0 ? ledger.exchangeRate : USD_CNY_RATE,
      source: USAGE_PRICE_SOURCE,
      holidayCoverage: {
        fromYear: HOLIDAY_COVERAGE.fromYear,
        toYear: HOLIDAY_COVERAGE.toYear,
        note: HOLIDAY_COVERAGE.note
      }
    },
    dataFile: 'usage/usage-ledger.json',
    keepDays: USAGE_KEEP_DAYS
  }
}

function beijingToday(nowMs: number): string {
  const date: Date = new Date(nowMs + 8 * 3600 * 1000)
  return (
    date.getUTCFullYear().toString() +
    '-' +
    pad2(date.getUTCMonth() + 1) +
    '-' +
    pad2(date.getUTCDate())
  )
}

/** 汇总某天的模型占比（按指标排序） */
export interface UsageModelShare {
  provider: UsageProvider
  model: string
  value: number
  requests: number
  tokens: number
  costUsd: number
}

export function buildModelShares(
  day: UsageDayProviderBuckets | undefined,
  providerFilter: UsageProviderFilter,
  metric: UsageMetricKey
): UsageModelShare[] {
  const out: UsageModelShare[] = []
  if (day === undefined) {
    return out
  }
  for (const provider of Object.keys(day)) {
    if (providerFilter !== 'all' && provider !== providerFilter) {
      continue
    }
    const models: Record<string, UsageModelPeriods> = day[provider]
    for (const model of Object.keys(models)) {
      const periods: UsageModelPeriods = models[model]
      const merged: UsageMetrics = emptyUsageMetrics()
      if (periods.peak !== undefined) {
        addUsageMetrics(merged, normalizeMetrics(periods.peak))
      }
      if (periods.offpeak !== undefined) {
        addUsageMetrics(merged, normalizeMetrics(periods.offpeak))
      }
      out.push({
        provider: provider as UsageProvider,
        model,
        value: metricValue(merged, metric),
        requests: merged.requests,
        tokens: metricsTotalTokens(merged),
        costUsd: merged.equivalentUsd
      })
    }
  }
  out.sort((a, b) => b.value - a.value)
  return out
}
