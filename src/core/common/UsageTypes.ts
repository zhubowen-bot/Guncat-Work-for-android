// 用量与成本统计的数据模型（纯类型，无平台依赖）。
//
// 设计原则：
//   · 逐请求归一化后**立刻**聚合成「日期 × 服务商 × 模型 × 峰/谷」，
//     请求级明细只在栈上短暂存在，不进入长期内存，也不写消息/会话存档；
//   · 金额统一以美元存储（DeepSeek 的官方人民币价按固定汇率折算），
//     展示时再换算成人民币，避免同一份数据里混用币种；
//   · 文件带 version，后续价目表/口径变化时可以迁移。

/** 统计口径里的服务商（按 Base URL 区分，不按模型名猜） */
export type UsageProvider = 'deepseek' | 'opencode-go' | 'other'

/** 峰谷时段：peak=高峰，offpeak=空闲 */
export type UsagePeriod = 'peak' | 'offpeak'

/** 页面上的指标切换 */
export type UsageMetricKey = 'cost' | 'tokens' | 'requests'

export interface UsageTokenFields {
  /** 缓存命中的输入 tokens */
  inputHit: number
  /** 缓存未命中的输入 tokens（Anthropic 的 input_tokens 只表示这一部分） */
  inputMiss: number
  /** 缓存写入 tokens（Anthropic cache_creation_input_tokens） */
  cacheWrite: number
  /** 输出 tokens（reasoning 已包含在内，不重复计费） */
  output: number
}

/** 一次 API 响应的临时归一化结果；只用于聚合成日桶，不会被长期保存 */
export interface UsageRecord extends UsageTokenFields {
  /** 请求开始时间（毫秒时间戳）—— 计费日期与峰谷都以它为准 */
  startedAt: number
  provider: UsageProvider
  model: string
  protocol: string
  /** 服务端联网搜索/抓取成功次数（可选） */
  searchCount: number
  /** OpenCode Go 套餐额度消耗（美元） */
  allowanceUsd: number
  /** 实际扣费（美元；Go 套餐内为 0） */
  costUsd: number
  /** 等价按量成本（美元；OpenCode 的 list_cost） */
  listCostUsd: number
  /** 统一比较用成本：OpenCode 优先 list_cost，DeepSeek 用实付计算值 */
  equivalentUsd: number
  /** OpenCode 的 billing_source：go / go-plus / balance / byok / free */
  billingSource: string
  /** OpenCode 网关本次响应里带的窗口信息（如果有） */
  opencodeWindows?: UsageWindow[]
  /** 成本是否来自估算（价目缺失 / 网关标记 estimated） */
  estimated: boolean
  /** 成功响应但没有可用 usage */
  missingUsage: boolean
  /** 会话级键（仅用于「本轮统计」，不落盘） */
  sessionId: string
}

/** 一个日桶内、一个模型的两个时段 */
export interface UsageModelPeriods {
  peak?: UsageMetrics
  offpeak?: UsageMetrics
}

/** 日期 → 服务商 → 模型 → 峰/谷 */
export type UsageDayProviderBuckets = Record<string, Record<string, UsageModelPeriods>>
export type UsageDayBuckets = Record<string, UsageDayProviderBuckets>

/** 聚合指标。全部为累加值，避免每次渲染回扫请求明细。 */
export interface UsageMetrics {
  requests: number
  inputHit: number
  inputMiss: number
  cacheWrite: number
  output: number
  searchCount: number
  allowanceUsd: number
  costUsd: number
  listCostUsd: number
  equivalentUsd: number
  /** 成功响应但缺少 usage 的请求数 */
  missingUsage: number
  /** 成本来自估算的请求数 */
  estimatedRequests: number
  /** billing_source → 请求数（OpenCode 专用，其它服务商为空） */
  billingSources: Record<string, number>
}

/** OpenCode 网关返回的窗口信息（如果网关提供了的话） */
export interface UsageWindow {
  id: string
  label: string
  usedUsd: number
  limitUsd: number
  /** 窗口重置时间（毫秒时间戳；未知为 0） */
  resetAt: number
}

export interface UsageBalanceInfo {
  currency: string
  totalBalance: number
  grantedBalance: number
  toppedUpBalance: number
}

/** DeepSeek 余额快照：只作对账，不参与热力图 */
export interface UsageBalanceSnapshot {
  /** 本机是否配置了 DeepSeek Key */
  configured: boolean
  /** 接口是否返回可用余额 */
  available: boolean
  infos: UsageBalanceInfo[]
  fetchedAt: number
  /** 最近一次刷新失败的原因（成功时为空串） */
  error: string
}

export interface UsageOpencodeMeta {
  lastSeenAt: number
  billingSources: Record<string, number>
  windows: UsageWindow[]
}

export interface UsageLedgerMeta {
  opencode: UsageOpencodeMeta
  balance: UsageBalanceSnapshot
  lastBalanceAttemptAt: number
}

/** 落盘文件。version 用于未来迁移。 */
export interface UsageLedgerFile {
  version: number
  updatedAt: number
  priceTableVersion: string
  exchangeRate: number
  days: UsageDayBuckets
  /** 全量累计值（不随 400 天裁剪而减少） */
  totals: UsageMetrics
  providerTotals: Record<string, UsageMetrics>
  meta: UsageLedgerMeta
}

/** 页面 DTO：按日展开后的模型维度 */
export interface UsageDayModelDto {
  provider: UsageProvider
  model: string
  peak?: UsageMetrics
  offpeak?: UsageMetrics
}

export interface UsageDayDto {
  date: string
  models: UsageDayModelDto[]
}

export interface UsagePricingInfoDto {
  version: string
  updatedAt: string
  currency: string
  exchangeRate: number
  source: string
  /** 价目表覆盖的年份 */
  holidayCoverage: {
    fromYear: number
    toYear: number
    note: string
  }
}

export interface UsageOverviewDto {
  generatedAt: number
  /** 今天（北京时间 YYYY-MM-DD） */
  today: string
  /** 日桶（最近约 400 天，按日期升序） */
  days: UsageDayDto[]
  totals: UsageMetrics
  providerTotals: Partial<Record<UsageProvider, UsageMetrics>>
  opencode: UsageOpencodeMeta
  balance: UsageBalanceSnapshot
  pricing: UsagePricingInfoDto
  /** 相对应用私有目录的数据文件位置 */
  dataFile: string
  /** 已保留的天数上限 */
  keepDays: number
}

/** 本轮统计（只存在内存里，不写消息存档） */
export interface UsageRunTotals {
  requests: number
  tokens: number
  costUsd: number
  allowanceUsd: number
}
