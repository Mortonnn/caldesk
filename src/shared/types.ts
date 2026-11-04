/**
 * caldesk 领域模型。
 *
 * 设计约束：字段语义与「日历清单 CalendarTask」的 MCP 工具对齐，
 * 这样外部 agent（Codex / WorkBuddy 等）换到本应用后话术与调用习惯不变：
 *  - 日格任务（day cell）= 某天格子里的多行文本，完成用 Markdown 删除线 `~~text~~`
 *  - 事件（event）= 带时间的实体，kind 区分 重复任务 / 提醒 / 倒数日
 *  - 便签（note）= 独立窗口的富文本
 */

export type ISODate = string // YYYY-MM-DD
export type ISODateTime = string // ISO 8601 带时区偏移

export type EventKind = 'task' | 'reminder' | 'countdown'

export interface CalendarMeta {
  id: string
  name: string
  color: string
  sort: number
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}

export interface DayCell {
  /** 稳定主键：`${calendarId}:${date}`，便于跨设备合并 */
  id: string
  calendarId: string
  date: ISODate
  /** 整格 Markdown 文本；一行一个任务；完成 = `~~...~~` */
  text: string
  /** 背景色，null 表示跟随日历 */
  color: string | null
  updatedAt: number
  deletedAt: number | null
}

export interface CalendarEvent {
  id: string
  calendarId: string
  kind: EventKind
  title: string
  notes: string | null
  allDay: boolean
  /** 首次开始时间 */
  start: ISODateTime
  end: ISODateTime | null
  /** RFC 5545 RRULE，如 FREQ=WEEKLY;BYDAY=WE */
  rrule: string | null
  /** kind=reminder 时的提前分钟数 */
  remindMinutes: number | null
  /** kind=countdown 时的目标日期 */
  targetDate: ISODate | null
  color: string | null
  /** 非重复事件是否完成 */
  completed: boolean
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}

/** 重复事件的单次完成记录 */
export interface EventDone {
  eventId: string
  occurrenceDate: ISODate
  updatedAt: number
}

/** 某一天展开出来的一个事件实例 */
export interface EventOccurrence {
  event: CalendarEvent
  date: ISODate
  done: boolean
}

/** 新建事件入参 */
export interface EventInput {
  /** 可选：指定主键。迁移/导入时用旧 id 保证幂等，重复导入不会产生重复事件 */
  id?: string
  calendarId: string
  kind: EventKind
  title: string
  /** YYYY-MM-DD 或带时间的 ISO 字符串 */
  start: string
  allDay?: boolean
  rrule?: string | null
  remindMinutes?: number | null
  targetDate?: ISODate | null
  color?: string | null
  notes?: string | null
}

export interface Note {
  id: string
  calendarId: string
  title: string
  content: string
  pinned: boolean
  color: string | null
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}

export interface NoteInput {
  calendarId: string
  title?: string
  content: string
  pinned?: boolean
  color?: string | null
}

/** 搜索结果条目 */
export interface SearchHit {
  type: 'task' | 'event' | 'note'
  calendarId: string
  calendarName: string
  /** 任务/事件为日期；便签为最后修改日 */
  date: string
  title: string
  /** 命中行在日格中的行号（仅任务） */
  lineIndex?: number
  eventId?: string
  noteId?: string
}

/** 日格文本 <-> 行 的转换工具 */
export function splitLines(text: string): string[] {
  if (!text) return []
  return text.split(/\r?\n/)
}

export function isDoneLine(line: string): boolean {
  return /^~~.*~~$/.test(line.trim())
}

export function lineText(line: string): string {
  return line.trim().replace(/^~~/, '').replace(/~~$/, '')
}

export function markDone(line: string, done: boolean): string {
  const plain = lineText(line)
  return done ? `~~${plain}~~` : plain
}

/* ------------------------------ 同步协议 ------------------------------ */

export type SyncTable =
  | 'calendars'
  | 'day_cells'
  | 'events'
  | 'event_done'
  | 'event_skip'
  | 'notes'

/** 一条待推送的变更。LWW：updatedAt 大者胜，相等时 deviceId 字典序大者胜 */
export interface SyncChange {
  table: SyncTable
  id: string
  /** 行快照（删除时为删除墓碑） */
  payload: unknown
  updatedAt: number
  deviceId: string
}

export interface SyncPushRequest {
  deviceId: string
  changes: SyncChange[]
}

export interface SyncPushResponse {
  ok: true
  /** 服务端已接受的 id 水位 */
  accepted: number
}

export interface SyncPullResponse {
  changes: SyncChange[]
  /** 下次增量拉取的游标 */
  cursor: number
}

export interface SyncState {
  deviceId: string
  cursor: number
  lastPushAt: number | null
  lastPullAt: number | null
}

/* ------------------------------ 本地回滚 ------------------------------ */

/** 一条回滚记录的摘要（不含行数据，避免列表接口负载过大） */
export interface SnapshotMeta {
  id: string
  label: string
  /** 覆盖的行数 */
  count: number
  /** 涉及的表名，去重 */
  tables: string[]
  createdAt: number
  updatedAt: number
  /** 当前停在这个时间点上 */
  current: boolean
}

export interface RestoreResult {
  restored: number
  deleted: number
  failed: number
}
