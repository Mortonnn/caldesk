/**
 * PC 端同步客户端：本地 SQLite ↔ Cloudflare Worker(/D1)
 *
 * 安全模型：
 *  1. 每台设备一套凭据：Authorization: Bearer <deviceId>.<secret>，
 *     服务端只存 sha256(salt || secret)，比对走常量时间循环；
 *  2. 账号 = 用户名 + 密码，任意设备登录同一账号就能同步；
 *  3. 服务端按 account 隔离，推/拉只看得到自己账号的数据。
 *
 * 服务端存明文（用户明确要求简单方便），所以这里没有加解密。
 *
 * 增量策略：push 只发 updated_at > 上次推送水位的行；pull 用 (updatedAt, id) 复合游标翻页。
 * 冲突是 LWW（updated_at 大者胜；相等时 deviceId 字典序大者胜，由服务端裁决），
 * 服务端会把赢家的 updated_at 抬高 1，保证输的那一端下次拉取一定能收敛过来。
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
import { decodeDeviceNameHeader, encodeDeviceNameHeader } from '@shared/identity'

const TABLES: SyncTable[] = ['calendars', 'day_cells', 'events', 'notes', 'event_done', 'event_skip']
const PAGE = 200
/** /sync/push 单次上限（服务端 MAX_ROWS）；exportRows 也是按 500 切的 */
const PUSH_BATCH = 500
/** 一次同步最多推几轮整页：40 × 500 = 2 万行，足够覆盖首次全量 */
const PUSH_MAX_ROUNDS = 40

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

interface PullPage {
  rows: RemoteRow[]
  /** 本页最后一行的 (updatedAt, id)；空页原样回传上一次的游标 */
  cursor: number
  cursorId?: string
}

function authHeader(id: StoredIdentity): Record<string, string> {
  // 顺带上报设备名：本地改过名（或从"这台电脑"迁移过来）时，服务端下一次请求就会同步。
  // 头里只能放 latin1，中文机器名要走百分号编码，否则 fetch 直接抛错。
  return {
    authorization: `Bearer ${id.deviceId}.${id.deviceSecret}`,
    'x-device-name': encodeDeviceNameHeader(id.deviceName)
  }
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
  if (res.status === 401) throw new Error('设备凭据已失效（被撤销或换了账号），请重新登录')
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

  /*
   * 水位必须在**推拉之前**读。
   *
   * 以前是同步完再读：如果这期间另一端刚写完一行，我们既没拉到它，
   * 又把"已经变了"的水位记成已读 —— 热更新探针从此认为没新东西，
   * 那一行要等下一次别的改动才会出现。先读一次再同步，这个窗口就没了。
   */
  let tokenBefore = 0
  try {
    tokenBefore = await remoteChangeToken(id)
  } catch {
    /* 拿不到就退回旧行为：下次探针会自己重新探 */
  }

  try {
    for (const table of TABLES) {
      const stat = { pushed: 0, pulled: 0, failed: 0 }
      report.tables[table] = stat

      /* ---- 推送 ---- */
      /*
       * 这里必须有循环。
       *
       * exportRows() 单次最多回 500 行（SQL 里 LIMIT 500）。以前推一次就收工：
       * 本地一次改动超过 500 行（首次登录全量推、批量导入、迁移），
       * 只有前 500 行能上去，剩下的要等"下一次同步"——而水位一旦推进过去，
       * 同一毫秒里的行甚至永远推不上去，手机上就永远少一部分数据，还不报错。
       * 现在照拉取那边的写法：整页就继续推，直到不满一页为止。
       */
      /*
       * 游标是复合的 (updatedAt, id)：只按时间戳翻页时，同一毫秒的行一旦跨页
       * 就再也翻不过去（`updated_at > cursor` 会把整批又捞一遍），最后几百行
       * 永远推不上去还不报错。id 是主键、唯一，所以 (时间戳, id) 一定单调前进。
       */
      let pushCursor = full ? 0 : Number(getMeta(`push:${table}`) ?? 0)
      let pushId = full ? '' : String(getMeta(`pushId:${table}`) ?? '')
      const savePushCursor = (ts: number, idAfter: string): void => {
        pushCursor = ts
        pushId = idAfter
        setMeta(`push:${table}`, String(ts))
        setMeta(`pushId:${table}`, idAfter)
      }
      for (let round = 0; round < PUSH_MAX_ROUNDS; round += 1) {
        const pending = exportRows(table, pushCursor, pushId)
        if (pending.length === 0) break
        const batch = pending.slice(0, PUSH_BATCH)
        const payload: RemoteRow[] = batch.map((row) => ({
          id: row.id,
          updatedAt: row.updatedAt,
          deletedAt: row.deletedAt,
          payload: JSON.stringify(row)
        }))
        const res = await call<{ written: number; stale?: number; failed: number; errors?: string[] }>(
          id,
          '/sync/push',
          { method: 'POST', body: { table, rows: payload } }
        )
        const maxUpdated = batch.reduce((m, r) => Math.max(m, r.updatedAt), pushCursor)
        const minUpdated = batch.reduce((m, r) => Math.min(m, r.updatedAt), maxUpdated)
        stat.pushed += res.written ?? batch.length
        report.pushed += res.written ?? batch.length
        if (res.failed) {
          stat.failed += res.failed
          report.failed += res.failed
          for (const e of res.errors ?? []) {
            if (report.errors.length < 10) report.errors.push(`${table} ${e}`)
          }
        }

        if ((res.failed ?? 0) > 0) {
          /*
           * 有行被服务端拒了：水位绝不能推进到它们之上，否则下次不会再推，
           * 这些行就永远只存在本地。退回到这批里最早的一行，下次整批重试。
           */
          savePushCursor(Math.max(0, minUpdated - 1), '')
          break
        }

        const fullPage = batch.length >= PUSH_BATCH
        const last = batch[batch.length - 1]
        if (!fullPage) {
          // 不满一页说明这个集合已经推完了：游标停在最后一行的时间戳上
          savePushCursor(maxUpdated, '')
          break
        }
        // 整页：游标推到最后一行之后，下一轮从 (时间戳, id) 严格更大的位置继续
        if (last.updatedAt === pushCursor && last.id === pushId) {
          // 理论上不会发生（id 唯一、查询严格大于），留一道防线避免死循环
          if (report.errors.length < 10) {
            report.errors.push(`${table} 推送游标没有前进，本轮停止（last=${last.id}）`)
          }
          break
        }
        savePushCursor(last.updatedAt, last.id)
      }

      /* ---- 拉取 ---- */
      let cursor = full ? 0 : Number(getMeta(`pull:${table}`) ?? 0)
      let cursorId = full ? '' : String(getMeta(`pullId:${table}`) ?? '')
      let guard = 0
      while (guard < 50) {
        guard += 1
        const page = await call<PullPage>(
          id,
          `/sync/pull?table=${table}&since=${cursor}&sinceId=${encodeURIComponent(cursorId)}&limit=${PAGE}`
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

        // 复合游标：同一批行时间戳一样时，靠 id 继续往后翻，不会卡住也不会漏
        const nextCursor = Math.max(cursor, Number(page.cursor ?? 0))
        const nextId =
          page.cursorId !== undefined ? String(page.cursorId) : nextCursor > cursor ? '' : cursorId
        const moved = nextCursor > cursor || nextId !== cursorId
        cursor = nextCursor
        cursorId = nextId
        setMeta(`pull:${table}`, String(cursor))
        setMeta(`pullId:${table}`, cursorId)
        if (!moved) break
        if (page.rows.length < PAGE) break
      }
      setMeta(`pull:${table}`, String(cursor))
      setMeta(`pullId:${table}`, cursorId)
    }

    setMeta('sync:lastAt', String(Date.now()))
    // 记住**同步开始前**看到的水位：同步期间的变化下次探针还能发现
    if (tokenBefore > 0) setMeta('sync:remoteToken', String(tokenBefore))
    report.ok = true
    return report
  } catch (err) {
    report.error = (err as Error).message
    return report
  }
}

/* ------------------------------ 账号 ------------------------------ */

export interface AccountInfo {
  accountId: string
  username: string
  /** 这个账号有没有设过用户名密码（配对时代的老账号是 false） */
  claimed: boolean
  deviceId: string
  deviceName: string
}

export interface AuthInput {
  username: string
  password: string
}

function serverBase(id: StoredIdentity): string {
  const base = id.serverUrl.replace(/\/$/, '')
  if (!base) throw new Error('还没填服务器地址')
  return base
}

/** 读服务端错误体里的中文说明，别把整段 JSON 甩到界面上 */
async function readError(res: Response): Promise<string> {
  const text = await res.text()
  if (res.status === 404) return '服务器版本太旧，还没有账号密码接口，先部署新版 Worker'
  try {
    const body = JSON.parse(text) as { message?: string; error?: string }
    return body.message || body.error || `HTTP ${res.status}`
  } catch {
    return `HTTP ${res.status}: ${text.slice(0, 120)}`
  }
}

async function postAuth<T>(
  id: StoredIdentity,
  path: string,
  body: unknown,
  withAuth = false
): Promise<T> {
  const res = await fetch(serverBase(id) + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(withAuth ? authHeader(id) : {})
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000)
  })
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as T
}

export interface AuthResult {
  accountId: string
  username: string
  /** 服务端可能换了一把新钥匙（这台设备原来挂在别的账号下），客户端要换成本地凭据 */
  deviceId?: string
  secret?: string
}

/** 注册：建账号 + 这台电脑作为首台设备 */
export async function registerAccount(
  id: StoredIdentity,
  input: AuthInput
): Promise<AuthResult> {
  return postAuth<AuthResult>(id, '/auth/register', {
    username: input.username,
    password: input.password,
    deviceId: id.deviceId,
    secret: id.deviceSecret,
    deviceName: id.deviceName
  })
}

/** 登录：任意设备登录同一账号，就绑到同一个 accountId（不需要配对） */
export async function loginAccount(id: StoredIdentity, input: AuthInput): Promise<AuthResult> {
  return postAuth<AuthResult>(id, '/auth/login', {
    username: input.username,
    password: input.password,
    deviceId: id.deviceId,
    secret: id.deviceSecret,
    deviceName: id.deviceName
  })
}

/** 老账号认领：用现有设备凭据设一次用户名密码，数据一行不动 */
export async function claimAccount(
  id: StoredIdentity,
  input: AuthInput
): Promise<{ accountId: string; username: string }> {
  return postAuth<{ accountId: string; username: string }>(
    id,
    '/auth/claim',
    { username: input.username, password: input.password },
    true
  )
}

export async function accountInfo(id: StoredIdentity): Promise<AccountInfo> {
  const res = await fetch(serverBase(id) + '/auth/me', {
    headers: authHeader(id),
    signal: AbortSignal.timeout(15000)
  })
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as AccountInfo
}

export async function logoutDevice(id: StoredIdentity): Promise<void> {
  const res = await fetch(serverBase(id) + '/auth/logout', {
    method: 'POST',
    headers: { ...authHeader(id), 'content-type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(15000)
  })
  if (!res.ok && res.status !== 401) throw new Error(await readError(res))
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
  const list = await call<DeviceList>(id, '/devices')
  // 老版本 Worker 没解码就把百分号编码存进了 devices.name；这里解一次再交给界面
  return {
    ...list,
    devices: list.devices.map((d) => ({ ...d, name: decodeDeviceNameHeader(d.name ?? '') }))
  }
}

/** 删除设备：撤销它的凭据，并把这一行从列表里去掉 */
export async function revokeDevice(id: StoredIdentity, deviceId: string): Promise<void> {
  await call(id, '/devices/revoke', { method: 'POST', body: { deviceId, purge: true } })
}
