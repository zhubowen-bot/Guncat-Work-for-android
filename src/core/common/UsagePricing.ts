// 价目表与金额/数量格式化（纯逻辑，渲染层与主进程共用）。
//
// 价目表集中管理，带版本号和更新日期。DeepSeek 官方人民币价目（2026-08-17 生效）：
//   Flash 高峰：缓存命中 0.04 / 未命中 2 / 输出 8 元每百万 tokens；空闲价减半。
//   Pro   高峰：缓存命中 0.30 / 未命中 9 / 输出 27 元每百万 tokens；空闲价减半。
// Search / Fetch 各 5 元 / 1000 次成功请求（用户给定口径）。
//
// 存储统一用美元：DeepSeek 先用人民币价算出精确的 CNY 成本，再按固定汇率折算成 USD；
// OpenCode 网关返回的 cost/list_cost 本身就是美元。展示时再乘回汇率，因此 DeepSeek
// 的人民币金额不会被四舍五入污染。

import type { UsageMetrics, UsageProvider, UsageTokenFields } from './UsageTypes'

/** 展示用固定汇率。集中在这里，页面底部会明确标注。 */
export const USD_CNY_RATE: number = 7.2

export const USAGE_PRICE_TABLE_VERSION: string = 'deepseek-cny-2026-08-17'
export const USAGE_PRICE_TABLE_UPDATED_AT: string = '2026-08-17'
export const USAGE_PRICE_SOURCE: string = 'DeepSeek 官方价目表（人民币）'

/** DeepSeek 服务端搜索/抓取：5 元 / 1000 次成功请求 */
export const DEEPSEEK_SEARCH_CNY_PER_REQUEST: number = 5 / 1000

/** OpenCode Go 套餐当前月费（仅作窗口展示参考，不作为计费依据） */
export const OPENCODE_GO_MONTHLY_USD: number = 10

export interface DeepSeekRate {
  cacheHit: number
  cacheMiss: number
  output: number
}

export interface DeepSeekRateCard {
  peak: DeepSeekRate
  offpeak: DeepSeekRate
}

export const DEEPSEEK_RATE_CARDS: Record<'flash' | 'pro', DeepSeekRateCard> = {
  flash: {
    peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
    offpeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 }
  },
  pro: {
    peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 },
    offpeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 }
  }
}

const KNOWN_FLASH_MODELS: string[] = [
  'deepseek-flash',
  'deepseek-v4-flash',
  'deepseek-v4-flash-vision-exp'
]
const KNOWN_PRO_MODELS: string[] = ['deepseek-v4-pro', 'deepseek-pro']

export interface DeepSeekModelPricing {
  family: 'flash' | 'pro'
  card: DeepSeekRateCard
  /** 模型名不在已收录清单里：仍按 Flash/Pro 家族估算，但页面要注明 */
  estimated: boolean
}

/** 按模型名选择 DeepSeek 价目。优先精确清单，其次按 pro 关键字分类。 */
export function deepSeekModelPricing(model: string): DeepSeekModelPricing {
  const name: string = (model ?? '').trim().toLowerCase()
  if (KNOWN_PRO_MODELS.indexOf(name) >= 0) {
    return { family: 'pro', card: DEEPSEEK_RATE_CARDS.pro, estimated: false }
  }
  if (KNOWN_FLASH_MODELS.indexOf(name) >= 0) {
    return { family: 'flash', card: DEEPSEEK_RATE_CARDS.flash, estimated: false }
  }
  // 旧的 deepseek-chat / deepseek-reasoner 已下线，若用户仍配置则按 Flash 价估算
  const family: 'flash' | 'pro' = name.indexOf('pro') >= 0 ? 'pro' : 'flash'
  return { family, card: DEEPSEEK_RATE_CARDS[family], estimated: true }
}

export interface DeepSeekCostResult {
  costCny: number
  costUsd: number
  estimated: boolean
  family: 'flash' | 'pro'
}

/** 按峰/谷与 token 拆分计算 DeepSeek 官方成本。 */
export function priceDeepSeekUsage(
  model: string,
  period: 'peak' | 'offpeak',
  tokens: UsageTokenFields,
  searchCount: number
): DeepSeekCostResult {
  const pricing: DeepSeekModelPricing = deepSeekModelPricing(model)
  const rate: DeepSeekRate = period === 'peak' ? pricing.card.peak : pricing.card.offpeak
  const hit: number = Math.max(0, tokens.inputHit)
  const miss: number = Math.max(0, tokens.inputMiss)
  // DeepSeek 没有单独的缓存写入价；若兼容协议报出 cache_write，按未命中输入计费，
  // 避免把新写入的缓存 token 当成免费。
  const write: number = Math.max(0, tokens.cacheWrite)
  const output: number = Math.max(0, tokens.output)
  const searches: number = Math.max(0, Math.floor(searchCount || 0))
  const tokenCny: number =
    (hit * rate.cacheHit + (miss + write) * rate.cacheMiss + output * rate.output) / 1000000
  const searchCny: number = searches * DEEPSEEK_SEARCH_CNY_PER_REQUEST
  const costCny: number = tokenCny + searchCny
  return {
    costCny,
    costUsd: costCny / USD_CNY_RATE,
    estimated: pricing.estimated,
    family: pricing.family
  }
}

/** tokens 总数（缓存写入属于输入的一部分） */
export function totalTokenCount(fields: UsageTokenFields): number {
  return (
    Math.max(0, fields.inputHit) +
    Math.max(0, fields.inputMiss) +
    Math.max(0, fields.cacheWrite) +
    Math.max(0, fields.output)
  )
}

/**
 * 热力图/汇总里使用的“统一比较成本”：
 *   · OpenCode：优先 list_cost（等价按量成本），其次 allowance，最后 cost；
 *   · DeepSeek：本地按官方价目计算出的实付成本；
 *   · 其它：有 reported cost 就用，否则 0。
 */
export function metricEquivalentUsd(provider: UsageProvider, metrics: UsageMetrics): number {
  if (metrics.equivalentUsd > 0) {
    return metrics.equivalentUsd
  }
  if (provider === 'opencode-go') {
    return metrics.listCostUsd > 0
      ? metrics.listCostUsd
      : metrics.allowanceUsd > 0
        ? metrics.allowanceUsd
        : metrics.costUsd
  }
  return metrics.costUsd > 0 ? metrics.costUsd : metrics.listCostUsd
}

export function providerLabel(provider: string): string {
  switch (provider) {
    case 'deepseek':
      return 'DeepSeek'
    case 'opencode-go':
      return 'OpenCode Go'
    default:
      return '其它服务商'
  }
}

export function usagePeriodLabel(period: string): string {
  return period === 'peak' ? '高峰' : '空闲'
}

function groupFixed(value: number, digits: number): string {
  const fixed: string = value.toFixed(digits)
  const parts: string[] = fixed.split('.')
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return parts.length > 1 ? parts[0] + '.' + parts[1] : parts[0]
}

/** 人民币金额：小额保留更多小数，避免 0.004 被显示成 0.00 */
export function formatCnyAmount(value: number): string {
  const n: number = Number(value)
  if (!Number.isFinite(n) || n === 0) {
    return '¥0'
  }
  const abs: number = Math.abs(n)
  if (abs < 0.001) {
    return (n < 0 ? '-¥' : '¥') + groupFixed(abs, 5)
  }
  if (abs < 0.01) {
    return (n < 0 ? '-¥' : '¥') + groupFixed(abs, 4)
  }
  if (abs < 1) {
    return (n < 0 ? '-¥' : '¥') + groupFixed(abs, 3)
  }
  return (n < 0 ? '-¥' : '¥') + groupFixed(abs, 2)
}

/** 美元金额 */
export function formatUsdAmount(value: number): string {
  const n: number = Number(value)
  if (!Number.isFinite(n) || n === 0) {
    return '$0'
  }
  const abs: number = Math.abs(n)
  if (abs < 0.001) {
    return (n < 0 ? '-$' : '$') + groupFixed(abs, 5)
  }
  if (abs < 0.01) {
    return (n < 0 ? '-$' : '$') + groupFixed(abs, 4)
  }
  if (abs < 1) {
    return (n < 0 ? '-$' : '$') + groupFixed(abs, 3)
  }
  return (n < 0 ? '-$' : '$') + groupFixed(abs, 2)
}

export function usdToCny(usd: number): number {
  return (Number.isFinite(usd) ? usd : 0) * USD_CNY_RATE
}

export function cnyToUsd(cny: number): number {
  return (Number.isFinite(cny) ? cny : 0) / USD_CNY_RATE
}

/** 大数字：1.2K / 3.4M / 1.1B，用于卡片与图例 */
export function formatCompactTokens(value: number): string {
  const n: number = Math.max(0, Number(value) || 0)
  if (n >= 1000000000) {
    return (n / 1000000000).toFixed(n >= 10000000000 ? 0 : 1) + 'B'
  }
  if (n >= 1000000) {
    return (n / 1000000).toFixed(n >= 10000000 ? 0 : 1) + 'M'
  }
  if (n >= 1000) {
    return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'K'
  }
  return Math.round(n).toString()
}

/** 精确整数（带千分位），用于明细与 tooltip */
export function formatInteger(value: number): string {
  const n: number = Math.round(Number(value) || 0)
  return groupFixed(n, 0)
}

export function formatPercent(value: number, digits: number = 0): string {
  const n: number = Number(value)
  if (!Number.isFinite(n)) {
    return '—'
  }
  return (n * 100).toFixed(digits) + '%'
}

export function formatDateTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return '—'
  }
  const date: Date = new Date(ms)
  const pad = (v: number): string => (v < 10 ? '0' + v.toString() : v.toString())
  return (
    date.getFullYear().toString() +
    '-' +
    pad(date.getMonth() + 1) +
    '-' +
    pad(date.getDate()) +
    ' ' +
    pad(date.getHours()) +
    ':' +
    pad(date.getMinutes())
  )
}

/** CSV 数字：保留足够精度，避免小额成本被四舍五入成 0 */
export function csvNumber(value: number, digits: number = 6): string {
  const n: number = Number.isFinite(value) ? value : 0
  return n.toFixed(digits)
}
