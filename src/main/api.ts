/**
 * 本地 API：同时提供 MCP（JSON-RPC 2.0）与 CLI 使用的入口。
 *
 * 只监听 127.0.0.1 的随机端口，端口写入 userData/runtime.json，
 * CLI 与 stdio 桥读该文件发现端口。无鉴权（本机回环），
 * 这样 agent 配置里不需要塞任何密钥。
 */
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { TOOLS } from '@shared/tools'
import type { EventInput } from '@shared/types'
import * as db from './db'

const SERVER_INFO = { name: 'caldesk', version: '0.1.0' }
const PROTOCOL_VERSION = '2024-11-05'
const MAX_BODY = 1_000_000

interface RpcMessage {
  jsonrpc: '2.0'
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

function ok(result: unknown): unknown {
  return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] }
}

function fail(message: string): unknown {
  return { content: [{ type: 'text', text: message }], isError: true }
}

function firstCalendarId(): string {
  const list = db.listCalendars()
  if (list.length === 0) throw new Error('还没有任何视图，请先在 caldesk 里新建一个')
  return list[0].id
}

function resolveCalendar(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value : firstCalendarId()
}

/** 只读工具：调用它们不该触发界面刷新 */
const READ_TOOLS = new Set([
  'calendar_list',
  'items_get',
  'events_query',
  'search',
  'notes_list',
  'notes_get'
])

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
      case 'calendar_list':
        return ok(
          db.listCalendars().map((c) => ({ id: c.id, name: c.name, color: c.color }))
        )

      case 'items_get': {
        const cell = db.getDayCell(resolveCalendar(args.calendar_id), String(args.date))
        const lines = cell.text ? cell.text.split('\n') : []
        return ok({ date: cell.date, text: cell.text, lines })
      }

      case 'items_append_line':
        return ok(
          db.appendDayLine(resolveCalendar(args.calendar_id), String(args.date), String(args.text))
            .text
        )

      case 'items_set':
        return ok(
          db.setDayCellText(resolveCalendar(args.calendar_id), String(args.date), String(args.text))
            .text
        )

      case 'item_line_update':
        return ok(
          db.updateDayLine(
            resolveCalendar(args.calendar_id),
            String(args.date),
            Number(args.index),
            String(args.text)
          ).text
        )

      case 'item_line_delete':
        return ok(
          db.deleteDayLine(
            resolveCalendar(args.calendar_id),
            String(args.date),
            Number(args.index)
          ).text
        )

      case 'item_line_set_done':
        return ok(
          db.setDayLineDone(
            resolveCalendar(args.calendar_id),
            String(args.date),
            Number(args.index),
            Boolean(args.done)
          ).text
        )

      case 'events_query': {
        const occ = db.listOccurrences(
          resolveCalendar(args.calendar_id),
          String(args.from),
          String(args.to),
          (args.kind as 'all') ?? 'all'
        )
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
        const input: EventInput = {
          calendarId: resolveCalendar(args.calendar_id),
          title: String(args.title),
          kind: String(args.kind) as EventInput['kind'],
          start: String(args.start),
          rrule: (args.rrule as string | undefined) ?? null,
          targetDate: (args.target_date as string | undefined) ?? null,
          remindMinutes: (args.remind_minutes as number | undefined) ?? null
        }
        const created = db.createEvent(input)
        return ok({ id: created.id, title: created.title, kind: created.kind, start: created.start })
      }

      case 'event_update': {
        const patch: Partial<EventInput> = {}
        if (args.title !== undefined) patch.title = String(args.title)
        if (args.start !== undefined) patch.start = String(args.start)
        if (args.rrule !== undefined) patch.rrule = args.rrule === null ? null : String(args.rrule)
        if (args.target_date !== undefined) patch.targetDate = String(args.target_date)
        const updated = db.updateEvent(String(args.id), patch)
        return ok({ id: updated.id, title: updated.title, start: updated.start })
      }

      case 'event_delete':
        db.deleteEvent(String(args.id))
        return ok('已删除')

      case 'search':
        return ok(db.search(String(args.query), args.calendar_id as string | undefined, Number(args.limit ?? 50)))

      case 'notes_list':
        return ok(
          db
            .listNotes(args.calendar_id as string | undefined, Number(args.limit ?? 100))
            .map((n) => ({
              id: n.id,
              title: n.title || n.content.split('\n')[0].slice(0, 40),
              preview: n.content.slice(0, 120),
              pinned: n.pinned,
              updatedAt: n.updatedAt
            }))
        )

      case 'notes_get': {
        const note = db.getNote(String(args.id))
        return ok({ id: note.id, title: note.title, content: note.content })
      }

      case 'notes_create': {
        const created = db.createNote({
          calendarId: resolveCalendar(args.calendar_id),
          title: args.title === undefined ? '' : String(args.title),
          content: String(args.content),
          pinned: Boolean(args.pinned)
        })
        return ok({ id: created.id, title: created.title })
      }

      case 'notes_update': {
        const patch: Partial<import('@shared/types').NoteInput> = {}
        if (args.title !== undefined) patch.title = String(args.title)
        if (args.content !== undefined) patch.content = String(args.content)
        if (args.pinned !== undefined) patch.pinned = Boolean(args.pinned)
        const updated = db.updateNote(String(args.id), patch)
        return ok({ id: updated.id, title: updated.title })
      }

      case 'notes_delete':
        db.deleteNote(String(args.id))
        return ok('已删除')

      default:
        return fail(`未知工具：${name}`)
    }
  } catch (err) {
    return fail((err as Error).message)
  }
}

/** 处理一条 JSON-RPC 消息；返回 null 表示不需要响应（通知） */
export function dispatch(msg: RpcMessage): unknown | null {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: '无效的 JSON-RPC 请求' } }
  }
  const { method, id } = msg

  if (method.startsWith('notifications/')) return null

  try {
    switch (method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO
          }
        }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} }
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: TOOLS } }
      case 'tools/call': {
        const params = msg.params ?? {}
        const name = String(params.name ?? '')
        const args = (params.arguments as Record<string, unknown>) ?? {}
        if (!name) throw new Error('tools/call 缺少 name')
        const result = callTool(name, args)
        return { jsonrpc: '2.0', id, result }
      }
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `未实现的方法：${method}` } }
    }
  } catch (err) {
    return { jsonrpc: '2.0', id, error: { code: -32603, message: (err as Error).message } }
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  })
  res.end(body)
}

export interface ApiHandle {
  port: number
  close(): void
}

export interface ApiHooks {
  /** 触发一次同步；由主进程注入，避免 api 直接依赖同步实现 */
  runSync?: (options: { full?: boolean }) => Promise<unknown>
  /** 触发旧数据迁移 */
  runMigrate?: (options: {
    from: string
    to: string
    command?: string
    args?: string[]
  }) => Promise<unknown>
  /** 写类工具执行后回调：主进程用它通知窗口重读 */
  onDataChanged?: () => void
}

export function startApiServer(userDataDir: string, hooks: ApiHooks = {}): Promise<ApiHandle> {
  return new Promise((resolve, reject) => {
    writeNotify = hooks.onDataChanged ?? null
    const startedAt = Date.now()
    const instanceId = randomBytes(8).toString('hex')

    const server = createServer((req, res) => {
      void (async () => {
        // 注意：必须解析成 URL 对象，否则 searchParams 不存在（曾因此报 reading 'get'）
        const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
        const pathname = reqUrl.pathname
        if (req.method === 'GET' && pathname === '/health') {
          sendJson(res, 200, { ok: true, app: 'caldesk', pid: process.pid, startedAt })
          return
        }
        if (req.method === 'POST' && pathname === '/sync/run') {
          if (!hooks.runSync) {
            sendJson(res, 503, { ok: false, error: '同步未启用' })
            return
          }
          try {
            const full = reqUrl.searchParams.get('full') === '1'
            const result = await hooks.runSync({ full })
            sendJson(res, 200, result)
          } catch (err) {
            const e = err as Error
            console.error('[caldesk] sync 失败:', e.stack ?? e.message)
            sendJson(res, 500, { ok: false, error: e.message, stack: e.stack?.split('\n').slice(0, 6) })
          }
          return
        }
        if (req.method === 'POST' && pathname === '/migrate/run') {
          if (!hooks.runMigrate) {
            sendJson(res, 503, { ok: false, error: '迁移未启用' })
            return
          }
          try {
            const from = reqUrl.searchParams.get('from') ?? ''
            const to = reqUrl.searchParams.get('to') ?? ''
            const command = reqUrl.searchParams.get('command') ?? undefined
            const argsRaw = reqUrl.searchParams.get('args')
            const args = argsRaw ? (JSON.parse(argsRaw) as string[]) : undefined
            const result = await hooks.runMigrate({ from, to, command, args })
            sendJson(res, 200, result)
          } catch (err) {
            sendJson(res, 500, { ok: false, error: (err as Error).message })
          }
          return
        }
        if (req.method === 'POST' && pathname === '/mcp') {
          try {
            const raw = await readBody(req)
            const parsed = JSON.parse(raw) as RpcMessage | RpcMessage[]
            if (Array.isArray(parsed)) {
              const out = parsed.map((m) => dispatch(m)).filter((r) => r !== null)
              sendJson(res, 200, out)
              return
            }
            const result = dispatch(parsed)
            if (result === null) {
              res.writeHead(202)
              res.end()
              return
            }
            sendJson(res, 200, result)
          } catch (err) {
            sendJson(res, 400, {
              jsonrpc: '2.0',
              id: null,
              error: { code: -32700, message: (err as Error).message }
            })
          }
          return
        }
        sendJson(res, 404, { error: 'not found' })
      })()
    })

    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      try {
        writeFileSync(
          join(userDataDir, 'runtime.json'),
          JSON.stringify({ port, pid: process.pid, startedAt, instanceId }, null, 2)
        )
      } catch {
        /* 写不了也不阻塞服务 */
      }
      console.log(`[caldesk] MCP 服务已启动：http://127.0.0.1:${port}/mcp`)
      resolve({
        port,
        close: () => server.close()
      })
    })
  })
}
