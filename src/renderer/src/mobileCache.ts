/**
 * 手机端的本地缓存。
 *
 * 手机端没有本地数据库，所有内容都靠 HTTP 现拉，所以：
 *   - 冷启动要等一轮网络才有东西看；
 *   - 每次写完还要再拉一次才能确认（两趟往返）。
 *
 * 这里把「上一次看到的日历 / 每个日历的日格文本 / 重复待办」存进 localStorage，
 * 启动先画缓存，再后台刷新；写操作先改本地，再把请求发出去。
 * 缓存只是显示用的快照，权威数据仍然在服务器上。
 *
 * **缓存必须按账号 + 服务器分开**（scope）。
 *
 * 只有一份 key 的时候，A 账号的内容会被 B 账号读到：换服务器地址只会把人踢回登录页，
 * 不会清缓存，下一个账号进来冷启动时先画出来的就是上一个人的任务
 * （断网时更是会一直挂在那儿）—— 这是数据串号，不是显示小瑕疵。
 * 现在每条缓存都带 scope，scope 不匹配直接当没有缓存。
 */
import type { CalendarMeta, DayCell, EventOccurrence } from '@shared/types'

const KEY = 'caldesk.cache.v1'

export interface MobileCache {
  /** 这份缓存属于哪个账号 / 哪台服务器；对不上就不用 */
  scope: string
  calendars: CalendarMeta[]
  /** 日历 id → (日期 → 文本)。只存有内容的日期 */
  cellsByCal: Record<string, Record<string, string>>
  /** 日历 id → 该日历的重复待办（事件按日历分开存，切日历才不会串） */
  eventsByCal: Record<string, EventOccurrence[]>
  /** 上次停留的日历，启动时优先恢复 */
  calId: string
  savedAt: number
}

const EMPTY: MobileCache = {
  scope: '',
  calendars: [],
  cellsByCal: {},
  eventsByCal: {},
  calId: '',
  savedAt: 0
}

/**
 * 缓存分区标识：账号 + 服务器。
 *
 * 服务器地址去掉尾斜杠再比：`https://a.dev` 和 `https://a.dev/` 是同一台服务器，
 * 不该被当成两份缓存（否则改一下地址写法，缓存就"消失"了）。
 */
export function cacheScope(id: { accountId?: string; serverUrl?: string } | null): string {
  if (!id?.accountId) return ''
  const server = (id.serverUrl ?? '').trim().replace(/\/+$/, '').toLowerCase()
  return `${id.accountId}@${server}`
}

export function loadCache(scope = ''): MobileCache {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return EMPTY
    const parsed = JSON.parse(raw) as Partial<MobileCache>
    // 老缓存没有 scope 字段：一律当成"不知道是谁的"，不画
    if (typeof parsed.scope !== 'string' || parsed.scope !== scope) return EMPTY
    return {
      scope: parsed.scope,
      calendars: Array.isArray(parsed.calendars) ? (parsed.calendars as CalendarMeta[]) : [],
      cellsByCal:
        parsed.cellsByCal && typeof parsed.cellsByCal === 'object'
          ? (parsed.cellsByCal as Record<string, Record<string, string>>)
          : {},
      eventsByCal:
        parsed.eventsByCal && typeof parsed.eventsByCal === 'object'
          ? (parsed.eventsByCal as Record<string, EventOccurrence[]>)
          : {},
      calId: typeof parsed.calId === 'string' ? parsed.calId : '',
      savedAt: Number(parsed.savedAt) || 0
    }
  } catch {
    return EMPTY
  }
}

export function saveCache(scope: string, next: Omit<MobileCache, 'savedAt' | 'scope'>): void {
  // 还没登录就没有"这份数据属于谁"可言，别往磁盘里写
  if (!scope) return
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...next, scope, savedAt: Date.now() }))
  } catch {
    /* 配额满了就放弃缓存，不影响功能 */
  }
}

export function clearCache(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* 忽略 */
  }
}

/** 缓存里的文本 → DayCell 形状（渲染只需要 date/text） */
export function cellsFromText(
  map: Record<string, string> | undefined,
  calId: string
): Record<string, DayCell> {
  const out: Record<string, DayCell> = {}
  for (const [date, text] of Object.entries(map ?? {})) {
    if (typeof text !== 'string') continue
    out[date] = {
      id: `${calId}:${date}`,
      calendarId: calId,
      date,
      text,
      color: null,
      updatedAt: 0,
      deletedAt: null
    }
  }
  return out
}

/** 当前日格 → 缓存里的文本表（只留有内容的） */
export function textFromCells(cells: Record<string, DayCell>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [date, cell] of Object.entries(cells)) {
    if (cell?.text && cell.text.trim()) out[date] = cell.text
  }
  return out
}
