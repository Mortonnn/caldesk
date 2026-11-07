/**
 * RRULE 展开器（RFC 5545 的常用子集）—— Worker 侧副本。
 *
 * 为什么是副本而不是直接 import 仓库根的 src/shared/rrule：
 * Cloudflare Workers Builds 的根目录设成 worker/，构建上下文里没有仓库根的
 * src/，跨目录 import 会让线上构建失败。同理，本文件与桌面端那份实现保持
 * 行为一致（改一边记得改另一边）。
 *
 * 只依赖纯计算，不引第三方包。
 * 日期一律按"日历日"处理：内部用 UTC 毫秒做加减，避免夏令时把 24h 算成 23/25h。
 *
 * 支持：FREQ=DAILY|WEEKLY|MONTHLY|YEARLY，INTERVAL，COUNT，UNTIL，
 *      BYDAY（每周几），BYMONTHDAY（每月几号）。
 */

type Frequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'

interface RruleParts {
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

function parseRrule(rule: string): RruleParts {
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
function weekdayOf(n: number): number {
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

/**
 * 展开重复事件在 [rangeStart, rangeEnd] 内（含端点）的日期。
 * COUNT 从事件首次开始日算起，与 RFC 一致。
 */
export function expandRrule(
  rule: string,
  startDate: string,
  rangeStart: string,
  rangeEnd: string,
  options: { maxOccurrences?: number } = {}
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
