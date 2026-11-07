/**
 * RRULE 展开器（RFC 5545 的常用子集）。
 *
 * 只依赖纯计算，不引第三方库，因此主进程、渲染层、Cloudflare Worker 都能复用。
 * 日期一律按"日历日"处理：内部用 UTC 毫秒做加减，避免夏令时把 24h 算成 23/25h。
 *
 * 支持：FREQ=DAILY|WEEKLY|MONTHLY|YEARLY，INTERVAL，COUNT，UNTIL，
 *      BYDAY（每周几），BYMONTHDAY（每月几号）。
 * 不支持（遇到会忽略并保持基础频率）：BYSETPOS、BYMONTH、BYYEARDAY、WKST 变更等。
 */

export type Frequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'

export interface RruleParts {
  freq: Frequency
  interval: number
  count: number | null
  /** YYYY-MM-DD，含当天 */
  until: string | null
  /** 0=周一 … 6=周日 */
  byday: number[] | null
  bymonthday: number[] | null
}

const WEEKDAY_CODES: Record<string, number> = {
  MO: 0,
  TU: 1,
  WE: 2,
  TH: 3,
  FR: 4,
  SA: 5,
  SU: 6
}

export function parseRrule(rule: string): RruleParts {
  const out: RruleParts = {
    freq: 'DAILY',
    interval: 1,
    count: null,
    until: null,
    byday: null,
    bymonthday: null
  }
  for (const chunk of rule.split(';')) {
    const [rawKey, rawValue] = chunk.split('=')
    if (!rawKey || rawValue === undefined) continue
    const key = rawKey.trim().toUpperCase()
    const value = rawValue.trim().toUpperCase()
    switch (key) {
      case 'FREQ':
        if (value === 'DAILY' || value === 'WEEKLY' || value === 'MONTHLY' || value === 'YEARLY') {
          out.freq = value
        }
        break
      case 'INTERVAL': {
        const n = Number(value)
        if (Number.isFinite(n) && n >= 1) out.interval = Math.floor(n)
        break
      }
      case 'COUNT': {
        const n = Number(value)
        if (Number.isFinite(n) && n >= 1) out.count = Math.floor(n)
        break
      }
      case 'UNTIL':
        out.until = normalizeUntil(value)
        break
      case 'BYDAY':
        out.byday = value
          .split(',')
          .map((code) => WEEKDAY_CODES[code.slice(-2)])
          .filter((v): v is number => typeof v === 'number')
        if (out.byday.length === 0) out.byday = null
        break
      case 'BYMONTHDAY':
        out.bymonthday = value
          .split(',')
          .map((v) => Number(v))
          .filter((v) => Number.isInteger(v) && v !== 0)
        if (out.bymonthday.length === 0) out.bymonthday = null
        break
      default:
        break
    }
  }
  return out
}

/** UNTIL 可能是 20261231T235959Z 或 2026-12-31，统一成 YYYY-MM-DD */
function normalizeUntil(value: string): string | null {
  const compact = /^(\d{4})(\d{2})(\d{2})/.exec(value)
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`
  const dashed = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  if (dashed) return `${dashed[1]}-${dashed[2]}-${dashed[3]}`
  return null
}

/* ------------------------------ 日期工具 ------------------------------ */

const DAY_MS = 86_400_000

export function toDayNumber(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!m) throw new Error(`非法日期：${iso}`)
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS
}

export function fromDayNumber(n: number): string {
  const d = new Date(n * DAY_MS)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 0=周一 … 6=周日 */
export function weekdayOf(n: number): number {
  // 1970-01-01 是周四：getUTCDay() 0=周日 → 转成周一起算
  return ((n + 3) % 7 + 7) % 7
}

function monthIndexOf(n: number): number {
  const d = new Date(n * DAY_MS)
  return d.getUTCFullYear() * 12 + d.getUTCMonth()
}

function dayOfMonth(n: number): number {
  return new Date(n * DAY_MS).getUTCDate()
}

/* ------------------------------ 展开 ------------------------------ */

export interface ExpandOptions {
  /** 展开上限，防止异常规则导致死循环 */
  maxOccurrences?: number
}

/**
 * 展开重复事件在 [rangeStart, rangeEnd] 内（含端点）的日期。
 * COUNT 从事件首次开始日算起，与 RFC 一致。
 */
export function expandRrule(
  rule: string,
  startDate: string,
  rangeStart: string,
  rangeEnd: string,
  options: ExpandOptions = {}
): string[] {
  const parts = parseRrule(rule)
  const start = toDayNumber(startDate)
  const from = toDayNumber(rangeStart)
  const to = toDayNumber(rangeEnd)
  const until = parts.until ? toDayNumber(parts.until) : null
  const maxOccurrences = options.maxOccurrences ?? 1000

  const result: string[] = []
  let seen = 0
  let day = start
  // 采样上限：正向逐日扫描，最多扫描 50 年，避免病态输入
  const hardStop = Math.min(to, start + 366 * 50)
  const startWeekday = weekdayOf(start)
  const startMonthIndex = monthIndexOf(start)
  const startDayOfMonth = dayOfMonth(start)

  const byday = parts.byday ?? (parts.freq === 'WEEKLY' ? [startWeekday] : null)
  const bymonthday = parts.bymonthday ?? (parts.freq === 'MONTHLY' ? [startDayOfMonth] : null)

  while (day <= hardStop) {
    if (until !== null && day > until) break
    // 只在频率轴上取点，避免逐日扫描对 DAILY 也成立但语义混乱
    if (matches(day, start)) {
      seen += 1
      if (parts.count !== null && seen > parts.count) break
      if (day >= from && day <= to) result.push(fromDayNumber(day))
      if (result.length >= maxOccurrences) break
    }
    day += 1
  }

  return result

  function matches(candidate: number, origin: number): boolean {
    switch (parts.freq) {
      case 'DAILY': {
        const diff = candidate - origin
        return diff >= 0 && diff % parts.interval === 0
      }
      case 'WEEKLY': {
        if (!byday!.includes(weekdayOf(candidate))) return false
        const originWeek = origin - weekdayOf(origin)
        const candidateWeek = candidate - weekdayOf(candidate)
        const weeks = (candidateWeek - originWeek) / 7
        return weeks >= 0 && weeks % parts.interval === 0
      }
      case 'MONTHLY': {
        if (!bymonthday!.includes(dayOfMonth(candidate))) return false
        const months = monthIndexOf(candidate) - startMonthIndex
        return months >= 0 && months % parts.interval === 0
      }
      case 'YEARLY': {
        const cd = new Date(candidate * DAY_MS)
        const sd = new Date(origin * DAY_MS)
        if (cd.getUTCMonth() !== sd.getUTCMonth() || cd.getUTCDate() !== sd.getUTCDate()) return false
        const years = cd.getUTCFullYear() - sd.getUTCFullYear()
        return years >= 0 && years % parts.interval === 0
      }
      default:
        return false
    }
  }
}

/** 常用重复规则的展示文案 */
export function describeRrule(rule: string | null): string {
  if (!rule) return '不重复'
  const p = parseRrule(rule)
  const n = p.interval
  const dayNames = ['一', '二', '三', '四', '五', '六', '日']
  /**
   * 星期几的中文读法：
   *   一个 → 每周三
   *   多个 → 每周一、周三（每个都带"周"，不然"每周一、三"容易读成一和十三）
   */
  const weekly = (): string => {
    if (!p.byday || p.byday.length === 0) return '每周'
    const names = p.byday.map((d) => dayNames[d])
    return names.length === 1 ? `每周${names[0]}` : `每周${names[0]}、周${names.slice(1).join('、周')}`
  }
  /** 每 N 周：要说清是那几周的星期几，不能拼成"每 2 每周三" */
  const weeklyEvery = (every: number): string => {
    const names = p.byday?.map((d) => dayNames[d]) ?? []
    return names.length === 0 ? `每 ${every} 周` : `每 ${every} 周的周${names.join('、周')}`
  }
  switch (p.freq) {
    case 'DAILY':
      return n === 1 ? '每天' : `每 ${n} 天`
    case 'WEEKLY':
      return n === 1 ? weekly() : weeklyEvery(n)
    case 'MONTHLY':
      return n === 1 ? '每月' : `每 ${n} 个月`
    case 'YEARLY':
      return n === 1 ? '每年' : `每 ${n} 年`
    default:
      return rule
  }
}
