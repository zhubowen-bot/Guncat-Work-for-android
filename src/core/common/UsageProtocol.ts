// 三协议 usage 归一化 + 北京时间/峰谷判定 + 成本归一（纯逻辑）。
//
// 关键口径（不要混）：
//   Anthropic       命中 = cache_read_input_tokens
//                   未命中 = input_tokens（**不含**缓存命中/写入）
//                   写入 = cache_creation_input_tokens
//                   输出 = output_tokens
//   Responses       命中 = input_tokens_details.cached_tokens
//                   未命中 = input_tokens - 命中（Responses 的 input_tokens 含缓存命中）
//                   输出 = output_tokens
//   Completions     优先 prompt_cache_hit_tokens / prompt_cache_miss_tokens；
//                   否则 prompt_tokens 与 prompt_tokens_details.cached_tokens 相减
//   OpenCode        优先 usage.opencode.tokens（input / output / cache_read / cache_write）
//                   否则回落到对应协议的字段
//
// reasoning tokens 已包含在 output 里，任何协议都不再加一遍。

import { isChineseHoliday } from './ChineseHolidays'
import {
  deepSeekModelPricing,
  priceDeepSeekUsage
} from './UsagePricing'
import type {
  UsageMetrics,
  UsageProvider,
  UsageRecord,
  UsageTokenFields,
  UsageWindow
} from './UsageTypes'

const BEIJING_OFFSET_MS: number = 8 * 3600 * 1000

export interface BeijingParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  /** 0=周日 … 6=周六 */
  weekday: number
  dateKey: string
}

function pad2(value: number): string {
  return value < 10 ? '0' + value.toString() : value.toString()
}

export function beijingParts(ms: number): BeijingParts {
  const date: Date = new Date((Number.isFinite(ms) ? ms : Date.now()) + BEIJING_OFFSET_MS)
  const year: number = date.getUTCFullYear()
  const month: number = date.getUTCMonth() + 1
  const day: number = date.getUTCDate()
  return {
    year,
    month,
    day,
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    weekday: date.getUTCDay(),
    dateKey: year.toString() + '-' + pad2(month) + '-' + pad2(day)
  }
}

/** 毫秒时间戳 → 北京时间 YYYY-MM-DD */
export function beijingDateKey(ms: number): string {
  return beijingParts(ms).dateKey
}

export function dateKeyFromParts(year: number, month: number, day: number): string {
  return year.toString() + '-' + pad2(month) + '-' + pad2(day)
}

function parseDateKey(key: string): { year: number; month: number; day: number } {
  return {
    year: Number(key.substring(0, 4)),
    month: Number(key.substring(5, 7)),
    day: Number(key.substring(8, 10))
  }
}

export function dateKeyToUtcMs(key: string): number {
  const parts = parseDateKey(key)
  return Date.UTC(parts.year, parts.month - 1, parts.day)
}

export function addDaysToDateKey(key: string, delta: number): string {
  const ms: number = dateKeyToUtcMs(key) + delta * 86400000
  const date: Date = new Date(ms)
  return dateKeyFromParts(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())
}

/** 该日期所在周的周一（周一为一周第一天） */
export function startOfWeekMonday(key: string): string {
  const ms: number = dateKeyToUtcMs(key)
  const weekday: number = new Date(ms).getUTCDay()
  const offset: number = weekday === 0 ? 6 : weekday - 1
  return addDaysToDateKey(key, -offset)
}

export function monthKeyOf(dateKey: string): string {
  return dateKey.substring(0, 7)
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** 一天中的第几分钟（北京时间） */
export function beijingMinuteOfDay(ms: number): number {
  const parts: BeijingParts = beijingParts(ms)
  return parts.hour * 60 + parts.minute
}

/**
 * 峰谷判定：周一至周五 09:00–12:00、14:00–18:00 为高峰；
 * 周末、法定节假日、其余时段为空闲。区间左闭右开。
 */
export function usagePeriodAt(ms: number): 'peak' | 'offpeak' {
  const parts: BeijingParts = beijingParts(ms)
  if (parts.weekday === 0 || parts.weekday === 6) {
    return 'offpeak'
  }
  if (isChineseHoliday(parts.dateKey)) {
    return 'offpeak'
  }
  const minute: number = parts.hour * 60 + parts.minute
  if ((minute >= 9 * 60 && minute < 12 * 60) || (minute >= 14 * 60 && minute < 18 * 60)) {
    return 'peak'
  }
  return 'offpeak'
}

/** 按 Base URL 识别预置服务商；不按模型名猜 */
export function detectUsageProvider(baseUrl: string): UsageProvider {
  const url: string = (baseUrl ?? '').trim()
  if (/^https?:\/\/api\.deepseek\.com(?::\d+)?(\/|$)/i.test(url)) {
    return 'deepseek'
  }
  if (/^https?:\/\/opencode\.ai\/inference(?:\/|$)/i.test(url)) {
    return 'opencode-go'
  }
  return 'other'
}

/** OpenAI 兼容流式请求是否支持 stream_options.include_usage（按 provider 兼容处理） */
export function supportsStreamUsage(baseUrl: string): boolean {
  const url: string = (baseUrl ?? '').trim()
  return (
    /^https?:\/\/api\.deepseek\.com(?::\d+)?(\/|$)/i.test(url) ||
    /^https?:\/\/opencode\.ai\/inference(?:\/|$)/i.test(url) ||
    /^https?:\/\/api\.openai\.com(?::\d+)?(\/|$)/i.test(url)
  )
}

function asRecord(value: Object | null | undefined): Record<string, Object> | null {
  if (typeof value !== 'object' || value === null || value instanceof Array) {
    return null
  }
  return value as Record<string, Object>
}

function numberValue(value: Object | null | undefined): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string') {
    const parsed: number = Number(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return undefined
}

function boolValue(value: Object | null | undefined): boolean {
  if (typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'string') {
    return value.toLowerCase() === 'true'
  }
  return false
}

function stringValue(value: Object | null | undefined): string {
  return typeof value === 'string' ? value : ''
}

function positive(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0
}

/** 深合并 usage 片段（Anthropic 的 message_start / message_delta 会分两次带字段） */
export function mergeUsageObjects(
  prev: Record<string, Object> | null,
  next: Record<string, Object> | null
): Record<string, Object> | null {
  if (next === null) {
    return prev
  }
  if (prev === null) {
    return cloneUsageValue(next) as Record<string, Object>
  }
  const out: Record<string, Object> = cloneUsageValue(prev) as Record<string, Object>
  mergeInto(out, next)
  return out
}

function mergeInto(target: Record<string, Object>, source: Record<string, Object>): void {
  const keys: string[] = Object.keys(source)
  for (const key of keys) {
    const nextValue: Object = source[key]
    const prevValue: Object = target[key]
    if (
      typeof nextValue === 'object' &&
      nextValue !== null &&
      !(nextValue instanceof Array) &&
      typeof prevValue === 'object' &&
      prevValue !== null &&
      !(prevValue instanceof Array)
    ) {
      const child: Record<string, Object> = prevValue as Record<string, Object>
      mergeInto(child, nextValue as Record<string, Object>)
      target[key] = child
    } else {
      target[key] = cloneUsageValue(nextValue)
    }
  }
}

function cloneUsageValue(value: Object): Object {
  if (typeof value !== 'object' || value === null) {
    return value
  }
  if (value instanceof Array) {
    const arr: Object[] = value as Object[]
    const out: Object[] = []
    for (const item of arr) {
      out.push(cloneUsageValue(item))
    }
    return out
  }
  const source: Record<string, Object> = value as Record<string, Object>
  const out: Record<string, Object> = {}
  for (const key of Object.keys(source)) {
    out[key] = cloneUsageValue(source[key])
  }
  return out
}

export interface NormalizedUsageTokens {
  tokens: UsageTokenFields
  /** 响应里是否出现了可识别的 token 字段（即使值为 0） */
  present: boolean
  /** 响应里是否出现了缓存命中/写入字段（用于区分「0% 命中」与「没有缓存数据」） */
  cacheFieldsPresent: boolean
}

function opencodeTokens(raw: Record<string, Object> | null): Record<string, Object> | null {
  if (raw === null) {
    return null
  }
  const opencode: Record<string, Object> | null = asRecord(raw['opencode'])
  return opencode === null ? null : asRecord(opencode['tokens'])
}

/**
 * 三协议 + OpenCode 的 token 归一化。
 * protocol 传空串时按字段自动判断（供 deriveStreamStats 的旧调用点兼容）。
 */
export function normalizeUsageTokens(
  protocol: string,
  raw: Record<string, Object> | null
): NormalizedUsageTokens {
  const empty: UsageTokenFields = { inputHit: 0, inputMiss: 0, cacheWrite: 0, output: 0 }
  if (raw === null) {
    return { tokens: empty, present: false, cacheFieldsPresent: false }
  }

  const oc: Record<string, Object> | null = opencodeTokens(raw)
  if (oc !== null) {
    const write5m: number = positive(numberValue(oc['cache_write_5m']))
    const write1h: number = positive(numberValue(oc['cache_write_1h']))
    const explicitWrite: number | undefined = numberValue(oc['cache_write'])
    return {
      tokens: {
        inputHit: positive(numberValue(oc['cache_read'])),
        inputMiss: positive(numberValue(oc['input'])),
        cacheWrite: explicitWrite !== undefined ? positive(explicitWrite) : write5m + write1h,
        output: positive(numberValue(oc['output']))
      },
      present: true,
      cacheFieldsPresent:
        oc['cache_read'] !== undefined ||
        oc['cache_write'] !== undefined ||
        oc['cache_write_5m'] !== undefined ||
        oc['cache_write_1h'] !== undefined
    }
  }

  let effective: string = protocol
  if (effective === '') {
    if (
      raw['cache_read_input_tokens'] !== undefined ||
      raw['cache_creation_input_tokens'] !== undefined
    ) {
      effective = 'anthropic'
    } else if (
      raw['input_tokens_details'] !== undefined ||
      (raw['input_tokens'] !== undefined && raw['output_tokens'] !== undefined)
    ) {
      effective = 'responses'
    } else {
      effective = 'completions'
    }
  }

  if (effective === 'anthropic') {
    const present: boolean =
      numberValue(raw['input_tokens']) !== undefined ||
      numberValue(raw['output_tokens']) !== undefined ||
      numberValue(raw['cache_read_input_tokens']) !== undefined ||
      numberValue(raw['cache_creation_input_tokens']) !== undefined
    return {
      tokens: {
        inputHit: positive(numberValue(raw['cache_read_input_tokens'])),
        inputMiss: positive(numberValue(raw['input_tokens'])),
        cacheWrite: positive(numberValue(raw['cache_creation_input_tokens'])),
        output: positive(numberValue(raw['output_tokens']))
      },
      present,
      cacheFieldsPresent:
        raw['cache_read_input_tokens'] !== undefined ||
        raw['cache_creation_input_tokens'] !== undefined
    }
  }

  if (effective === 'responses') {
    const input: number = positive(
      numberValue(raw['input_tokens']) ?? numberValue(raw['prompt_tokens'])
    )
    const inputDetails: Record<string, Object> | null = asRecord(raw['input_tokens_details'])
    const promptDetails: Record<string, Object> | null = asRecord(raw['prompt_tokens_details'])
    const cached: number = positive(
      (inputDetails !== null ? numberValue(inputDetails['cached_tokens']) : undefined) ??
        (promptDetails !== null ? numberValue(promptDetails['cached_tokens']) : undefined)
    )
    const hit: number = Math.min(input, cached)
    const output: number = positive(
      numberValue(raw['output_tokens']) ?? numberValue(raw['completion_tokens'])
    )
    return {
      tokens: {
        inputHit: hit,
        inputMiss: Math.max(0, input - hit),
        cacheWrite: positive(numberValue(raw['cache_creation_input_tokens'])),
        output
      },
      present:
        numberValue(raw['input_tokens']) !== undefined ||
        numberValue(raw['output_tokens']) !== undefined ||
        numberValue(raw['prompt_tokens']) !== undefined ||
        numberValue(raw['completion_tokens']) !== undefined,
      cacheFieldsPresent:
        (inputDetails !== null && inputDetails['cached_tokens'] !== undefined) ||
        (promptDetails !== null && promptDetails['cached_tokens'] !== undefined)
    }
  }

  // completions（含 DeepSeek 原生）
  const prompt: number = positive(numberValue(raw['prompt_tokens']))
  const explicitHit: number | undefined = numberValue(raw['prompt_cache_hit_tokens'])
  const explicitMiss: number | undefined = numberValue(raw['prompt_cache_miss_tokens'])
  const promptDetails: Record<string, Object> | null = asRecord(raw['prompt_tokens_details'])
  const cached: number = positive(
    promptDetails !== null ? numberValue(promptDetails['cached_tokens']) : undefined
  )
  let hit: number = 0
  let miss: number = 0
  if (explicitHit !== undefined || explicitMiss !== undefined) {
    hit = positive(explicitHit)
    miss = positive(explicitMiss)
    if (miss === 0 && prompt > 0) {
      miss = Math.max(0, prompt - hit)
    }
    if (hit === 0 && prompt > 0) {
      hit = Math.max(0, prompt - miss)
    }
  } else {
    hit = Math.min(prompt, cached)
    miss = Math.max(0, prompt - hit)
  }
  return {
    tokens: {
      inputHit: hit,
      inputMiss: miss,
      cacheWrite: positive(
        numberValue(raw['cache_creation_input_tokens']) ??
          numberValue(raw['prompt_cache_write_tokens'])
      ),
      output: positive(
        numberValue(raw['completion_tokens']) ?? numberValue(raw['output_tokens'])
      )
    },
    present:
      numberValue(raw['prompt_tokens']) !== undefined ||
      explicitHit !== undefined ||
      explicitMiss !== undefined ||
      numberValue(raw['completion_tokens']) !== undefined ||
      cached > 0,
    cacheFieldsPresent:
      explicitHit !== undefined ||
      explicitMiss !== undefined ||
      (promptDetails !== null && promptDetails['cached_tokens'] !== undefined)
  }
}

/** 服务端联网搜索/抓取次数（Anthropic/DeepSeek 的 server_tool_use） */
export function extractSearchCount(raw: Record<string, Object> | null): number {
  if (raw === null) {
    return 0
  }
  const serverTool: Record<string, Object> | null = asRecord(raw['server_tool_use'])
  let count: number = 0
  if (serverTool !== null) {
    count += positive(numberValue(serverTool['web_search_requests']))
    count += positive(numberValue(serverTool['web_fetch_requests']))
    count += positive(numberValue(serverTool['search_requests']))
    count += positive(numberValue(serverTool['fetch_requests']))
  }
  count += positive(numberValue(raw['web_search_requests']))
  count += positive(numberValue(raw['web_fetch_requests']))
  return Math.floor(count)
}

export interface OpencodeUsageMeta {
  allowanceUsd: number
  costUsd: number | undefined
  listCostUsd: number | undefined
  billingSource: string
  estimated: boolean
  windows: UsageWindow[]
}

/** 提取 OpenCode 的套餐/计费字段（字段缺失时保持 undefined，交给调用方判断） */
export function extractOpencodeMeta(raw: Record<string, Object> | null): OpencodeUsageMeta {
  const out: OpencodeUsageMeta = {
    allowanceUsd: 0,
    costUsd: undefined,
    listCostUsd: undefined,
    billingSource: '',
    estimated: false,
    windows: []
  }
  if (raw === null) {
    return out
  }
  const opencode: Record<string, Object> | null = asRecord(raw['opencode'])
  if (opencode !== null) {
    out.allowanceUsd = positive(numberValue(opencode['allowance']))
    out.costUsd = numberValue(opencode['cost'])
    out.listCostUsd = numberValue(opencode['list_cost'])
    out.billingSource = stringValue(opencode['billing_source'])
    out.estimated = boolValue(opencode['estimated'])
    out.windows = extractOpencodeWindows(opencode)
  }
  const topCost: number | undefined = numberValue(raw['cost'])
  if (topCost !== undefined) {
    if (out.costUsd === undefined) {
      out.costUsd = topCost
    }
    if (out.listCostUsd === undefined) {
      out.listCostUsd = topCost
    }
  }
  return out
}

function pickWindowEntry(source: Record<string, Object>, keys: string[]): Record<string, Object> | null {
  for (const key of keys) {
    const value: Record<string, Object> | null = asRecord(source[key])
    if (value !== null) {
      return value
    }
  }
  return null
}

/** 兼容网关可能返回的窗口结构；没有就返回空数组（页面会如实标注“网关未返回”） */
function extractOpencodeWindows(opencode: Record<string, Object>): UsageWindow[] {
  const container: Record<string, Object> | null =
    asRecord(opencode['windows']) ??
    asRecord(opencode['limits']) ??
    asRecord(opencode['usage'])
  if (container === null) {
    return []
  }
  const definitions: Array<{ id: string; label: string; keys: string[] }> = [
    { id: '5h', label: '5 小时', keys: ['five_hour', 'five_hours', '5h', 'fiveHour'] },
    { id: 'week', label: '本周', keys: ['week', 'weekly', '7d', 'seven_day'] },
    { id: 'month', label: '本月', keys: ['month', 'monthly', '30d', 'thirty_day'] }
  ]
  const out: UsageWindow[] = []
  for (const def of definitions) {
    const entry: Record<string, Object> | null = pickWindowEntry(container, def.keys)
    if (entry === null) {
      continue
    }
    const used: number = positive(
      numberValue(entry['used']) ?? numberValue(entry['usage']) ?? numberValue(entry['spent'])
    )
    const limit: number = positive(
      numberValue(entry['limit']) ?? numberValue(entry['total']) ?? numberValue(entry['cap'])
    )
    const resetAt: number = positive(
      numberValue(entry['reset_at']) ?? numberValue(entry['resets_at'])
    )
    if (used === 0 && limit === 0) {
      continue
    }
    out.push({ id: def.id, label: def.label, usedUsd: used, limitUsd: limit, resetAt })
  }
  return out
}

export interface BuildUsageRecordOptions {
  success: boolean
  sessionId?: string
}

/**
 * 把一次响应的 usage 归一化并计价。缺失 usage 时仍返回一条 missingUsage 记录，
 * 让页面能如实显示「有多少请求没有拿到 usage」，但金额为 0。
 */
export function buildUsageRecord(
  protocol: string,
  raw: Record<string, Object> | null,
  baseUrl: string,
  model: string,
  startedAt: number,
  options: BuildUsageRecordOptions
): UsageRecord {
  const provider: UsageProvider = detectUsageProvider(baseUrl)
  const period: 'peak' | 'offpeak' = usagePeriodAt(startedAt)
  const normalized: NormalizedUsageTokens = normalizeUsageTokens(protocol, raw)
  const tokens: UsageTokenFields = normalized.tokens
  const searchCount: number = extractSearchCount(raw)
  const oc: OpencodeUsageMeta = extractOpencodeMeta(raw)
  const modelName: string = (model ?? '').trim() || 'unknown'
  const missingUsage: boolean = !normalized.present
  const record: UsageRecord = {
    startedAt,
    provider,
    model: modelName,
    protocol,
    inputHit: tokens.inputHit,
    inputMiss: tokens.inputMiss,
    cacheWrite: tokens.cacheWrite,
    output: tokens.output,
    searchCount,
    allowanceUsd: oc.allowanceUsd,
    costUsd: 0,
    listCostUsd: 0,
    equivalentUsd: 0,
    billingSource: oc.billingSource,
    opencodeWindows: oc.windows,
    estimated: false,
    missingUsage,
    sessionId: options.sessionId ?? ''
  }

  if (provider === 'deepseek') {
    const priced = priceDeepSeekUsage(modelName, period, tokens, searchCount)
    record.costUsd = priced.costUsd
    record.listCostUsd = priced.costUsd
    record.equivalentUsd = priced.costUsd
    record.estimated = priced.estimated
    return record
  }

  if (provider === 'opencode-go') {
    const cost: number = positive(oc.costUsd)
    const listCost: number = positive(oc.listCostUsd)
    record.costUsd = cost
    record.listCostUsd = listCost
    record.allowanceUsd = oc.allowanceUsd
    record.billingSource = oc.billingSource
    record.equivalentUsd =
      listCost > 0 ? listCost : oc.allowanceUsd > 0 ? oc.allowanceUsd : cost
    const hasCostField: boolean =
      oc.costUsd !== undefined || oc.listCostUsd !== undefined || oc.allowanceUsd > 0
    record.estimated = oc.estimated || (!hasCostField && !missingUsage)
    return record
  }

  // 其它服务商：能拿到 reported cost 就记，拿不到则只统计 tokens（不猜价格）
  const cost: number = positive(oc.costUsd)
  const listCost: number = positive(oc.listCostUsd)
  record.costUsd = cost
  record.listCostUsd = listCost
  record.allowanceUsd = oc.allowanceUsd
  record.billingSource = oc.billingSource
  record.equivalentUsd = cost > 0 ? cost : listCost
  record.estimated = oc.estimated || (!missingUsage && oc.costUsd === undefined && oc.listCostUsd === undefined)
  return record
}

/** 供上下文预算使用：一次请求的总输入 = 命中 + 未命中 + 缓存写入 */
export function usageTotalInputTokens(protocol: string, raw: Record<string, Object> | null): number {
  const normalized: NormalizedUsageTokens = normalizeUsageTokens(protocol, raw)
  return (
    positive(normalized.tokens.inputHit) +
    positive(normalized.tokens.inputMiss) +
    positive(normalized.tokens.cacheWrite)
  )
}

/** 峰谷/日期说明由页面直接展示，这里提供一份统一文案 */
export function deepSeekPeakRuleText(): string {
  return '高峰：周一至周五 09:00–12:00、14:00–18:00（北京时间）；周末、法定节假日与其余时段为空闲，空闲价为高峰价的一半。'
}

/** 价目表覆盖说明 */
export function deepSeekPricingNote(model: string): string {
  const pricing = deepSeekModelPricing(model)
  if (pricing.estimated) {
    return '该模型未收录在价目表中，暂按 ' + (pricing.family === 'pro' ? 'Pro' : 'Flash') + ' 价估算。'
  }
  return ''
}

/** 聚合指标的 token 总数（供 UI 复用） */
export function metricsTotalTokens(metrics: UsageMetrics): number {
  return (
    Math.max(0, metrics.inputHit) +
    Math.max(0, metrics.inputMiss) +
    Math.max(0, metrics.cacheWrite) +
    Math.max(0, metrics.output)
  )
}
