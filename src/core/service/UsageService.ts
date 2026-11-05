// UsageService：逐请求记账 + 按日聚合 + 原子落盘 + DeepSeek 余额对账。
//
// 性能边界（刻意约束）：
//   · 每个 API 响应只在结束时做一次归一化/计价，然后 O(1) 合进日桶；
//   · 请求级明细不保留、不写消息、不写会话存档；
//   · 落盘 4 秒防抖，流式过程中不会反复序列化；
//   · 统计模块全程 try/catch，任何失败都不向聊天主流程抛异常；
//   · 余额只在用户手动刷新或打开用量页且超过 10 分钟节流时才请求，没有后台轮询。

import { fileIo } from '@kit.CoreFileKit'
import { http } from '@kit.NetworkKit'
import { util } from '@kit.ArkTS'
import { filesDir } from '../platform/appPaths'
import { appContext } from '../platform/kit/AbilityKit'
import { StorageManager } from '../data/StorageManager'
import { ApiConfig } from '../model/ApiConfig'
import { ApiProfile } from '../model/ApiProfile'
import {
  USAGE_KEEP_DAYS,
  USAGE_LEDGER_VERSION,
  addUsageRecordToLedger,
  buildUsageCsv,
  buildUsageOverview,
  createEmptyUsageLedger,
  cropUsageLedger,
  recomputeUsageTotals,
  type UsageProviderFilter
} from '../common/UsageAggregate'
import {
  USAGE_PRICE_TABLE_VERSION,
  USD_CNY_RATE
} from '../common/UsagePricing'
import {
  beijingDateKey,
  buildUsageRecord,
  detectUsageProvider,
  mergeUsageObjects,
  usagePeriodAt
} from '../common/UsageProtocol'
import type {
  UsageBalanceInfo,
  UsageBalanceSnapshot,
  UsageLedgerFile,
  UsageOverviewDto,
  UsageRecord,
  UsageRunTotals
} from '../common/UsageTypes'

const LEDGER_RELATIVE_PATH: string = 'usage/usage-ledger.json'
const BALANCE_THROTTLE_MS: number = 10 * 60 * 1000
const BALANCE_TIMEOUT_MS: number = 12000
const FLUSH_DEBOUNCE_MS: number = 4000
const MAX_LAST_RUNS: number = 32

function emptyRunTotals(): UsageRunTotals {
  return { requests: 0, tokens: 0, costUsd: 0, allowanceUsd: 0 }
}

function roundUsd(value: number): number {
  return Math.round((Number.isFinite(value) ? value : 0) * 1000000) / 1000000
}

function asRecord(value: Object | null | undefined): Record<string, Object> | null {
  if (typeof value !== 'object' || value === null || value instanceof Array) {
    return null
  }
  return value as Record<string, Object>
}

function numeric(value: Object | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string') {
    const parsed: number = Number(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return 0
}

/**
 * 一次请求的 usage 收集器。
 *
 * observe() 只做小对象的深合并（Anthropic 的 message_start / message_delta 会分两次
 * 带 input/cache 与 output）；finish() 在流结束时统一归一化并记账一次。
 */
export class UsageRequestMeter {
  private protocol: string
  private baseUrl: string
  private model: string
  private sessionId: string
  private startedAt: number
  private merged: Record<string, Object> | null = null
  private observed: boolean = false
  private finished: boolean = false

  constructor(config: ApiConfig, protocol: string, startedAt: number) {
    this.protocol = protocol
    this.baseUrl = config?.baseUrl ?? ''
    this.model = config?.model ?? ''
    this.sessionId = config?.sessionId ?? ''
    this.startedAt = startedAt
  }

  /** 合并一个 usage 片段，返回当前合并结果（供速度/命中率实时计算） */
  observe(raw: Record<string, Object> | null): Record<string, Object> | null {
    if (raw === null) {
      return this.merged
    }
    this.observed = true
    try {
      this.merged = mergeUsageObjects(this.merged, raw)
    } catch {
      // 坏 usage 不应影响流式链路；保留上一次的合并结果
    }
    return this.merged
  }

  /** 流结束/失败时调用；同一个 meter 只会记账一次 */
  finish(success: boolean, aborted: boolean): void {
    if (this.finished) {
      return
    }
    this.finished = true
    try {
      // 请求失败且从未收到 usage：没有响应可记账，直接跳过。
      if (!this.observed && (!success || aborted)) {
        return
      }
      const record: UsageRecord = buildUsageRecord(
        this.protocol,
        this.merged,
        this.baseUrl,
        this.model,
        this.startedAt,
        { success, sessionId: this.sessionId }
      )
      UsageService.record(record)
    } catch {
      // 统计失败必须静默：聊天/Agent 流程继续
    }
  }
}

export class UsageService {
  private static ledger: UsageLedgerFile | null = null
  private static loaded: boolean = false
  private static dirty: boolean = false
  private static flushTimer: ReturnType<typeof setTimeout> | null = null
  private static hooksInstalled: boolean = false
  private static balanceRequest: Promise<UsageBalanceSnapshot> | null = null
  private static activeRuns: Map<string, UsageRunTotals> = new Map<string, UsageRunTotals>()
  private static lastRuns: Map<string, UsageRunTotals> = new Map<string, UsageRunTotals>()

  /** 本次请求的记账器。构造本身不碰磁盘，开销可忽略。 */
  static beginRequest(config: ApiConfig, protocol: string): UsageRequestMeter {
    const startedAt: number = Date.now()
    try {
      UsageService.installFlushHooks()
    } catch {
      // ignore
    }
    return new UsageRequestMeter(config, protocol, startedAt)
  }

  /**
   * 非流式 LLM 请求（多模态解析 / 表格识别等）的直接记账入口。
   * 与聊天链路共用同一套 makes：归一化 → 计价 → 日聚合。
   */
  static recordDirect(
    baseUrl: string,
    model: string,
    protocol: string,
    startedAt: number,
    rawUsage: Record<string, Object> | null,
    success: boolean,
    sessionId: string = ''
  ): void {
    try {
      if (rawUsage === null && !success) {
        return
      }
      const record: UsageRecord = buildUsageRecord(protocol, rawUsage, baseUrl, model, startedAt, {
        success,
        sessionId
      })
      UsageService.record(record)
    } catch {
      // 静默降级
    }
  }

  /** 记账：O(1) 合入日桶，不做任何持久化序列化（落盘由防抖负责）。 */
  static record(record: UsageRecord): void {
    try {
      const ledger: UsageLedgerFile = UsageService.load()
      const dateKey: string = beijingDateKey(record.startedAt)
      const period: 'peak' | 'offpeak' = usagePeriodAt(record.startedAt)
      addUsageRecordToLedger(ledger, record, dateKey, period)

      if (record.provider === 'opencode-go') {
        const opencode = ledger.meta.opencode
        opencode.lastSeenAt = Math.max(opencode.lastSeenAt, record.startedAt)
        if (record.billingSource !== '') {
          opencode.billingSources[record.billingSource] =
            (opencode.billingSources[record.billingSource] ?? 0) + 1
        }
        if (record.opencodeWindows !== undefined && record.opencodeWindows.length > 0) {
          opencode.windows = record.opencodeWindows.slice()
        }
      }

      if (record.sessionId !== '') {
        const run: UsageRunTotals | undefined = UsageService.activeRuns.get(record.sessionId)
        if (run !== undefined) {
          run.requests += 1
          run.tokens +=
            Math.max(0, record.inputHit) +
            Math.max(0, record.inputMiss) +
            Math.max(0, record.cacheWrite) +
            Math.max(0, record.output)
          run.costUsd = roundUsd(run.costUsd + record.equivalentUsd)
          run.allowanceUsd = roundUsd(run.allowanceUsd + record.allowanceUsd)
        }
      }

      UsageService.dirty = true
      UsageService.scheduleFlush()
    } catch {
      // 统计失败必须静默
    }
  }

  /** 开始一轮任务（聊天/工作/交互），用于面板里的「本轮费用/本轮 tokens」 */
  static beginRun(sessionId: string): void {
    try {
      if (sessionId === '') {
        return
      }
      UsageService.activeRuns.set(sessionId, emptyRunTotals())
    } catch {
      // ignore
    }
  }

  /** 结束一轮任务：把本轮数字移到“最近一次”里，面板结束后仍能读到。 */
  static endRun(sessionId: string): void {
    try {
      if (sessionId === '') {
        return
      }
      const run: UsageRunTotals | undefined = UsageService.activeRuns.get(sessionId)
      if (run !== undefined) {
        UsageService.activeRuns.delete(sessionId)
        UsageService.lastRuns.set(sessionId, run)
        UsageService.trimLastRuns()
      }
    } catch {
      // ignore
    }
  }

  /** 当前/最近一轮的统计（只读副本，不落盘、不写消息） */
  static runTotals(sessionId: string): UsageRunTotals {
    try {
      if (sessionId === '') {
        return emptyRunTotals()
      }
      const run: UsageRunTotals | undefined =
        UsageService.activeRuns.get(sessionId) ?? UsageService.lastRuns.get(sessionId)
      return run === undefined ? emptyRunTotals() : { ...run }
    } catch {
      return emptyRunTotals()
    }
  }

  private static trimLastRuns(): void {
    while (UsageService.lastRuns.size > MAX_LAST_RUNS) {
      const first: string | undefined = UsageService.lastRuns.keys().next().value
      if (first === undefined) {
        break
      }
      UsageService.lastRuns.delete(first)
    }
  }

  /** 打开用量页时调用：只读内存 + 一次轻量的配置检查，不做网络请求。 */
  static async overview(): Promise<UsageOverviewDto> {
    let ledger: UsageLedgerFile = UsageService.load()
    let dto: UsageOverviewDto
    try {
      dto = buildUsageOverview(ledger, Date.now())
    } catch {
      // 账本结构损坏：退回空账本继续渲染，不能让整页报错
      ledger = createEmptyUsageLedger()
      UsageService.ledger = ledger
      UsageService.loaded = true
      dto = buildUsageOverview(ledger, Date.now())
    }
    try {
      const config: ApiConfig | null = await UsageService.findDeepSeekConfig()
      dto.balance.configured = config !== null
    } catch {
      dto.balance.configured = false
    }
    return dto
  }

  /** 生成 CSV 文本（不落盘；落盘/分享由平台宿主完成） */
  static buildCsv(providerFilter: UsageProviderFilter = 'all'): string {
    try {
      const ledger: UsageLedgerFile = UsageService.load()
      return buildUsageCsv(ledger, providerFilter, ledger.exchangeRate || USD_CNY_RATE)
    } catch {
      return '\ufeff日期,服务商,模型,时段,请求数\r\n'
    }
  }

  /**
   * DeepSeek 余额对账。
   * throttle=true（页面打开）时，距上次尝试不足 10 分钟直接返回快照；
   * 用户手动点刷新传 force=true 才立即请求。没有 Key 时绝不发网络请求。
   */
  static async refreshBalance(force: boolean = false): Promise<UsageBalanceSnapshot> {
    const ledger: UsageLedgerFile = UsageService.load()
    try {
      const config: ApiConfig | null = await UsageService.findDeepSeekConfig()
      if (config === null) {
        ledger.meta.balance.configured = false
        return { ...ledger.meta.balance, configured: false }
      }
      ledger.meta.balance.configured = true
      const now: number = Date.now()
      if (
        !force &&
        ledger.meta.lastBalanceAttemptAt > 0 &&
        now - ledger.meta.lastBalanceAttemptAt < BALANCE_THROTTLE_MS
      ) {
        return { ...ledger.meta.balance, configured: true }
      }
      if (UsageService.balanceRequest !== null) {
        return await UsageService.balanceRequest
      }
      ledger.meta.lastBalanceAttemptAt = now
      UsageService.dirty = true
      UsageService.scheduleFlush()
      UsageService.balanceRequest = UsageService.requestDeepSeekBalance(config, now)
        .then((snapshot: UsageBalanceSnapshot): UsageBalanceSnapshot => {
          ledger.meta.balance = snapshot
          UsageService.dirty = true
          UsageService.scheduleFlush()
          return snapshot
        })
        .catch((error: Error): UsageBalanceSnapshot => {
          // 保留上一次成功快照，只把错误挂在返回值上
          const previous = ledger.meta.balance
          const failed: UsageBalanceSnapshot = {
            configured: true,
            available: previous.fetchedAt > 0 ? previous.available : false,
            infos: previous.infos ?? [],
            fetchedAt: previous.fetchedAt ?? 0,
            error: error instanceof Error ? error.message : String(error)
          }
          return failed
        })
        .finally((): void => {
          UsageService.balanceRequest = null
        })
      return await UsageService.balanceRequest
    } catch (error) {
      return {
        configured: false,
        available: false,
        infos: [],
        fetchedAt: 0,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  /** 切后台/退出时同步冲刷。失败静默，保留 dirty 以便下次重试。 */
  static flush(): void {
    try {
      if (!UsageService.loaded || !UsageService.dirty || UsageService.ledger === null) {
        return
      }
      const ledger: UsageLedgerFile = UsageService.ledger
      ledger.version = USAGE_LEDGER_VERSION
      ledger.priceTableVersion = USAGE_PRICE_TABLE_VERSION
      ledger.exchangeRate = USD_CNY_RATE
      ledger.updatedAt = Date.now()
      const json: string = JSON.stringify(ledger)
      UsageService.writeAtomic(json)
      UsageService.dirty = false
    } catch {
      // 写盘失败不影响聊天；下次 record / 退出时继续尝试
    }
  }

  /** 数据文件绝对路径（交付说明/诊断用） */
  static dataFilePath(): string {
    try {
      return filesDir() + '/' + LEDGER_RELATIVE_PATH
    } catch {
      return LEDGER_RELATIVE_PATH
    }
  }

  static installFlushHooks(): void {
    if (UsageService.hooksInstalled) {
      return
    }
    if (typeof window === 'undefined') {
      return
    }
    UsageService.hooksInstalled = true
    try {
      window.addEventListener('pagehide', (): void => UsageService.flush())
      window.addEventListener('beforeunload', (): void => UsageService.flush())
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', (): void => {
          if (document.visibilityState === 'hidden') {
            UsageService.flush()
          }
        })
      }
    } catch {
      // 环境不支持事件时忽略
    }
  }

  // ===== 内部：加载 / 写盘 =====

  private static load(): UsageLedgerFile {
    if (UsageService.loaded && UsageService.ledger !== null) {
      return UsageService.ledger
    }
    const ledger: UsageLedgerFile = createEmptyUsageLedger()
    UsageService.ledger = ledger
    UsageService.loaded = true
    try {
      UsageService.installFlushHooks()
      const path: string = UsageService.dataFilePath()
      if (!fileIo.accessSync(path)) {
        return ledger
      }
      const raw: string = fileIo.readTextSync(path)
      if (raw.trim() === '') {
        return ledger
      }
      const parsed: Object = JSON.parse(raw)
      const record: Record<string, Object> | null = asRecord(parsed)
      if (record === null) {
        return ledger
      }
      const days: Object = record['days']
      if (typeof days === 'object' && days !== null && !(days instanceof Array)) {
        ledger.days = days as UsageLedgerFile['days']
      }
      const totals: Record<string, Object> | null = asRecord(record['totals'])
      if (totals !== null) {
        ledger.totals = totals as unknown as UsageLedgerFile['totals']
      }
      const providerTotals: Record<string, Object> | null = asRecord(record['providerTotals'])
      if (providerTotals !== null) {
        ledger.providerTotals = providerTotals as unknown as UsageLedgerFile['providerTotals']
      }
      const meta: Record<string, Object> | null = asRecord(record['meta'])
      if (meta !== null) {
        const opencode: Record<string, Object> | null = asRecord(meta['opencode'])
        if (opencode !== null) {
          ledger.meta.opencode.lastSeenAt = numeric(opencode['lastSeenAt'])
          const sources: Record<string, Object> | null = asRecord(opencode['billingSources'])
          if (sources !== null) {
            const out: Record<string, number> = {}
            for (const key of Object.keys(sources)) {
              out[key] = numeric(sources[key])
            }
            ledger.meta.opencode.billingSources = out
          }
          const windows: Object = opencode['windows']
          if (windows instanceof Array) {
            ledger.meta.opencode.windows = windows as unknown as UsageLedgerFile['meta']['opencode']['windows']
          }
        }
        const balance: Record<string, Object> | null = asRecord(meta['balance'])
        if (balance !== null) {
          ledger.meta.balance = {
            configured: balance['configured'] === true,
            available: balance['available'] === true,
            infos: balance['infos'] instanceof Array
              ? (balance['infos'] as unknown as UsageBalanceInfo[])
              : [],
            fetchedAt: numeric(balance['fetchedAt']),
            error: typeof balance['error'] === 'string' ? (balance['error'] as string) : ''
          }
        }
        ledger.meta.lastBalanceAttemptAt = numeric(meta['lastBalanceAttemptAt'])
      }
      // 缺 totals 或旧文件：从日桶重算（最多 400 天，打开时一次）
      if (ledger.totals === undefined || ledger.totals === null ||
        typeof ledger.totals.requests !== 'number') {
        recomputeUsageTotals(ledger)
      }
      const exchange: number = numeric(record['exchangeRate'])
      ledger.exchangeRate = exchange > 0 ? exchange : USD_CNY_RATE
      ledger.priceTableVersion =
        typeof record['priceTableVersion'] === 'string'
          ? (record['priceTableVersion'] as string)
          : USAGE_PRICE_TABLE_VERSION
      const version: number = numeric(record['version'])
      ledger.version = version > 0 ? version : USAGE_LEDGER_VERSION
      const today: string = beijingDateKey(Date.now())
      if (cropUsageLedger(ledger, today, USAGE_KEEP_DAYS) > 0) {
        UsageService.dirty = true
      }
    } catch {
      // 文件损坏/权限问题 → 用空账本继续；不阻塞聊天
      UsageService.ledger = ledger
      UsageService.loaded = true
    }
    return ledger
  }

  private static scheduleFlush(): void {
    if (UsageService.flushTimer !== null) {
      return
    }
    UsageService.flushTimer = setTimeout((): void => {
      UsageService.flushTimer = null
      UsageService.flush()
    }, FLUSH_DEBOUNCE_MS)
    const timer = UsageService.flushTimer as unknown as { unref?: () => void }
    timer.unref?.()
  }

  private static writeAtomic(json: string): void {
    const path: string = UsageService.dataFilePath()
    const slash: number = path.lastIndexOf('/')
    if (slash > 0) {
      fileIo.mkdirSync(path.substring(0, slash), true)
    }
    const tmp: string = path + '.tmp'
    const bytes: Uint8Array = new util.TextEncoder().encode(json)
    let renamed: boolean = false
    try {
      const file: fileIo.File = fileIo.openSync(
        tmp,
        fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC
      )
      try {
        fileIo.writeSync(file.fd, bytes)
      } finally {
        fileIo.closeSync(file.fd)
      }
      try {
        fileIo.renameSync(tmp, path)
      } catch {
        if (fileIo.accessSync(path)) {
          fileIo.unlinkSync(path)
        }
        fileIo.renameSync(tmp, path)
      }
      renamed = true
    } catch {
      try {
        if (fileIo.accessSync(tmp)) {
          fileIo.unlinkSync(tmp)
        }
      } catch {
        // ignore
      }
    }
    if (!renamed) {
      const file: fileIo.File = fileIo.openSync(
        path,
        fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC
      )
      try {
        fileIo.writeSync(file.fd, bytes)
      } finally {
        fileIo.closeSync(file.fd)
      }
    }
  }

  // ===== 内部：余额 =====

  private static async findDeepSeekConfig(): Promise<ApiConfig | null> {
    try {
      const ctx = appContext()
      const profiles: ApiProfile[] = await StorageManager.loadApiProfiles(ctx).catch(
        (): ApiProfile[] => []
      )
      const current: ApiConfig | null = await StorageManager.loadApiConfig(ctx).catch(
        (): ApiConfig | null => null
      )
      for (const profile of profiles) {
        const config: ApiConfig = profile.apiConfig
        if (detectUsageProvider(config.baseUrl) === 'deepseek' && config.apiKey.trim() !== '') {
          return config
        }
      }
      if (
        current !== null &&
        detectUsageProvider(current.baseUrl) === 'deepseek' &&
        current.apiKey.trim() !== ''
      ) {
        return current
      }
      return null
    } catch {
      return null
    }
  }

  private static async requestDeepSeekBalance(
    config: ApiConfig,
    now: number
  ): Promise<UsageBalanceSnapshot> {
    const originMatch: RegExpExecArray | null = /^(https?:\/\/[^/]+)/i.exec(config.baseUrl.trim())
    if (originMatch === null) {
      throw new Error('DeepSeek Base URL 无效')
    }
    const url: string = originMatch[1] + '/user/balance'
    const request: http.HttpRequest = http.createHttp()
    try {
      const resp: http.HttpResponse = await request.request(url, {
        method: http.RequestMethod.GET,
        header: {
          'Authorization': 'Bearer ' + config.apiKey,
          'Accept': 'application/json'
        },
        readTimeout: BALANCE_TIMEOUT_MS
      })
      if (resp.responseCode < 200 || resp.responseCode >= 300) {
        throw new Error('余额接口返回 ' + resp.responseCode.toString())
      }
      let parsed: Record<string, Object> | null = null
      if (typeof resp.result === 'string') {
        parsed = asRecord(JSON.parse(resp.result) as Object)
      } else {
        parsed = asRecord(resp.result as Object)
      }
      if (parsed === null) {
        throw new Error('余额接口返回为空')
      }
      const infos: UsageBalanceInfo[] = []
      const rawInfos: Object = parsed['balance_infos']
      if (rawInfos instanceof Array) {
        for (const item of rawInfos as Object[]) {
          const info: Record<string, Object> | null = asRecord(item)
          if (info === null) {
            continue
          }
          infos.push({
            currency: typeof info['currency'] === 'string' ? (info['currency'] as string) : 'CNY',
            totalBalance: numeric(info['total_balance']),
            grantedBalance: numeric(info['granted_balance']),
            toppedUpBalance: numeric(info['topped_up_balance'])
          })
        }
      }
      return {
        configured: true,
        available: parsed['is_available'] === true,
        infos,
        fetchedAt: now,
        error: ''
      }
    } finally {
      try {
        request.destroy()
      } catch {
        // ignore
      }
    }
  }
}

// 移动端（WebView）切后台/退出时冲刷；桌面端由主进程 will-quit 调用 flush()。
UsageService.installFlushHooks()
