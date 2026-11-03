/**
 * PC 端同步客户端：本地 SQLite ↔ Cloudflare Worker(/D1)
 *
 * 增量策略：
 *  - push：只发 updated_at > 上次推送水位的行
 *  - pull：只拉 updated_at > 上次拉取游标的行，循环直到没有新数据
 *
 * 冲突：两端都是 LWW（updated_at 大者胜），且 SQL 里带 WHERE 守卫，
 * 所以"旧数据覆盖新数据"在服务端和本地都不会发生。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  exportRows,
  getMeta,
  importRows,
  setMeta,
  type SyncPayloadRow,
  type SyncTable
} from './db'

const TABLES: SyncTable[] = ['calendars', 'day_cells', 'events', 'notes', 'event_done', 'event_skip']
const PAGE = 200

export interface SyncConfig {
  url: string
  token: string
}

export interface SyncReport {
  ok: boolean
  pushed: number
  pulled: number
  failed: number
  errors: string[]
  tables: Record<string, { pushed: number; pulled: number; failed: number }>
  error?: string
}

export function syncConfigPath(userDataDir: string): string {
  return join(userDataDir, 'sync.json')
}

export function loadSyncConfig(userDataDir: string): SyncConfig | null {
  try {
    const p = syncConfigPath(userDataDir)
    if (!existsSync(p)) return null
    // 兼容带 BOM 的 UTF-8（Windows 上很多编辑器/命令行默认会写 BOM）
    const text = readFileSync(p, 'utf-8').replace(/^\uFEFF/, '')
    const raw = JSON.parse(text) as Partial<SyncConfig>
    if (!raw.url || !raw.token) return null
    return { url: raw.url.replace(/\/$/, ''), token: raw.token }
  } catch {
    return null
  }
}

export function saveSyncConfig(userDataDir: string, cfg: SyncConfig): void {
  const p = syncConfigPath(userDataDir)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify({ url: cfg.url.replace(/\/$/, ''), token: cfg.token }, null, 2))
}

async function postJson(url: string, token: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

async function getJson(url: string, token: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20000)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

export interface SyncOptions {
  /** 忽略本地水位，全量重传/重拉（服务端数据被清空后使用） */
  full?: boolean
}

export async function syncNow(cfg: SyncConfig, options: SyncOptions = {}): Promise<SyncReport> {
  const full = options.full === true
  const report: SyncReport = {
    ok: false,
    pushed: 0,
    pulled: 0,
    failed: 0,
    errors: [],
    tables: {}
  }

  try {
    for (const table of TABLES) {
      const stat = { pushed: 0, pulled: 0, failed: 0 }
      report.tables[table] = stat
      console.log(`[caldesk] sync: ${table} 开始`)

      /* ---- 推送本地新增/修改 ---- */
      const pushCursor = full ? 0 : Number(getMeta(`push:${table}`) ?? 0)
      const pending = exportRows(table, pushCursor)
      if (pending.length > 0) {
        console.log(`[caldesk] sync: ${table} 推送 ${pending.length} 行`)
        await postJson(`${cfg.url}/sync/push`, cfg.token, { table, rows: pending })
        const maxUpdated = pending.reduce((m, r) => Math.max(m, r.updatedAt), pushCursor)
        setMeta(`push:${table}`, String(maxUpdated))
        stat.pushed = pending.length
        report.pushed += pending.length
      }

      /* ---- 拉取远端新增/修改 ---- */
      let cursor = full ? 0 : Number(getMeta(`pull:${table}`) ?? 0)
      let guard = 0
      while (guard < 50) {
        guard += 1
        const page = (await getJson(
          `${cfg.url}/sync/pull?table=${table}&since=${cursor}&limit=${PAGE}`,
          cfg.token
        )) as { rows: SyncPayloadRow[]; cursor: number }

        if (!Array.isArray(page.rows) || page.rows.length === 0) break
        const imported = importRows(table, page.rows)
        stat.pulled += imported.written
        stat.failed += imported.failed
        report.pulled += imported.written
        report.failed += imported.failed
        for (const e of imported.errors) {
          if (report.errors.length < 10) report.errors.push(`${table} ${e}`)
        }

        const next = Math.max(cursor, Number(page.cursor ?? 0))
        if (next === cursor && imported.written === 0) break
        cursor = next
        setMeta(`pull:${table}`, String(cursor))
        if (page.rows.length < PAGE) break
      }
      setMeta(`pull:${table}`, String(cursor))
    }

    setMeta('sync:lastAt', String(Date.now()))
    report.ok = true
    return report
  } catch (err) {
    report.error = (err as Error).message
    return report
  }
}
