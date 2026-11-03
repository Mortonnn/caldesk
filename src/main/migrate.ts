/**
 * 从旧版「日历清单」迁移数据。
 *
 * 数据来源：旧版自带的 MCP 服务（desktopcal-mcp.exe，stdio）。
 * 不直接读它的加密数据库——那会导致数据损坏并与它自己的云同步冲突。
 *
 * 语义映射：
 *   旧版 calendar_list  → 本地 calendars（按名字匹配，缺失则新建）
 *   旧版 items_get      → 本地 day_cells.text（两边都是 Markdown，完成即 ~~删除线~~）
 *   旧版 events_query   → 本地 events（kind: task/reminder/countdown，rrule 原样保留）
 *
 * 幂等：迁移过的行按 (calendar, date) / (event id) 覆盖写入，重复执行不会产生重复数据；
 * 是否已迁移记录在 meta 表，UI 可提示。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { EventKind } from '@shared/types'
import {
  createCalendar,
  createEvent,
  getMeta,
  listCalendars,
  setDayCellText,
  setMeta
} from './db'

export interface MigrateOptions {
  /** 可执行文件；默认旧版 desktopcal-mcp.exe */
  command: string
  args?: string[]
  /** 迁移起始日期 YYYY-MM-DD */
  from: string
  /** 迁移结束日期 YYYY-MM-DD */
  to: string
  /** 旧版 app 未开着 AI 访问时会直接报 FEATURE_DISABLED */
  onProgress?: (line: string) => void
}

export interface MigrateReport {
  ok: boolean
  calendars: number
  cells: number
  events: number
  skipped: number
  errors: string[]
  error?: string
}

/* ------------------------------ MCP 客户端 ------------------------------ */

class McpClient {
  private proc: ChildProcessWithoutNullStreams
  private seq = 1
  private pending = new Map<number, (value: unknown) => void>()
  private rejectors = new Map<number, (err: Error) => void>()

  constructor(command: string, args: string[]) {
    this.proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const rl = createInterface({ input: this.proc.stdout })
    rl.on('line', (line) => {
      const trimmed = line.trim()
      if (!trimmed) return
      let msg: { id?: number; result?: unknown; error?: { message?: string } }
      try {
        msg = JSON.parse(trimmed)
      } catch {
        return
      }
      if (typeof msg.id !== 'number') return
      const resolve = this.pending.get(msg.id)
      const reject = this.rejectors.get(msg.id)
      this.pending.delete(msg.id)
      this.rejectors.delete(msg.id)
      if (msg.error) reject?.(new Error(msg.error.message ?? 'MCP 返回错误'))
      else resolve?.(msg.result)
    })
    this.proc.stderr.on('data', (buf: Buffer) => {
      const text = buf.toString('utf-8').trim()
      if (text) process.stderr.write(`[old-mcp] ${text}\n`)
    })
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.seq++
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params })
    return new Promise((resolve, reject) => {
      this.pending.set(id, resolve)
      this.rejectors.set(id, reject)
      this.proc.stdin.write(payload + '\n')
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          this.rejectors.delete(id)
          reject(new Error(`调用 ${method} 超时`))
        }
      }, 20000)
    })
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'caldesk-migrator', version: '0.1.0' }
    })
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = (await this.request('tools/call', { name, arguments: args })) as {
      content?: Array<{ text?: string }>
      isError?: boolean
    }
    const text = result?.content?.map((c) => c.text ?? '').join('\n') ?? ''
    if (result?.isError) throw new Error(text || `${name} 调用失败`)
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }

  close(): void {
    try {
      this.proc.stdin.end()
      this.proc.kill()
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------ 日期工具 ------------------------------ */

function eachDate(from: string, to: string, max = 800): string[] {
  const out: string[] = []
  const start = new Date(`${from}T00:00:00`)
  const end = new Date(`${to}T00:00:00`)
  const cursor = new Date(start)
  while (cursor <= end && out.length < max) {
    const p = (n: number): string => String(n).padStart(2, '0')
    out.push(`${cursor.getFullYear()}-${p(cursor.getMonth() + 1)}-${p(cursor.getDate())}`)
    cursor.setDate(cursor.getDate() + 1)
  }
  return out
}

function isKind(value: unknown): value is EventKind {
  return value === 'task' || value === 'reminder' || value === 'countdown'
}

/* ------------------------------ 迁移主体 ------------------------------ */

export async function migrateFromOldApp(options: MigrateOptions): Promise<MigrateReport> {
  const report: MigrateReport = {
    ok: false,
    calendars: 0,
    cells: 0,
    events: 0,
    skipped: 0,
    errors: []
  }
  const log = (line: string): void => {
    options.onProgress?.(line)
    console.log('[migrate]', line)
  }

  const client = new McpClient(options.command, options.args ?? [])
  try {
    await client.initialize()

    /* ---- 1. 视图 ---- */
    const listing = (await client.callTool('calendar_list', {})) as {
      calendars?: Array<{ id: string; name: string; color?: string }>
    }
    const remoteCals = Array.isArray(listing?.calendars) ? listing.calendars : []
    if (remoteCals.length === 0) {
      log('旧版没有返回任何视图（可能未开启 AI 访问）')
    }

    const localByName = new Map(listCalendars().map((c) => [c.name, c.id] as const))
    const idMap = new Map<string, string>()

    for (const remote of remoteCals) {
      const name = String(remote.name ?? '').trim() || '未命名'
      let localId = localByName.get(name)
      if (!localId) {
        const created = createCalendar(name, remote.color)
        localId = created.id
        localByName.set(name, localId)
        report.calendars += 1
        log(`新建视图「${name}」`)
      }
      idMap.set(String(remote.id), localId)
    }

    /* ---- 2. 日格任务 ---- */
    const dates = eachDate(options.from, options.to)
    for (const remote of remoteCals) {
      const localId = idMap.get(String(remote.id))
      if (!localId) continue
      let filled = 0
      for (const date of dates) {
        try {
          const cell = (await client.callTool('items_get', {
            date,
            calendar_id: String(remote.id)
          })) as { text?: string }
          const text = typeof cell?.text === 'string' ? cell.text : ''
          if (text.trim()) {
            setDayCellText(localId, date, text)
            filled += 1
            report.cells += 1
          } else {
            report.skipped += 1
          }
        } catch (err) {
          report.errors.push(`${date} 读取失败：${(err as Error).message}`)
        }
      }
      log(`视图「${remote.name}」迁移 ${filled} 天有内容`)
    }

    /* ---- 3. 事件 ---- */
    for (const remote of remoteCals) {
      const localId = idMap.get(String(remote.id))
      if (!localId) continue
      try {
        const occ = (await client.callTool('events_query', {
          calendar_id: String(remote.id),
          from: `${options.from}T00:00:00+08:00`,
          to: `${options.to}T00:00:00+08:00`,
          kind: 'all'
        })) as Array<Record<string, unknown>> | { events?: Array<Record<string, unknown>> }

        const rows = Array.isArray(occ) ? occ : Array.isArray(occ?.events) ? occ.events : []
        const seen = new Set<string>()
        for (const row of rows) {
          const id = String(row.id ?? '')
          if (!id || seen.has(id)) continue
          seen.add(id)
          const kindRaw = row.kind ?? row.event_type
          const kind: EventKind = isKind(kindRaw) ? kindRaw : 'task'
          const date =
            typeof row.date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(row.date)
              ? row.date.slice(0, 10)
              : options.from
          try {
            createEvent({
              // 用旧 id 作为本地主键：重复迁移只会更新，不会产生重复事件
              id: `old:${id}`,
              calendarId: localId,
              kind,
              title: String(row.title ?? '未命名事件'),
              start: date,
              rrule: typeof row.rrule === 'string' ? row.rrule : null,
              targetDate: kind === 'countdown' ? date : null,
              remindMinutes: kind === 'reminder' ? 0 : null
            })
            report.events += 1
          } catch (err) {
            report.errors.push(`事件「${String(row.title ?? '')}」导入失败：${(err as Error).message}`)
          }
        }
        log(`视图「${remote.name}」迁移 ${seen.size} 个事件`)
      } catch (err) {
        report.errors.push(`事件查询失败：${(err as Error).message}`)
      }
    }

    setMeta('migrate:lastAt', String(Date.now()))
    setMeta('migrate:range', `${options.from}~${options.to}`)
    report.ok = true
    return report
  } catch (err) {
    report.error = (err as Error).message
    return report
  } finally {
    client.close()
    void getMeta('migrate:lastAt')
  }
}
