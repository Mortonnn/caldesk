/**
 * 本地数据层：使用 Electron 内置的 node:sqlite（零原生依赖）。
 *
 * 说明：@types/node 22.20 已经在 sqlite.d.ts 里声明了 node:sqlite，所以这里直接
 * import，不再用 require 绕类型。StatementSync.get()/all() 声明成
 * Record<string, SQLOutputValue>，比 Row 窄，下面那层薄接口把它统一收窄一次，
 * 免得每处 SQL 调用都写一遍类型断言。
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  CalendarEvent,
  CalendarMeta,
  DayCell,
  EventInput,
  EventKind,
  EventOccurrence,
  Note,
  NoteInput,
  RestoreResult,
  SearchHit,
  SnapshotMeta
} from '@shared/types'
import { CALENDAR_COLORS, isDoneLine, lineText, markDone, splitLines, nextCalendarColor } from '@shared/types'
import { expandRrule, fromDayNumber, parseRrule, toDayNumber } from '@shared/rrule'

type Row = Record<string, unknown>

interface StatementLike {
  run(...params: unknown[]): { changes?: number | bigint }
  get(...params: unknown[]): Row | undefined
  all(...params: unknown[]): Row[]
}

interface DatabaseLike {
  exec(sql: string): void
  prepare(sql: string): StatementLike
  close(): void
}

function openDatabase(path: string): DatabaseLike {
  return new DatabaseSync(path) as unknown as DatabaseLike
}

let db: DatabaseLike | null = null
/** 当前打开的库文件：换数据目录时要重开，不能默默沿用旧库（测试与 --user-data 都会踩到） */
let dbPath: string | null = null

const DDL = `
CREATE TABLE IF NOT EXISTS calendars (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS day_cells (
  id          TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL,
  date        TEXT NOT NULL,
  text        TEXT NOT NULL DEFAULT '',
  color       TEXT,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_day_cells_lookup ON day_cells (calendar_id, date);

CREATE TABLE IF NOT EXISTS events (
  id             TEXT PRIMARY KEY,
  calendar_id    TEXT NOT NULL,
  kind           TEXT NOT NULL,
  title          TEXT NOT NULL,
  notes          TEXT,
  all_day        INTEGER NOT NULL DEFAULT 0,
  start          TEXT NOT NULL,
  end            TEXT,
  rrule          TEXT,
  remind_minutes INTEGER,
  target_date    TEXT,
  color          TEXT,
  completed      INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  deleted_at     INTEGER
);

CREATE TABLE IF NOT EXISTS event_done (
  id              TEXT,
  event_id        TEXT NOT NULL,
  occurrence_date TEXT NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER,
  PRIMARY KEY (event_id, occurrence_date)
);

CREATE TABLE IF NOT EXISTS event_skip (
  id              TEXT,
  event_id        TEXT NOT NULL,
  occurrence_date TEXT NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER,
  PRIMARY KEY (event_id, occurrence_date)
);

CREATE TABLE IF NOT EXISTS notes (
  id          TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL DEFAULT '',
  pinned      INTEGER NOT NULL DEFAULT 0,
  color       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER
);

CREATE TABLE IF NOT EXISTS snapshots (
  id         TEXT PRIMARY KEY,
  account    TEXT NOT NULL DEFAULT 'local',
  label      TEXT NOT NULL,
  entries    TEXT NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_recent ON snapshots (account, updated_at DESC);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

/** 首次启动的内置视图：只保留工作与生活 */
const DEFAULT_CALENDARS: Array<{ name: string; color: string }> = [
  { name: '工作', color: '#5b8cff' },
  { name: '生活', color: '#3ddc97' }
]

export { CALENDAR_COLORS }

function rowToCalendar(row: Record<string, unknown>): CalendarMeta {
  return {
    id: String(row.id),
    name: String(row.name),
    color: String(row.color),
    sort: Number(row.sort),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    deletedAt: row.deleted_at === null ? null : Number(row.deleted_at)
  }
}

export function initDb(userDataDir: string): void {
  const file = join(userDataDir, 'caldesk.db')
  // 同一个库重复调用直接返回（幂等）；换了目录就把旧库关掉重开，
  // 否则"换数据目录"会静默继续用上一个库。
  if (db && dbPath === file) return
  if (db) closeDb()
  mkdirSync(userDataDir, { recursive: true })
  db = openDatabase(file)
  dbPath = file
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec(DDL)
  migrateEventDone()
  migrateEventSkip()
  seedIfEmpty()
}

/**
 * 事务包装：多表写入必须全成或全不成。
 * 同步 API，可以用 savepoint 嵌套（回滚内部再调 recordSnapshot 也是安全的）。
 * savepoint 名固定：SQLite 允许同名嵌套，RELEASE / ROLLBACK TO 作用于最内层，
 * 既不用拼名字（SQL 里就不出现变量），也不怕嵌套层数。
 */
const TX_SAVEPOINT = 'sp_caldesk'

function tx<T>(run: () => T): T {
  const conn = requireDb()
  if (txDepth === 0) conn.exec('BEGIN')
  else conn.exec(`SAVEPOINT ${TX_SAVEPOINT}`)
  txDepth += 1
  try {
    const out = run()
    txDepth -= 1
    if (txDepth === 0) conn.exec('COMMIT')
    else conn.exec(`RELEASE ${TX_SAVEPOINT}`)
    return out
  } catch (err) {
    txDepth -= 1
    try {
      if (txDepth === 0) conn.exec('ROLLBACK')
      else conn.exec(`ROLLBACK TO ${TX_SAVEPOINT}`)
    } catch {
      /* 事务已经被 SQLite 自己回滚掉了 */
    }
    throw err
  }
}

let txDepth = 0

/** 分页参数兜底：NaN / Infinity / 小数都会让 SQLite 的 LIMIT 报 datatype mismatch */
function clampLimit(limit: number, fallback: number, max: number): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return fallback
  return Math.min(Math.max(1, Math.trunc(limit)), max)
}

/**
 * event_done 早期版本没有 id / deleted_at 列：
 *  - id：同步需要稳定的行主键；
 *  - deleted_at：取消完成也是"改状态"，删行会让同步另一端永远停在"已完成"。
 */
function migrateEventDone(): void {
  const conn = requireDb()
  const cols = conn.prepare('PRAGMA table_info(event_done)').all() as Array<{ name?: string }>
  if (!cols.some((c) => c.name === 'id')) {
    conn.exec('ALTER TABLE event_done ADD COLUMN id TEXT')
  }
  if (!cols.some((c) => c.name === 'deleted_at')) {
    conn.exec('ALTER TABLE event_done ADD COLUMN deleted_at INTEGER')
  }
  conn.exec(
    `UPDATE event_done SET id = event_id || ':' || occurrence_date
     WHERE id IS NULL OR id = ''`
  )
  // 索引必须放在补列之后：老库没有 id 列时，直接建索引会抛 "no such column: id"
  conn.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_event_done_id ON event_done (id)')
}

/**
 * event_skip 迁移：补行主键 + 补 deleted_at。
 *
 *  - id：它要参与同步，且回滚记录按 id 定位行（形状与 migrateEventDone 一致）。
 *  - deleted_at：撤销「仅删除这天」时不能把行硬删 —— 删了以后同步没有墓碑，
 *    别的设备下次拉取会把这天的跳过状态"忘掉"，那一条又冒出来了。
 *    跟 events 一样用软删除，列表查询按 deleted_at IS NULL 过滤。
 */
function migrateEventSkip(): void {
  const conn = requireDb()
  const cols = conn.prepare('PRAGMA table_info(event_skip)').all() as Array<{ name?: string }>
  const hasId = cols.some((c) => c.name === 'id')
  if (!hasId) {
    conn.exec('ALTER TABLE event_skip ADD COLUMN id TEXT')
  }
  if (!cols.some((c) => c.name === 'deleted_at')) {
    conn.exec('ALTER TABLE event_skip ADD COLUMN deleted_at INTEGER')
  }
  conn.exec(
    `UPDATE event_skip SET id = event_id || ':' || occurrence_date
     WHERE id IS NULL OR id = ''`
  )
  conn.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_event_skip_id ON event_skip (id)')
}

function requireDb(): DatabaseLike {
  if (!db) throw new Error('数据库尚未初始化')
  return db
}

function seedIfEmpty(): void {
  const conn = requireDb()
  // 只数"活着"的视图：别的设备把视图全删了再同步过来时，只剩墓碑，
  // 这时候启动必须补回内置视图，否则界面一个视图都没有（activeCal 为空，整屏不可用）。
  const row = conn.prepare('SELECT COUNT(*) AS n FROM calendars WHERE deleted_at IS NULL').get()
  const count = Number(row?.n ?? 0)
  if (count > 0) return

  const now = Date.now()
  DEFAULT_CALENDARS.forEach((cal, index) => {
    conn
      .prepare(
        `INSERT INTO calendars (id, name, color, sort, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(randomUUID(), cal.name, cal.color, index, now, now)
  })
}

export function listCalendars(): CalendarMeta[] {
  const rows = requireDb()
    .prepare(
      `SELECT * FROM calendars WHERE deleted_at IS NULL ORDER BY sort ASC, created_at ASC`
    )
    .all()
  return rows.map(rowToCalendar)
}

export function createCalendar(name: string, color?: string): CalendarMeta {
  const conn = requireDb()
  const trimmed = name.trim()
  if (!trimmed) throw new Error('视图名称不能为空')
  if (trimmed.length > 24) throw new Error('视图名称最多 24 个字符')

  const dup = conn.prepare('SELECT id FROM calendars WHERE name = ? AND deleted_at IS NULL').get(trimmed)
  if (dup) throw new Error(`已存在同名视图「${trimmed}」`)

  const maxRow = conn.prepare('SELECT COALESCE(MAX(sort), -1) AS m FROM calendars').get()
  const sort = Number(maxRow?.m ?? -1) + 1

  // 配色规则和手机端共用一份（@shared）：取第一支没用过的
  const nextColor = color ?? nextCalendarColor(listCalendars().map((c) => c.color))

  const now = Date.now()
  const id = randomUUID()
  recordSnapshot('新建视图', [{ table: 'calendars', id }])
  conn
    .prepare(
      `INSERT INTO calendars (id, name, color, sort, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`
    )
    .run(id, trimmed, nextColor, sort, now, now)

  return {
    id,
    name: trimmed,
    color: nextColor,
    sort,
    createdAt: now,
    updatedAt: now,
    deletedAt: null
  }
}

export function updateCalendar(
  id: string,
  patch: { name?: string; color?: string }
): CalendarMeta[] {
  const conn = requireDb()
  const existing = conn.prepare('SELECT * FROM calendars WHERE id = ? AND deleted_at IS NULL').get(id)
  if (!existing) throw new Error('视图不存在')

  // 先校验再落库：校验失败不能留下一条"什么都没改"的回滚记录
  let name = String(existing.name)
  let color = String(existing.color)
  let changed = false
  if (patch.name !== undefined) {
    const trimmed = patch.name.trim()
    if (!trimmed) throw new Error('视图名称不能为空')
    if (trimmed.length > 24) throw new Error('视图名称最多 24 个字符')
    if (trimmed !== name) {
      // 改名和新建一样不能撞车（否则列表里会出现两个同名视图，自己都分不清）
      const dup = conn
        .prepare('SELECT id FROM calendars WHERE name = ? AND deleted_at IS NULL AND id <> ?')
        .get(trimmed, id)
      if (dup) throw new Error(`已存在同名视图「${trimmed}」`)
      name = trimmed
      changed = true
    }
  }
  if (patch.color !== undefined && patch.color !== color) {
    color = patch.color
    changed = true
  }
  if (!changed) return listCalendars()

  tx(() => {
    recordSnapshot('修改视图', [{ table: 'calendars', id }])
    conn
      .prepare('UPDATE calendars SET name = ?, color = ?, updated_at = ? WHERE id = ?')
      .run(name, color, Date.now(), id)
  })
  return listCalendars()
}

/**
 * 软删除一个视图，连带它名下的日格、事件、便签一起软删除。
 *
 * 三者必须一起走：只删日格的话，事件/便签会变成"视图没了但行还活着"的孤儿 ——
 * 界面上再也打不开，同步却一直把它们推给别的设备。
 * 多表写入包在一个事务里，任一语句失败就整体回滚，不留半截数据。
 * 回滚记录带上全部受影响的行，撤销删除时视图连同内容一起回来。
 */
export function deleteCalendar(id: string): CalendarMeta[] {
  const conn = requireDb()
  const target = conn.prepare('SELECT id FROM calendars WHERE id = ? AND deleted_at IS NULL').get(id)
  if (!target) throw new Error('视图不存在')
  const remaining = listCalendars().filter((c) => c.id !== id)
  if (remaining.length === 0) throw new Error('至少需要保留一个视图')

  const now = Date.now()
  const pairs: Array<{ table: string; id: string }> = [{ table: 'calendars', id }]
  for (const table of ['day_cells', 'events', 'notes'] as const) {
    const rows = conn
      .prepare(`SELECT id FROM ${table} WHERE calendar_id = ? AND deleted_at IS NULL`)
      .all(id)
    for (const row of rows) pairs.push({ table, id: String(row.id) })
  }

  tx(() => {
    recordSnapshot('删除视图', pairs)
    conn.prepare('UPDATE calendars SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, id)
    for (const table of ['day_cells', 'events', 'notes'] as const) {
      conn
        .prepare(`UPDATE ${table} SET deleted_at = ?, updated_at = ? WHERE calendar_id = ?`)
        .run(now, now, id)
    }
  })
  return listCalendars()
}

export function closeDb(): void {
  db?.close()
  db = null
  dbPath = null
}

/* ------------------------------ 日格任务 ------------------------------ */

const MAX_CELL_TEXT = 20_000

function cellId(calendarId: string, date: string): string {
  return `${calendarId}:${date}`
}

function assertDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`日期格式必须是 YYYY-MM-DD，收到「${date}」`)
  }
  const [y, m, d] = date.split('-').map(Number)
  const probe = new Date(y, m - 1, d)
  if (
    probe.getFullYear() !== y ||
    probe.getMonth() !== m - 1 ||
    probe.getDate() !== d
  ) {
    throw new Error(`「${date}」不是一个真实存在的日期`)
  }
}

function assertCalendar(calendarId: string): void {
  const row = requireDb()
    .prepare('SELECT id FROM calendars WHERE id = ? AND deleted_at IS NULL')
    .get(calendarId)
  if (!row) throw new Error('视图不存在或已删除')
}

function rowToCell(row: Record<string, unknown>): DayCell {
  return {
    id: String(row.id),
    calendarId: String(row.calendar_id),
    date: String(row.date),
    text: String(row.text ?? ''),
    color: row.color === null ? null : String(row.color),
    updatedAt: Number(row.updated_at),
    deletedAt: row.deleted_at === null ? null : Number(row.deleted_at)
  }
}

/** 空日返回空文本的空单元格（不落库），与旧版 items_get 行为一致 */
export function getDayCell(calendarId: string, date: string): DayCell {
  assertDate(date)
  assertCalendar(calendarId)
  const row = requireDb()
    .prepare('SELECT * FROM day_cells WHERE id = ? AND deleted_at IS NULL')
    .get(cellId(calendarId, date))
  if (row) return rowToCell(row)
  return {
    id: cellId(calendarId, date),
    calendarId,
    date,
    text: '',
    color: null,
    updatedAt: 0,
    deletedAt: null
  }
}

export function listDayCells(calendarId: string, from: string, to: string): DayCell[] {
  assertDate(from)
  assertDate(to)
  assertCalendar(calendarId)
  const rows = requireDb()
    .prepare(
      `SELECT * FROM day_cells
       WHERE calendar_id = ? AND date >= ? AND date <= ? AND deleted_at IS NULL
         AND text <> ''
       ORDER BY date ASC`
    )
    .all(calendarId, from, to)
  return rows.map(rowToCell)
}

/**
 * 写整格文本。options.snapshot=false 用于"调用方已经统一记过一条回滚记录"的场景
 * （例如跨天移动任务：两格必须落在同一条记录里，撤销时才是原子的）。
 */
function writeCellText(
  calendarId: string,
  date: string,
  text: string,
  options: { snapshot?: boolean } = {}
): DayCell {
  assertDate(date)
  assertCalendar(calendarId)
  if (text.length > MAX_CELL_TEXT) {
    throw new Error(`日格内容过长（上限 ${MAX_CELL_TEXT} 字符）`)
  }
  const now = Date.now()
  const id = cellId(calendarId, date)
  if (options.snapshot !== false) recordSnapshot('修改日格', [{ table: 'day_cells', id }])
  requireDb()
    .prepare(
      `INSERT INTO day_cells (id, calendar_id, date, text, color, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, NULL, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET
         text = excluded.text,
         updated_at = excluded.updated_at,
         deleted_at = NULL`
    )
    .run(id, calendarId, date, text, now)
  return getDayCell(calendarId, date)
}

/** 整格替换（旧版 items_set 语义） */
export function setDayCellText(calendarId: string, date: string, text: string): DayCell {
  return writeCellText(calendarId, date, text)
}

/** 追加一行（旧版 items_append_line 语义） */
export function appendDayLine(calendarId: string, date: string, text: string): DayCell {
  const line = text.trim()
  if (!line) throw new Error('任务内容不能为空')
  if (/[\r\n]/.test(text)) throw new Error('追加的任务只能是单行文本')
  const cell = getDayCell(calendarId, date)
  const lines = splitLines(cell.text)
  lines.push(line)
  return writeCellText(calendarId, date, lines.join('\n'))
}

function replaceLines(calendarId: string, date: string, lines: string[]): DayCell {
  return writeCellText(calendarId, date, lines.join('\n'))
}

function assertIndex(index: number, lines: string[]): void {
  if (!Number.isInteger(index) || index < 0 || index >= lines.length) {
    throw new Error(`行号 ${index} 超出范围（当前共 ${lines.length} 行）`)
  }
}

export function updateDayLine(
  calendarId: string,
  date: string,
  index: number,
  text: string
): DayCell {
  const next = text.trim()
  if (!next) throw new Error('任务内容不能为空')
  if (/[\r\n]/.test(text)) throw new Error('单行任务不能包含换行')
  const cell = getDayCell(calendarId, date)
  const lines = splitLines(cell.text)
  assertIndex(index, lines)
  // 保留原有的完成状态
  lines[index] = isDoneLine(lines[index]) ? `~~${lineText(next)}~~` : next
  return replaceLines(calendarId, date, lines)
}

export function deleteDayLine(calendarId: string, date: string, index: number): DayCell {
  const cell = getDayCell(calendarId, date)
  const lines = splitLines(cell.text)
  assertIndex(index, lines)
  lines.splice(index, 1)
  return replaceLines(calendarId, date, lines)
}

export function setDayLineDone(
  calendarId: string,
  date: string,
  index: number,
  done: boolean
): DayCell {
  const cell = getDayCell(calendarId, date)
  const lines = splitLines(cell.text)
  assertIndex(index, lines)
  lines[index] = markDone(lines[index], done)
  return replaceLines(calendarId, date, lines)
}

export function moveDayLine(
  calendarId: string,
  fromDate: string,
  index: number,
  toDate: string
): { moved: string; from: string; to: string } {
  const srcCell = getDayCell(calendarId, fromDate)
  const srcLines = splitLines(srcCell.text)
  assertIndex(index, srcLines)
  // 同一天"移动"就是空操作：不能把这一行挪到末尾（用户看不出发生了什么，顺序却变了）
  if (toDate === fromDate) {
    return { moved: lineText(srcLines[index]), from: fromDate, to: toDate }
  }
  // 先校验目标日期与视图（getDayCell 内部 assertDate/assertCalendar），失败时源格还没动
  const dstCell = getDayCell(calendarId, toDate)
  const [moved] = srcLines.splice(index, 1)
  const dstLines = splitLines(dstCell.text)
  dstLines.push(moved)

  // 两格写在一个事务 + 一条回滚记录里：只撤销一半会让任务变成两条
  tx(() => {
    recordSnapshot('移动任务', [
      { table: 'day_cells', id: cellId(calendarId, toDate) },
      { table: 'day_cells', id: cellId(calendarId, fromDate) }
    ])
    writeCellText(calendarId, toDate, dstLines.join('\n'), { snapshot: false })
    writeCellText(calendarId, fromDate, srcLines.join('\n'), { snapshot: false })
  })
  return { moved: lineText(moved), from: fromDate, to: toDate }
}

/* ------------------------------ 事件 ------------------------------ */

const MAX_TITLE = 200
const KINDS: EventKind[] = ['task', 'reminder', 'countdown']

function rowToEvent(row: Record<string, unknown>): CalendarEvent {
  return {
    id: String(row.id),
    calendarId: String(row.calendar_id),
    kind: String(row.kind) as EventKind,
    title: String(row.title),
    notes: row.notes === null ? null : String(row.notes),
    allDay: Number(row.all_day) === 1,
    start: String(row.start),
    end: row.end === null ? null : String(row.end),
    rrule: row.rrule === null ? null : String(row.rrule),
    remindMinutes: row.remind_minutes === null ? null : Number(row.remind_minutes),
    targetDate: row.target_date === null ? null : String(row.target_date),
    color: row.color === null ? null : String(row.color),
    completed: Number(row.completed) === 1,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    deletedAt: row.deleted_at === null ? null : Number(row.deleted_at)
  }
}

/** 从 start（可能是纯日期或 ISO 时间）取出日历日 */
function startDateOf(start: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(start)
  if (!m) throw new Error(`start 必须是 YYYY-MM-DD 或 ISO 时间，收到「${start}」`)
  assertDate(m[1])
  return m[1]
}

function assertKind(kind: string): asserts kind is EventKind {
  if (!KINDS.includes(kind as EventKind)) {
    throw new Error(`kind 必须是 task / reminder / countdown，收到「${kind}」`)
  }
}

/**
 * 校验事件入参。
 *
 * options.validateRrule=false 用于 updateEvent 的"没动 rrule"场景：
 * 老库里可能存着别的端写进来的脏规则，只改标题不该被它拦住。
 */
function validateEventInput(
  input: EventInput,
  calendarId: string,
  options: { validateRrule?: boolean } = {}
): void {
  const title = input.title.trim()
  if (!title) throw new Error('事件标题不能为空')
  if (title.length > MAX_TITLE) throw new Error(`事件标题过长（上限 ${MAX_TITLE}）`)
  assertKind(input.kind)
  assertCalendar(calendarId)
  startDateOf(input.start)
  if (input.rrule && options.validateRrule !== false) {
    // FREQ 必须是认得的那四个值：写错的规则（FREQ=BOGUS / FREQ=）在展开器里会
    // 悄悄退化成"每天"，用户看到的是"怎么天天都有"，比直接报错更难查。
    const freq = /(?:^|;)\s*FREQ=([A-Za-z]+)/i.exec(input.rrule)
    if (!freq) throw new Error('rrule 必须包含 FREQ=DAILY|WEEKLY|MONTHLY|YEARLY')
    if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq[1].toUpperCase())) {
      throw new Error(`rrule 的 FREQ 只能是 DAILY/WEEKLY/MONTHLY/YEARLY，收到「${freq[1]}」`)
    }
    const p = parseRrule(input.rrule)
    if (p.interval > 999) throw new Error('重复间隔过大')
  }
  if (input.remindMinutes !== null && input.remindMinutes !== undefined) {
    if (!Number.isInteger(input.remindMinutes) || input.remindMinutes < 0 || input.remindMinutes > 10080) {
      throw new Error('提醒提前量必须是 0–10080 分钟')
    }
  }
  if (input.kind === 'reminder' && input.rrule && input.targetDate) {
    throw new Error('提醒事件不能同时带 targetDate')
  }
  if (input.kind === 'countdown') {
    if (!input.targetDate) throw new Error('倒数日必须提供 targetDate')
    assertDate(input.targetDate)
    if (input.rrule) throw new Error('倒数日不支持重复规则（它本身就是持续显示的目标）')
  }
}

export function createEvent(input: EventInput): CalendarEvent {
  validateEventInput(input, input.calendarId)
  const now = Date.now()
  const id = input.id ?? randomUUID()
  // 新建时该行通常还不存在 → 记录成 data:null，撤销即删除
  recordSnapshot('新建事件', [{ table: 'events', id }])
  requireDb()
    .prepare(
      `INSERT INTO events (id, calendar_id, kind, title, notes, all_day, start, end, rrule,
                           remind_minutes, target_date, color, completed, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 0, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET
         calendar_id    = excluded.calendar_id,
         kind           = excluded.kind,
         title          = excluded.title,
         notes          = excluded.notes,
         all_day        = excluded.all_day,
         start          = excluded.start,
         rrule          = excluded.rrule,
         remind_minutes = excluded.remind_minutes,
         target_date    = excluded.target_date,
         updated_at     = excluded.updated_at`
    )
    .run(
      id,
      input.calendarId,
      input.kind,
      input.title.trim(),
      input.notes ?? null,
      input.allDay === false ? 0 : 1,
      input.start,
      input.rrule ?? null,
      input.remindMinutes ?? null,
      input.targetDate ?? null,
      input.color ?? null,
      now,
      now
    )
  return getEvent(id)
}

export function getEvent(id: string): CalendarEvent {
  const row = requireDb()
    .prepare('SELECT * FROM events WHERE id = ? AND deleted_at IS NULL')
    .get(id)
  if (!row) throw new Error('事件不存在或已删除')
  return rowToEvent(row)
}

export function updateEvent(id: string, patch: Partial<EventInput>): CalendarEvent {
  const existing = getEvent(id)
  const merged: EventInput = {
    calendarId: existing.calendarId,
    kind: (patch.kind ?? existing.kind) as EventKind,
    title: patch.title ?? existing.title,
    start: patch.start ?? existing.start,
    allDay: patch.allDay ?? existing.allDay,
    rrule: patch.rrule !== undefined ? patch.rrule : existing.rrule,
    remindMinutes:
      patch.remindMinutes !== undefined ? patch.remindMinutes : existing.remindMinutes,
    targetDate: patch.targetDate !== undefined ? patch.targetDate : existing.targetDate,
    color: patch.color !== undefined ? patch.color : existing.color,
    notes: patch.notes !== undefined ? patch.notes : existing.notes
  }
  // 只有调用方显式改了 rrule 才校验它：老库里的脏规则不该拦住"只改标题"这种编辑
  validateEventInput(merged, existing.calendarId, { validateRrule: patch.rrule !== undefined })
  if (patch.kind && patch.kind !== existing.kind) {
    // 与旧版一致：切到非倒数日类型时清掉目标日期，避免残留字段
    merged.targetDate = patch.kind === 'countdown' ? merged.targetDate : null
  }

  recordSnapshot('修改事件', [{ table: 'events', id }])
  requireDb()
    .prepare(
      `UPDATE events SET kind = ?, title = ?, notes = ?, all_day = ?, start = ?, rrule = ?,
             remind_minutes = ?, target_date = ?, color = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(
      merged.kind,
      merged.title.trim(),
      merged.notes ?? null,
      merged.allDay === false ? 0 : 1,
      merged.start,
      merged.rrule ?? null,
      merged.remindMinutes ?? null,
      merged.targetDate ?? null,
      merged.color ?? null,
      Date.now(),
      id
    )
  return getEvent(id)
}

export function deleteEvent(id: string): void {
  const now = Date.now()
  // 先确认存在，避免为一次必然失败的删除留下无意义的回滚记录
  getEvent(id)
  recordSnapshot('删除事件', [{ table: 'events', id }])
  const res = requireDb()
    .prepare('UPDATE events SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
    .run(now, now, id)
  if (Number((res as { changes?: number }).changes ?? 0) === 0) {
    throw new Error('事件不存在或已删除')
  }
}

/**
 * 列出区间内展开后的事件实例。
 * 重复事件按 RRULE 展开；单次事件只在自己那一天出现。
 */
export function listOccurrences(
  calendarId: string,
  from: string,
  to: string,
  kind: EventKind | 'all' = 'all'
): EventOccurrence[] {
  assertDate(from)
  assertDate(to)
  assertCalendar(calendarId)

  const rows = requireDb()
    .prepare('SELECT * FROM events WHERE calendar_id = ? AND deleted_at IS NULL ORDER BY start ASC')
    .all(calendarId)

  const out: EventOccurrence[] = []
  for (const row of rows) {
    const event = rowToEvent(row)
    if (kind !== 'all' && event.kind !== kind) continue

    const startDate = startDateOf(event.start)
    let dates: string[] = []

    if (event.kind === 'countdown' && event.targetDate) {
      // 倒数日：从开始日（或区间起点）起每天显示，直到目标日，最多 100 天
      const begin = Math.max(toDayNumber(from), toDayNumber(startDate))
      const end = Math.min(toDayNumber(to), toDayNumber(event.targetDate))
      let cursor = begin
      let guard = 0
      while (cursor <= end && guard < 100) {
        dates.push(fromDayNumber(cursor))
        cursor += 1
        guard += 1
      }
    } else if (event.rrule) {
      dates = expandRrule(event.rrule, startDate, from, to)
    } else if (startDate >= from && startDate <= to) {
      dates = [startDate]
    }
    if (dates.length === 0) continue
    // 用户「仅删除本次」跳过的日期不再出现（软删除的行不算）
    if (event.rrule) {
      const skipped = new Set(
        requireDb()
          .prepare(
            'SELECT occurrence_date FROM event_skip WHERE event_id = ? AND deleted_at IS NULL'
          )
          .all(event.id)
          .map((r) => String(r.occurrence_date))
      )
      dates = dates.filter((d) => !skipped.has(d))
      if (dates.length === 0) continue
    }

    for (const date of dates) {
      out.push({ event, date, done: isOccurrenceDone(event, date) })
    }
  }

  // 排序：先按日期，再按创建时间（先建的在上），最后用标题兜底保证稳定
  return out.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1
    if (a.event.createdAt !== b.event.createdAt) return a.event.createdAt - b.event.createdAt
    return a.event.title.localeCompare(b.event.title)
  })
}

function isOccurrenceDone(event: CalendarEvent, date: string): boolean {
  if (!event.rrule) return event.completed
  const row = requireDb()
    .prepare(
      'SELECT 1 AS hit FROM event_done WHERE event_id = ? AND occurrence_date = ? AND deleted_at IS NULL'
    )
    .get(event.id, date)
  return Boolean(row)
}

/** 标记某一次发生（重复事件）或整个事件（单次事件）为完成 */
export function setOccurrenceDone(eventId: string, date: string, done: boolean): EventOccurrence {
  assertDate(date)
  const event = getEvent(eventId)
  if (!event.rrule) {
    recordSnapshot('切换完成状态', [{ table: 'events', id: eventId }])
    requireDb()
      .prepare('UPDATE events SET completed = ?, updated_at = ? WHERE id = ?')
      .run(done ? 1 : 0, Date.now(), eventId)
    const next = getEvent(eventId)
    return { event: next, date: startDateOf(next.start), done: next.completed }
  }

  // 重复事件：完成状态记在 event_done，按「事件:日期」这一逻辑行回滚
  const id = `${eventId}:${date}`
  recordSnapshot('切换完成状态', [{ table: 'event_done', id }])
  const now = Date.now()
  // 取消完成用软删除（打墓碑）而不是 DELETE：
  // 真删了以后同步没有变更可推，别的设备会一直停在这天"已完成"的状态。
  requireDb()
    .prepare(
      `INSERT INTO event_done (id, event_id, occurrence_date, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(event_id, occurrence_date) DO UPDATE SET
         id = excluded.id,
         updated_at = excluded.updated_at,
         deleted_at = excluded.deleted_at`
    )
    .run(id, eventId, date, now, done ? null : now)
  return { event, date, done }
}

/** 仅删除某一次重复发生（其余日期保留） */
export function skipOccurrence(eventId: string, date: string): void {
  assertDate(date)
  getEvent(eventId)
  const id = `${eventId}:${date}`
  recordSnapshot('仅删除本次', [{ table: 'event_skip', id }])
  requireDb()
    .prepare(
      `INSERT INTO event_skip (id, event_id, occurrence_date, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT(event_id, occurrence_date) DO UPDATE SET
         id = excluded.id,
         updated_at = excluded.updated_at,
         deleted_at = NULL`
    )
    .run(id, eventId, date, Date.now())
}

/** 撤销「仅删除这天」：给它打墓碑，列表就不会再过滤这一天 */
export function unskipOccurrence(eventId: string, date: string): void {
  assertDate(date)
  const id = `${eventId}:${date}`
  recordSnapshot('撤销仅删除本次', [{ table: 'event_skip', id }])
  requireDb()
    .prepare('UPDATE event_skip SET deleted_at = ?, updated_at = ? WHERE id = ?')
    .run(Date.now(), Date.now(), id)
}

/** 撤销删除事件：清掉墓碑，整条事件连同重复规则一起回来 */
export function restoreEvent(id: string): CalendarEvent {
  const now = Date.now()
  recordSnapshot('撤销删除事件', [{ table: 'events', id }])
  const res = requireDb()
    .prepare('UPDATE events SET deleted_at = NULL, updated_at = ? WHERE id = ?')
    .run(now, id)
  if (Number((res as { changes?: number }).changes ?? 0) === 0) {
    throw new Error('事件不存在')
  }
  return getEvent(id)
}

/* ------------------------------ 便签 ------------------------------ */

const MAX_NOTE_CONTENT = 100_000

function rowToNote(row: Record<string, unknown>): Note {
  return {
    id: String(row.id),
    calendarId: String(row.calendar_id),
    title: String(row.title ?? ''),
    content: String(row.content ?? ''),
    pinned: Number(row.pinned) === 1,
    color: row.color === null ? null : String(row.color),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    deletedAt: row.deleted_at === null ? null : Number(row.deleted_at)
  }
}

export function listNotes(calendarId?: string, limit = 100): Note[] {
  const max = clampLimit(limit, 100, 500)
  const sql = `SELECT * FROM notes WHERE deleted_at IS NULL
               ${calendarId ? 'AND calendar_id = ?' : ''}
               ORDER BY pinned DESC, updated_at DESC LIMIT ?`
  const rows = calendarId
    ? requireDb().prepare(sql).all(calendarId, max)
    : requireDb().prepare(sql).all(max)
  return rows.map(rowToNote)
}

export function getNote(id: string): Note {
  const row = requireDb()
    .prepare('SELECT * FROM notes WHERE id = ? AND deleted_at IS NULL')
    .get(id)
  if (!row) throw new Error('便签不存在或已删除')
  return rowToNote(row)
}

function validateNote(input: NoteInput): void {
  assertCalendar(input.calendarId)
  if (input.content.length > MAX_NOTE_CONTENT) {
    throw new Error(`便签内容过长（上限 ${MAX_NOTE_CONTENT} 字符）`)
  }
  if (input.title && input.title.length > 200) throw new Error('便签标题过长（上限 200 字符）')
  if (!input.content.trim() && !(input.title ?? '').trim()) {
    throw new Error('便签不能为空（标题和内容至少填一个）')
  }
}

export function createNote(input: NoteInput): Note {
  validateNote(input)
  const now = Date.now()
  const id = randomUUID()
  recordSnapshot('新建便签', [{ table: 'notes', id }])
  requireDb()
    .prepare(
      `INSERT INTO notes (id, calendar_id, title, content, pinned, color, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`
    )
    .run(
      id,
      input.calendarId,
      (input.title ?? '').trim(),
      input.content,
      input.pinned ? 1 : 0,
      input.color ?? null,
      now,
      now
    )
  return getNote(id)
}

export function updateNote(id: string, patch: Partial<NoteInput>): Note {
  const existing = getNote(id)
  const merged: NoteInput = {
    calendarId: existing.calendarId,
    title: patch.title !== undefined ? patch.title : existing.title,
    content: patch.content !== undefined ? patch.content : existing.content,
    pinned: patch.pinned !== undefined ? patch.pinned : existing.pinned,
    color: patch.color !== undefined ? patch.color : existing.color
  }
  validateNote(merged)
  recordSnapshot('修改便签', [{ table: 'notes', id }])
  requireDb()
    .prepare(
      `UPDATE notes SET title = ?, content = ?, pinned = ?, color = ?, updated_at = ? WHERE id = ?`
    )
    .run(
      (merged.title ?? '').trim(),
      merged.content,
      merged.pinned ? 1 : 0,
      merged.color ?? null,
      Date.now(),
      id
    )
  return getNote(id)
}

export function deleteNote(id: string): void {
  const now = Date.now()
  // 先确认存在，避免为一次必然失败的删除留下无意义的回滚记录
  getNote(id)
  recordSnapshot('删除便签', [{ table: 'notes', id }])
  const res = requireDb()
    .prepare('UPDATE notes SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
    .run(now, now, id)
  if (Number((res as { changes?: number }).changes ?? 0) === 0) {
    throw new Error('便签不存在或已删除')
  }
}

/* ------------------------------ 本地回滚记录 ------------------------------ */

/** 连续编辑合并窗口：同一批行在 100 秒内的改动合并成一条记录 */
const SNAP_WINDOW_MS = 100_000
/** 每个账户最多保留的记录条数 */
const SNAP_LIMIT = 100
/** 目前只有一个本地账户；留字段是为了将来多账户 */
const SNAP_ACCOUNT = 'local'

/** 可回滚的表白名单：表名会拼进 SQL，必须挡住意外值 */
const SNAP_TABLES = new Set(['calendars', 'day_cells', 'events', 'event_done', 'event_skip', 'notes'])

/** 一条回滚条目：编辑前的整行（snake_case）；data=null 表示编辑前不存在 */
interface SnapshotEntry {
  table: string
  id: string
  data: Record<string, unknown> | null
}

function entryKey(entry: { table: string; id: string }): string {
  return `${entry.table}:${entry.id}`
}

function parseEntries(raw: string): SnapshotEntry[] {
  try {
    const parsed = JSON.parse(raw) as SnapshotEntry[]
    if (!Array.isArray(parsed)) return []
    return parsed.filter((e) => e && typeof e.table === 'string' && typeof e.id === 'string')
  } catch {
    // 记录损坏就当它没有内容，不要让整个列表接口挂掉
    return []
  }
}

/** 读取受影响行的当前状态；行不存在时 data=null（回滚语义变成"删除"） */
function captureRows(pairs: Array<{ table: string; id: string }>): SnapshotEntry[] {
  const conn = requireDb()
  const seen = new Set<string>()
  const out: SnapshotEntry[] = []
  for (const pair of pairs) {
    if (!SNAP_TABLES.has(pair.table)) continue
    const key = entryKey(pair)
    if (seen.has(key)) continue
    seen.add(key)
    try {
      const row = conn.prepare(`SELECT * FROM ${pair.table} WHERE id = ?`).get(pair.id)
      out.push({ table: pair.table, id: pair.id, data: row ? { ...row } : null })
    } catch {
      // 列对不上（老库缺列等）就跳过这一行，快照不能拖累正常编辑
    }
  }
  return out
}

function trimSnapshots(): void {
  requireDb()
    .prepare(
      `DELETE FROM snapshots WHERE account = ?
         AND id NOT IN (SELECT id FROM snapshots WHERE account = ? ORDER BY updated_at DESC LIMIT ?)`
    )
    .run(SNAP_ACCOUNT, SNAP_ACCOUNT, SNAP_LIMIT)
}

/** 当前停在哪个时间点上（没恢复过就是最新那条） */
const SNAP_CURSOR_KEY = 'snap.cursor'

export function currentSnapshotId(): string | null {
  const id = getMeta(SNAP_CURSOR_KEY)
  if (!id) return null
  // 记录的 id 可能已经被清空或裁剪掉，那就当没有游标
  const row = requireDb().prepare('SELECT id FROM snapshots WHERE id = ?').get(id)
  return row ? id : null
}

function setSnapshotCursor(id: string): void {
  setMeta(SNAP_CURSOR_KEY, id)
}

/**
 * 在真正写库之前调用：把受影响行的原始状态打成一条回滚记录。
 * 快照失败绝不能让用户的编辑失败，所以整体包在 try/catch 里。
 * options.fresh 用于强制新建一条（回滚时的自动备份，不能并进被回滚的那条）。
 */
function recordSnapshot(
  label: string,
  pairs: Array<{ table: string; id: string }>,
  options: { fresh?: boolean } = {}
): void {
  try {
    const entries = captureRows(pairs)
    if (entries.length === 0) return

    const conn = requireDb()
    const now = Date.now()
    const recent = conn
      .prepare(
        `SELECT * FROM snapshots WHERE account = ? AND updated_at > ?
         ORDER BY updated_at DESC LIMIT 1`
      )
      .get(SNAP_ACCOUNT, now - SNAP_WINDOW_MS) as Record<string, unknown> | undefined

    const oldEntries = recent ? parseEntries(String(recent.entries ?? '[]')) : []
    const newKeys = new Set(entries.map(entryKey))
    const shared = oldEntries.some((entry) => newKeys.has(entryKey(entry)))

    if (recent && shared && options.fresh !== true) {
      // 合并：老条目原样保留（它们记的是最早的编辑前状态），只追加没见过的行
      const known = new Set(oldEntries.map(entryKey))
      const merged = [...oldEntries]
      for (const entry of entries) {
        if (known.has(entryKey(entry))) continue
        known.add(entryKey(entry))
        merged.push(entry)
      }
      conn
        .prepare('UPDATE snapshots SET entries = ?, count = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(merged), merged.length, now, String(recent.id))
      // 又有了新改动 = 站回时间线最上面那个点
      setSnapshotCursor(String(recent.id))
    } else {
      const newId = randomUUID()
      conn
        .prepare(
          `INSERT INTO snapshots (id, account, label, entries, count, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(newId, SNAP_ACCOUNT, label, JSON.stringify(entries), entries.length, now, now)
      setSnapshotCursor(newId)
    }
    trimSnapshots()
  } catch (err) {
    console.error('[caldesk] 记录回滚快照失败:', (err as Error).message)
  }
}

/** 最近的回滚记录（按 updated_at 倒序），只有一条的 current 为 true */
export function listSnapshots(limit = SNAP_LIMIT): SnapshotMeta[] {
  const max = clampLimit(limit, SNAP_LIMIT, SNAP_LIMIT)
  const rows = requireDb()
    .prepare(
      `SELECT id, label, count, entries, created_at, updated_at FROM snapshots
       WHERE account = ? ORDER BY updated_at DESC LIMIT ?`
    )
    .all(SNAP_ACCOUNT, max)
  // 游标指向哪里；没有游标（从没恢复过）就是最新一条
  const cursor = currentSnapshotId() ?? (rows.length > 0 ? String(rows[0].id) : null)
  return rows.map((row) => {
    const entries = parseEntries(String(row.entries ?? '[]'))
    return {
      id: String(row.id),
      label: String(row.label),
      count: Number(row.count ?? entries.length),
      tables: [...new Set(entries.map((entry) => entry.table))],
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      current: String(row.id) === cursor
    }
  })
}

/**
 * 回到某个时间点：把记录里的行按 data 写回，data=null 的行删除。
 *
 * 这一下**不算改动**：不新增记录、也不删掉被恢复的那条，只把"当前所在"挪过去。
 * 所以时间线长度不变，点哪个点就是站到哪个点上，来回跳都行。
 *  - 恢复出来的行把 updated_at 改成现在，这样它在 LWW 里胜出并被推上云端；
 *  - 单行失败只计数，不中断其余行；
 *  - 整体包在一个事务里：中途崩了不会留下"只恢复了一半"的库。
 */
export function restoreSnapshot(id: string): RestoreResult {
  const conn = requireDb()
  const row = conn.prepare('SELECT * FROM snapshots WHERE id = ?').get(id)
  if (!row) throw new Error('回滚记录不存在')

  const entries = parseEntries(String(row.entries ?? '[]'))
  const result: RestoreResult = { restored: 0, deleted: 0, failed: 0 }
  const now = Date.now()

  tx(() => {
    for (const entry of entries) {
      if (!SNAP_TABLES.has(entry.table)) continue
      try {
        if (entry.data === null) {
          conn.prepare(`DELETE FROM ${entry.table} WHERE id = ?`).run(entry.id)
          result.deleted += 1
          continue
        }
        const data: Record<string, unknown> = { ...entry.data }
        // 列名会拼进 SQL：只认合法标识符（快照来自本地库，但别给篡改留口子）
        const badKey = Object.keys(data).find((key) => !/^[a-z][a-z0-9_]*$/.test(key))
        if (badKey) throw new Error(`列名不合法：${badKey}`)
        // 时间戳改成现在：恢复出来的行要压过现场的版本，也才能被同步推上去
        if (Object.prototype.hasOwnProperty.call(data, 'updated_at')) data.updated_at = now
        const cols = Object.keys(data)
        const placeholders = cols.map(() => '?').join(', ')
        const updates = cols.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`)
        const sql =
          updates.length > 0
            ? `INSERT INTO ${entry.table} (${cols.join(', ')}) VALUES (${placeholders})
               ON CONFLICT(id) DO UPDATE SET ${updates.join(', ')}`
            : `INSERT INTO ${entry.table} (${cols.join(', ')}) VALUES (${placeholders})
               ON CONFLICT(id) DO NOTHING`
        conn.prepare(sql).run(...cols.map((c) => data[c]))
        result.restored += 1
      } catch (err) {
        result.failed += 1
        console.error(`[caldesk] 回滚 ${entry.table}/${entry.id} 失败:`, (err as Error).message)
      }
    }

    // 站到这一点上（记录本身留着，随时能跳回来）
    setSnapshotCursor(id)
  })
  return result
}

/** 清空全部回滚记录，返回删除条数 */
export function clearSnapshots(): number {
  const res = requireDb().prepare('DELETE FROM snapshots WHERE account = ?').run(SNAP_ACCOUNT)
  // 记录都没了，游标也一起清掉
  requireDb().prepare('DELETE FROM meta WHERE key = ?').run(SNAP_CURSOR_KEY)
  return Number((res as { changes?: number }).changes ?? 0)
}

/* ------------------------------ 同步支撑 ------------------------------ */

export type SyncTable = 'calendars' | 'day_cells' | 'events' | 'notes' | 'event_done' | 'event_skip'

/** 统一的行载荷形状（camelCase，两端一致） */
export interface SyncPayloadRow {
  id: string
  updatedAt: number
  deletedAt: number | null
  [key: string]: unknown
}

const TABLE_COLUMNS: Record<SyncTable, string[]> = {
  calendars: ['id', 'name', 'color', 'sort', 'created_at', 'updated_at', 'deleted_at'],
  day_cells: ['id', 'calendar_id', 'date', 'text', 'color', 'updated_at', 'deleted_at'],
  events: [
    'id',
    'calendar_id',
    'kind',
    'title',
    'notes',
    'all_day',
    'start',
    'end',
    'rrule',
    'remind_minutes',
    'target_date',
    'color',
    'completed',
    'created_at',
    'updated_at',
    'deleted_at'
  ],
  notes: ['id', 'calendar_id', 'title', 'content', 'pinned', 'color', 'created_at', 'updated_at', 'deleted_at'],
  // deleted_at 要参与同步：取消完成是打墓碑，别的设备得知道
  event_done: ['id', 'event_id', 'occurrence_date', 'updated_at', 'deleted_at'],
  // deleted_at 要参与同步：撤销「仅删除这天」是打墓碑，别的设备得知道
  event_skip: ['id', 'event_id', 'occurrence_date', 'updated_at', 'deleted_at']
}

/** 表名会拼进 SQL，导出/导入前必须挡一道（TS 的类型在运行时不存在） */
function assertSyncTable(table: string): SyncTable {
  if (!Object.prototype.hasOwnProperty.call(TABLE_COLUMNS, table)) {
    throw new Error(`未知集合：${table}`)
  }
  return table as SyncTable
}

function snakeToCamel(key: string): string {
  return key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
}

function camelToSnake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
}

/**
 * 导出某集合里 (updatedAt, id) 严格大于 (since, sinceId) 的行，最多 500 行。
 *
 * 为什么游标必须是复合的：只按 `updated_at > ?` 翻页时，如果一次有 ≥500 行的
 * `updated_at` 完全相同（迁移脚本用同一个常量时间戳批量插入、或首次登录全量推），
 * 第二页的 `updated_at > cursor` 会把这一整批又捞回来一遍——永远翻不过去，
 * 剩下的行就只能永远留在本地。加上 id 作为第二排序键/第二游标才收敛。
 *
 * 用 `updated_at > ?` **或** `(updated_at = ? AND id > ?)` 两个分支，走
 * `(updated_at)` / `(calendar_id, date)` 等既有索引，不会退化成全表扫。
 *
 * `sinceId` 省略时等价于旧的单游标行为（只比时间戳）。
 */
export function exportRows(table: SyncTable, since: number, sinceId = ''): SyncPayloadRow[] {
  const name = assertSyncTable(table)
  const rows = requireDb()
    .prepare(
      `SELECT * FROM ${name}
        WHERE updated_at > ? OR (updated_at = ? AND id > ?)
        ORDER BY updated_at ASC, id ASC
        LIMIT 500`
    )
    .all(since, since, sinceId)
  return rows.map((row) => {
    const out: SyncPayloadRow = { id: '', updatedAt: 0, deletedAt: null }
    for (const col of TABLE_COLUMNS[name]) {
      const key = snakeToCamel(col)
      const value = row[col]
      if (key === 'id') out.id = String(value)
      else if (key === 'updatedAt') out.updatedAt = Number(value)
      else if (key === 'deletedAt') out.deletedAt = value === null ? null : Number(value)
      else out[key] = value
    }
    return out
  })
}

/**
 * 写入远端行（LWW 守卫在 SQL 里，旧数据不会覆盖新数据）。
 * 返回写入与失败计数——失败要暴露出来，不能静默吞掉，
 * 否则同步会"看起来成功但数据没进来"。
 */
export function importRows(
  table: SyncTable,
  rows: SyncPayloadRow[]
): { written: number; failed: number; errors: string[] } {
  const result = { written: 0, failed: 0, errors: [] as string[] }
  const name = assertSyncTable(table)
  if (rows.length === 0) return result

  const cols = TABLE_COLUMNS[name]
  const placeholders = cols.map(() => '?').join(', ')
  const updates = cols
    .filter((c) => c !== 'id')
    .map((c) => `${c} = excluded.${c}`)
    .join(', ')
  const sql = `INSERT INTO ${name} (${cols.join(', ')})
               VALUES (${placeholders})
               ON CONFLICT(id) DO UPDATE SET ${updates}
               WHERE excluded.updated_at > ${name}.updated_at`

  const stmt = requireDb().prepare(sql)
  // 各端字段可能略有差异（例如移动端先上线某个字段），这里给 NOT NULL 列兜底，
  // 避免因为缺一个字段就整行同步失败。
  const NOT_NULL_DEFAULTS: Record<string, string | number> = {
    all_day: 1,
    completed: 0,
    pinned: 0,
    sort: 0,
    kind: 'task',
    name: '',
    title: '',
    text: '',
    content: ''
  }
  for (const row of rows) {
    if (!row || typeof row.id !== 'string' || typeof row.updatedAt !== 'number') {
      result.failed += 1
      result.errors.push('行缺少 id 或 updatedAt')
      continue
    }
    const values = cols.map((col) => {
      const key = snakeToCamel(col)
      const value = row[key]
      if (value === undefined || value === null) {
        if (col === 'created_at' || col === 'updated_at') return row.updatedAt
        if (col in NOT_NULL_DEFAULTS) return NOT_NULL_DEFAULTS[col]
        return null
      }
      if (typeof value === 'boolean') return value ? 1 : 0
      return value as string | number
    })
    try {
      // LWW 的 WHERE 不满足时 SQLite 影响 0 行：这不叫"写入"，不能算进 written
      const res = stmt.run(...values)
      if (Number(res?.changes ?? 0) > 0) result.written += 1
    } catch (err) {
      result.failed += 1
      if (result.errors.length < 5) result.errors.push(`${row.id}: ${(err as Error).message}`)
    }
  }
  return result
}

export function getMeta(key: string): string | null {
  const row = requireDb().prepare('SELECT value FROM meta WHERE key = ?').get(key)
  return row ? String(row.value) : null
}

/**
 * 本地库的"变更水位"：所有业务表里最新的 updated_at。
 *
 * 用来做热更新轮询：各端每几秒问一次服务端"你那边变了吗"，
 * 变了才真的去拉数据，避免每次都搬整个月。
 *
 * 表名必须和同步的 TABLES 一致（少了 event_done/event_skip 会导致
 * 远端水位永远大于本地水位，每 5 秒都白同步一次）。
 */
export function localChangeToken(): number {
  const tables = ['calendars', 'day_cells', 'events', 'notes', 'event_done', 'event_skip']
  let max = 0
  for (const t of tables) {
    try {
      const row = requireDb()
        .prepare(`SELECT MAX(updated_at) AS m FROM ${t}`)
        .get() as { m?: number | null } | undefined
      const v = Number(row?.m ?? 0)
      if (Number.isFinite(v) && v > max) max = v
    } catch {
      /* 表还没建好，跳过 */
    }
  }
  return max
}

export function setMeta(key: string, value: string): void {
  requireDb()
    .prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(key, value)
}

/* ------------------------------ 搜索 ------------------------------ */

export type { SearchHit }

export function search(query: string, calendarId?: string, limit = 50): SearchHit[] {
  const q = query.trim()
  if (!q) throw new Error('搜索关键词不能为空')
  // 反斜杠是 ESCAPE 字符，必须先转义它自己，否则搜 "a\b" 会退化成搜 "ab"
  const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`
  const max = clampLimit(limit, 50, 200)

  const calNames = new Map(listCalendars().map((c) => [c.id, c.name] as const))
  const hits: SearchHit[] = []

  const cellRows = requireDb()
    .prepare(
      `SELECT calendar_id, date, text FROM day_cells
       WHERE deleted_at IS NULL AND text LIKE ? ESCAPE '\\'
         ${calendarId ? 'AND calendar_id = ?' : ''}
       ORDER BY date DESC LIMIT ?`
    )
    .all(...(calendarId ? [like, calendarId, max] : [like, max]))

  for (const row of cellRows) {
    const cal = String(row.calendar_id)
    if (!calNames.has(cal)) continue
    const lines = splitLines(String(row.text ?? ''))
    lines.forEach((line, idx) => {
      if (line.toLowerCase().includes(q.toLowerCase())) {
        hits.push({
          type: 'task',
          calendarId: cal,
          calendarName: calNames.get(cal) ?? '',
          date: String(row.date),
          title: lineText(line),
          lineIndex: idx
        })
      }
    })
  }

  const eventRows = requireDb()
    .prepare(
      `SELECT id, calendar_id, title, start, kind FROM events
       WHERE deleted_at IS NULL AND title LIKE ? ESCAPE '\\'
         ${calendarId ? 'AND calendar_id = ?' : ''}
       ORDER BY start DESC LIMIT ?`
    )
    .all(...(calendarId ? [like, calendarId, max] : [like, max]))

  for (const row of eventRows) {
    const cal = String(row.calendar_id)
    if (!calNames.has(cal)) continue
    hits.push({
      type: 'event',
      calendarId: cal,
      calendarName: calNames.get(cal) ?? '',
      date: String(row.start).slice(0, 10),
      title: String(row.title),
      eventId: String(row.id)
    })
  }

  const noteRows = requireDb()
    .prepare(
      `SELECT id, calendar_id, title, content, updated_at FROM notes
       WHERE deleted_at IS NULL AND (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')
         ${calendarId ? 'AND calendar_id = ?' : ''}
       ORDER BY updated_at DESC LIMIT ?`
    )
    .all(...(calendarId ? [like, like, calendarId, max] : [like, like, max]))

  for (const row of noteRows) {
    const cal = String(row.calendar_id)
    if (!calNames.has(cal)) continue
    const title = String(row.title ?? '').trim() || String(row.content ?? '').split('\n')[0].slice(0, 30)
    hits.push({
      type: 'note',
      calendarId: cal,
      calendarName: calNames.get(cal) ?? '',
      date: new Date(Number(row.updated_at)).toISOString().slice(0, 10),
      title,
      noteId: String(row.id)
    })
  }

  return hits.slice(0, max)
}
