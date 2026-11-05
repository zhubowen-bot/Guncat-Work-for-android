// 中国法定节假日表（按北京时间日期，全天按空闲计费）。
//
// 口径与 DeepSeek 官方一致：高峰只落在周一至周五的 09:00–12:00 / 14:00–18:00，
// 法定节假日全天按空闲；调休上班的周末**仍然按周末空闲**（DeepSeek 的规则就是
// Monday-Friday，不按“调休工作日”反推）。
//
// 覆盖 2024–2026：2026 年安排来自国办发明电〔2025〕7 号。2027 年及以后的通知
// 尚未发布，缺失年份按“工作日高峰”保守估算（会略微高估费用，不会低估），页面底部
// 会明确注明这一点。

interface HolidaySpan {
  start: string
  end: string
  name: string
}

const HOLIDAY_SPANS: HolidaySpan[] = [
  // 2024
  { start: '2024-01-01', end: '2024-01-01', name: '元旦' },
  { start: '2024-02-10', end: '2024-02-17', name: '春节' },
  { start: '2024-04-04', end: '2024-04-06', name: '清明节' },
  { start: '2024-05-01', end: '2024-05-05', name: '劳动节' },
  { start: '2024-06-08', end: '2024-06-10', name: '端午节' },
  { start: '2024-09-15', end: '2024-09-17', name: '中秋节' },
  { start: '2024-10-01', end: '2024-10-07', name: '国庆节' },
  // 2025
  { start: '2025-01-01', end: '2025-01-01', name: '元旦' },
  { start: '2025-01-28', end: '2025-02-04', name: '春节' },
  { start: '2025-04-04', end: '2025-04-06', name: '清明节' },
  { start: '2025-05-01', end: '2025-05-05', name: '劳动节' },
  { start: '2025-05-31', end: '2025-06-02', name: '端午节' },
  { start: '2025-10-01', end: '2025-10-08', name: '国庆节·中秋节' },
  // 2026（国办发明电〔2025〕7 号）
  { start: '2026-01-01', end: '2026-01-03', name: '元旦' },
  { start: '2026-02-15', end: '2026-02-23', name: '春节' },
  { start: '2026-04-04', end: '2026-04-06', name: '清明节' },
  { start: '2026-05-01', end: '2026-05-05', name: '劳动节' },
  { start: '2026-06-19', end: '2026-06-21', name: '端午节' },
  { start: '2026-09-25', end: '2026-09-27', name: '中秋节' },
  { start: '2026-10-01', end: '2026-10-07', name: '国庆节' }
]

function pad2(value: number): string {
  return value < 10 ? '0' + value.toString() : value.toString()
}

function keyOfUtcMs(ms: number): string {
  const date: Date = new Date(ms)
  return (
    date.getUTCFullYear().toString() +
    '-' +
    pad2(date.getUTCMonth() + 1) +
    '-' +
    pad2(date.getUTCDate())
  )
}

function dayMs(key: string): number {
  const year: number = Number(key.substring(0, 4))
  const month: number = Number(key.substring(5, 7))
  const day: number = Number(key.substring(8, 10))
  return Date.UTC(year, month - 1, day)
}

function buildHolidaySet(): Set<string> {
  const set: Set<string> = new Set<string>()
  for (const span of HOLIDAY_SPANS) {
    const end: number = dayMs(span.end)
    let cursor: number = dayMs(span.start)
    // 防御坏数据：跨度最多 31 天，避免异常输入把启动拖住
    let guard: number = 0
    while (cursor <= end && guard < 31) {
      set.add(keyOfUtcMs(cursor))
      cursor += 86400000
      guard++
    }
  }
  return set
}

const HOLIDAY_SET: Set<string> = buildHolidaySet()

/** 节假日表覆盖的年份范围（页面底部要如实展示） */
export const HOLIDAY_COVERAGE = {
  fromYear: 2024,
  toYear: 2026,
  note:
    '内置 2024–2026 年中国法定节假日；2027 年及以后尚未公布，缺失年份按工作日高峰保守估算。'
}

/** 某天（北京时间 YYYY-MM-DD）是否为法定节假日 */
export function isChineseHoliday(dateKey: string): boolean {
  return HOLIDAY_SET.has(dateKey)
}

/** 该年份是否已有节假日数据；false 表示页面需要提示“按工作日保守估算” */
export function hasHolidayDataForYear(year: number): boolean {
  return year >= HOLIDAY_COVERAGE.fromYear && year <= HOLIDAY_COVERAGE.toYear
}
