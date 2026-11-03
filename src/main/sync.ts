/**
 * PC 端同步客户端：本地 SQLite ↔ Cloudflare Worker(/D1)
 *
 * 安全模型：
 *  1. 每台设备一套凭据：Authorization: Bearer <deviceId>.<secret>，
 *     服务端只存 sha256(salt || secret)，比对走常量时间循环；
 *  2. 新设备必须走配对并被已授权设备批准，才能同步；
 *  3. 服务端按 account 隔离，推/拉只看得到自己账号的数据。
 *
 * 服务端存明文（用户明确要求简单方便），所以这里没有加解密。
 *
 * 增量策略：push 只发 updated_at > 上次推送水位的行；pull 按游标翻页。
 * 冲突是 LWW（updated_at 大者胜），SQL 里带 WHERE 守卫。
 */
import {
  exportRows,
  getMeta,
  importRows,
  setMeta,
  type SyncPayloadRow,
  type SyncTable
} from './db'
import type { StoredIdentity } from './identity'

const TABLES: SyncTable[] = ['calendars', 'day_cells', 'events', 'notes', 'event_done', 'event_skip']
const PAGE = 200

export interface SyncReport {
  ok: boolean
  pushed: number
  pulled: number
  failed: number
  errors: string[]
  tables: Record<string, { pushed: number; pulled: number; failed: number }>
  error?: string
}

interface RemoteRow {
  id: string
  updatedAt: number
  deletedAt: number | null
  payload: string
}

function authHeader(id: StoredIdentity): Record<string, string> {
  return { authorization: `Bearer ${id.deviceId}.${id.deviceSecret}` }
}

async function call<T>(
  id: StoredIdentity,
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<T> {
  const base = id.serverUrl.replace(/\/$/, '')
  if (!base) throw new Error('还没填服务器地址')
  const res = await fetch(base + path, {
    method: init.method ?? 'GET',
    headers: {
      ...authHeader(id),
      ...(init.body ? { 'content-type': 'application/json' } : {})
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(20000)
  })
  if (res.status === 401) throw new Error('设备未授权或已被撤销，请重新配对')
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`)
  return (await res.json()) as T
}

export interface SyncOptions {
  /** 忽略本地水位，全量重传/重拉（服务端数据被清空后使用） */
  full?: boolean
}

/**
 * 问服务端"账号里最新的水位是多少"。
 *
 * 用来做热更新：渲染层每隔几秒探一次，
 * 数字变了才真的去拉数据，否则什么都不做。
 * 比每次都拉整月便宜得多。
 */
export async function remoteChangeToken(id: StoredIdentity): Promise<number> {
  const res = await call<{ token?: number }>(id, '/api/changes')
  return Number(res.token ?? 0)
}

export async function syncNow(id: StoredIdentity, options: SyncOptions = {}): Promise<SyncReport> {
  const full = options.full === true
  const report: SyncReport = {
    ok: false,
    pushed: 0,
    pulled: 0,
    failed: 0,
    errors: [],
    tables: {}
  }
  if (!id.accountId) {
    report.error = '本机还没有加入任何账号'
    return report
  }

  try {
    for (const table of TABLES) {
      const stat = { pushed: 0, pulled: 0, failed: 0 }
      report.tables[table] = stat

      /* ---- 推送 ---- */
      const pushCursor = full ? 0 : Number(getMeta(`push:${table}`) ?? 0)
      const pending = exportRows(table, pushCursor)
      if (pending.length > 0) {
        const payload: RemoteRow[] = pending.map((row) => ({
          id: row.id,
          updatedAt: row.updatedAt,
          deletedAt: row.deletedAt,
          payload: JSON.stringify(row)
        }))
        const res = await call<{ written: number; failed: number; errors?: string[] }>(
          id,
          '/sync/push',
          { method: 'POST', body: { table, rows: payload } }
        )
        const maxUpdated = pending.reduce((m, r) => Math.max(m, r.updatedAt), pushCursor)
        setMeta(`push:${table}`, String(maxUpdated))
        stat.pushed = res.written ?? payload.length
        report.pushed += stat.pushed
        if (res.failed) {
          stat.failed += res.failed
          report.failed += res.failed
          for (const e of res.errors ?? []) {
            if (report.errors.length < 10) report.errors.push(`${table} ${e}`)
          }
        }
      }

      /* ---- 拉取 ---- */
      let cursor = full ? 0 : Number(getMeta(`pull:${table}`) ?? 0)
      let guard = 0
      while (guard < 50) {
        guard += 1
        const page = await call<{ rows: RemoteRow[]; cursor: number }>(
          id,
          `/sync/pull?table=${table}&since=${cursor}&limit=${PAGE}`
        )
        if (!Array.isArray(page.rows) || page.rows.length === 0) break

        const decoded: SyncPayloadRow[] = []
        for (const row of page.rows) {
          try {
            const parsed = JSON.parse(row.payload) as SyncPayloadRow
            // 服务端给的 id/时间戳优先，避免被 payload 里的旧值覆盖
            decoded.push({ ...parsed, id: row.id, updatedAt: row.updatedAt, deletedAt: row.deletedAt })
          } catch {
            report.failed += 1
            if (report.errors.length < 10) report.errors.push(`${table} ${row.id}: 内容解析失败`)
          }
        }
        if (decoded.length > 0) {
          const imported = importRows(table, decoded)
          stat.pulled += imported.written
          stat.failed += imported.failed
          report.pulled += imported.written
          report.failed += imported.failed
          for (const e of imported.errors) {
            if (report.errors.length < 10) report.errors.push(`${table} ${e}`)
          }
        }

        const next = Math.max(cursor, Number(page.cursor ?? 0))
        if (next === cursor && decoded.length === 0) break
        cursor = next
        setMeta(`pull:${table}`, String(cursor))
        if (page.rows.length < PAGE) break
      }
      setMeta(`pull:${table}`, String(cursor))
    }

    setMeta('sync:lastAt', String(Date.now()))
    // 记住这次看到的服务端水位：热更新探针靠它判断"有没有新东西"
    try {
      setMeta('sync:remoteToken', String(await remoteChangeToken(id)))
    } catch {
      /* 拿不到就算了，下次探针会重新探 */
    }
    report.ok = true
    return report
  } catch (err) {
    report.error = (err as Error).message
    return report
  }
}

/* ------------------------------ 账号与配对 ------------------------------ */

export interface PairStart {
  pairId: string
  code: string
  expiresAt: number
}

export interface PendingDevice {
  deviceId: string
  name: string
  createdAt: number
}

/** 已配对的电脑发起一次配对，得到二维码里要放的 pairId / code */
export async function startPairing(id: StoredIdentity): Promise<PairStart> {
  return call<PairStart>(id, '/pair/start', { method: 'POST', body: {} })
}

export async function listPendingDevices(
  id: StoredIdentity,
  pairId: string
): Promise<PendingDevice[]> {
  const res = await call<{ devices: PendingDevice[] }>(
    id,
    `/pair/pending?pairId=${encodeURIComponent(pairId)}`
  )
  return res.devices ?? []
}

export async function approveDevice(
  id: StoredIdentity,
  pairId: string,
  deviceId: string
): Promise<void> {
  await call(id, '/pair/approve', { method: 'POST', body: { pairId, deviceId } })
}

export async function rejectDevice(
  id: StoredIdentity,
  pairId: string,
  deviceId: string
): Promise<void> {
  await call(id, '/pair/reject', { method: 'POST', body: { pairId, deviceId } })
}

export interface DeviceList {
  devices: Array<{
    deviceId: string
    name: string
    status: string
    lastSeenAt: number | null
    lastIp: string | null
    current: boolean
  }>
  online: number
}

export async function listDevices(id: StoredIdentity): Promise<DeviceList> {
  return call<DeviceList>(id, '/devices')
}

export async function revokeDevice(id: StoredIdentity, deviceId: string): Promise<void> {
  await call(id, '/devices/revoke', { method: 'POST', body: { deviceId } })
}

/** 首次建账号：本机既是 owner 设备，也是账号的起点 */
export async function createAccount(
  id: StoredIdentity,
  options: { invite: string; accountName: string }
): Promise<{ accountId: string }> {
  const base = id.serverUrl.replace(/\/$/, '')
  if (!base) throw new Error('还没填服务器地址')
  const res = await fetch(`${base}/account/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      invite: options.invite,
      accountName: options.accountName,
      deviceId: id.deviceId,
      accountSecret: id.deviceSecret,
      deviceName: id.deviceName
    }),
    signal: AbortSignal.timeout(20000)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`)
  return (await res.json()) as { accountId: string }
}
