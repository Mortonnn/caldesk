/**
 * caldesk-sync — Cloudflare Worker + D1
 *
 * 一张通用表存所有集合，按 (tbl, id) 定位，payload 存整行 JSON。
 * 好处：加新集合不用改表结构，同步逻辑与业务字段解耦。
 *
 * 冲突策略与客户端完全一致：LWW（updated_at 大者胜），
 * 服务端也做一次守卫（WHERE excluded.updated_at > rows.updated_at），
 * 防止乱序到达的旧数据覆盖新数据。
 *
 * 鉴权：Authorization: Bearer <SYNC_TOKEN>
 */

export interface Env {
  DB: D1Database
  SYNC_TOKEN: string
}

interface SyncRow {
  id: string
  updatedAt: number
  deletedAt?: number | null
  [key: string]: unknown
}

/* ---------------- REST 层复用的纯函数（与桌面端同一份实现） ---------------- */
import { expandRrule, fromDayNumber, toDayNumber } from '../../src/shared/rrule'
import { isDoneLine, lineText, markDone, splitLines } from '../../src/shared/types'

const ALLOWED = new Set(['calendars', 'day_cells', 'events', 'notes', 'event_done', 'event_skip'])
const MAX_ROWS = 500

/**
 * CORS：Capacitor/浏览器里的页面来源是 https://localhost 或 file://，
 * 跨域访问会带 Authorization 头 → 触发预检。这里统一放行。
 * 鉴权仍靠 Bearer token，放开来源不影响安全性。
 */
const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-max-age': '86400'
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS_HEADERS }
  })
}

function authorized(req: Request, env: Env): boolean {
  const header = req.headers.get('authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  return token.length > 0 && token === env.SYNC_TOKEN
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)

    // 预检必须在鉴权之前处理，否则浏览器拿不到 CORS 头直接判失败
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }

    if (url.pathname === '/health') {
      return json({ ok: true, service: 'caldesk-sync', d1: Boolean(env.DB) })
    }

    if (!authorized(req, env)) return json({ error: 'unauthorized' }, 401)
    if (!env.DB) return json({ error: 'D1 未绑定' }, 500)

    /* ---------------- 拉取 ---------------- */
    if (url.pathname === '/sync/pull' && req.method === 'GET') {
      const table = url.searchParams.get('table') ?? ''
      const since = Number(url.searchParams.get('since') ?? 0)
      const limitRaw = Number(url.searchParams.get('limit') ?? 200)
      const limit = Math.min(Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 200), MAX_ROWS)

      if (!ALLOWED.has(table)) return json({ error: `未知集合：${table}` }, 400)

      const { results } = await env.DB.prepare(
        `SELECT payload, updated_at FROM rows
         WHERE tbl = ? AND updated_at > ?
         ORDER BY updated_at ASC LIMIT ?`
      )
        .bind(table, Number.isFinite(since) ? since : 0, limit)
        .all<{ payload: string; updated_at: number }>()

      const rows = (results ?? []).map((r) => JSON.parse(r.payload) as SyncRow)
      const cursor = rows.reduce((m, r) => Math.max(m, r.updatedAt ?? 0), Number.isFinite(since) ? since : 0)
      return json({ rows, cursor })
    }

    /* ---------------- 推送 ---------------- */
    if (url.pathname === '/sync/push' && req.method === 'POST') {
      let body: { table?: string; rows?: SyncRow[] }
      try {
        body = (await req.json()) as { table?: string; rows?: SyncRow[] }
      } catch {
        return json({ error: '请求体不是合法 JSON' }, 400)
      }
      const table = body.table ?? ''
      if (!ALLOWED.has(table)) return json({ error: `未知集合：${table}` }, 400)
      if (!Array.isArray(body.rows)) return json({ error: 'rows 必须是数组' }, 400)
      if (body.rows.length > MAX_ROWS) return json({ error: `单次最多推送 ${MAX_ROWS} 行` }, 400)

      const stmt = env.DB.prepare(
        `INSERT INTO rows (tbl, id, updated_at, deleted_at, payload)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(tbl, id) DO UPDATE SET
           updated_at = excluded.updated_at,
           deleted_at = excluded.deleted_at,
           payload    = excluded.payload
         WHERE excluded.updated_at > rows.updated_at`
      )

      let accepted = 0
      const batch: D1PreparedStatement[] = []
      for (const row of body.rows) {
        if (!row || typeof row.id !== 'string' || typeof row.updatedAt !== 'number') continue
        batch.push(
          stmt.bind(
            table,
            row.id,
            row.updatedAt,
            typeof row.deletedAt === 'number' ? row.deletedAt : null,
            JSON.stringify(row)
          )
        )
        accepted += 1
      }

      if (batch.length > 0) await env.DB.batch(batch)
      return json({ ok: true, accepted })
    }

    /* ---------------- REST：给移动端用的读写接口 ---------------- */

    if (url.pathname === '/api/calendars' && req.method === 'GET') {
      const rows = (await loadTable(env, 'calendars')).filter((r) => !r.deletedAt)
      rows.sort((a, b) => Number(a.sort ?? 0) - Number(b.sort ?? 0))
      return json(rows.map((r) => ({ id: r.id, name: r.name, color: r.color, sort: r.sort })))
    }

    if (url.pathname === '/api/cells' && req.method === 'GET') {
      const calendar = url.searchParams.get('calendar') ?? ''
      const from = url.searchParams.get('from') ?? ''
      const to = url.searchParams.get('to') ?? ''
      const rows = (await loadTable(env, 'day_cells')).filter(
        (r) =>
          !r.deletedAt &&
          (!calendar || r.calendarId === calendar) &&
          String(r.date) >= from &&
          String(r.date) <= to
      )
      return json(rows.map((r) => ({ date: r.date, text: r.text ?? '' })))
    }

    if (url.pathname === '/api/cells/append' && req.method === 'POST') {      const body = await jsonBody(req)
      const calendar = String(body.calendar ?? '')
      const date = String(body.date ?? '')
      const text = String(body.text ?? '').trim()
      if (!calendar || !date || !text) return json({ error: '缺少 calendar/date/text' }, 400)
      if (/[\r\n]/.test(text)) return json({ error: '任务只能是单行' }, 400)
      const current = await readCell(env, calendar, date)
      const lines = splitLines(current)
      lines.push(text)
      const next = lines.join('\n')
      await writeCell(env, calendar, date, next)
      return json({ text: next })
    }

    if (url.pathname === '/api/cells/toggle' && req.method === 'POST') {
      const body = await jsonBody(req)
      const calendar = String(body.calendar ?? '')
      const date = String(body.date ?? '')
      const index = Number(body.index)
      const done = Boolean(body.done)
      const lines = splitLines(await readCell(env, calendar, date))
      if (!Number.isInteger(index) || index < 0 || index >= lines.length) {
        return json({ error: `行号 ${index} 超出范围` }, 400)
      }
      lines[index] = markDone(lines[index], done)
      const next = lines.join('\n')
      await writeCell(env, calendar, date, next)
      return json({ text: next })
    }

    if (url.pathname === '/api/cells/remove-line' && req.method === 'POST') {
      const body = await jsonBody(req)
      const calendar = String(body.calendar ?? '')
      const date = String(body.date ?? '')
      const index = Number(body.index)
      const lines = splitLines(await readCell(env, calendar, date))
      if (!Number.isInteger(index) || index < 0 || index >= lines.length) {
        return json({ error: `行号 ${index} 超出范围` }, 400)
      }
      lines.splice(index, 1)
      const next = lines.join('\n')
      await writeCell(env, calendar, date, next)
      return json({ text: next })
    }

    if (url.pathname === '/api/events' && req.method === 'GET') {
      const calendar = url.searchParams.get('calendar') ?? ''
      const from = url.searchParams.get('from') ?? ''
      const to = url.searchParams.get('to') ?? ''
      return json(await listOccurrences(env, calendar, from, to))
    }

    if (url.pathname === '/api/events/create' && req.method === 'POST') {
      const body = await jsonBody(req)
      const now = Date.now()
      // 字段必须与桌面端 CalendarEvent 完全同构，否则桌面端导入会撞 NOT NULL 约束
      const row: SyncRow = {
        id: `evt:${crypto.randomUUID()}`,
        calendarId: String(body.calendar ?? ''),
        kind: String(body.kind ?? 'task'),
        title: String(body.title ?? '').trim(),
        notes: null,
        allDay: true,
        start: String(body.start ?? ''),
        end: null,
        rrule: body.rrule ? String(body.rrule) : null,
        remindMinutes: null,
        targetDate: body.targetDate ? String(body.targetDate) : null,
        color: null,
        completed: false,
        createdAt: now,
        updatedAt: now,
        deletedAt: null
      }
      if (!row.title || !row.start) return json({ error: '缺少 title/start' }, 400)
      await saveRow(env, 'events', row)
      return json({ id: row.id })
    }

    if (url.pathname === '/api/events/delete' && req.method === 'POST') {
      const body = await jsonBody(req)
      const id = String(body.id ?? '')
      const rows = await loadTable(env, 'events')
      const hit = rows.find((r) => r.id === id)
      if (!hit) return json({ error: '事件不存在' }, 404)
      await saveRow(env, 'events', { ...hit, deletedAt: Date.now(), updatedAt: Date.now() })
      return json({ ok: true })
    }

    if (url.pathname === '/api/events/toggle' && req.method === 'POST') {
      const body = await jsonBody(req)
      const eventId = String(body.id ?? '')
      const date = String(body.date ?? '')
      const done = Boolean(body.done)
      await saveRow(env, 'event_done', {
        id: `${eventId}:${date}`,
        eventId,
        occurrenceDate: date,
        updatedAt: Date.now(),
        deletedAt: done ? null : Date.now()
      })
      return json({ ok: true, done })
    }

    if (url.pathname === '/api/events/skip' && req.method === 'POST') {
      const body = await jsonBody(req)
      const eventId = String(body.id ?? '')
      const date = String(body.date ?? '')
      if (!eventId || !date) return json({ error: '缺少 id/date' }, 400)
      // 与桌面端同构：行主键固定为「事件:日期」，桌面端按 id 回滚/去重
      await saveRow(env, 'event_skip', {
        id: `${eventId}:${date}`,
        eventId,
        occurrenceDate: date,
        updatedAt: Date.now(),
        deletedAt: null
      })
      return json({ ok: true })
    }

    if (url.pathname === '/api/notes' && req.method === 'GET') {
      const rows = (await loadTable(env, 'notes')).filter((r) => !r.deletedAt)
      rows.sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt))
      return json(
        rows.map((r) => ({
          id: r.id,
          calendarId: r.calendarId,
          title: r.title ?? '',
          content: r.content ?? '',
          pinned: Boolean(r.pinned),
          updatedAt: r.updatedAt
        }))
      )
    }

    if (url.pathname === '/api/notes/save' && req.method === 'POST') {
      const body = await jsonBody(req)
      const now = Date.now()
      const id = body.id ? String(body.id) : `note:${crypto.randomUUID()}`
      const existing = (await loadTable(env, 'notes')).find((r) => r.id === id)
      const row: SyncRow = {
        id,
        calendarId: String(body.calendarId ?? existing?.calendarId ?? ''),
        title: String(body.title ?? existing?.title ?? ''),
        content: String(body.content ?? existing?.content ?? ''),
        pinned: body.pinned !== undefined ? Boolean(body.pinned) : Boolean(existing?.pinned),
        color: null,
        createdAt: Number(existing?.createdAt ?? now),
        updatedAt: now,
        deletedAt: null
      }
      await saveRow(env, 'notes', row)
      return json({ id, title: row.title, content: row.content })
    }

    if (url.pathname === '/api/notes/delete' && req.method === 'POST') {
      const body = await jsonBody(req)
      const id = String(body.id ?? '')
      const hit = (await loadTable(env, 'notes')).find((r) => r.id === id)
      if (!hit) return json({ error: '便签不存在' }, 404)
      await saveRow(env, 'notes', { ...hit, deletedAt: Date.now(), updatedAt: Date.now() })
      return json({ ok: true })
    }

    if (url.pathname === '/api/notes/get' && req.method === 'GET') {
      const id = url.searchParams.get('id') ?? ''
      const hit = (await loadTable(env, 'notes')).find((r) => r.id === id && !r.deletedAt)
      if (!hit) return json({ error: '便签不存在' }, 404)
      return json({ id: hit.id, title: hit.title ?? '', content: hit.content ?? '' })
    }

    if (url.pathname === '/api/calendars/create' && req.method === 'POST') {
      const body = await jsonBody(req)
      const name = String(body.name ?? '').trim()
      if (!name) return json({ error: '名称不能为空' }, 400)
      const rows = (await loadTable(env, 'calendars')).filter((r) => !r.deletedAt)
      if (rows.some((r) => r.name === name)) return json({ error: `已存在同名视图「${name}」` }, 400)
      const now = Date.now()
      const row: SyncRow = {
        id: `cal:${crypto.randomUUID()}`,
        name,
        color: String(body.color ?? '#5b8cff'),
        sort: rows.length,
        createdAt: now,
        updatedAt: now,
        deletedAt: null
      }
      await saveRow(env, 'calendars', row)
      return json({ id: row.id, name: row.name, color: row.color })
    }

    if (url.pathname === '/api/calendars/delete' && req.method === 'POST') {
      const body = await jsonBody(req)
      const id = String(body.id ?? '')
      const rows = (await loadTable(env, 'calendars')).filter((r) => !r.deletedAt)
      if (rows.length <= 1) return json({ error: '至少保留一个视图' }, 400)
      const hit = rows.find((r) => r.id === id)
      if (!hit) return json({ error: '视图不存在' }, 404)
      await saveRow(env, 'calendars', { ...hit, deletedAt: Date.now(), updatedAt: Date.now() })
      return json({ ok: true })
    }

    if (url.pathname === '/api/search' && req.method === 'GET') {
      const q = (url.searchParams.get('q') ?? '').trim().toLowerCase()
      if (!q) return json([])
      const [cals, cells, events, notes] = await Promise.all([
        loadTable(env, 'calendars'),
        loadTable(env, 'day_cells'),
        loadTable(env, 'events'),
        loadTable(env, 'notes')
      ])
      const calName = new Map(cals.map((c) => [c.id, String(c.name ?? '')]))
      const hits: Array<Record<string, unknown>> = []
      for (const c of cells) {
        if (c.deletedAt) continue
        splitLines(String(c.text ?? '')).forEach((line, idx) => {
          if (line.toLowerCase().includes(q)) {
            hits.push({
              type: 'task',
              calendarId: c.calendarId,
              calendarName: calName.get(String(c.calendarId)) ?? '',
              date: c.date,
              title: lineText(line),
              lineIndex: idx
            })
          }
        })
      }
      for (const e of events) {
        if (e.deletedAt) continue
        if (String(e.title ?? '').toLowerCase().includes(q)) {
          hits.push({
            type: 'event',
            calendarId: e.calendarId,
            calendarName: calName.get(String(e.calendarId)) ?? '',
            date: String(e.start ?? '').slice(0, 10),
            title: e.title,
            eventId: e.id
          })
        }
      }
      for (const n of notes) {
        if (n.deletedAt) continue
        const text = `${n.title ?? ''} ${n.content ?? ''}`.toLowerCase()
        if (text.includes(q)) {
          hits.push({
            type: 'note',
            calendarId: n.calendarId,
            calendarName: calName.get(String(n.calendarId)) ?? '',
            date: new Date(Number(n.updatedAt)).toISOString().slice(0, 10),
            title: n.title || String(n.content ?? '').split('\n')[0].slice(0, 30),
            noteId: n.id
          })
        }
      }
      return json(hits.slice(0, 100))
    }

    return json({ error: 'not found' }, 404)
  }
}

/* ------------------------------ REST 辅助 ------------------------------ */

async function loadTable(env: Env, table: string): Promise<SyncRow[]> {
  const { results } = await env.DB.prepare('SELECT payload FROM rows WHERE tbl = ?')
    .bind(table)
    .all<{ payload: string }>()
  return (results ?? []).map((r) => JSON.parse(r.payload) as SyncRow)
}

async function saveRow(env: Env, table: string, row: SyncRow): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO rows (tbl, id, updated_at, deleted_at, payload)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(tbl, id) DO UPDATE SET
       updated_at = excluded.updated_at,
       deleted_at = excluded.deleted_at,
       payload    = excluded.payload
     WHERE excluded.updated_at > rows.updated_at`
  )
    .bind(
      table,
      row.id,
      row.updatedAt,
      typeof row.deletedAt === 'number' ? row.deletedAt : null,
      JSON.stringify(row)
    )
    .run()
}

function jsonBody(req: Request): Promise<Record<string, unknown>> {
  return req.json() as Promise<Record<string, unknown>>
}

const cellId = (calendarId: string, date: string): string => `${calendarId}:${date}`

async function readCell(env: Env, calendarId: string, date: string): Promise<string> {
  const rows = await loadTable(env, 'day_cells')
  const hit = rows.find((r) => r.id === cellId(calendarId, date) && !r.deletedAt)
  return hit ? String(hit.text ?? '') : ''
}

async function writeCell(
  env: Env,
  calendarId: string,
  date: string,
  text: string
): Promise<void> {
  await saveRow(env, 'day_cells', {
    id: cellId(calendarId, date),
    calendarId,
    date,
    text,
    color: null,
    updatedAt: Date.now(),
    deletedAt: null
  })
}

function expandEvent(event: SyncRow, from: string, to: string): string[] {
  const start = String(event.start ?? '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return []
  if (event.kind === 'countdown' && event.targetDate) {
    const begin = Math.max(toDayNumber(from), toDayNumber(start))
    const end = Math.min(toDayNumber(to), toDayNumber(String(event.targetDate)))
    const out: string[] = []
    let cursor = begin
    let guard = 0
    while (cursor <= end && guard < 100) {
      out.push(fromDayNumber(cursor))
      cursor += 1
      guard += 1
    }
    return out
  }
  if (typeof event.rrule === 'string' && event.rrule) {
    return expandRrule(event.rrule, start, from, to)
  }
  return start >= from && start <= to ? [start] : []
}

async function listOccurrences(
  env: Env,
  calendarId: string,
  from: string,
  to: string
): Promise<Array<{ event: SyncRow; date: string; done: boolean }>> {
  const [events, dones] = await Promise.all([
    loadTable(env, 'events'),
    loadTable(env, 'event_done')
  ])
  const doneSet = new Set(dones.filter((d) => !d.deletedAt).map((d) => String(d.id)))
  const out: Array<{ event: SyncRow; date: string; done: boolean }> = []
  for (const event of events) {
    if (event.deletedAt) continue
    if (calendarId && event.calendarId !== calendarId) continue
    for (const date of expandEvent(event, from, to)) {
      out.push({
        event,
        date,
        done: event.rrule ? doneSet.has(`${event.id}:${date}`) : Boolean(event.completed)
      })
    }
  }
  return out.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1
    const ac = Number(a.event.createdAt ?? 0)
    const bc = Number(b.event.createdAt ?? 0)
    if (ac !== bc) return ac - bc
    return String(a.event.title ?? '').localeCompare(String(b.event.title ?? ''))
  })
}
