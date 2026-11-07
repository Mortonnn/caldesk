/**
 * caldesk-sync — Cloudflare Worker + D1
 *
 * 安全模型：
 * 1. 账号 = 用户名 + 密码。密码用 PBKDF2-HMAC-SHA256（120k 次，16 字节随机盐）
 *    存成 hex，服务端不存明文；比对走常量时间循环。
 *    `accounts.username_key` 是去空白 + 忽略大小写的唯一键。
 * 2. 登录成功后，客户端拿到的仍是「每设备一套凭据」：
 *    `Authorization: Bearer <deviceId>.<secretHex>`，服务端只存
 *    sha256(salt || secretHex)。设备凭据与账号密码是两层：
 *    密码用于“这台设备属于哪个账号”，设备凭据用于后续每一次请求。
 *    任意设备登录同一账号，就绑定到同一个 account_id —— 不需要配对码。
 * 3. 老账号（配对时代创建、没有用户名密码）用当前设备凭据调 /auth/claim
 *    设一次用户名密码即可，rows 里的数据一行不动。
 * 4. 服务端存明文：rows.payload 就是整行的明文 JSON 字符串，
 *    服务端不解密、也不解析业务字段（同步协议里 payload 是不透明字符串）。
 * 5. 多账号隔离：账号一律由凭据推导（devices.account_id），
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
}

/** 允许同步的集合；加新集合只改这里 */
const ALLOWED_TABLES = new Set(['calendars', 'day_cells', 'events', 'event_done', 'event_skip', 'notes'])

const MAX_ROWS = 500
const DEFAULT_LIMIT = 200
const ONLINE_WINDOW_MS = 5 * 60 * 1000
/** device secret 是 32 字节 → 64 个 hex 字符 */
const SECRET_HEX_LEN = 64
const SALT_BYTES = 16
/** 设备 id 是 UUID；留点余量给老客户端，但别让 1MB 的 id 进查询 */
const MAX_DEVICE_ID = 128
/** 行 id 是 `cal:x` / `note:x` / `evt:x` / `calendarId:date`，200 够用 */
const MAX_ROW_ID = 200
/** 单行 payload 上限。D1 单行/单值有大小限制，超了会让**整批**写入失败 */
const MAX_PAYLOAD_BYTES = 512 * 1024
/** 日格里一整段文本的上限（避免一个请求把一行撑爆） */
const MAX_CELL_TEXT_BYTES = 128 * 1024
/** 请求体上限（/sync/push 一批最多 500 行 × 512KB），超出直接 413 */
const MAX_BODY_BYTES = 8 * 1024 * 1024
/** 设备活跃时间写库的节流窗口：轮询不要每次都写 D1 */
const TOUCH_INTERVAL_MS = 60 * 1000
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/* 账号密码：PBKDF2-HMAC-SHA256，迭代次数写在账号行里，以后调高不会让老密码失效。
   100000 是 Workers WebCrypto 的硬上限，超过会直接抛 NotSupportedError。 */
const PBKDF2_ITERS = 100_000
const PASSWORD_MIN = 10
const USERNAME_MAX = 64

/**
 * CORS：Capacitor/浏览器里的页面来源是 https://localhost 或 file://，
 * 跨域访问会带 Authorization 头 → 触发预检。这里统一放行。
 *
 * 为什么仍然是 `*`：这套接口不用 Cookie/Session，凭据只在 Authorization 头里，
 * 浏览器不会自动携带，别的站点拿不到也不该有 —— 放开来源不会造成越权读取。
 * 反过来写死白名单会把 Capacitor（https://localhost、capacitor://localhost）
 * 和各种自定义域名挡在外面，反而打断正常的手机端。
 */
const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, x-device-name',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-max-age': '86400'
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // 响应里有账号/设备信息，别让中间层缓存
      'cache-control': 'no-store',
      ...CORS_HEADERS
    }
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

/* ------------------------------ 账号密码 ------------------------------ */

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/** PBKDF2-SHA256 → 32 字节 hex；迭代次数存在账号行里，升级不影响老密码 */
async function pbkdf2Hex(password: string, saltHex: string, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: hexToBytes(saltHex), iterations, hash: 'SHA-256' },
    key,
    256
  )
  return bytesToHex(new Uint8Array(bits))
}

/**
 * 用户不存在 / 老账号没设密码时，也要跑一次同样代价的 PBKDF2。
 *
 * 否则「这个用户名有没有」可以直接用响应时间测出来：
 * 不存在的用户 20ms 返回，存在的用户 130ms 返回，差一个数量级。
 * 盐是一次性的，每 isolate 生成一次即可（盐本身不是秘密）。
 */
let burnSalt: string | null = null

async function burnPasswordCheck(password: string): Promise<void> {
  if (!burnSalt) burnSalt = randomHex(SALT_BYTES)
  await pbkdf2Hex(password, burnSalt, PBKDF2_ITERS)
}

/**
 * 用户名比较键：去空白 + 忽略大小写，保证 Alice 与 alice 是同一个账号。
 *
 * 用 toLowerCase 而不是 toLocaleLowerCase：后者跟运行环境的默认语言绑，
 * 土耳其语环境下 "I".toLocaleLowerCase() 会变成 "ı"，同一个人在两台机器上
 * 可能就登录不上同一个账号了。
 */
function usernameKeyOf(username: string): string {
  return username.trim().toLowerCase()
}

function checkUsername(username: string): string | null {
  const name = username.trim()
  if (name.length < 1 || name.length > USERNAME_MAX) {
    return `用户名长度需在 1–${USERNAME_MAX} 个字符之间`
  }
  // 不允许控制字符；空格也只能出现在中间（首尾已 trim）
  if (/[\u0000-\u001f\u007f]/.test(name)) return '用户名含有不可见字符'
  return null
}

/** 密码策略：至少 10 位，且数字、大写、小写、符号各至少一个 */
function checkPassword(password: string): string | null {
  if (password.length < PASSWORD_MIN) return `密码至少 ${PASSWORD_MIN} 位`
  if (password.length > 200) return '密码太长'
  if (!/[0-9]/.test(password)) return '密码需要包含数字'
  if (!/[a-z]/.test(password)) return '密码需要包含小写字母'
  if (!/[A-Z]/.test(password)) return '密码需要包含大写字母'
  if (!/[^A-Za-z0-9]/.test(password)) return '密码需要包含符号'
  return null
}

/**
 * deviceId 由客户端生成（UUID），但它是 URL/头里的**查询键**，
 * 必须挡住空值、超长和空白字符，否则会变成一个又大又没用的 D1 查询。
 * 也挡住 '.'：凭据是 `<deviceId>.<secret>`，deviceId 里带点会让解析产生歧义。
 */
function checkDeviceId(deviceId: string): string | null {
  if (!deviceId) return '缺少 deviceId'
  if (deviceId.length > MAX_DEVICE_ID) return `deviceId 太长（最多 ${MAX_DEVICE_ID} 个字符）`
  if (deviceId.includes('.')) return 'deviceId 不能包含 "."'
  if (/[\s\u0000-\u001f\u007f]/.test(deviceId)) return 'deviceId 含有空白或不可见字符'
  return null
}

interface AccountAuthRow {
  id: string
  username: string | null
  username_key: string | null
  password_hash: string | null
  password_salt: string | null
  password_iters: number | null
}

async function accountByUsername(env: Env, key: string): Promise<AccountAuthRow | null> {
  return await firstRow<AccountAuthRow>(
    env,
    `SELECT id, username, username_key, password_hash, password_salt, password_iters
       FROM accounts WHERE username_key = ?`,
    key
  )
}

async function accountById(env: Env, id: string): Promise<AccountAuthRow | null> {
  return await firstRow<AccountAuthRow>(
    env,
    `SELECT id, username, username_key, password_hash, password_salt, password_iters
       FROM accounts WHERE id = ?`,
    id
  )
}

/**
 * 把一台设备挂到账号下（登录 / 注册都走这里）。
 *
 * 设备凭据由客户端生成，服务端只存哈希。同一个 deviceId 已经属于别的账号时，
 * 这里**换一把新钥匙**：服务端发一个新的 deviceId + secret 回来，客户端换成本地凭据。
 * 这样"退出登录后换一个账号登录"能走通，同时旧账号那一行原样留着（还能在它那边撤销）。
 */
async function bindDevice(
  env: Env,
  accountId: string,
  deviceId: string,
  deviceName: string,
  secret: string
): Promise<{ deviceId: string; secret: string } | Response> {
  const existing = await firstRow<{ account_id: string }>(
    env,
    'SELECT account_id FROM devices WHERE device_id = ?',
    deviceId
  )
  const { salt, hash } = await makeCredential(secret)
  const now = Date.now()

  if (existing && existing.account_id !== accountId) {
    // 这台设备原来挂在别的账号下：给它发一套新凭据。
    // 同时把旧账号那一行**作废** —— 不然同一把 secret 在旧账号里永远有效，
    // 换账号登录之后旧账号的门还开着（设备被转手/secret 泄露就是越权）。
    await env.DB.prepare(`UPDATE devices SET status = 'revoked' WHERE device_id = ? AND account_id <> ?`)
      .bind(deviceId, accountId)
      .run()
    const freshId = crypto.randomUUID()
    const freshSecret = randomHex(32)
    const fresh = await makeCredential(freshSecret)
    await env.DB.prepare(
      `INSERT INTO devices
         (device_id, account_id, name, secret_salt, secret_hash, status, created_at, last_seen_at, last_ip)
       VALUES (?, ?, ?, ?, ?, 'approved', ?, ?, NULL)`
    )
      .bind(freshId, accountId, deviceName, fresh.salt, fresh.hash, now, now)
      .run()
    return { deviceId: freshId, secret: freshSecret }
  }

  if (existing) {
    await env.DB.prepare(
      `UPDATE devices SET name = ?, secret_salt = ?, secret_hash = ?, status = 'approved', last_seen_at = ?
        WHERE device_id = ?`
    )
      .bind(deviceName, salt, hash, now, deviceId)
      .run()
  } else {
    await env.DB.prepare(
      `INSERT INTO devices
         (device_id, account_id, name, secret_salt, secret_hash, status, created_at, last_seen_at, last_ip)
       VALUES (?, ?, ?, ?, ?, 'approved', ?, ?, NULL)`
    )
      .bind(deviceId, accountId, deviceName, salt, hash, now, now)
      .run()
  }
  return { deviceId, secret }
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

/**
 * JSON 里的布尔：只认真正的 true / 1 / "true"。
 * 直接 Boolean("false") 会是 true —— 客户端传字符串时"取消勾选"就变成勾选了。
 */
function bool(value: unknown): boolean {
  return value === true || value === 1 || value === 'true' || value === '1'
}

/** REST 的日期参数只接受真实存在的 YYYY-MM-DD（2026-13-40 / 2026-02-30 都算坏） */
function badDate(value: string): boolean {
  if (!DATE_RE.test(value)) return true
  const [year, month, day] = value.split('-').map(Number)
  if (month < 1 || month > 12 || day < 1 || day > 31) return true
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
}

/** 日格文本按字节算（中文一个字 3 字节），超了直接 413 */
function textTooLarge(text: string): boolean {
  return new TextEncoder().encode(text).length > MAX_CELL_TEXT_BYTES
}

async function firstRow<T>(env: Env, sql: string, ...binds: unknown[]): Promise<T | null> {
  return await env.DB.prepare(sql)
    .bind(...binds)
    .first<T>()
}

/* ------------------------------ 登录限流 ------------------------------ */

/**
 * 固定窗口失败计数。
 *
 * 以前 /auth/login 和 /auth/register 是裸的：公网谁都能无限次试密码，
 * 每次成本只有一次 PBKDF2，配合弱口令就是可爆破的。这里按
 * 「用户名键 + IP」计失败次数，15 分钟内错满 10 次锁 15 分钟。
 *
 * 为什么要带 IP 而不只按用户名：只按用户名的话，攻击者可以拿别人的
 * 用户名反复失败，把人锁死（DoS）。带 IP 只惩罚攻击者自己那台。
 */
const AUTH_WINDOW_MS = 15 * 60_000
const AUTH_MAX_FAILS = 10

interface AuthFailRow {
  count: number
  window_at: number
  locked_until: number | null
}

/** 客户端 IP；Cloudflare 一定给 cf-connecting-ip，本地 dev 退回 x-forwarded-for */
function clientIp(req: Request): string {
  return req.headers.get('cf-connecting-ip') ?? req.headers.get('x-forwarded-for') ?? 'local'
}

/** 返回还需要锁定的秒数；0 表示可以继续尝试 */
async function authLockRemaining(env: Env, key: string): Promise<number> {
  const row = await firstRow<AuthFailRow>(
    env,
    'SELECT count, window_at, locked_until FROM auth_fails WHERE key = ?',
    key
  )
  if (!row?.locked_until) return 0
  const left = row.locked_until - Date.now()
  return left > 0 ? Math.ceil(left / 1000) : 0
}

/** 记一次失败；到达阈值时顺手续上锁 */
async function noteAuthFail(env: Env, key: string): Promise<void> {
  const now = Date.now()
  const row = await firstRow<AuthFailRow>(
    env,
    'SELECT count, window_at FROM auth_fails WHERE key = ?',
    key
  )
  if (!row || now - row.window_at > AUTH_WINDOW_MS) {
    await env.DB.prepare(
      `INSERT INTO auth_fails (key, count, window_at, locked_until) VALUES (?, 1, ?, NULL)
       ON CONFLICT(key) DO UPDATE SET count = 1, window_at = excluded.window_at, locked_until = NULL`
    )
      .bind(key, now)
      .run()
    return
  }
  const count = row.count + 1
  const lockedUntil = count >= AUTH_MAX_FAILS ? now + AUTH_WINDOW_MS : null
  await env.DB.prepare('UPDATE auth_fails SET count = ?, locked_until = ? WHERE key = ?')
    .bind(count, lockedUntil, key)
    .run()
}

async function clearAuthFails(env: Env, key: string): Promise<void> {
  await env.DB.prepare('DELETE FROM auth_fails WHERE key = ?').bind(key).run()
}

/** 锁定时统一回 429，文案不透露用户名是否存在 */
function authLocked(seconds: number): Response {
  const mins = Math.ceil(seconds / 60)
  return fail(429, 'too_many_attempts', `尝试次数过多，请 ${mins} 分钟后再试`)
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
  // 用最后一个点分：deviceId 是 UUID 不含点，secret 是纯 hex；
  // 用 indexOf 的话 "多带了一段" 的凭据会被解析成别的 deviceId，行为不好预测。
  const dot = token.lastIndexOf('.')
  if (dot <= 0 || dot === token.length - 1) return null

  const deviceId = token.slice(0, dot)
  const secret = token.slice(dot + 1)
  if (deviceId.length > MAX_DEVICE_ID) return null
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

/**
 * 每个通过鉴权的请求都刷新设备活跃时间（在线数就靠它）。
 *
 * 顺带接收客户端报上来的设备名：老设备的"这台手机"在本地改名之后，
 * 下一次请求就会把新名字（型号_月日时）写回服务端，不用重新登录。
 *
 * 节流：手机端每 5 秒打一次 /api/changes，如果每次都无条件 UPDATE，
 * 光轮询一天就能烧掉 D1 单日写入额度的一大半。这里用 WHERE 把
 * 「60 秒内没变化且名字没变」的请求变成零行写入。
 */
/**
 * 解开 `x-device-name` 的百分号编码。
 *
 * 与 `src/shared/identity.ts` 里的 encodeDeviceNameHeader 成对：客户端把设备名
 * encodeURIComponent 之后放进头里（HTTP 头只能承载 latin1，中文机型名不编码
 * 会让整个请求失败）。老客户端发的是裸值，没有 '%' 就原样返回。
 */
function decodeDeviceNameHeader(raw: string): string {
  const value = raw.trim()
  if (!value) return ''
  if (!value.includes('%')) return value.slice(0, 80)
  try {
    return decodeURIComponent(value).slice(0, 80)
  } catch {
    return value.slice(0, 80)
  }
}

async function touchDevice(req: Request, env: Env, deviceId: string): Promise<void> {
  const ip = req.headers.get('cf-connecting-ip')
  // 客户端把设备名百分号编码过（头里只能放 latin1，中文机型名不编码会让 fetch 直接失败）。
  // 老客户端发的是裸值，没有 '%' 就原样用。
  const reported = decodeDeviceNameHeader(req.headers.get('x-device-name') ?? '')
  const now = Date.now()
  await env.DB.prepare(
    `UPDATE devices
        SET last_seen_at = ?, last_ip = ?, name = COALESCE(NULLIF(?, ''), name)
      WHERE device_id = ?
        AND (last_seen_at IS NULL OR last_seen_at < ? OR name <> COALESCE(NULLIF(?, ''), name))`
  )
    .bind(now, ip && ip.length > 0 ? ip : null, reported, deviceId, now - TOUCH_INTERVAL_MS, reported)
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
    try {
      return await handle(req, env)
    } catch (err) {
      /*
       * 线上出异常时 Cloudflare 只给一句 1101，看不到原因，所以要自己兜住。
       *
       * 但**细节只进日志，不进响应**：以前的实现对客户端回了 message + stack，
       * 等于把 Worker 内部路径、SQL 片段、依赖版本免费送出去。
       * 客户端拿一个机器码就够了，排障靠 `wrangler tail`。
       */
      const message = err instanceof Error ? err.message : String(err)
      const stack = err instanceof Error ? (err.stack ?? '').slice(0, 400) : ''
      console.error('[caldesk] 未捕获异常:', message, stack)
      return fail(500, 'internal', '服务端出错了，请稍后重试')
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
    // D1 没绑好的时候不该报"健康"：监控和客户端都要能一眼看出不能同步
    const d1 = Boolean(env.DB)
    return json({ ok: d1, service: 'caldesk-sync', d1 }, d1 ? 200 : 503)
  }

  if (!env.DB) return fail(503, 'd1_missing', 'D1 未绑定，同步服务不可用')

  // 大 body 直接挡在解析之前，别把一个 100MB 的 JSON 读进内存
  const declared = Number(req.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return fail(413, 'body_too_large', `请求体太大（上限 ${Math.round(MAX_BODY_BYTES / 1024 / 1024)}MB）`)
  }

  // 首次访问时把表建好（IF NOT EXISTS，每个 isolate 只跑一次）
  await ensureSchema(env.DB as unknown as D1Like)

  /* -------------------- 公开接口（无需凭据） -------------------- */

  // 账号密码：注册即建账号 + 绑一台设备；登录即把当前设备绑到已有账号
  if (url.pathname === '/auth/register' && req.method === 'POST') {
    return await registerAccount(req, env)
  }
  if (url.pathname === '/auth/login' && req.method === 'POST') {
    return await loginAccount(req, env)
  }

  /* -------------------- 以下全部要求设备凭据 -------------------- */

  const auth = await authenticate(req, env)
  if (!auth) return fail(401, 'unauthorized', '设备凭据无效或未获批准')
  await touchDevice(req, env, auth.deviceId)

  // 老账号（配对时代创建、还没有用户名密码）用现有凭据认领一次
  if (url.pathname === '/auth/claim' && req.method === 'POST') {
    return await claimAccount(req, env, auth)
  }
  if (url.pathname === '/auth/me' && req.method === 'GET') {
    return await accountInfo(env, auth)
  }
  if (url.pathname === '/auth/logout' && req.method === 'POST') {
    return await logoutDevice(env, auth)
  }

  if (url.pathname === '/devices' && req.method === 'GET') return await listDevices(env, auth)
  if (url.pathname === '/devices/revoke' && req.method === 'POST') return await revokeDevice(req, env, auth)

  if (url.pathname === '/sync/pull' && req.method === 'GET') return await pull(url, env, auth)
  if (url.pathname === '/sync/push' && req.method === 'POST') return await push(req, env, auth)

  /* -------------------- REST（移动端在用） -------------------- */

  if (url.pathname.startsWith('/api/')) {
    return await handleRest(req, url, env, auth)
  }

  return fail(404, 'not_found', `未知接口：${req.method} ${url.pathname}`)
}

/* ------------------------------ 账号密码 ------------------------------ */

/**
 * 注册：建账号 + 把当前设备挂上去，直接 approved。
 * 设备凭据由客户端生成（deviceId + 64 位 hex secret），服务端只存哈希。
 */
async function registerAccount(req: Request, env: Env): Promise<Response> {
  const body = await readJson(req)
  if (!body) return fail(400, 'bad_json', '请求体不是合法 JSON')

  const username = str(body.username).trim()
  const password = str(body.password)
  const deviceId = str(body.deviceId).trim()
  const secret = str(body.secret).trim()
  const deviceName = str(body.deviceName).trim() || '未命名设备'

  const nameError = checkUsername(username)
  if (nameError) return fail(400, 'invalid_username', nameError)
  const passwordError = checkPassword(password)
  if (passwordError) return fail(400, 'weak_password', passwordError)
  const deviceError = checkDeviceId(deviceId)
  if (deviceError) return fail(400, 'invalid_device_id', deviceError)
  if (!isHex(secret, SECRET_HEX_LEN)) {
    return fail(400, 'invalid_secret', `secret 必须是 ${SECRET_HEX_LEN} 位 hex`)
  }

  const key = usernameKeyOf(username)
  // 注册也限流：否则「用户名是否被占用」这个 409 可以被无限次刷，用来枚举账号
  const regKey = `reg|${clientIp(req)}`
  const lockedFor = await authLockRemaining(env, regKey)
  if (lockedFor > 0) return authLocked(lockedFor)
  if (await accountByUsername(env, key)) {
    await noteAuthFail(env, regKey)
    return fail(409, 'username_taken', '这个用户名已被占用')
  }

  const accountId = crypto.randomUUID()
  const now = Date.now()
  const salt = randomHex(SALT_BYTES)
  const hash = await pbkdf2Hex(password, salt, PBKDF2_ITERS)

  try {
    await env.DB.prepare(
      `INSERT INTO accounts
         (id, name, created_at, username, username_key, password_hash, password_salt, password_iters, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(accountId, username, now, username, key, hash, salt, PBKDF2_ITERS, now)
      .run()
  } catch {
    // 并发注册同名：唯一索引先炸
    if (await accountByUsername(env, key)) {
      await noteAuthFail(env, regKey)
      return fail(409, 'username_taken', '这个用户名已被占用')
    }
    throw new Error('账号创建失败')
  }

  const bound = await bindDevice(env, accountId, deviceId, deviceName, secret)
  if (bound instanceof Response) {
    // 设备冲突：把刚建的账号收回，避免留下没有设备的空账号
    await env.DB.prepare('DELETE FROM accounts WHERE id = ?').bind(accountId).run()
    return bound
  }

  return json({ accountId, username, deviceId: bound.deviceId, secret: bound.secret })
}

/** 登录：校验密码，然后把当前设备挂到该账号（任意设备登录同一账号即同步） */
async function loginAccount(req: Request, env: Env): Promise<Response> {
  const body = await readJson(req)
  if (!body) return fail(400, 'bad_json', '请求体不是合法 JSON')

  const username = str(body.username).trim()
  const password = str(body.password)
  const deviceId = str(body.deviceId).trim()
  const secret = str(body.secret).trim()
  const deviceName = str(body.deviceName).trim() || '未命名设备'

  if (!username || !password) return fail(400, 'missing_fields', '请填写用户名和密码')
  const deviceError = checkDeviceId(deviceId)
  if (deviceError) return fail(400, 'invalid_device_id', deviceError)
  if (!isHex(secret, SECRET_HEX_LEN)) {
    return fail(400, 'invalid_secret', `secret 必须是 ${SECRET_HEX_LEN} 位 hex`)
  }

  const account = await accountByUsername(env, usernameKeyOf(username))
  const failKey = `login|${usernameKeyOf(username)}|${clientIp(req)}`
  const lockedFor = await authLockRemaining(env, failKey)
  if (lockedFor > 0) return authLocked(lockedFor)
  if (!account?.password_hash || !account.password_salt) {
    // 用户不存在 / 老账号没设密码：也花同样的时间，别让人从耗时里枚举用户名
    await burnPasswordCheck(password)
    await noteAuthFail(env, failKey)
    return fail(401, 'bad_credentials', '用户名或密码不正确')
  }
  const hash = await pbkdf2Hex(
    password,
    account.password_salt,
    account.password_iters ?? PBKDF2_ITERS
  )
  if (!timingSafeEqual(hash, account.password_hash)) {
    await noteAuthFail(env, failKey)
    return fail(401, 'bad_credentials', '用户名或密码不正确')
  }
  await clearAuthFails(env, failKey)

  const bound = await bindDevice(env, account.id, deviceId, deviceName, secret)
  if (bound instanceof Response) return bound

  // 设备之前挂在别的账号下时，服务端换了一把新钥匙，客户端要换成本地凭据
  return json({
    accountId: account.id,
    username: account.username ?? username,
    deviceId: bound.deviceId,
    secret: bound.secret
  })
}

/**
 * 认领：配对时代建的账号还没有用户名密码，用现有设备凭据设一次。
 * 只允许在没有凭据的账号上执行，避免被人用旧设备悄悄改掉密码。
 */
async function claimAccount(req: Request, env: Env, auth: AuthedDevice): Promise<Response> {
  const body = await readJson(req)
  if (!body) return fail(400, 'bad_json', '请求体不是合法 JSON')

  const username = str(body.username).trim()
  const password = str(body.password)
  const nameError = checkUsername(username)
  if (nameError) return fail(400, 'invalid_username', nameError)
  const passwordError = checkPassword(password)
  if (passwordError) return fail(400, 'weak_password', passwordError)

  const account = await accountById(env, auth.accountId)
  if (!account) return fail(404, 'account_missing', '账号不存在')
  if (account.password_hash) return fail(409, 'already_claimed', '这个账号已经有用户名密码了')

  const key = usernameKeyOf(username)
  const salt = randomHex(SALT_BYTES)
  const hash = await pbkdf2Hex(password, salt, PBKDF2_ITERS)
  try {
    await env.DB.prepare(
      `UPDATE accounts
          SET username = ?, username_key = ?, password_hash = ?, password_salt = ?, password_iters = ?, updated_at = ?
        WHERE id = ?`
    )
      .bind(username, key, hash, salt, PBKDF2_ITERS, Date.now(), auth.accountId)
      .run()
  } catch {
    if (await accountByUsername(env, key)) {
      return fail(409, 'username_taken', '这个用户名已被占用')
    }
    throw new Error('账号认领失败')
  }
  return json({ accountId: auth.accountId, username })
}

/** 当前账号信息：设置页用来显示“登录的是谁” */
async function accountInfo(env: Env, auth: AuthedDevice): Promise<Response> {
  const account = await accountById(env, auth.accountId)
  const device = await firstRow<{ name: string }>(
    env,
    'SELECT name FROM devices WHERE device_id = ?',
    auth.deviceId
  )
  return json({
    accountId: auth.accountId,
    username: account?.username ?? '',
    claimed: Boolean(account?.password_hash),
    deviceId: auth.deviceId,
    deviceName: device?.name ?? ''
  })
}

/** 退出登录：只撤销当前这台设备，别的设备不受影响 */
async function logoutDevice(env: Env, auth: AuthedDevice): Promise<Response> {
  await env.DB.prepare(`UPDATE devices SET status = 'revoked' WHERE device_id = ?`)
    .bind(auth.deviceId)
    .run()
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

/**
 * 撤销一台设备。
 *
 * 默认只标记 revoked（凭据立刻失效，但行还留着可追溯）；
 * 传 purge=true 就把这一行整个删掉 —— 客户端里"删除设备"就是这个意思：
 * 撤销 + 从列表里消失。行没了凭据自然也就查不到，照样 401。
 */
async function revokeDevice(req: Request, env: Env, auth: AuthedDevice): Promise<Response> {
  const body = await readJson(req)
  if (!body) return fail(400, 'bad_json', '请求体不是合法 JSON')
  const deviceId = str(body.deviceId).trim()
  const purge = body.purge === true
  if (!deviceId) return fail(400, 'missing_fields', '缺少 deviceId')
  if (deviceId === auth.deviceId) return fail(400, 'cannot_revoke_self', '不能吊销当前设备')

  const device = await firstRow<{ account_id: string }>(
    env,
    'SELECT account_id FROM devices WHERE device_id = ?',
    deviceId
  )
  if (!device || device.account_id !== auth.accountId) return fail(404, 'device_not_found', '设备不存在')

  if (purge) {
    await env.DB.prepare('DELETE FROM devices WHERE device_id = ?').bind(deviceId).run()
    return json({ ok: true, deleted: true })
  }
  await env.DB.prepare(`UPDATE devices SET status = 'revoked' WHERE device_id = ?`).bind(deviceId).run()
  return json({ ok: true, deleted: false })
}

/* ------------------------------ 同步 ------------------------------ */

/**
 * 账号里最新的 updated_at —— 也就是 /api/changes 的水位。
 *
 * 约定（也是下面 push / saveRow 要守住的）：**每一次被接受的写入，
 * updated_at 都必须严格大于写之前的这个值**。只有这样才能保证
 *   1) /api/changes 的水位只增不减，其它端一定能探到"有变化"；
 *   2) 其它端的拉取游标（= 它们上次看到的最大 updated_at）一定小于新写入，
 *      不会出现"写了但谁都拉不到"的行。
 * 客户端的钟可能是慢的（手机手动改过时间），所以 push 时要把时间戳抬到水位之上；
 * 值得庆幸的是这不会破坏 LWW：抬过的行本来就是"最新的一次写入"。
 */
async function maxUpdatedAt(env: Env, accountId: string): Promise<number> {
  const row = await firstRow<{ m: number | null }>(
    env,
    'SELECT MAX(updated_at) AS m FROM rows WHERE account_id = ?',
    accountId
  )
  const value = Number(row?.m ?? 0)
  return Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * 拉取：只回本账号的行，payload 原样（明文 JSON 字符串）返回，服务端不解析业务字段。
 *
 * 游标是 (updated_at, id) 复合游标，不是单独的 updated_at。
 * 只用 updated_at 的话，一页 200 行如果时间戳相同（批量导入、迁移、极快的连续写入），
 * 剩下的行因为 `updated_at > cursor` 永远拉不到 —— 实测 250 行同时间戳只拉到 200 行。
 */
async function pull(url: URL, env: Env, auth: AuthedDevice): Promise<Response> {
  const table = url.searchParams.get('table') ?? ''
  if (!ALLOWED_TABLES.has(table)) return fail(400, 'unknown_table', `未知集合：${table}`)

  const rawSince = Number(url.searchParams.get('since') ?? '0')
  const since = Number.isFinite(rawSince) ? Math.floor(rawSince) : 0
  const sinceId = (url.searchParams.get('sinceId') ?? '').slice(0, MAX_ROW_ID)
  const rawLimit = Number(url.searchParams.get('limit') ?? String(DEFAULT_LIMIT))
  const limit = Math.min(Math.max(1, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : DEFAULT_LIMIT), MAX_ROWS)

  const { results } = await env.DB.prepare(
    `SELECT id, updated_at, deleted_at, payload FROM rows
      WHERE tbl = ? AND account_id = ?
        AND (updated_at > ? OR (updated_at = ? AND id > ?))
      ORDER BY updated_at ASC, id ASC LIMIT ?`
  )
    .bind(table, auth.accountId, since, since, sinceId, limit)
    .all<{ id: string; updated_at: number; deleted_at: number | null; payload: string }>()

  const rows = (results ?? []).map((r) => ({
    id: r.id,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at ?? null,
    payload: r.payload
  }))
  const last = rows[rows.length - 1]
  return json({
    rows,
    // cursor/cursorId 是"本页最后一行"的位置；空页原样回传，客户端游标不会后退
    cursor: last ? last.updatedAt : since,
    cursorId: last ? last.id : sinceId
  })
}

/**
 * 写入一行同步数据。LWW 判定在代码里做（需要读旧行），冲突键是
 * (tbl, account_id, id)：不同账号用同一个行 id 也不会互相覆盖。
 *
 * 为什么不再只靠 SQL 的 `WHERE excluded.updated_at > rows.updated_at`：
 *  - 时间戳完全相等时旧实现是"先到的那条留在库里"，后到的设备既推不上去
 *    （守卫不放行）也拉不到（客户端导入也要求严格大于），两端永久分叉；
 *    现在按 origin_device 字典序定赢家（README 的规则），并把赢家的
 *    updated_at +1，让输家下一次拉取一定能看见并收敛；
 *  - 时间戳比账号水位小时，写入虽然成功，但 /api/changes 水位不动、
 *    别的端游标已经越过它 —— 那一行等于写了个寂寞。所以统一抬到水位之上。
 */
const UPSERT_SQL = `INSERT INTO rows (tbl, id, account_id, updated_at, deleted_at, payload, origin_device)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(tbl, account_id, id) DO UPDATE SET
    updated_at    = excluded.updated_at,
    deleted_at    = excluded.deleted_at,
    payload       = excluded.payload,
    origin_device = excluded.origin_device
  WHERE excluded.updated_at > rows.updated_at`

const BUMP_SQL = `UPDATE rows SET updated_at = ?
   WHERE tbl = ? AND account_id = ? AND id = ? AND updated_at = ?`

interface StoredRowMeta {
  id: string
  updated_at: number
  origin_device: string | null
}

/** 一次把本页要用到的旧行读出来。
 *  注意 D1 单条语句最多 100 个绑定参数，所以每 50 个 id 一条 SQL（2 个固定参数 + 50 个 id）。 */
async function loadRowMeta(
  env: Env,
  accountId: string,
  table: string,
  ids: string[]
): Promise<Map<string, StoredRowMeta>> {
  const out = new Map<string, StoredRowMeta>()
  const CHUNK = 50
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK)
    const placeholders = chunk.map(() => '?').join(', ')
    const { results } = await env.DB.prepare(
      `SELECT id, updated_at, origin_device FROM rows
        WHERE tbl = ? AND account_id = ? AND id IN (${placeholders})`
    )
      .bind(table, accountId, ...chunk)
      .all<StoredRowMeta>()
    for (const row of results ?? []) out.set(row.id, row)
  }
  return out
}

async function push(req: Request, env: Env, auth: AuthedDevice): Promise<Response> {
  const body = await readJson(req)
  if (!body) return fail(400, 'bad_json', '请求体不是合法 JSON')

  const table = str(body.table)
  if (!ALLOWED_TABLES.has(table)) return fail(400, 'unknown_table', `未知集合：${table}`)
  if (!Array.isArray(body.rows)) return fail(400, 'bad_rows', 'rows 必须是数组')
  if (body.rows.length > MAX_ROWS) return fail(400, 'too_many_rows', `单次最多推送 ${MAX_ROWS} 行`)

  const errors: string[] = []
  const incoming: Array<{ id: string; updatedAt: number; deletedAt: number | null; payload: string }> = []

  body.rows.forEach((value, index) => {
    const row = (value ?? {}) as Record<string, unknown>
    const id = str(row.id)
    const updatedAt = num(row.updatedAt)
    const payload = typeof row.payload === 'string' ? row.payload : null

    if (!id) {
      errors.push(`第 ${index + 1} 行缺少 id`)
      return
    }
    if (id.length > MAX_ROW_ID) {
      errors.push(`第 ${index + 1} 行 id 太长（最多 ${MAX_ROW_ID} 个字符）`)
      return
    }
    if (updatedAt === null || updatedAt <= 0) {
      errors.push(`第 ${index + 1} 行缺少 updatedAt`)
      return
    }
    if (payload === null) {
      errors.push(`第 ${index + 1} 行缺少 payload`)
      return
    }
    // 单行过大会让整批 D1 写入失败（而且是 500，客户端只能整批重试）；按行拒绝更有用
    if (new TextEncoder().encode(payload).length > MAX_PAYLOAD_BYTES) {
      errors.push(`第 ${index + 1} 行 payload 超过 ${Math.round(MAX_PAYLOAD_BYTES / 1024)}KB`)
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

    incoming.push({ id, updatedAt, deletedAt: num(row.deletedAt), payload })
  })

  if (incoming.length === 0) {
    return json({ written: 0, stale: 0, failed: errors.length, errors })
  }

  const accountId = auth.accountId
  const origin = auth.deviceId
  const base = await maxUpdatedAt(env, accountId)
  const stored = await loadRowMeta(env, accountId, table, incoming.map((r) => r.id))
  const upsert = env.DB.prepare(UPSERT_SQL)
  const bump = env.DB.prepare(BUMP_SQL)
  const stmts: D1PreparedStatement[] = []
  let stale = 0
  let accepted = 0

  for (const row of incoming) {
    const prev = stored.get(row.id)
    if (!prev) {
      // 新行：抬到水位之上，保证别的端一定能拉到
      const ts = Math.max(row.updatedAt, base + 1)
      stmts.push(upsert.bind(table, row.id, accountId, ts, row.deletedAt, row.payload, origin))
      accepted += 1
      continue
    }
    if (row.updatedAt > prev.updated_at) {
      const ts = Math.max(row.updatedAt, base + 1)
      stmts.push(upsert.bind(table, row.id, accountId, ts, row.deletedAt, row.payload, origin))
      accepted += 1
      continue
    }
    if (row.updatedAt === prev.updated_at) {
      // 平局：deviceId 字典序大者胜（README 的规则，两端算出同一个赢家）
      if (origin > (prev.origin_device ?? '')) {
        stmts.push(
          upsert.bind(table, row.id, accountId, prev.updated_at + 1, row.deletedAt, row.payload, origin)
        )
        accepted += 1
      } else if (origin === (prev.origin_device ?? '')) {
        /*
         * 同一台设备把同一版本又推了一遍（客户端重试 / 拉回来的行再次被导出）。
         * 这里必须什么都不做：如果也走"抬高赢家时间戳"那条路，
         * 每次同步都会 +1，水位无限增长，两端永远在追一个追不上的数字。
         */
      } else {
        // 库里那条赢：把它 +1，好让推失败的这一端下次拉取时能看见（否则永久分叉）
        stmts.push(bump.bind(prev.updated_at + 1, table, accountId, row.id, prev.updated_at))
        stale += 1
      }
      continue
    }
    // 比库里旧：乱序到达的旧数据，不覆盖
    stale += 1
  }

  let written = 0
  if (stmts.length > 0) {
    // 结果里没有意外就行；written 用"payload 真正落地的行数"，
    // 平局时把赢家时间戳 +1 的那条 bump 不算一次成功推送。
    await env.DB.batch(stmts)
    written = accepted
  }

  return json({ written, stale, failed: errors.length, errors })
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
/** 每个 REST handler 拿到的上下文。字段名与原 handleRest 的局部变量同名，函数体可以原样搬运。 */
interface RestCtx {
  req: Request
  url: URL
  env: Env
  accountId: string
}

type RestRun = (ctx: RestCtx) => Promise<Response>

/**
 * 一个 REST 端点 = 方法 + 路径 + 处理函数。
 * 加接口只往 REST_ROUTES 里加一行，不用再改一个 374 行的 if 链。
 */
interface RestRoute {
  method: string
  path: string
  run: RestRun
}

/** GET /api/changes */
async function restChanges({ req, url, env, accountId }: RestCtx): Promise<Response> {
  const token = await maxUpdatedAt(env, accountId)
  return json({ token, at: Date.now() })
}

/** GET /api/calendars */
async function restCalendarsList({ req, url, env, accountId }: RestCtx): Promise<Response> {
  const rows = (await loadTable(env, accountId, 'calendars')).filter((r) => !r.deletedAt)
  rows.sort((a, b) => Number(a.sort ?? 0) - Number(b.sort ?? 0))
  return json(rows.map((r) => ({ id: r.id, name: r.name, color: r.color, sort: r.sort })))
}

/** GET /api/cells */
async function restCellsList({ req, url, env, accountId }: RestCtx): Promise<Response> {
  const calendar = url.searchParams.get('calendar') ?? ''
  const from = url.searchParams.get('from') ?? ''
  const to = url.searchParams.get('to') ?? ''
  if (from && badDate(from)) return fail(400, 'bad_date', `from 不是合法日期：${from}`)
  if (to && badDate(to)) return fail(400, 'bad_date', `to 不是合法日期：${to}`)
  const rows = (await loadTable(env, accountId, 'day_cells')).filter(
    (r) =>
      !r.deletedAt &&
      (!calendar || r.calendarId === calendar) &&
      String(r.date) >= from &&
      String(r.date) <= to
  )
  return json(rows.map((r) => ({ date: r.date, text: r.text ?? '' })))
}

/** POST /api/cells/append */
async function restCellsAppend({ req, url, env, accountId }: RestCtx): Promise<Response> {
  const body = await readJson(req)
  if (!body) return fail(400, 'bad_json', '请求体不是合法 JSON')
  const calendar = String(body.calendar ?? '')
  const date = String(body.date ?? '')
  const text = String(body.text ?? '').trim()
  if (!calendar || !date || !text) return fail(400, 'missing_fields', '缺少 calendar/date/text')
  if (badDate(date)) return fail(400, 'bad_date', `date 不是合法日期：${date}`)
  if (/[\r\n]/.test(text)) return fail(400, 'single_line_only', '任务只能是单行')
  if (textTooLarge(text)) return fail(413, 'text_too_large', '这条任务太长了')
  const current = await readCell(env, accountId, calendar, date)
  const lines = splitLines(current)
  lines.push(text)
  const next = lines.join('\n')
  if (textTooLarge(next)) return fail(413, 'text_too_large', '这一天已经写满了，先删几行')
  await writeCell(env, accountId, calendar, date, next)
  return json({ text: next })
}

/** POST /api/cells/toggle */
async function restCellsToggle({ req, url, env, accountId }: RestCtx): Promise<Response> {
  const body = await readJson(req)
  if (!body) return fail(400, 'bad_json', '请求体不是合法 JSON')
  const calendar = String(body.calendar ?? '')
  const date = String(body.date ?? '')
  const index = Number(body.index)
  const done = bool(body.done)
  if (!calendar || !date) return fail(400, 'missing_fields', '缺少 calendar/date')
  if (badDate(date)) return fail(400, 'bad_date', `date 不是合法日期：${date}`)
  const lines = splitLines(await readCell(env, accountId, calendar, date))
  if (!Number.isInteger(index) || index < 0 || index >= lines.length) {
    return fail(400, 'bad_index', `行号 ${index} 超出范围`)
  }
  lines[index] = markDone(lines[index], done)
  const next = lines.join('\n')
  await writeCell(env, accountId, calendar, date, next)
  return json({ text: next })
}

/** POST /api/cells/remove-line */
async function restCellsRemoveLine({ req, url, env, accountId }: RestCtx): Promise<Response> {
  const body = await readJson(req)
  if (!body) return fail(400, 'bad_json', '请求体不是合法 JSON')
  const calendar = String(body.calendar ?? '')
  const date = String(body.date ?? '')
  const index = Number(body.index)
  if (!calendar || !date) return fail(400, 'missing_fields', '缺少 calendar/date')
  if (badDate(date)) return fail(400, 'bad_date', `date 不是合法日期：${date}`)
  const lines = splitLines(await readCell(env, accountId, calendar, date))
  if (!Number.isInteger(index) || index < 0 || index >= lines.length) {
    return fail(400, 'bad_index', `行号 ${index} 超出范围`)
  }
  lines.splice(index, 1)
  const next = lines.join('\n')
  await writeCell(env, accountId, calendar, date, next)
  return json({ text: next })
}

/** POST /api/cells/set */
async function restCellsSet({ req, url, env, accountId }: RestCtx): Promise<Response> {
  const body = await readJson(req)
  if (!body) return fail(400, 'bad_json', '请求体不是合法 JSON')
  const calendar = String(body.calendar ?? '')
  const date = String(body.date ?? '')
  const text = typeof body.text === 'string' ? body.text : ''
  if (!calendar || !date) return fail(400, 'missing_fields', '缺少 calendar/date')
  if (badDate(date)) return fail(400, 'bad_date', `date 不是合法日期：${date}`)
  if (textTooLarge(text)) return fail(413, 'text_too_large', '这一天已经写满了，先删几行')
  await writeCell(env, accountId, calendar, date, text)
  return json({ text })
}

/** GET /api/events */
async function restEventsList({ req, url, env, accountId }: RestCtx): Promise<Response> {
  const calendar = url.searchParams.get('calendar') ?? ''
  const from = url.searchParams.get('from') ?? ''
  const to = url.searchParams.get('to') ?? ''
  if (!from || !to) return fail(400, 'missing_fields', '缺少 from/to')
  if (badDate(from) || badDate(to)) return fail(400, 'bad_date', 'from/to 必须是 YYYY-MM-DD')
  return json(await listOccurrences(env, accountId, calendar, from, to))
}

/** POST /api/events/create */
async function restEventCreate({ req, url, env, accountId }: RestCtx): Promise<Response> {
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
  if (!row.calendarId || !row.title || !row.start) {
    return fail(400, 'missing_fields', '缺少 calendar/title/start')
  }
  // 以前不校验日期：写进去一条 start='not-a-date' 的事件，展开器直接返回空，
  // 用户在列表里再也找不到它（不是隐藏，是"写了但永远看不见"）。
  if (badDate(row.start)) return fail(400, 'bad_date', `start 必须是 YYYY-MM-DD：${row.start}`)
  if (row.targetDate && badDate(row.targetDate)) {
    return fail(400, 'bad_date', `targetDate 必须是 YYYY-MM-DD：${row.targetDate}`)
  }
  if (row.title.length > 200) return fail(400, 'title_too_long', '标题太长（最多 200 字）')
  await saveRow(env, accountId, 'events', row)
  return json({ id: row.id })
}

/** POST /api/events/delete */
async function restEventDelete({ req, url, env, accountId }: RestCtx): Promise<Response> {
  const body = await readJson(req)
  if (!body) return fail(400, 'bad_json', '请求体不是合法 JSON')
  const id = String(body.id ?? '')
  if (!id) return fail(400, 'missing_fields', '缺少 id')
  const rows = await loadTable(env, accountId, 'events')
  const hit = rows.find((r) => r.id === id)
  if (!hit || hit.deletedAt) return fail(404, 'not_found', '事件不存在')
  await saveRow(env, accountId, 'events', { ...hit, deletedAt: Date.now(), updatedAt: Date.now() })
  return json({ ok: true })
}

/** POST /api/events/restore */
async function restEventRestore({ req, url, env, accountId }: RestCtx): Promise<Response> {
  const body = await readJson(req)
  if (!body) return fail(400, 'bad_json', '请求体不是合法 JSON')
  const id = String(body.id ?? '')
  if (!id) return fail(400, 'missing_fields', '缺少 id')
  const rows = await loadTable(env, accountId, 'events')
  const hit = rows.find((r) => r.id === id)
  if (!hit) return fail(404, 'not_found', '事件不存在')
  await saveRow(env, accountId, 'events', { ...hit, deletedAt: null, updatedAt: Date.now() })
  return json({ ok: true })
}

/** POST /api/events/toggle */
async function restEventToggle({ req, url, env, accountId }: RestCtx): Promise<Response> {
  const body = await readJson(req)
  if (!body) return fail(400, 'bad_json', '请求体不是合法 JSON')
  const eventId = String(body.id ?? '')
  const date = String(body.date ?? '')
  const done = bool(body.done)
  // 以前什么都不校验：id/date 都缺的时候会写进一行 id 为 ":" 的垃圾数据，
  // 列表里没有对应事件、也没法删，纯脏数据。
  if (!eventId || !date) return fail(400, 'missing_fields', '缺少 id/date')
  if (badDate(date)) return fail(400, 'bad_date', `date 不是合法日期：${date}`)
  await saveRow(env, accountId, 'event_done', {
    id: `${eventId}:${date}`,
    eventId,
    occurrenceDate: date,
    updatedAt: Date.now(),
    deletedAt: done ? null : Date.now()
  })
  return json({ ok: true, done })
}

/** POST /api/events/skip */
async function restEventSkip({ req, url, env, accountId }: RestCtx): Promise<Response> {
  const body = await readJson(req)
  if (!body) return fail(400, 'bad_json', '请求体不是合法 JSON')
  const eventId = String(body.id ?? '')
  const date = String(body.date ?? '')
  if (!eventId || !date) return fail(400, 'missing_fields', '缺少 id/date')
  if (badDate(date)) return fail(400, 'bad_date', `date 不是合法日期：${date}`)
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

/** POST /api/events/unskip */
async function restEventUnskip({ req, url, env, accountId }: RestCtx): Promise<Response> {
  const body = await readJson(req)
  if (!body) return fail(400, 'bad_json', '请求体不是合法 JSON')
  const eventId = String(body.id ?? '')
  const date = String(body.date ?? '')
  if (!eventId || !date) return fail(400, 'missing_fields', '缺少 id/date')
  if (badDate(date)) return fail(400, 'bad_date', `date 不是合法日期：${date}`)
  const id = `${eventId}:${date}`
  const rows = await loadTable(env, accountId, 'event_skip')
  const hit = rows.find((r) => r.id === id)
  if (hit) {
    await saveRow(env, accountId, 'event_skip', { ...hit, deletedAt: Date.now(), updatedAt: Date.now() })
  }
  return json({ ok: true })
}

/** GET /api/notes */
async function restNotesList({ req, url, env, accountId }: RestCtx): Promise<Response> {
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

/** POST /api/notes/save */
async function restNotesSave({ req, url, env, accountId }: RestCtx): Promise<Response> {
  const body = await readJson(req)
  if (!body) return fail(400, 'bad_json', '请求体不是合法 JSON')
  const now = Date.now()
  const id = body.id ? String(body.id) : `note:${crypto.randomUUID()}`
  if (id.length > MAX_ROW_ID) return fail(400, 'bad_id', 'id 太长')
  const title = String(body.title ?? '').trim()
  const content = String(body.content ?? '')
  if (title.length > 200) return fail(400, 'title_too_long', '标题太长（最多 200 字）')
  if (textTooLarge(content)) return fail(413, 'text_too_large', '便签内容太长')
  const existing = (await loadTable(env, accountId, 'notes')).find((r) => r.id === id)
  const row: RestRow = {
    id,
    calendarId: String(body.calendarId ?? existing?.calendarId ?? ''),
    title: body.title !== undefined ? title : String(existing?.title ?? ''),
    content: body.content !== undefined ? content : String(existing?.content ?? ''),
    pinned: body.pinned !== undefined ? bool(body.pinned) : Boolean(existing?.pinned),
    color: null,
    createdAt: Number(existing?.createdAt ?? now),
    updatedAt: now,
    deletedAt: null
  }
  await saveRow(env, accountId, 'notes', row)
  return json({ id, title: row.title, content: row.content })
}

/** POST /api/notes/delete */
async function restNotesDelete({ req, url, env, accountId }: RestCtx): Promise<Response> {
  const body = await readJson(req)
  if (!body) return fail(400, 'bad_json', '请求体不是合法 JSON')
  const id = String(body.id ?? '')
  if (!id) return fail(400, 'missing_fields', '缺少 id')
  const hit = (await loadTable(env, accountId, 'notes')).find((r) => r.id === id && !r.deletedAt)
  if (!hit) return fail(404, 'not_found', '便签不存在')
  await saveRow(env, accountId, 'notes', { ...hit, deletedAt: Date.now(), updatedAt: Date.now() })
  return json({ ok: true })
}

/** GET /api/notes/get */
async function restNotesGet({ req, url, env, accountId }: RestCtx): Promise<Response> {
  const id = url.searchParams.get('id') ?? ''
  if (!id) return fail(400, 'missing_fields', '缺少 id')
  const hit = (await loadTable(env, accountId, 'notes')).find((r) => r.id === id && !r.deletedAt)
  if (!hit) return fail(404, 'not_found', '便签不存在')
  return json({ id: hit.id, title: hit.title ?? '', content: hit.content ?? '' })
}

/** POST /api/calendars/create */
async function restCalendarCreate({ req, url, env, accountId }: RestCtx): Promise<Response> {
  const body = await readJson(req)
  if (!body) return fail(400, 'bad_json', '请求体不是合法 JSON')
  const name = String(body.name ?? '').trim()
  if (!name) return fail(400, 'missing_name', '名称不能为空')
  if (name.length > 64) return fail(400, 'name_too_long', '名称太长（最多 64 字）')
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
  // 直接把新列表带回去：手机端一次往返就能画完，不用再 GET 一遍
  const after = (await loadTable(env, accountId, 'calendars'))
    .filter((r) => !r.deletedAt)
    .sort((a, b) => Number(a.sort ?? 0) - Number(b.sort ?? 0))
  return json({
    created: { id: row.id, name: row.name, color: row.color },
    calendars: after.map((r) => ({ id: r.id, name: r.name, color: r.color, sort: r.sort }))
  })
}

/** POST /api/calendars/delete */
async function restCalendarDelete({ req, url, env, accountId }: RestCtx): Promise<Response> {
  const body = await readJson(req)
  if (!body) return fail(400, 'bad_json', '请求体不是合法 JSON')
  const id = String(body.id ?? '')
  if (!id) return fail(400, 'missing_fields', '缺少 id')
  const rows = (await loadTable(env, accountId, 'calendars')).filter((r) => !r.deletedAt)
  if (rows.length <= 1) return fail(400, 'need_one_calendar', '至少保留一个视图')
  const hit = rows.find((r) => r.id === id)
  if (!hit) return fail(404, 'not_found', '视图不存在')
  await saveRow(env, accountId, 'calendars', { ...hit, deletedAt: Date.now(), updatedAt: Date.now() })
  const after = (await loadTable(env, accountId, 'calendars'))
    .filter((r) => !r.deletedAt)
    .sort((a, b) => Number(a.sort ?? 0) - Number(b.sort ?? 0))
  return json({
    ok: true,
    calendars: after.map((r) => ({ id: r.id, name: r.name, color: r.color, sort: r.sort }))
  })
}

/** GET /api/search */
async function restSearch({ req, url, env, accountId }: RestCtx): Promise<Response> {
  const q = (url.searchParams.get('q') ?? '').trim().toLowerCase()
  if (!q) return json([])
  if (q.length > 200) return fail(400, 'query_too_long', '搜索词太长')
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

/** REST 路由表（顺序无关，查找按 method + path 精确匹配） */
const REST_ROUTES: RestRoute[] = [
  { method: 'GET', path: '/api/changes', run: restChanges },
  { method: 'GET', path: '/api/calendars', run: restCalendarsList },
  { method: 'GET', path: '/api/cells', run: restCellsList },
  { method: 'POST', path: '/api/cells/append', run: restCellsAppend },
  { method: 'POST', path: '/api/cells/toggle', run: restCellsToggle },
  { method: 'POST', path: '/api/cells/remove-line', run: restCellsRemoveLine },
  { method: 'POST', path: '/api/cells/set', run: restCellsSet },
  { method: 'GET', path: '/api/events', run: restEventsList },
  { method: 'POST', path: '/api/events/create', run: restEventCreate },
  { method: 'POST', path: '/api/events/delete', run: restEventDelete },
  { method: 'POST', path: '/api/events/restore', run: restEventRestore },
  { method: 'POST', path: '/api/events/toggle', run: restEventToggle },
  { method: 'POST', path: '/api/events/skip', run: restEventSkip },
  { method: 'POST', path: '/api/events/unskip', run: restEventUnskip },
  { method: 'GET', path: '/api/notes', run: restNotesList },
  { method: 'POST', path: '/api/notes/save', run: restNotesSave },
  { method: 'POST', path: '/api/notes/delete', run: restNotesDelete },
  { method: 'GET', path: '/api/notes/get', run: restNotesGet },
  { method: 'POST', path: '/api/calendars/create', run: restCalendarCreate },
  { method: 'POST', path: '/api/calendars/delete', run: restCalendarDelete },
  { method: 'GET', path: '/api/search', run: restSearch },
]

/**
 * REST 分发。所有 /api/* 端点都要求设备凭据，并且一律按 auth.accountId 过滤/写入
 * —— 账号隔离的第二道闸门。
 */
async function handleRest(req: Request, url: URL, env: Env, auth: AuthedDevice): Promise<Response> {
  const route = REST_ROUTES.find((r) => r.path === url.pathname && r.method === req.method)
  if (!route) return fail(404, 'not_found', `未知接口：${req.method} ${url.pathname}`)
  return route.run({ req, url, env, accountId: auth.accountId })
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

/**
 * 写本账号的一行：payload 存整行的明文 JSON，LWW 冲突守卫见上面 UPSERT_SQL 的注释。
 *
 * REST 是"用户刚刚在手机上点了"的写入，必须落地，所以这里：
 *  - 时间戳取 max(调用方给的, 账号水位 + 1)：保证水位单调、别的端拉得到；
 *  - 不做 `updated_at >` 守卫：同一毫秒内的两次点击（append 完立刻 toggle）
 *    以前会被守卫静默吞掉，接口还回了 200，用户看到的是"改了没生效"。
 */
async function saveRow(env: Env, accountId: string, table: string, row: RestRow): Promise<void> {
  const updatedAt = Math.max(row.updatedAt, (await maxUpdatedAt(env, accountId)) + 1)
  const payload = JSON.stringify({ ...row, updatedAt })
  await env.DB.prepare(
    `INSERT INTO rows (tbl, id, account_id, updated_at, deleted_at, payload, origin_device)
     VALUES (?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(tbl, account_id, id) DO UPDATE SET
       updated_at    = excluded.updated_at,
       deleted_at    = excluded.deleted_at,
       payload       = excluded.payload`
  )
    .bind(
      table,
      row.id,
      accountId,
      updatedAt,
      typeof row.deletedAt === 'number' ? row.deletedAt : null,
      payload
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
  /*
   * 这里必须把 event_skip 也读出来。
   *
   * 以前只读 events + event_done，「仅删除重复的这一天」写进去的 skip 行
   * 全服务端没人看 —— 手机上删掉当天那一条，刷新就回来了。
   * 桌面端的 listOccurrences 一直有这段过滤，worker 漏了。
   */
  const [events, dones, skips] = await Promise.all([
    loadTable(env, accountId, 'events'),
    loadTable(env, accountId, 'event_done'),
    loadTable(env, accountId, 'event_skip')
  ])
  const doneSet = new Set(dones.filter((d) => !d.deletedAt).map((d) => String(d.id)))
  const skipSet = new Set(skips.filter((s) => !s.deletedAt).map((s) => String(s.id)))
  const out: Array<{ event: RestRow; date: string; done: boolean }> = []
  for (const event of events) {
    if (event.deletedAt) continue
    if (calendarId && event.calendarId !== calendarId) continue
    for (const date of expandEvent(event, from, to)) {
      // 这一天被单独跳过（仅删本次）就不列出来
      if (skipSet.has(`${event.id}:${date}`)) continue
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
