/**
 * 本地 API：同时提供 MCP（JSON-RPC 2.0）与 CLI 使用的入口。
 *
 * 默认监听 127.0.0.1:19283（固定高位端口），可用 CALDESK_MCP_PORT 环境变量覆盖。
 * 端口写入 userData/runtime.json，CLI 与 stdio 桥读该文件发现端口。
 *
 * 安全模型（本地回环服务，浏览器是同机最大的攻击面）：
 *  1. 只绑 127.0.0.1，绝不绑 0.0.0.0；
 *  2. POST /mcp 强制 `Content-Type: application/json`——浏览器跨源发 JSON 必须先预检，
 *     预检在这里被拒，从而挡掉「任意网页用 text/plain 盲写日历」的 CSRF；
 *  3. 带 Origin 的请求必须是本机回环来源（含端口），其余 403；
 *  4. Host 头必须是回环名，挡 DNS rebinding；
 *  5. 可选共享令牌：设置 CALDESK_MCP_TOKEN 后 /mcp 与 /sync/run、/migrate/run 需要
 *     `Authorization: Bearer <runtime.json 里的 token>`，CLI 与 stdio 桥会自动带上。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { DEFAULT_MCP_PORT } from '@shared/identity'
import { TOOLS } from '@shared/tools'
import type { DayCell, EventInput, NoteInput } from '@shared/types'
import * as db from './db'

const SERVER_NAME = 'caldesk'
/**
 * 协议里报的版本号。由主进程用 `app.getVersion()` 注入，
 * 不再手写常量——之前写死 '0.2.0'，package.json 升到 1.0.0 后就对不上了。
 */
let serverVersion = '1.0.0'
/** 支持的 MCP 协议版本；客户端请求其中之一就照原样回，否则回最新版 */
const PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18']
const LATEST_PROTOCOL = PROTOCOL_VERSIONS[PROTOCOL_VERSIONS.length - 1]
const MAX_BODY = 1_000_000

/** 允许的浏览器来源：本机回环（任意端口）。file:// 会发 `Origin: null`，一律拒绝。 */
const LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

interface RpcMessage {
  jsonrpc: '2.0'
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

/** 协议级错误（映射到 JSON-RPC error），与「工具执行失败」（isError 内容）区分开 */
class RpcError extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

/** 工具入参不合法：同样算工具执行失败，但文案要能指导 AI 重试 */
class ToolInputError extends Error {}

function ok(result: unknown): unknown {
  const text =
    typeof result === 'string' ? result : JSON.stringify(result ?? null, null, 2)
  return { content: [{ type: 'text', text }] }
}

function fail(message: string): unknown {
  return { content: [{ type: 'text', text: message }], isError: true }
}

/* ----------------------------- 入参校验 ----------------------------- */

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function needString(args: Record<string, unknown>, key: string, allowEmpty = false): string {
  const v = args[key]
  if (typeof v !== 'string') {
    throw new ToolInputError(
      `参数 ${key} 必须是字符串，收到 ${describe(v)}${v === undefined ? '（缺少该参数）' : ''}`
    )
  }
  if (!allowEmpty && !v.trim()) throw new ToolInputError(`参数 ${key} 不能为空`)
  return v
}

function optString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw new ToolInputError(`参数 ${key} 必须是字符串，收到 ${describe(v)}`)
  return v
}

/**
 * 行号/条数这类整数参数。
 * 注意不能写成 Number(x)：`Number(null) === 0`，AI 传 null/NaN 会静默操作第 0 行。
 */
function needInt(
  args: Record<string, unknown>,
  key: string,
  { min = 0, max = Number.MAX_SAFE_INTEGER }: { min?: number; max?: number } = {}
): number {
  const range = max === Number.MAX_SAFE_INTEGER ? `≥${min}` : `${min}–${max}`
  const v = args[key]
  if (v === undefined || v === null) {
    throw new ToolInputError(`参数 ${key} 必须是 ${range} 的整数${v === undefined ? '（缺少该参数）' : '，收到 null'}`)
  }
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new ToolInputError(`参数 ${key} 必须是整数（不要加引号），收到 ${describe(v)}`)
  }
  if (v < min || v > max) throw new ToolInputError(`参数 ${key} 必须是 ${range} 的整数，收到 ${v}`)
  return v
}

function optInt(
  args: Record<string, unknown>,
  key: string,
  opts: { min?: number; max?: number; fallback: number }
): number {
  if (args[key] === undefined || args[key] === null) return opts.fallback
  return needInt(args, key, opts)
}

function needBool(args: Record<string, unknown>, key: string): boolean {
  const v = args[key]
  if (typeof v !== 'boolean') {
    throw new ToolInputError(
      `参数 ${key} 必须是布尔值 true/false（不要传字符串 "false"），收到 ${describe(v)}`
    )
  }
  return v
}

function optBool(args: Record<string, unknown>, key: string): boolean | undefined {
  if (args[key] === undefined || args[key] === null) return undefined
  return needBool(args, key)
}

/* ----------------------------- 工具实现 ----------------------------- */

function firstCalendarId(): string {
  const list = db.listCalendars()
  if (list.length === 0) throw new Error('还没有任何视图，请先在 caldesk 里新建一个')
  return list[0].id
}

function resolveCalendar(args: Record<string, unknown>): string {
  const v = args.calendar_id
  if (v === undefined || v === null || v === '') return firstCalendarId()
  if (typeof v !== 'string') throw new ToolInputError(`参数 calendar_id 必须是字符串，收到 ${describe(v)}`)
  return v
}

/** 日格内容的统一返回结构：AI 侧可直接解析，不必再猜 */
function cellView(calendarId: string, cell: DayCell): unknown {
  return {
    calendar_id: calendarId,
    date: cell.date,
    text: cell.text,
    lines: cell.text ? cell.text.split('\n') : []
  }
}

/** 工具内部出现的 CRLF 一律收敛成 LF，否则 lines[0] 会带 \r 让行号操作错位 */
function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/** 只读工具：调用它们不该触发界面刷新 */
const READ_TOOLS = new Set([
  'context',
  'calendar_list',
  'items_get',
  'items_query',
  'events_query',
  'search',
  'notes_list',
  'notes_get'
])

const EVENT_KINDS = new Set(['all', 'task', 'reminder', 'countdown'])

/** 由 startApiServer 注入：写操作后通知所有窗口重新读库 */
let writeNotify: (() => void) | null = null

/** 执行一个 MCP 工具 */
export function callTool(name: string, args: Record<string, unknown>): unknown {
  const result = runTool(name, args)
  // 写类工具执行完要通知窗口重读：AI 在后台改了日程，界面不能还停在旧数据上
  if (!READ_TOOLS.has(name)) writeNotify?.()
  return result
}

function runTool(name: string, args: Record<string, unknown>): unknown {
  try {
    switch (name) {
      case 'context': {
        const list = db.listCalendars()
        const now = new Date()
        const p = (n: number) => String(n).padStart(2, '0')
        const today = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
        return ok({
          today,
          default_calendar_id: list[0]?.id ?? null,
          default_calendar_name: list[0]?.name ?? null,
          calendar_count: list.length,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
        })
      }

      case 'calendar_list':
        return ok(
          db.listCalendars().map((c) => ({ id: c.id, name: c.name, color: c.color }))
        )

      case 'items_get': {
        const calendarId = resolveCalendar(args)
        const date = needString(args, 'date')
        return ok(cellView(calendarId, db.getDayCell(calendarId, date)))
      }

      case 'items_query': {
        const calendarId = resolveCalendar(args)
        const from = needString(args, 'from')
        const to = needString(args, 'to')
        if (from > to) throw new ToolInputError(`from（${from}）不能晚于 to（${to}）`)
        return ok(
          db
            .listDayCells(calendarId, from, to)
            // 空日格没有信息量，过滤掉免得 AI 把「有 0 条任务」当成任务
            .filter((c) => c.text.trim() !== '')
            .map((c) => cellView(calendarId, c))
        )
      }

      case 'items_append_line': {
        const calendarId = resolveCalendar(args)
        const date = needString(args, 'date')
        const text = needString(args, 'text')
        if (/[\r\n]/.test(text)) {
          throw new ToolInputError('items_append_line 只能追加单行文本；多行请用 items_set')
        }
        return ok(cellView(calendarId, db.appendDayLine(calendarId, date, text)))
      }

      case 'items_set': {
        const calendarId = resolveCalendar(args)
        const date = needString(args, 'date')
        // 允许空串：语义就是「清空这一格」
        const text = needString(args, 'text', true)
        return ok(cellView(calendarId, db.setDayCellText(calendarId, date, normalizeText(text))))
      }

      case 'item_line_update': {
        const calendarId = resolveCalendar(args)
        const date = needString(args, 'date')
        const index = needInt(args, 'index')
        const text = needString(args, 'text')
        if (/[\r\n]/.test(text)) throw new ToolInputError('单行任务不能包含换行')
        return ok(cellView(calendarId, db.updateDayLine(calendarId, date, index, text)))
      }

      case 'item_line_delete': {
        const calendarId = resolveCalendar(args)
        const date = needString(args, 'date')
        const index = needInt(args, 'index')
        return ok(cellView(calendarId, db.deleteDayLine(calendarId, date, index)))
      }

      case 'item_line_set_done': {
        const calendarId = resolveCalendar(args)
        const date = needString(args, 'date')
        const index = needInt(args, 'index')
        const done = needBool(args, 'done')
        return ok(cellView(calendarId, db.setDayLineDone(calendarId, date, index, done)))
      }

      case 'item_line_move': {
        const calendarId = resolveCalendar(args)
        const fromDate = needString(args, 'from_date')
        const toDate = needString(args, 'to_date')
        const index = needInt(args, 'index')
        // 同天移动在 db 层会「先写目标再写源」，同一天时两步互相覆盖导致丢行，直接挡住
        if (fromDate === toDate) {
          throw new ToolInputError('from_date 与 to_date 相同，同一天内不需要移动（会丢行）')
        }
        return ok(db.moveDayLine(calendarId, fromDate, index, toDate))
      }

      case 'events_query': {
        const calendarId = resolveCalendar(args)
        const from = needString(args, 'from')
        const to = needString(args, 'to')
        const kind = optString(args, 'kind') ?? 'all'
        if (!EVENT_KINDS.has(kind)) {
          throw new ToolInputError(`kind 必须是 all / task / reminder / countdown，收到「${kind}」`)
        }
        if (from > to) throw new ToolInputError(`from（${from}）不能晚于 to（${to}）`)
        const occ = db.listOccurrences(calendarId, from, to, kind as 'all')
        return ok(
          occ.map((o) => ({
            date: o.date,
            id: o.event.id,
            kind: o.event.kind,
            title: o.event.title,
            rrule: o.event.rrule,
            done: o.done,
            target_date: o.event.targetDate
          }))
        )
      }

      case 'event_create': {
        const remindArg = args.remind_minutes
        const input: EventInput = {
          calendarId: resolveCalendar(args),
          title: needString(args, 'title'),
          kind: needString(args, 'kind') as EventInput['kind'],
          start: needString(args, 'start'),
          rrule: optString(args, 'rrule') ?? null,
          targetDate: optString(args, 'target_date') ?? null,
          remindMinutes:
            remindArg === undefined || remindArg === null
              ? null
              : needInt(args, 'remind_minutes', { min: 0, max: 10080 })
        }
        const created = db.createEvent(input)
        return ok({
          id: created.id,
          title: created.title,
          kind: created.kind,
          start: created.start,
          rrule: created.rrule,
          target_date: created.targetDate,
          remind_minutes: created.remindMinutes
        })
      }

      case 'event_update': {
        const id = needString(args, 'id')
        const patch: Partial<EventInput> = {}
        if (args.title !== undefined) patch.title = needString(args, 'title')
        if (args.kind !== undefined) patch.kind = needString(args, 'kind') as EventInput['kind']
        if (args.start !== undefined) patch.start = needString(args, 'start')
        // null = 显式清空（不带 rrule / 目标日期）
        if (args.rrule !== undefined) patch.rrule = args.rrule === null ? null : needString(args, 'rrule')
        if (args.target_date !== undefined) {
          patch.targetDate = args.target_date === null ? null : needString(args, 'target_date')
        }
        if (Object.keys(patch).length === 0) {
          throw new ToolInputError('event_update 至少要提供 title / kind / start / rrule / target_date 之一')
        }
        const updated = db.updateEvent(id, patch)
        return ok({
          id: updated.id,
          title: updated.title,
          kind: updated.kind,
          start: updated.start,
          rrule: updated.rrule,
          target_date: updated.targetDate
        })
      }

      case 'event_delete': {
        const id = needString(args, 'id')
        db.deleteEvent(id)
        return ok({ deleted: id })
      }

      case 'search': {
        const query = needString(args, 'query')
        const calendarId = optString(args, 'calendar_id')
        const limit = optInt(args, 'limit', { min: 1, max: 200, fallback: 50 })
        return ok(db.search(query, calendarId, limit))
      }

      case 'notes_list': {
        const calendarId = optString(args, 'calendar_id')
        const limit = optInt(args, 'limit', { min: 1, max: 500, fallback: 100 })
        return ok(
          db.listNotes(calendarId, limit).map((n) => ({
            id: n.id,
            title: n.title || n.content.split('\n')[0].slice(0, 40),
            preview: n.content.slice(0, 120),
            pinned: n.pinned,
            updatedAt: n.updatedAt,
            calendar_id: n.calendarId
          }))
        )
      }

      case 'notes_get': {
        const note = db.getNote(needString(args, 'id'))
        return ok({
          id: note.id,
          title: note.title,
          content: note.content,
          pinned: note.pinned,
          calendar_id: note.calendarId
        })
      }

      case 'notes_create': {
        const created = db.createNote({
          calendarId: resolveCalendar(args),
          title: optString(args, 'title') ?? '',
          content: needString(args, 'content', true),
          pinned: optBool(args, 'pinned') ?? false
        })
        return ok({ id: created.id, title: created.title, pinned: created.pinned })
      }

      case 'notes_update': {
        const id = needString(args, 'id')
        const patch: Partial<NoteInput> = {}
        if (args.title !== undefined) patch.title = optString(args, 'title') ?? ''
        if (args.content !== undefined) patch.content = needString(args, 'content', true)
        if (args.pinned !== undefined) patch.pinned = needBool(args, 'pinned')
        if (Object.keys(patch).length === 0) {
          throw new ToolInputError('notes_update 至少要提供 title / content / pinned 之一')
        }
        const updated = db.updateNote(id, patch)
        return ok({ id: updated.id, title: updated.title, pinned: updated.pinned })
      }

      case 'notes_delete': {
        const id = needString(args, 'id')
        db.deleteNote(id)
        return ok({ deleted: id })
      }

      default:
        // 未知工具属于协议层参数错误（MCP 规范：-32602），不是「工具执行失败」
        throw new RpcError(-32602, `未知工具：${name}`)
    }
  } catch (err) {
    if (err instanceof RpcError) throw err
    return fail((err as Error).message)
  }
}

/* ----------------------------- JSON-RPC ----------------------------- */

function errResponse(id: string | number | null, code: number, message: string): unknown {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function validId(id: unknown): id is string | number | null {
  return id === null || typeof id === 'string' || typeof id === 'number'
}

/** 处理一条 JSON-RPC 消息；返回 null 表示不需要响应（通知） */
export function dispatch(msg: unknown): unknown | null {
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
    return errResponse(null, -32600, '无效的 JSON-RPC 请求：必须是对象')
  }
  const m = msg as RpcMessage
  const isNotification = !Object.prototype.hasOwnProperty.call(m, 'id')
  const id = isNotification ? undefined : (m.id as string | number | null)

  if (m.jsonrpc !== '2.0' || typeof m.method !== 'string' || !m.method) {
    // 通知本身不合法时也不能回包（JSON-RPC 2.0 §4.1）
    return isNotification ? null : errResponse(null, -32600, '无效的 JSON-RPC 请求：缺少 jsonrpc=2.0 或 method')
  }
  if (!isNotification && !validId(m.id)) {
    return errResponse(null, -32600, '无效的 JSON-RPC 请求：id 必须是字符串、数字或 null')
  }
  if (m.params !== undefined && (m.params === null || typeof m.params !== 'object' || Array.isArray(m.params))) {
    return isNotification ? null : errResponse(id as string | number | null, -32602, 'params 必须是对象')
  }

  const { method, params } = m

  // 通知：执行副作用但不回包。原来这里会回一个没有 id 的 result，违反 JSON-RPC 2.0
  if (isNotification) {
    if (method === 'tools/call') {
      try {
        const p = params as Record<string, unknown>
        if (typeof p.name === 'string' && p.name) callTool(p.name, asArgs(p.arguments))
      } catch {
        /* 通知没有回包通道，失败只能吞掉 */
      }
    }
    return null
  }

  try {
    switch (method) {
      case 'initialize': {
        const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : ''
        const protocolVersion = PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: SERVER_NAME, version: serverVersion },
            instructions: buildInstructions()
          }
        }
      }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} }
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: TOOLS } }
      case 'tools/call': {
        if (!params) throw new RpcError(-32602, 'tools/call 缺少 params')
        const name = typeof params.name === 'string' ? params.name.trim() : ''
        if (!name) throw new RpcError(-32602, 'tools/call 缺少 name')
        const args = asArgs(params.arguments)
        return { jsonrpc: '2.0', id, result: callTool(name, args) }
      }
      default:
        return errResponse(id as string | number | null, -32601, `未实现的方法：${method}`)
    }
  } catch (error) {
    if (error instanceof RpcError) {
      return errResponse(id as string | number | null, error.code, error.message)
    }
    return errResponse(id as string | number | null, -32603, (error as Error).message)
  }
}

function asArgs(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new RpcError(-32602, `tools/call 的 arguments 必须是对象，收到 ${describe(value)}`)
  }
  return value as Record<string, unknown>
}

/* ----------------------------- HTTP 层 ----------------------------- */

class BodyTooLarge extends Error {}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? NaN)
    if (Number.isFinite(declared) && declared > limit) {
      reject(new BodyTooLarge(`请求体过大（上限 ${limit} 字节）`))
      return
    }
    let size = 0
    let done = false
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      if (done) return
      size += chunk.length
      if (size > limit) {
        done = true
        chunks.length = 0
        reject(new BodyTooLarge(`请求体过大（上限 ${limit} 字节）`))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (done) return
      done = true
      resolve(Buffer.concat(chunks).toString('utf-8'))
    })
    req.on('error', (err) => {
      if (done) return
      done = true
      reject(err)
    })
  })
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  extra: Record<string, string> = {}
): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...extra
  })
  res.end(body)
}

function sendEmpty(res: ServerResponse, status: number, extra: Record<string, string> = {}): void {
  res.writeHead(status, extra)
  res.end()
}

function originOf(req: IncomingMessage): string {
  const raw = req.headers.origin
  return typeof raw === 'string' ? raw.trim() : ''
}

function isAllowedOrigin(origin: string): boolean {
  return LOOPBACK_ORIGIN.test(origin)
}

/** DNS rebinding 防护：Host 头必须是回环名（无 Host 的非浏览器客户端放行） */
function isAllowedHost(host: string): boolean {
  if (!host) return true
  let name = host.trim().toLowerCase()
  if (name.startsWith('[')) {
    const end = name.indexOf(']')
    name = end > 0 ? name.slice(1, end) : name
  } else {
    name = name.replace(/:\d+$/, '')
  }
  return LOOPBACK_HOSTS.has(name)
}

/** 只接受 application/json（允许 charset 等参数）；这是挡 CSRF 的第一道闸 */
function isJsonContentType(req: IncomingMessage): boolean {
  const raw = req.headers['content-type']
  if (typeof raw !== 'string') return false
  return raw.split(';')[0].trim().toLowerCase() === 'application/json'
}

function bearerOf(req: IncomingMessage): string {
  const raw = req.headers.authorization
  if (typeof raw !== 'string') return ''
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim())
  return m ? m[1].trim() : ''
}

/** 令牌比对走常量时间，避免按字节短路泄露前缀（本地场景收益有限，但成本 3 行） */
function sameToken(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/**
 * `initialize` 返回的 instructions。
 *
 * 这段文字会被支持它的客户端（Claude Desktop、Cursor 等）当成系统提示读进去，
 * 所以只放「不写就一定会踩」的约定：日期格式、返回结构、错误语义、行号时序、RRULE 子集。
 * 更细的工具级约束仍然留在 tools.ts 的 description 里。
 */
function buildInstructions(): string {
  return [
    'caldesk 是用户本机的待办 / 日历应用，你通过 MCP 直接读写他本机的数据。',
    '',
    '1) 第一次调用先执行 `context` 拿 today 和 default_calendar_id。用户说「今天 / 明天 / 这周」时先取 today 再推算，不要凭训练数据猜当前日期。',
    '2) 日期一律是本地日历日 `YYYY-MM-DD`（例：2026-11-07），不带时间、不带时区。',
    '3) 工具返回的 `content[0].text` 是一段 **JSON 文本**（不是对象），需要先 JSON.parse。成功时是数据本身；失败时 `isError: true`，text 是中文的失败原因。',
    '4) 参数不合法（类型不对 / 缺必填 / 越界 / id 不存在）走 `result.isError`（HTTP 仍是 200），按 text 改参数重试即可，不要放弃；只有协议层问题（未知工具名、arguments 不是对象）才返回 JSON-RPC error。',
    '5) 写操作请显式传 `calendar_id`（从 `calendar_list` 或 `context` 取）。省略会落到「排序第一」的视图，可能不是用户想改的那个。',
    '6) `item_line_*` 的 index 从 0 开始，指「当前这一格中的行序号」。连续改多行时每轮先 `items_get` 刷新，否则删掉一行后行号会前移。',
    '7) 写操作执行后会自动刷新界面，不需要再调一次读接口确认。',
    '8) `rrule` 用 RFC5545 片段且不写 DTSTART，例：`FREQ=WEEKLY;BYDAY=WE`、`FREQ=DAILY;INTERVAL=2`。支持 FREQ / INTERVAL / COUNT / UNTIL / BYDAY / BYMONTHDAY；BYMONTH、BYSETPOS、BYYEARDAY、WKST 会被忽略。',
    '',
    '可用工具：' + TOOLS.map((t) => t.name).join(' / ')
  ].join('\n')
}

export interface ApiHandle {
  port: number
  close(): void
}

export interface ApiHooks {
  /** 应用版本号（主进程传 app.getVersion()），用于 MCP initialize 的 serverInfo */
  version?: string
  /** 触发一次同步；由主进程注入，避免 api 直接依赖同步实现 */
  runSync?: (options: { full?: boolean }) => Promise<unknown>
  /** 触发旧数据迁移（可执行文件由主进程自己探测，不接受外部传入） */
  runMigrate?: (options: { from: string; to: string }) => Promise<unknown>
  /** 写类工具执行后回调：主进程用它通知窗口重读 */
  onDataChanged?: () => void
}

export function startApiServer(userDataDir: string, hooks: ApiHooks = {}): Promise<ApiHandle> {
  return new Promise((resolve, reject) => {
    writeNotify = hooks.onDataChanged ?? null
    if (hooks.version) serverVersion = hooks.version
    const startedAt = Date.now()
    const instanceId = randomBytes(8).toString('hex')
    // 可选共享令牌：设了 CALDESK_MCP_TOKEN 才启用，默认不启用（本机回环，无鉴权）
    const token = (process.env.CALDESK_MCP_TOKEN ?? '').trim()

    const server = createServer((req, res) => {
      void (async () => {
        // 注意：必须解析成 URL 对象，否则 searchParams 不存在（曾因此报 reading 'get'）
        const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
        const pathname = reqUrl.pathname
        const origin = originOf(req)
        const host = typeof req.headers.host === 'string' ? req.headers.host : ''

        // 1) 来源校验：带 Origin 的请求只允许本机回环（浏览器跨源攻击在这里被挡住）
        if (origin && !isAllowedOrigin(origin)) {
          sendJson(res, 403, { ok: false, error: 'origin_not_allowed', origin })
          return
        }
        if (!isAllowedHost(host)) {
          sendJson(res, 403, { ok: false, error: 'host_not_allowed', host })
          return
        }
        const cors: Record<string, string> = origin
          ? { 'access-control-allow-origin': origin, vary: 'origin' }
          : {}

        // 2) 预检：合法来源回 204 + 明确的 CORS 能力；非法来源已在上面 403
        if (req.method === 'OPTIONS') {
          sendEmpty(res, 204, {
            ...cors,
            'access-control-allow-methods': 'POST, GET, OPTIONS',
            'access-control-allow-headers':
              'content-type, authorization, mcp-protocol-version, mcp-session-id',
            'access-control-max-age': '600'
          })
          return
        }

        // 3) 所有 POST 一律要求 application/json。
        //    浏览器发这个类型必须先预检，预检在这里被拒 → 跨源「简单请求」写不进来。
        //    以前这段只包在 `/mcp` 分支里，`/sync/run`、`/migrate/run` 因此能被打成盲 CSRF，
        //    现在提到所有 POST 之前，任何新加端点都自动带上这道闸。
        if (req.method === 'POST' && !isJsonContentType(req)) {
          sendJson(
            res,
            415,
            pathname === '/mcp'
              ? {
                  jsonrpc: '2.0',
                  id: null,
                  error: {
                    code: -32000,
                    message: 'Content-Type 必须是 application/json（本服务不接受表单/text/plain 提交）'
                  }
                }
              : {
                  ok: false,
                  error: 'content_type_required',
                  message: 'Content-Type 必须是 application/json'
                },
            cors
          )
          return
        }

        if ((req.method === 'GET' || req.method === 'HEAD') && pathname === '/health') {
          const payload = { ok: true, app: 'caldesk', pid: process.pid, startedAt }
          if (req.method === 'HEAD') {
            sendEmpty(res, 200, cors)
            return
          }
          sendJson(res, 200, payload, cors)
          return
        }

        // 需要令牌的写/管理端点（默认无令牌，token 为空时这段整体跳过）
        const authRequired =
          token !== '' &&
          (pathname === '/mcp' || pathname === '/sync/run' || pathname === '/migrate/run')
        if (authRequired && !sameToken(bearerOf(req), token)) {
          sendJson(
            res,
            401,
            {
              jsonrpc: '2.0',
              id: null,
              error: {
                code: -32001,
                message:
                  '缺少或错误的访问令牌：请读取 userData/runtime.json 的 token 字段，放到 Authorization: Bearer 头（cal 与 cal-mcp 会自动带）'
              }
            },
            { ...cors, 'www-authenticate': 'Bearer' }
          )
          return
        }

        if (req.method === 'POST' && pathname === '/sync/run') {
          if (!hooks.runSync) {
            sendJson(res, 503, { ok: false, error: '同步未启用' }, cors)
            return
          }
          try {
            const full = reqUrl.searchParams.get('full') === '1'
            const result = await hooks.runSync({ full })
            sendJson(res, 200, result, cors)
          } catch (err) {
            const e = err as Error
            // 细节只进本地日志；响应里不回 message/stack——里面带安装路径，
            // 等于把 asar 结构与依赖版本白送给任何能打这个端点的进程
            console.error('[caldesk] sync 失败:', e.stack ?? e.message)
            sendJson(res, 500, { ok: false, error: 'sync_failed' }, cors)
          }
          return
        }

        if (req.method === 'POST' && pathname === '/migrate/run') {
          if (!hooks.runMigrate) {
            sendJson(res, 503, { ok: false, error: '迁移未启用' }, cors)
            return
          }
          try {
            const from = reqUrl.searchParams.get('from') ?? ''
            const to = reqUrl.searchParams.get('to') ?? ''
            // 不接受外部指定可执行文件。
            // 以前这里能传 `command` / `args`，一路下到 migrate.ts 的 spawn()，
            // 等于给本机任意进程（以及任意 localhost 页面的盲 CSRF）开了一个
            // 「以当前用户身份执行任意程序」的接口。现在只允许主进程自己探测旧版程序。
            const result = await hooks.runMigrate({ from, to })
            sendJson(res, 200, result, cors)
          } catch (err) {
            sendJson(res, 500, { ok: false, error: (err as Error).message }, cors)
          }
          return
        }

        if (pathname === '/mcp') {
          if (req.method !== 'POST') {
            // 没有 SSE 通道（GET 用来开服务端推送流），如实回 405 并给出允许的方法
            sendJson(
              res,
              405,
              {
                jsonrpc: '2.0',
                id: null,
                error: { code: -32000, message: 'MCP 端点只接受 POST（本服务不提供 SSE 推送流）' }
              },
              { ...cors, allow: 'POST, OPTIONS' }
            )
            return
          }
          // Content-Type 已在上面「所有 POST 一律要求 application/json」处统一校验
          try {
            const raw = await readBody(req, MAX_BODY)
            const parsed = JSON.parse(raw) as unknown
            if (Array.isArray(parsed)) {
              // 空批次是无效请求（JSON-RPC 2.0 §6）
              if (parsed.length === 0) {
                sendJson(res, 200, errResponse(null, -32600, '无效的 JSON-RPC 批次：数组不能为空'), cors)
                return
              }
              const out = parsed.map((m) => dispatch(m)).filter((r) => r !== null)
              if (out.length === 0) {
                sendEmpty(res, 202, cors)
                return
              }
              sendJson(res, 200, out, cors)
              return
            }
            const result = dispatch(parsed)
            if (result === null) {
              sendEmpty(res, 202, cors)
              return
            }
            sendJson(res, 200, result, cors)
          } catch (err) {
            if (err instanceof BodyTooLarge) {
              sendJson(
                res,
                413,
                { jsonrpc: '2.0', id: null, error: { code: -32000, message: err.message } },
                { ...cors, connection: 'close' }
              )
              req.resume()
              return
            }
            sendJson(
              res,
              400,
              { jsonrpc: '2.0', id: null, error: { code: -32700, message: (err as Error).message } },
              cors
            )
          }
          return
        }

        sendJson(res, 404, { error: 'not found' }, cors)
      })().catch((err) => {
        // 客户端中途断开（EPIPE/ECONNRESET）等：回不了包就把连接收掉，
        // 不要留下未处理的 Promise 拒绝污染主进程日志
        try {
          if (!res.headersSent) {
            sendJson(res, 500, { ok: false, error: (err as Error).message })
            return
          }
        } catch {
          /* 连头都发不出去，直接销毁 */
        }
        res.destroy()
      })
    })

    server.on('error', reject)
    // 显式绑回环地址：绝不监听 0.0.0.0，否则同局域网的其他机器能直接读写日历
    const port = Number(process.env.CALDESK_MCP_PORT) || DEFAULT_MCP_PORT
    server.listen(port, '127.0.0.1', () => {
      const actualPort = (server.address() as AddressInfo).port
      try {
        writeFileSync(
          join(userDataDir, 'runtime.json'),
          JSON.stringify(
            { port: actualPort, pid: process.pid, startedAt, instanceId, token: token || undefined },
            null,
            2
          ),
          // 定过令牌时这个文件就是凭据文件，别用默认的 0644
          { mode: 0o600 }
        )
      } catch {
        /* 写不了也不阻塞服务 */
      }
      console.log(
        `[caldesk] MCP 服务已启动：http://127.0.0.1:${actualPort}/mcp${token ? '（需要 Bearer 令牌）' : ''}`
      )
      resolve({
        port: actualPort,
        close: () => {
          // closeAllConnections 强制断开活跃连接（Node 18.2+），否则旧连接会拖住进程不退出
          const s = server as typeof server & { closeAllConnections?: () => void }
          s.closeAllConnections?.()
          server.close()
        }
      })
    })
  })
}
