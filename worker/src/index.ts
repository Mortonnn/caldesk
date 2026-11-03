/**
 * caldesk-sync — Cloudflare Worker + D1
 *
 * 安全模型：
 * 1. 每台设备一套凭据：随机 32 字节 secret，客户端以
 *    `Authorization: Bearer <deviceId>.<secretHex>` 发送。
 *    服务端只存 sha256(salt || secretHex)，salt 每设备随机 16 字节，
 *    比对走定长常量时间循环，数据库泄露也拿不到可用凭据。
 * 2. 新设备通过二维码配对：已授权设备生成 6 位数字码（5 分钟），
 *    新设备扫码后调 /pair/join（等价于 /pair/request）提交自己的身份 →
 *    状态 pending → 旧设备在 /pair/pending 里看到它并批准 → approved。
 *    二维码里只有 pairId + code，不带任何密钥。
 * 3. 服务端存明文：rows.payload 就是整行的明文 JSON 字符串，
 *    服务端不加解密、也不解析业务字段（同步协议里 payload 是不透明字符串）。
 * 4. 多账号隔离：账号一律由凭据推导（devices.account_id），
 *    永远不信任请求体里的 accountId / account_id。
 *    REST 接口（/api/*）同样按账号过滤与写入。
 *
 * 冲突策略仍是 LWW（updated_at 大者胜），服务端在 SQL 里再守一道，
 * 防止乱序到达的旧数据覆盖新数据。
 *
 * 行主键是 (tbl, account_id, id)：同一个 id 在不同账号下互不干扰。
 */

import { ensureSchema, type D1Like } from './schema'
// 纯函数在 worker/src 下各存一份副本（见文件头注释）：
// 线上构建的根目录是 worker/，跨目录 import 仓库根的 src/shared 会构建失败。
import { expandRrule, fromDayNumber, toDayNumber } from './rrule'
import { lineText, markDone, splitLines } from './celltext'

export interface Env {
  DB: D1Database
  INSTANCE_INVITE?: string
}

/** 允许同步的集合；加新集合只改这里 */
const ALLOWED_TABLES = new Set(['calendars', 'day_cells', 'events', 'event_done', 'event_skip', 'notes'])

const MAX_ROWS = 500
const DEFAULT_LIMIT = 200
const PAIRING_TTL_MS = 5 * 60 * 1000
const ONLINE_WINDOW_MS = 5 * 60 * 1000
/** device secret 是 32 字节 → 64 个 hex 字符 */
const SECRET_HEX_LEN = 64
const SALT_BYTES = 16

/**
 * CORS：Capacitor/浏览器里的页面来源是 https://localhost 或 file://，
 * 跨域访问会带 Authorization 头 → 触发预检。这里统一放行。
 * 鉴权仍靠每设备 Bearer 凭据，放开来源不影响安全性。
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

/** 统一错误体：error 是机器码，message 是给人看的中文 */
function fail(status: number, error: string, message?: string): Response {
  return json(message ? { error, message } : { error }, status)
}

/* ------------------------------ 基础工具 ------------------------------ */

const HEX_RE = /^[0-9a-f]+$/i

function isHex(value: string, len?: number): boolean {
  if (len !== undefined && value.length !== len) return false
  return value.length > 0 && value.length % 2 === 0 && HEX_RE.test(value)
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  let out = ''
  for (const b of buf) out += b.toString(16).padStart(2, '0')
  return out
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  let out = ''
  for (const b of new Uint8Array(digest)) out += b.toString(16).padStart(2, '0')
  return out
}

/**
 * 常量时间比较：逐字符异或后合并，不因提前 return 泄露位置信息。
 * 长度不同直接 false（长度本身不是秘密，hex 长度是固定的）。
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

/** 6 位数字配对码，左侧补零 */
function randomPairingCode(): string {
  const buf = new Uint32Array(1)
  crypto.getRandomValues(buf)
  return String(buf[0] % 1_000_000).padStart(6, '0')
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = (await req.json()) as unknown
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null
    return body as Record<string, unknown>
  } catch {
    return null
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

async function firstRow<T>(env: Env, sql: string, ...binds: unknown[]): Promise<T | null> {
  return await env.DB.prepare(sql)
    .bind(...binds)
    .first<T>()
}

/* ------------------------------ 凭据与鉴权 ------------------------------ */

interface AuthedDevice {
  deviceId: string
  accountId: string
}

interface DeviceRecord {
  account_id: string
  secret_salt: string
  secret_hash: string
  status: string
}

/**
 * 校验 `Authorization: Bearer <deviceId>.<secretHex>`。
 * 只有 approved 的设备能过；accountId 从 devices 行取，
 * 请求体里的任何账号字段一律忽略。
 */
async function authenticate(req: Request, env: Env): Promise<AuthedDevice | null> {
  const header = req.headers.get('authorization') ?? ''
  if (!header.startsWith('Bearer ')) return null

  const token = header.slice(7).trim()
  const dot = token.indexOf('.')
  if (dot <= 0) return null

  const deviceId = token.slice(0, dot)
  const secret = token.slice(dot + 1)
  // secret 必须是 64 个 hex 字符，否则连哈希都不用算
  if (!isHex(secret, SECRET_HEX_LEN)) return null

  const device = await firstRow<DeviceRecord>(
    env,
    `SELECT account_id, secret_salt, secret_hash, status FROM devices WHERE device_id = ?`,
    deviceId
  )
  if (!device) return null
  if (device.status !== 'approved') return null

  const hash = await sha256Hex(device.secret_salt + secret)
  if (!timingSafeEqual(hash, device.secret_hash)) return null

  return { deviceId, accountId: device.account_id }
}

/** 每个通过鉴权的请求都刷新设备活跃时间（在线数就靠它） */
async function touchDevice(req: Request, env: Env, deviceId: string): Promise<void> {
  const ip = req.headers.get('cf-connecting-ip')
  await env.DB.prepare('UPDATE devices SET last_seen_at = ?, last_ip = ? WHERE device_id = ?')
    .bind(Date.now(), ip && ip.length > 0 ? ip : null, deviceId)
    .run()
}

/** 生成一条设备行需要的 (salt, hash) */
async function makeCredential(secretHex: string): Promise<{ salt: string; hash: string }> {
  const salt = randomHex(SALT_BYTES)
  return { salt, hash: await sha256Hex(salt + secretHex) }
}

/* ------------------------------ 入口 ------------------------------ */

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // 线上出异常时 Cloudflare 只给一句 1101，看不到原因；这里兜住并把信息带出来
    try {
      return await handle(req, env)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const stack = err instanceof Error ? (err.stack ?? '').slice(0, 400) : ''
      console.error('[caldesk] 未捕获异常:', message, stack)
      return json({ error: 'runtime', message, stack }, 500)
    }
  }
}

async function handle(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url)

  // 预检必须在鉴权之前处理，否则浏览器拿不到 CORS 头直接判失败
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  if (url.pathname === '/health') {
    return json({ ok: true, service: 'caldesk-sync', d1: Boolean(env.DB) })
  }

  if (!env.DB) return json({ error: 'D1 未绑定' }, 500)

  // 首次访问时把表建好（IF NOT EXISTS，每个 isolate 只跑一次）
  await ensureSchema(env.DB as unknown as D1Like)

  /* -------------------- 公开接口（无需凭据） -------------------- */

  if (url.pathname === '/account/create' && req.method === 'POST') {
    return await createAccount(req, env)
  }
  // /pair/join 与 /pair/request 等价：手机扫码后提交自己的身份
  if ((url.pathname === '/pair/join' || url.pathname === '/pair/request') && req.method === 'POST') {
    return await joinPairing(req, env)
  }
  if (url.pathname === '/pair/status' && req.method === 'GET') {
    return await pairingStatus(url, env)
  }

  /* -------------------- 以下全部要求设备凭据 -------------------- */

  const auth = await authenticate(req, env)
  if (!auth) return fail(401, 'unauthorized', '设备凭据无效或未获批准')
  await touchDevice(req, env, auth.deviceId)

  if (url.pathname === '/pair/start' && req.method === 'POST') return await startPairing(env, auth)
  if (url.pathname === '/pair/pending' && req.method === 'GET') return await listPending(url, env, auth)
  if (url.pathname === '/pair/approve' && req.method === 'POST') return await approvePairing(req, env, auth)
  if (url.pathname === '/pair/reject' && req.method === 'POST') return await rejectPairing(req, env, auth)

  if (url.pathname === '/devices' && req.method === 'GET') return await listDevices(env, auth)
  if (url.pathname === '/devices/revoke' && req.method === 'POST') return await revokeDevice(req, env, auth)

  if (url.pathname === '/sync/pull' && req.method === 'GET') return await pull(url, env, auth)
  if (url.pathname === '/sync/push' && req.method === 'POST') return await push(req, env, auth)

  /* -------------------- REST（移动端在用） -------------------- */

  if (url.pathname.startsWith('/api/')) {
    return await handleRest(req, url, env, auth)
  }

  return json({ error: 'not found' }, 404)
}

/* ------------------------------ 账号 ------------------------------ */

/**
 * 注册账号 + 首台设备（owner，直接 approved）。
 * INSTANCE_INVITE 设置时是单租户私有部署，必须带对邀请码；
 * 不设置则允许任意人自建（BYO）。
 */
async function createAccount(req: Request, env: Env): Promise<Response> {
  const body = await readJson(req)
  if (!body) return fail(400, 'bad_json', '请求体不是合法 JSON')

  if (env.INSTANCE_INVITE) {
    const invite = str(body.invite)
    if (!timingSafeEqual(invite, env.INSTANCE_INVITE)) return fail(403, 'invalid_invite', '邀请码不正确')
  }

  const deviceId = str(body.deviceId).trim()
  const accountSecret = str(body.accountSecret).trim()
  const accountName = str(body.accountName).trim()
  const deviceName = str(body.deviceName).trim()
  if (!deviceId) return fail(400, 'missing_device_id', '缺少 deviceId')
  if (!isHex(accountSecret, SECRET_HEX_LEN)) {
    return fail(400, 'invalid_secret', `accountSecret 必须是 ${SECRET_HEX_LEN} 位 hex`)
  }

  const existing = await firstRow<{ device_id: string }>(
    env,
    'SELECT device_id FROM devices WHERE device_id = ?',
    deviceId
  )
  if (existing) return fail(409, 'device_exists', '该设备已注册')

  const accountId = crypto.randomUUID()
  const now = Date.now()
  const { salt, hash } = await makeCredential(accountSecret)

  try {
    await env.DB.batch([
      // 服务端存明文，accounts 表不再有 encrypted 语义
      env.DB.prepare('INSERT INTO accounts (id, name, created_at) VALUES (?, ?, ?)').bind(
        accountId,
        accountName,
        now
      ),
      env.DB.prepare(
        `INSERT INTO devices
           (device_id, account_id, name, secret_salt, secret_hash, status, created_at, last_seen_at, last_ip)
         VALUES (?, ?, ?, ?, ?, 'approved', ?, NULL, NULL)`
      ).bind(deviceId, accountId, deviceName, salt, hash, now)
    ])
  } catch (err) {
    // 并发注册同一 deviceId 时唯一键会先炸，这里翻译成 409
    const again = await firstRow<{ device_id: string }>(
      env,
      'SELECT device_id FROM devices WHERE device_id = ?',
      deviceId
    )
    if (again) return fail(409, 'device_exists', '该设备已注册')
    throw err
  }

  return json({ accountId })
}

/* ------------------------------ 配对 ------------------------------ */

interface PairingRecord {
  id: string
  account_id: string
  code: string
  expires_at: number
  status: string
}

/**
 * 新设备入伙：凭 6 位码把设备挂到该配对所属账号下，状态 pending。
 * 此时还没有任何凭据可用，所以是公开接口；安全性由「码 + 5 分钟有效期」保证。
 * /pair/join 与 /pair/request 是同一个实现（手机扫码走 /pair/join）。
 */
async function joinPairing(req: Request, env: Env): Promise<Response> {
  const body = await readJson(req)
  if (!body) return fail(400, 'bad_json', '请求体不是合法 JSON')

  const pairId = str(body.pairId).trim()
  const code = str(body.code).trim()
  const deviceId = str(body.deviceId).trim()
  const accountSecret = str(body.accountSecret).trim()
  const deviceName = str(body.deviceName).trim()
  if (!code || !deviceId) return fail(400, 'missing_fields', '缺少 code/deviceId')
  if (!isHex(accountSecret, SECRET_HEX_LEN)) {
    return fail(400, 'invalid_secret', `accountSecret 必须是 ${SECRET_HEX_LEN} 位 hex`)
  }

  // pairId 可以不给（手动输配对码的场景）：按 code 找那一条未过期的配对
  let pairing: PairingRecord | null = null
  if (pairId) {
    pairing = await firstRow<PairingRecord>(
      env,
      'SELECT id, account_id, code, expires_at, status FROM pairings WHERE id = ?',
      pairId
    )
  } else {
    pairing = await firstRow<PairingRecord>(
      env,
      `SELECT id, account_id, code, expires_at, status FROM pairings
        WHERE code = ? AND status = 'open' AND expires_at > ?
        ORDER BY expires_at DESC LIMIT 1`,
      code,
      Date.now()
    )
  }
  if (!pairing || pairing.status !== 'open') return fail(404, 'pairing_unavailable', '配对不存在或已失效')
  if (pairing.expires_at <= Date.now()) return fail(410, 'pairing_expired', '配对码已过期')
  if (!timingSafeEqual(code, pairing.code)) return fail(403, 'invalid_code', '配对码不正确')

  const existing = await firstRow<{ device_id: string; status: string }>(
    env,
    'SELECT device_id, status FROM devices WHERE device_id = ?',
    deviceId
  )
  if (existing && existing.status === 'approved') {
    return fail(409, 'device_exists', '该设备已加入其它账号')
  }

  const now = Date.now()
  const { salt, hash } = await makeCredential(accountSecret)

  if (existing) {
    // 重试 / 被拒后重来：换新 secret 并重新挂到 pending，created_at 保持首次配对时间
    await env.DB.prepare(
      `UPDATE devices
          SET account_id = ?, name = ?, secret_salt = ?, secret_hash = ?,
              status = 'pending', last_seen_at = NULL, last_ip = NULL
        WHERE device_id = ?`
    )
      .bind(pairing.account_id, deviceName, salt, hash, deviceId)
      .run()
  } else {
    await env.DB.prepare(
      `INSERT INTO devices
         (device_id, account_id, name, secret_salt, secret_hash, status, created_at, last_seen_at, last_ip)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, NULL)`
    )
      .bind(deviceId, pairing.account_id, deviceName, salt, hash, now)
      .run()
  }

  return json({ ok: true })
}

/**
 * 轮询配对结果。新设备还没有凭据，所以用 code 作为共享秘密做校验。
 * 码不对 / 配对不存在一律返回 unknown，不泄露任何账号信息。
 */
async function pairingStatus(url: URL, env: Env): Promise<Response> {
  const pairId = url.searchParams.get('pairId') ?? ''
  const deviceId = url.searchParams.get('deviceId') ?? ''
  const code = url.searchParams.get('code') ?? ''

  const unknown = json({ status: 'unknown' })
  if (!deviceId || !code) return unknown

  // pairId 同样可以不给：按 code 找那条配对
  let pairing: PairingRecord | null = null
  if (pairId) {
    pairing = await firstRow<PairingRecord>(
      env,
      'SELECT id, account_id, code, expires_at, status FROM pairings WHERE id = ?',
      pairId
    )
  } else {
    pairing = await firstRow<PairingRecord>(
      env,
      `SELECT id, account_id, code, expires_at, status FROM pairings
        WHERE code = ? ORDER BY expires_at DESC LIMIT 1`,
      code
    )
  }
  if (!pairing) return unknown
  if (!timingSafeEqual(code, pairing.code)) return unknown

  const device = await firstRow<{ device_id: string; account_id: string; status: string }>(
    env,
    'SELECT device_id, account_id, status FROM devices WHERE device_id = ?',
    deviceId
  )
  if (!device || device.account_id !== pairing.account_id) return unknown

  // 状态集合：pending | approved | rejected | expired | unknown
  // （设备被拒绝或事后被吊销，对配对方来说都是"没批下来"）
  if (device.status === 'revoked') return json({ status: 'rejected' })
  if (device.status === 'approved') return json({ status: 'approved' })
  // 仍是 pending：看这次配对是否已经过期
  if (pairing.expires_at <= Date.now() || pairing.status !== 'open') return json({ status: 'expired' })
  return json({ status: 'pending' })
}

/** 已授权设备生成配对码；同一账号旧的 open 配对一律作废 */
async function startPairing(env: Env, auth: AuthedDevice): Promise<Response> {
  const now = Date.now()
  const expiresAt = now + PAIRING_TTL_MS
  const pairId = crypto.randomUUID()
  const code = randomPairingCode()

  await env.DB.batch([
    env.DB.prepare(`UPDATE pairings SET status = 'expired' WHERE account_id = ? AND status = 'open'`).bind(
      auth.accountId
    ),
    env.DB.prepare(
      `INSERT INTO pairings (id, account_id, code, created_at, expires_at, status)
       VALUES (?, ?, ?, ?, ?, 'open')`
    ).bind(pairId, auth.accountId, code, now, expiresAt)
  ])

  // 二维码里只有 pairId + code（+ 到期时间），不带任何密钥
  return json({ pairId, code, expiresAt })
}

/** 待批准设备列表（只看自己账号；给了 pairId 就校验归属） */
async function listPending(url: URL, env: Env, auth: AuthedDevice): Promise<Response> {
  const pairId = url.searchParams.get('pairId') ?? ''
  if (pairId) {
    const pairing = await firstRow<{ account_id: string }>(
      env,
      'SELECT account_id FROM pairings WHERE id = ?',
      pairId
    )
    if (!pairing || pairing.account_id !== auth.accountId) {
      return fail(404, 'pairing_not_found', '配对不存在')
    }
  }

  const { results } = await env.DB.prepare(
    `SELECT device_id, name, created_at FROM devices
      WHERE account_id = ? AND status = 'pending'
      ORDER BY created_at ASC`
  )
    .bind(auth.accountId)
    .all<{ device_id: string; name: string; created_at: number }>()

  const devices = (results ?? []).map((r) => ({
    deviceId: r.device_id,
    name: r.name,
    createdAt: r.created_at
  }))
  return json({ devices })
}

/** 批准：设备转 approved，配对一次性用掉 */
async function approvePairing(req: Request, env: Env, auth: AuthedDevice): Promise<Response> {
  const body = await readJson(req)
  if (!body) return fail(400, 'bad_json', '请求体不是合法 JSON')
  const pairId = str(body.pairId).trim()
  const deviceId = str(body.deviceId).trim()
  if (!pairId || !deviceId) return fail(400, 'missing_fields', '缺少 pairId/deviceId')

  const pairing = await firstRow<PairingRecord>(
    env,
    'SELECT id, account_id, code, expires_at, status FROM pairings WHERE id = ?',
    pairId
  )
  if (!pairing || pairing.account_id !== auth.accountId) return fail(404, 'pairing_not_found', '配对不存在')

  const device = await firstRow<{ account_id: string; status: string }>(
    env,
    'SELECT account_id, status FROM devices WHERE device_id = ?',
    deviceId
  )
  if (!device || device.account_id !== auth.accountId) return fail(404, 'device_not_found', '设备不存在')

  await env.DB.batch([
    env.DB.prepare(`UPDATE devices SET status = 'approved' WHERE device_id = ?`).bind(deviceId),
    env.DB.prepare(`UPDATE pairings SET status = 'used' WHERE id = ?`).bind(pairId)
  ])

  return json({ ok: true })
}

/** 拒绝：直接把那台设备标 revoked（账号内可再改回来重新配对） */
async function rejectPairing(req: Request, env: Env, auth: AuthedDevice): Promise<Response> {
  const body = await readJson(req)
  if (!body) return fail(400, 'bad_json', '请求体不是合法 JSON')
  const pairId = str(body.pairId).trim()
  const deviceId = str(body.deviceId).trim()
  if (!pairId || !deviceId) return fail(400, 'missing_fields', '缺少 pairId/deviceId')

  const pairing = await firstRow<PairingRecord>(
    env,
    'SELECT id, account_id, code, expires_at, status FROM pairings WHERE id = ?',
    pairId
  )
  if (!pairing || pairing.account_id !== auth.accountId) return fail(404, 'pairing_not_found', '配对不存在')

  const device = await firstRow<{ account_id: string }>(
    env,
    'SELECT account_id FROM devices WHERE device_id = ?',
    deviceId
  )
  if (!device || device.account_id !== auth.accountId) return fail(404, 'device_not_found', '设备不存在')

  await env.DB.prepare(`UPDATE devices SET status = 'revoked' WHERE device_id = ?`).bind(deviceId).run()
  return json({ ok: true })
}

/* ------------------------------ 设备管理 ------------------------------ */

async function listDevices(env: Env, auth: AuthedDevice): Promise<Response> {
  const now = Date.now()
  const { results } = await env.DB.prepare(
    `SELECT device_id, name, status, last_seen_at, last_ip FROM devices
      WHERE account_id = ?
      ORDER BY created_at ASC`
  )
    .bind(auth.accountId)
    .all<{ device_id: string; name: string; status: string; last_seen_at: number | null; last_ip: string | null }>()

  const rows = results ?? []
  const devices = rows.map((r) => ({
    deviceId: r.device_id,
    name: r.name,
    status: r.status,
    lastSeenAt: r.last_seen_at ?? null,
    lastIp: r.last_ip ?? null,
    current: r.device_id === auth.deviceId
  }))
  // 在线：已批准 且 最近 5 分钟内有请求
  const online = rows.filter(
    (r) => r.status === 'approved' && typeof r.last_seen_at === 'number' && r.last_seen_at >= now - ONLINE_WINDOW_MS
  ).length

  return json({ devices, online })
}

async function revokeDevice(req: Request, env: Env, auth: AuthedDevice): Promise<Response> {
  const body = await readJson(req)
  if (!body) return fail(400, 'bad_json', '请求体不是合法 JSON')
  const deviceId = str(body.deviceId).trim()
  if (!deviceId) return fail(400, 'missing_fields', '缺少 deviceId')
  if (deviceId === auth.deviceId) return fail(400, 'cannot_revoke_self', '不能吊销当前设备')

  const device = await firstRow<{ account_id: string }>(
    env,
    'SELECT account_id FROM devices WHERE device_id = ?',
    deviceId
  )
  if (!device || device.account_id !== auth.accountId) return fail(404, 'device_not_found', '设备不存在')

  await env.DB.prepare(`UPDATE devices SET status = 'revoked' WHERE device_id = ?`).bind(deviceId).run()
  return json({ ok: true })
}

/* ------------------------------ 同步 ------------------------------ */

/**
 * 拉取：只回本账号的行，payload 原样（明文 JSON 字符串）返回，服务端不解析业务字段。
 * cursor 取本页最大 updated_at，下一页用 since=cursor 续拉。
 */
async function pull(url: URL, env: Env, auth: AuthedDevice): Promise<Response> {
  const table = url.searchParams.get('table') ?? ''
  if (!ALLOWED_TABLES.has(table)) return fail(400, 'unknown_table', `未知集合：${table}`)

  const rawSince = Number(url.searchParams.get('since') ?? '0')
  const since = Number.isFinite(rawSince) ? Math.floor(rawSince) : 0
  const rawLimit = Number(url.searchParams.get('limit') ?? String(DEFAULT_LIMIT))
  const limit = Math.min(Math.max(1, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : DEFAULT_LIMIT), MAX_ROWS)

  const { results } = await env.DB.prepare(
    `SELECT id, updated_at, deleted_at, payload FROM rows
      WHERE tbl = ? AND account_id = ? AND updated_at > ?
      ORDER BY updated_at ASC LIMIT ?`
  )
    .bind(table, auth.accountId, since, limit)
    .all<{ id: string; updated_at: number; deleted_at: number | null; payload: string }>()

  const rows = (results ?? []).map((r) => ({
    id: r.id,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at ?? null,
    payload: r.payload
  }))
  const cursor = rows.reduce((max, r) => Math.max(max, r.updatedAt), since)
  return json({ rows, cursor })
}

/**
 * LWW 守卫写在 SQL 里：excluded.updated_at > rows.updated_at 才覆盖。
 * 冲突键是 (tbl, account_id, id)：不同账号用同一个 id 也不会互相覆盖。
 */
const PUSH_SQL = `INSERT INTO rows (tbl, id, account_id, updated_at, deleted_at, payload)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(tbl, account_id, id) DO UPDATE SET
    updated_at = excluded.updated_at,
    deleted_at = excluded.deleted_at,
    payload    = excluded.payload
  WHERE excluded.updated_at > rows.updated_at`

async function push(req: Request, env: Env, auth: AuthedDevice): Promise<Response> {
  const body = await readJson(req)
  if (!body) return fail(400, 'bad_json', '请求体不是合法 JSON')

  const table = str(body.table)
  if (!ALLOWED_TABLES.has(table)) return fail(400, 'unknown_table', `未知集合：${table}`)
  if (!Array.isArray(body.rows)) return fail(400, 'bad_rows', 'rows 必须是数组')
  if (body.rows.length > MAX_ROWS) return fail(400, 'too_many_rows', `单次最多推送 ${MAX_ROWS} 行`)

  const stmt = env.DB.prepare(PUSH_SQL)
  const stmts: D1PreparedStatement[] = []
  const errors: string[] = []

  body.rows.forEach((value, index) => {
    const row = (value ?? {}) as Record<string, unknown>
    const id = str(row.id)
    const updatedAt = num(row.updatedAt)
    const payload = typeof row.payload === 'string' ? row.payload : null

    if (!id) {
      errors.push(`第 ${index + 1} 行缺少 id`)
      return
    }
    if (updatedAt === null) {
      errors.push(`第 ${index + 1} 行缺少 updatedAt`)
      return
    }
    if (payload === null) {
      errors.push(`第 ${index + 1} 行缺少 payload`)
      return
    }
    // payload 是明文 JSON 字符串（客户端把整行 camelCase 对象 stringify 后塞进来）
    try {
      const parsed = JSON.parse(payload) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        errors.push(`第 ${index + 1} 行 payload 不是 JSON 对象`)
        return
      }
    } catch {
      errors.push(`第 ${index + 1} 行 payload 不是合法 JSON`)
      return
    }

    // account_id 一律用调用方的，body 里带了也忽略
    stmts.push(stmt.bind(table, id, auth.accountId, updatedAt, num(row.deletedAt), payload))
  })

  let written = 0
  if (stmts.length > 0) {
    const results = await env.DB.batch(stmts)
    for (const result of results) written += Number(result?.meta?.changes ?? 0)
  }

  return json({ written, failed: errors.length, errors })
}

/* ------------------------------ REST（移动端） ------------------------------ */

/** REST 层用到的行结构：字段与桌面端同构，服务端不加密 */
interface RestRow {
  id: string
  updatedAt: number
  deletedAt: number | null
  calendarId?: string
  date?: string
  text?: string
  name?: string
  color?: string | null
  sort?: number
  title?: string
  content?: string
  pinned?: boolean
  kind?: string
  notes?: string | null
  start?: string
  end?: string | null
  rrule?: string | null
  remindMinutes?: number | null
  targetDate?: string | null
  completed?: boolean
  createdAt?: number
  [key: string]: unknown
}

/**
 * REST 路由表。所有 /api/* 端点都要求设备凭据，
 * 并且一律按 auth.accountId 过滤/写入 —— 账号隔离的第二道闸门。
 */
async function handleRest(req: Request, url: URL, env: Env, auth: AuthedDevice): Promise<Response> {
  const accountId = auth.accountId
  const path = url.pathname

  if (path === '/api/calendars' && req.method === 'GET') {
    const rows = (await loadTable(env, accountId, 'calendars')).filter((r) => !r.deletedAt)
    rows.sort((a, b) => Number(a.sort ?? 0) - Number(b.sort ?? 0))
    return json(rows.map((r) => ({ id: r.id, name: r.name, color: r.color, sort: r.sort })))
  }

  if (path === '/api/cells' && req.method === 'GET') {
    const calendar = url.searchParams.get('calendar') ?? ''
    const from = url.searchParams.get('from') ?? ''
    const to = url.searchParams.get('to') ?? ''
    const rows = (await loadTable(env, accountId, 'day_cells')).filter(
      (r) =>
        !r.deletedAt &&
        (!calendar || r.calendarId === calendar) &&
        String(r.date) >= from &&
        String(r.date) <= to
    )
    return json(rows.map((r) => ({ date: r.date, text: r.text ?? '' })))
  }

  if (path === '/api/cells/append' && req.method === 'POST') {
    const body = await readJson(req)
    if (!body) return fail(400, 'bad_json', '请求体不是合法 JSON')
    const calendar = String(body.calendar ?? '')
    const date = String(body.date ?? '')
    const text = String(body.text ?? '').trim()
    if (!calendar || !date || !text) return fail(400, 'missing_fields', '缺少 calendar/date/text')
    if (/[\r\n]/.test(text)) return fail(400, 'single_line_only', '任务只能是单行')
    const current = await readCell(env, accountId, calendar, date)
    const lines = splitLines(current)
    lines.push(text)
    const next = lines.join('\n')
    await writeCell(env, accountId, calendar, date, next)
    return json({ text: next })
  }

  if (path === '/api/cells/toggle' && req.method === 'POST') {
    const body = await readJson(req)
    if (!body) return fail(400, 'bad_json', '请求体不是合法 JSON')
    const calendar = String(body.calendar ?? '')
    const date = String(body.date ?? '')
    const index = Number(body.index)
    const done = Boolean(body.done)
    const lines = splitLines(await readCell(env, accountId, calendar, date))
    if (!Number.isInteger(index) || index < 0 || index >= lines.length) {
      return fail(400, 'bad_index', `行号 ${index} 超出范围`)
    }
    lines[index] = markDone(lines[index], done)
    const next = lines.join('\n')
    await writeCell(env, accountId, calendar, date, next)
    return json({ text: next })
  }

  if (path === '/api/cells/remove-line' && req.method === 'POST') {
    const body = await readJson(req)
    if (!body) return fail(400, 'bad_json', '请求体不是合法 JSON')
    const calendar = String(body.calendar ?? '')
    const date = String(body.date ?? '')
    const index = Number(body.index)
    const lines = splitLines(await readCell(env, accountId, calendar, date))
    if (!Number.isInteger(index) || index < 0 || index >= lines.length) {
      return fail(400, 'bad_index', `行号 ${index} 超出范围`)
    }
    lines.splice(index, 1)
    const next = lines.join('\n')
    await writeCell(env, accountId, calendar, date, next)
    return json({ text: next })
  }

  if (path === '/api/events' && req.method === 'GET') {
    const calendar = url.searchParams.get('calendar') ?? ''
    const from = url.searchParams.get('from') ?? ''
    const to = url.searchParams.get('to') ?? ''
    return json(await listOccurrences(env, accountId, calendar, from, to))
  }

  if (path === '/api/events/create' && req.method === 'POST') {
    const body = await readJson(req)
    if (!body) return fail(400, 'bad_json', '请求体不是合法 JSON')
    const now = Date.now()
    // 字段必须与桌面端 CalendarEvent 完全同构，否则桌面端导入会撞 NOT NULL 约束
    const row: RestRow = {
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
    if (!row.title || !row.start) return fail(400, 'missing_fields', '缺少 title/start')
    await saveRow(env, accountId, 'events', row)
    return json({ id: row.id })
  }

  if (path === '/api/events/delete' && req.method === 'POST') {
    const body = await readJson(req)
    if (!body) return fail(400, 'bad_json', '请求体不是合法 JSON')
    const id = String(body.id ?? '')
    const rows = await loadTable(env, accountId, 'events')
    const hit = rows.find((r) => r.id === id)
    if (!hit) return fail(404, 'not_found', '事件不存在')
    await saveRow(env, accountId, 'events', { ...hit, deletedAt: Date.now(), updatedAt: Date.now() })
    return json({ ok: true })
  }

  if (path === '/api/events/toggle' && req.method === 'POST') {
    const body = await readJson(req)
    if (!body) return fail(400, 'bad_json', '请求体不是合法 JSON')
    const eventId = String(body.id ?? '')
    const date = String(body.date ?? '')
    const done = Boolean(body.done)
    await saveRow(env, accountId, 'event_done', {
      id: `${eventId}:${date}`,
      eventId,
      occurrenceDate: date,
      updatedAt: Date.now(),
      deletedAt: done ? null : Date.now()
    })
    return json({ ok: true, done })
  }

  if (path === '/api/events/skip' && req.method === 'POST') {
    const body = await readJson(req)
    if (!body) return fail(400, 'bad_json', '请求体不是合法 JSON')
    const eventId = String(body.id ?? '')
    const date = String(body.date ?? '')
    if (!eventId || !date) return fail(400, 'missing_fields', '缺少 id/date')
    // 与桌面端同构：行主键固定为「事件:日期」，桌面端按 id 回滚/去重
    await saveRow(env, accountId, 'event_skip', {
      id: `${eventId}:${date}`,
      eventId,
      occurrenceDate: date,
      updatedAt: Date.now(),
      deletedAt: null
    })
    return json({ ok: true })
  }

  if (path === '/api/notes' && req.method === 'GET') {
    const rows = (await loadTable(env, accountId, 'notes')).filter((r) => !r.deletedAt)
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

  if (path === '/api/notes/save' && req.method === 'POST') {
    const body = await readJson(req)
    if (!body) return fail(400, 'bad_json', '请求体不是合法 JSON')
    const now = Date.now()
    const id = body.id ? String(body.id) : `note:${crypto.randomUUID()}`
    const existing = (await loadTable(env, accountId, 'notes')).find((r) => r.id === id)
    const row: RestRow = {
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
    await saveRow(env, accountId, 'notes', row)
    return json({ id, title: row.title, content: row.content })
  }

  if (path === '/api/notes/delete' && req.method === 'POST') {
    const body = await readJson(req)
    if (!body) return fail(400, 'bad_json', '请求体不是合法 JSON')
    const id = String(body.id ?? '')
    const hit = (await loadTable(env, accountId, 'notes')).find((r) => r.id === id)
    if (!hit) return fail(404, 'not_found', '便签不存在')
    await saveRow(env, accountId, 'notes', { ...hit, deletedAt: Date.now(), updatedAt: Date.now() })
    return json({ ok: true })
  }

  if (path === '/api/notes/get' && req.method === 'GET') {
    const id = url.searchParams.get('id') ?? ''
    const hit = (await loadTable(env, accountId, 'notes')).find((r) => r.id === id && !r.deletedAt)
    if (!hit) return fail(404, 'not_found', '便签不存在')
    return json({ id: hit.id, title: hit.title ?? '', content: hit.content ?? '' })
  }

  if (path === '/api/calendars/create' && req.method === 'POST') {
    const body = await readJson(req)
    if (!body) return fail(400, 'bad_json', '请求体不是合法 JSON')
    const name = String(body.name ?? '').trim()
    if (!name) return fail(400, 'missing_name', '名称不能为空')
    const rows = (await loadTable(env, accountId, 'calendars')).filter((r) => !r.deletedAt)
    if (rows.some((r) => r.name === name)) return fail(400, 'duplicate_name', `已存在同名视图「${name}」`)
    const now = Date.now()
    const row: RestRow = {
      id: `cal:${crypto.randomUUID()}`,
      name,
      color: String(body.color ?? '#5b8cff'),
      sort: rows.length,
      createdAt: now,
      updatedAt: now,
      deletedAt: null
    }
    await saveRow(env, accountId, 'calendars', row)
    return json({ id: row.id, name: row.name, color: row.color })
  }

  if (path === '/api/calendars/delete' && req.method === 'POST') {
    const body = await readJson(req)
    if (!body) return fail(400, 'bad_json', '请求体不是合法 JSON')
    const id = String(body.id ?? '')
    const rows = (await loadTable(env, accountId, 'calendars')).filter((r) => !r.deletedAt)
    if (rows.length <= 1) return fail(400, 'need_one_calendar', '至少保留一个视图')
    const hit = rows.find((r) => r.id === id)
    if (!hit) return fail(404, 'not_found', '视图不存在')
    await saveRow(env, accountId, 'calendars', { ...hit, deletedAt: Date.now(), updatedAt: Date.now() })
    return json({ ok: true })
  }

  if (path === '/api/search' && req.method === 'GET') {
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase()
    if (!q) return json([])
    const [cals, cells, events, notes] = await Promise.all([
      loadTable(env, accountId, 'calendars'),
      loadTable(env, accountId, 'day_cells'),
      loadTable(env, accountId, 'events'),
      loadTable(env, accountId, 'notes')
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

/* ------------------------------ REST 辅助 ------------------------------ */

/**
 * 读本账号的一张集合表。
 * payload 是明文 JSON：能解析就并进行对象（业务字段），
 * id / updatedAt / deletedAt 始终以列为准（LWW 的权威值）。
 */
async function loadTable(env: Env, accountId: string, table: string): Promise<RestRow[]> {
  const { results } = await env.DB.prepare(
    'SELECT id, updated_at, deleted_at, payload FROM rows WHERE tbl = ? AND account_id = ?'
  )
    .bind(table, accountId)
    .all<{ id: string; updated_at: number; deleted_at: number | null; payload: string }>()

  const out: RestRow[] = []
  for (const r of results ?? []) {
    let parsed: Record<string, unknown> = {}
    try {
      const value = JSON.parse(r.payload) as unknown
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        parsed = value as Record<string, unknown>
      }
    } catch {
      // payload 不是 JSON：只用列里的字段，业务字段按缺省处理
    }
    out.push({ ...parsed, id: r.id, updatedAt: r.updated_at, deletedAt: r.deleted_at } as RestRow)
  }
  return out
}

/** 写本账号的一行：payload 存整行的明文 JSON，LWW 冲突守卫写在 SQL 里 */
async function saveRow(env: Env, accountId: string, table: string, row: RestRow): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO rows (tbl, id, account_id, updated_at, deleted_at, payload)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(tbl, account_id, id) DO UPDATE SET
       updated_at = excluded.updated_at,
       deleted_at = excluded.deleted_at,
       payload    = excluded.payload
     WHERE excluded.updated_at > rows.updated_at`
  )
    .bind(
      table,
      row.id,
      accountId,
      row.updatedAt,
      typeof row.deletedAt === 'number' ? row.deletedAt : null,
      JSON.stringify(row)
    )
    .run()
}

const cellId = (calendarId: string, date: string): string => `${calendarId}:${date}`

async function readCell(env: Env, accountId: string, calendarId: string, date: string): Promise<string> {
  const rows = await loadTable(env, accountId, 'day_cells')
  const hit = rows.find((r) => r.id === cellId(calendarId, date) && !r.deletedAt)
  return hit ? String(hit.text ?? '') : ''
}

async function writeCell(
  env: Env,
  accountId: string,
  calendarId: string,
  date: string,
  text: string
): Promise<void> {
  await saveRow(env, accountId, 'day_cells', {
    id: cellId(calendarId, date),
    calendarId,
    date,
    text,
    color: null,
    updatedAt: Date.now(),
    deletedAt: null
  })
}

function expandEvent(event: RestRow, from: string, to: string): string[] {
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
  accountId: string,
  calendarId: string,
  from: string,
  to: string
): Promise<Array<{ event: RestRow; date: string; done: boolean }>> {
  const [events, dones] = await Promise.all([
    loadTable(env, accountId, 'events'),
    loadTable(env, accountId, 'event_done')
  ])
  const doneSet = new Set(dones.filter((d) => !d.deletedAt).map((d) => String(d.id)))
  const out: Array<{ event: RestRow; date: string; done: boolean }> = []
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
