/**
 * 手机端测试用的「假 Worker」：实现 caldesk 手机端用到的 REST 子集。
 *
 * 和真 Worker（worker/src/index.ts）保持同一套协议：
 *   POST /auth/{register,login,logout}  GET /auth/me
 *   GET  /devices  POST /devices/revoke
 *   GET  /api/changes
 *   GET  /api/calendars  POST /api/calendars/{create,delete}
 *   GET  /api/cells      POST /api/cells/{append,toggle,remove-line,set}
 *   GET  /api/events     POST /api/events/{create,delete,toggle,skip,unskip}
 *
 * 额外的控制面（只用于测试，真 Worker 没有）：
 *   POST /__mock/reset        清空全部状态
 *   POST /__mock/seed         直接铺数据（账号 / 日历 / 日格 / 事件）
 *   POST /__mock/config       注入延迟、失败、乱序
 *   GET  /__mock/state        回读服务器当前数据（断言用）
 *   GET  /__mock/log          请求日志（断言请求次数用）
 *
 * 不写任何真实用户数据，也不访问网络。
 */
import { createServer } from 'node:http'

const PORT = Number(process.env.MOCK_PORT ?? 8788)

/* ------------------------------ 状态 ------------------------------ */

/** accountId → { username, password, devices: Map<deviceId, dev>, data: {...} } */
const accounts = new Map()
/** deviceId → { secret, accountId } */
const deviceIndex = new Map()
/** 请求日志 */
let log = []
/** 运行时注入 */
function freshCfg() {
  return {
    /** 所有 /api/* 的固定延迟（毫秒）。数字 = 全部；对象 = 按路径前缀 */
    delayMs: 0,
    delayByPath: {},
    /** 下一次 /api/* 请求直接失败（模拟断网/500），用完即清 */
    failNext: 0,
    /** 全局断网 */
    offline: false,
    /** 指定路径按顺序返回的延迟（用于构造乱序响应） */
    delayQueue: [],
    /** 只作用于 /api/cells 的延迟队列：一次一条，用来构造「旧响应比新响应晚到」 */
    cellDelayQueue: []
  }
}
let cfg = freshCfg()

const now = () => Date.now()

function emptyData() {
  return {
    calendars: [],
    /** `${calId}\u0000${date}` → text */
    cells: new Map(),
    events: [],
    /** `${eventId}:${date}` */
    done: new Set(),
    skip: new Set(),
    token: 1
  }
}

function bump(acc) {
  acc.data.token = now()
  return acc.data.token
}

function reset() {
  accounts.clear()
  deviceIndex.clear()
  log = []
  cfg = freshCfg()
}

/* ------------------------------ 工具 ------------------------------ */

function send(res, status, body, extra = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type, x-device-name',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'cache-control': 'no-store',
    ...extra
  })
  res.end(text)
}

function fail(res, status, message) {
  send(res, status, { message })
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** Bearer deviceId.secret → 账号（和真 Worker 同一套鉴权形态） */
function authOf(req) {
  const h = req.headers['authorization'] ?? ''
  const m = /^Bearer\s+(.+?)\.(.+)$/.exec(h)
  if (!m) return null
  const [, deviceId, secret] = m
  const hit = deviceIndex.get(deviceId)
  if (!hit || hit.secret !== secret) return null
  return { deviceId, accountId: hit.accountId }
}

function viewOf(auth) {
  const acc = accounts.get(auth.accountId)
  return acc?.data ?? null
}

/* ------------------------------ 重复规则展开 ------------------------------ */

const DAY_MS = 86400000
const WEEKDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

function isoToParts(iso) {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return { y, m, d }
}
function partsToIso(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}
function isoDay(iso) {
  const { y, m, d } = isoToParts(iso)
  return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS)
}
function dayIso(n) {
  const dt = new Date(n * DAY_MS)
  return partsToIso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate())
}
function weekdayIso(iso) {
  return WEEKDAY[new Date(`${iso}T00:00:00Z`).getUTCDay()]
}
function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/** 事件在 [from,to] 区间内的展开（够测试用：daily / weekly[BYDAY] / monthly / yearly） */
function occurrences(ev, from, to, data) {
  const start = String(ev.start ?? '').slice(0, 10)
  if (!start || Number.isNaN(isoDay(start))) return []
  const out = []
  const push = (iso) => {
    if (iso < from || iso > to) return
    const key = `${ev.id}:${iso}`
    if (data.skip.has(key)) return
    out.push({
      date: iso,
      done: data.done.has(key),
      event: { ...ev }
    })
  }
  if (!ev.rrule) {
    push(start)
    return out
  }
  const first = Math.max(isoDay(from), isoDay(start))
  const last = isoDay(to)
  const { y, m, d } = isoToParts(start)
  const byday = /BYDAY=([A-Z,]+)/.exec(ev.rrule)?.[1]?.split(',') ?? null
  for (let n = first; n <= last; n += 1) {
    const iso = dayIso(n)
    if (ev.rrule.includes('FREQ=DAILY')) {
      push(iso)
    } else if (ev.rrule.includes('FREQ=WEEKLY')) {
      if (!byday) {
        // 无 BYDAY 时按 start 的星期数
        if (weekdayIso(iso) === weekdayIso(start)) push(iso)
      } else if (byday.includes(weekdayIso(iso))) {
        push(iso)
      }
    } else if (ev.rrule.includes('FREQ=MONTHLY')) {
      const p = isoToParts(iso)
      if (p.d === Math.min(d, daysInMonth(p.y, p.m))) push(iso)
    } else if (ev.rrule.includes('FREQ=YEARLY')) {
      const p = isoToParts(iso)
      if (p.m === m && p.d === d) push(iso)
    }
  }
  return out
}

/* ------------------------------ 账号 ------------------------------ */

function ensureAccount(username, password) {
  const id = `acc-${username}`
  if (!accounts.has(id)) {
    accounts.set(id, { id, username, password, devices: new Map(), data: emptyData() })
  }
  return accounts.get(id)
}

function bindDevice(acc, deviceId, secret, deviceName) {
  deviceIndex.set(deviceId, { secret, accountId: acc.id })
  const dev = acc.devices.get(deviceId) ?? {
    deviceId,
    name: deviceName || 'unknown',
    status: 'approved',
    createdAt: now()
  }
  dev.lastSeenAt = now()
  acc.devices.set(deviceId, dev)
}

/* ------------------------------ 数据读写 ------------------------------ */

function cellKey(cal, date) {
  return `${cal}\u0000${date}`
}
function readCell(data, cal, date) {
  return data.cells.get(cellKey(cal, date)) ?? ''
}
function writeCell(data, cal, date, text) {
  if (!text) data.cells.delete(cellKey(cal, date))
  else data.cells.set(cellKey(cal, date), text)
}

/* ------------------------------ 路由 ------------------------------ */

function seed(body) {
  const acc = ensureAccount(body.username ?? 'demo', body.password ?? 'Passw0rd!')
  for (const d of body.devices ?? []) {
    bindDevice(acc, d.deviceId, d.secret, d.name)
    if (d.status) acc.devices.get(d.deviceId).status = d.status
  }
  const d = acc.data
  if (body.calendars) d.calendars = body.calendars.map((c, i) => ({ sort: i, ...c }))
  for (const c of body.cells ?? []) writeCell(d, c.calendarId, c.date, c.text)
  for (const e of body.events ?? []) {
    d.events.push({
      kind: 'task',
      notes: null,
      allDay: true,
      end: null,
      remindMinutes: null,
      targetDate: null,
      color: null,
      completed: false,
      createdAt: now(),
      updatedAt: now(),
      deletedAt: null,
      ...e
    })
  }
  bump(acc)
  return { accountId: acc.id, calendarIds: d.calendars.map((c) => c.id) }
}

async function handleMock(req, res, url) {
  if (url.pathname === '/__mock/reset' && req.method === 'POST') {
    reset()
    return send(res, 200, { ok: true })
  }
  if (url.pathname === '/__mock/config' && req.method === 'POST') {
    const body = (await readBody(req)) ?? {}
    cfg = { ...cfg, ...body }
    return send(res, 200, { ok: true, cfg })
  }
  if (url.pathname === '/__mock/seed' && req.method === 'POST') {
    const body = (await readBody(req)) ?? {}
    return send(res, 200, seed(body))
  }
  if (url.pathname === '/__mock/state' && req.method === 'GET') {
    const out = {}
    for (const [id, acc] of accounts) {
      out[id] = {
        username: acc.username,
        calendars: acc.data.calendars,
        cells: Object.fromEntries(
          [...acc.data.cells].map(([k, v]) => [k.replace('\u0000', '@'), v])
        ),
        events: acc.data.events,
        done: [...acc.data.done],
        skip: [...acc.data.skip],
        token: acc.data.token,
        devices: [...acc.devices.values()]
      }
    }
    return send(res, 200, out)
  }
  if (url.pathname === '/__mock/log' && req.method === 'GET') {
    return send(res, 200, log)
  }
  if (url.pathname === '/__mock/log' && req.method === 'DELETE') {
    log = []
    return send(res, 200, { ok: true })
  }
  return send(res, 404, { message: 'no such mock endpoint' })
}

async function handle(req, res, url) {
  if (req.method === 'OPTIONS') return send(res, 204, '')
  if (url.pathname.startsWith('/__mock/')) return handleMock(req, res, url)

  log.push({ path: url.pathname, q: url.search, at: now() })

  if (url.pathname === '/health') return send(res, 200, { ok: true, ts: now() })

  /* 注入的故障 / 延迟 */
  if (cfg.offline) return fail(res, 503, '服务器不可用（测试注入）')
  if (cfg.failNext > 0) {
    cfg.failNext -= 1
    return fail(res, 500, '服务器错误（测试注入）')
  }
  const qdelay =
    url.pathname === '/api/cells' ? cfg.cellDelayQueue.shift() : cfg.delayQueue.shift()
  const perPath = Object.entries(cfg.delayByPath ?? {}).find(([p]) => url.pathname.startsWith(p))
  const delay = Number(qdelay ?? perPath?.[1] ?? cfg.delayMs ?? 0)
  if (delay > 0) await new Promise((r) => setTimeout(r, delay))

  /* ---- 账号 ---- */
  if (url.pathname === '/auth/register' && req.method === 'POST') {
    const body = await readBody(req)
    if (!body) return fail(res, 400, '请求体不是合法 JSON')
    const username = String(body.username ?? '').trim()
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return fail(res, 400, '用户名只能是 3-20 位字母数字下划线')
    if (accounts.has(`acc-${username}`)) return fail(res, 409, '这个用户名已经被占用了')
    const acc = ensureAccount(username, String(body.password ?? ''))
    bindDevice(acc, String(body.deviceId), String(body.secret), String(body.deviceName ?? ''))
    return send(res, 200, { accountId: acc.id, username: acc.username, deviceId: body.deviceId, secret: body.secret })
  }

  if (url.pathname === '/auth/login' && req.method === 'POST') {
    const body = await readBody(req)
    if (!body) return fail(res, 400, '请求体不是合法 JSON')
    const username = String(body.username ?? '').trim()
    const acc = accounts.get(`acc-${username}`)
    if (!acc || acc.password !== String(body.password ?? '')) return fail(res, 401, '用户名或密码不对')
    bindDevice(acc, String(body.deviceId), String(body.secret), String(body.deviceName ?? ''))
    return send(res, 200, { accountId: acc.id, username: acc.username, deviceId: body.deviceId, secret: body.secret })
  }

  const auth = authOf(req)
  if (!auth) return fail(res, 401, '设备未授权')

  if (url.pathname === '/auth/logout' && req.method === 'POST') return send(res, 200, { ok: true })
  if (url.pathname === '/auth/me' && req.method === 'GET') {
    const acc = accounts.get(auth.accountId)
    return send(res, 200, {
      accountId: auth.accountId,
      username: acc?.username ?? '',
      claimed: true,
      deviceId: auth.deviceId,
      deviceName: acc?.devices.get(auth.deviceId)?.name ?? ''
    })
  }
  if (url.pathname === '/devices' && req.method === 'GET') {
    const acc = accounts.get(auth.accountId)
    return send(res, 200, {
      devices: [...(acc?.devices.values() ?? [])].map((d) => ({
        ...d,
        current: d.deviceId === auth.deviceId
      }))
    })
  }
  if (url.pathname === '/devices/revoke' && req.method === 'POST') {
    const body = await readBody(req)
    const acc = accounts.get(auth.accountId)
    acc?.devices.delete(String(body?.deviceId ?? ''))
    return send(res, 200, { ok: true })
  }

  const data = viewOf(auth)
  if (!data) return fail(res, 401, '设备未授权')

  if (url.pathname === '/api/changes') return send(res, 200, { token: data.token, at: now() })

  if (url.pathname === '/api/calendars' && req.method === 'GET') {
    return send(
      res,
      200,
      data.calendars
        .slice()
        .sort((a, b) => a.sort - b.sort)
        .map((c) => ({ id: c.id, name: c.name, color: c.color, sort: c.sort }))
    )
  }
  if (url.pathname === '/api/calendars/create' && req.method === 'POST') {
    const body = await readBody(req)
    const created = {
      id: `cal:${crypto.randomUUID()}`,
      name: String(body?.name ?? '新日历'),
      color: body?.color ?? '#7c8cff',
      sort: data.calendars.length,
      createdAt: now(),
      updatedAt: now(),
      deletedAt: null
    }
    data.calendars.push(created)
    bump(accounts.get(auth.accountId))
    return send(res, 200, { created, calendars: data.calendars })
  }
  if (url.pathname === '/api/calendars/delete' && req.method === 'POST') {
    const body = await readBody(req)
    const id = String(body?.id ?? '')
    data.calendars = data.calendars.filter((c) => c.id !== id)
    bump(accounts.get(auth.accountId))
    return send(res, 200, { ok: true, calendars: data.calendars })
  }

  if (url.pathname === '/api/cells' && req.method === 'GET') {
    const cal = url.searchParams.get('calendar') ?? ''
    const from = url.searchParams.get('from') ?? ''
    const to = url.searchParams.get('to') ?? ''
    const rows = []
    for (const [k, text] of data.cells) {
      const [c, date] = k.split('\u0000')
      if (cal && c !== cal) continue
      if (date < from || date > to) continue
      rows.push({ date, text })
    }
    rows.sort((a, b) => (a.date < b.date ? -1 : 1))
    return send(res, 200, rows)
  }
  if (url.pathname === '/api/cells/append' && req.method === 'POST') {
    const body = await readBody(req)
    const cal = String(body?.calendar ?? '')
    const date = String(body?.date ?? '')
    const text = String(body?.text ?? '').trim()
    if (!cal || !date || !text) return fail(res, 400, '0：缺少 calendar/date/text')
    const lines = readCell(data, cal, date) ? readCell(data, cal, date).split(/\r?\n/) : []
    lines.push(text)
    const next = lines.join('\n')
    writeCell(data, cal, date, next)
    bump(accounts.get(auth.accountId))
    return send(res, 200, { text: next })
  }
  if (url.pathname === '/api/cells/toggle' && req.method === 'POST') {
    const body = await readBody(req)
    const cal = String(body?.calendar ?? '')
    const date = String(body?.date ?? '')
    const index = Number(body?.index)
    const done = Boolean(body?.done)
    const cur = readCell(data, cal, date)
    const lines = cur ? cur.split(/\r?\n/) : []
    if (!Number.isInteger(index) || index < 0 || index >= lines.length) {
      return fail(res, 400, `行号 ${index} 超出范围`)
    }
    const plain = lines[index].trim().replace(/^~~/, '').replace(/~~$/, '')
    lines[index] = done ? `~~${plain}~~` : plain
    const next = lines.join('\n')
    writeCell(data, cal, date, next)
    bump(accounts.get(auth.accountId))
    return send(res, 200, { text: next })
  }
  if (url.pathname === '/api/cells/remove-line' && req.method === 'POST') {
    const body = await readBody(req)
    const cal = String(body?.calendar ?? '')
    const date = String(body?.date ?? '')
    const index = Number(body?.index)
    const cur = readCell(data, cal, date)
    const lines = cur ? cur.split(/\r?\n/) : []
    if (!Number.isInteger(index) || index < 0 || index >= lines.length) {
      return fail(res, 400, `行号 ${index} 超出范围`)
    }
    lines.splice(index, 1)
    const next = lines.join('\n')
    writeCell(data, cal, date, next)
    bump(accounts.get(auth.accountId))
    return send(res, 200, { text: next })
  }
  if (url.pathname === '/api/cells/set' && req.method === 'POST') {
    const body = await readBody(req)
    writeCell(data, String(body?.calendar ?? ''), String(body?.date ?? ''), String(body?.text ?? ''))
    bump(accounts.get(auth.accountId))
    return send(res, 200, { text: String(body?.text ?? '') })
  }

  if (url.pathname === '/api/events' && req.method === 'GET') {
    const cal = url.searchParams.get('calendar') ?? ''
    const from = url.searchParams.get('from') ?? ''
    const to = url.searchParams.get('to') ?? ''
    const out = []
    for (const ev of data.events) {
      if (ev.deletedAt) continue
      if (cal && ev.calendarId !== cal) continue
      out.push(...occurrences(ev, from, to, data))
    }
    out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    return send(res, 200, out)
  }
  if (url.pathname === '/api/events/create' && req.method === 'POST') {
    const body = await readBody(req)
    const row = {
      id: `evt:${crypto.randomUUID()}`,
      calendarId: String(body?.calendar ?? ''),
      kind: String(body?.kind ?? 'task'),
      title: String(body?.title ?? '').trim(),
      notes: null,
      allDay: true,
      start: String(body?.start ?? ''),
      end: null,
      rrule: body?.rrule ? String(body.rrule) : null,
      remindMinutes: null,
      targetDate: body?.targetDate ? String(body.targetDate) : null,
      color: null,
      completed: false,
      createdAt: now(),
      updatedAt: now(),
      deletedAt: null
    }
    if (!row.title || !row.start) return fail(res, 400, '缺少 title/start')
    data.events.push(row)
    bump(accounts.get(auth.accountId))
    return send(res, 200, { id: row.id })
  }
  if (url.pathname === '/api/events/delete' && req.method === 'POST') {
    const body = await readBody(req)
    const hit = data.events.find((e) => e.id === String(body?.id ?? ''))
    if (!hit) return fail(res, 404, '事件不存在')
    hit.deletedAt = now()
    bump(accounts.get(auth.accountId))
    return send(res, 200, { ok: true })
  }
  if (url.pathname === '/api/events/update' && req.method === 'POST') {
    const body = await readBody(req)
    const hit = data.events.find((e) => e.id === String(body?.id ?? ''))
    if (!hit) return fail(res, 404, '事件不存在')
    if (body.rrule !== undefined) hit.rrule = body.rrule ? String(body.rrule) : null
    hit.updatedAt = now()
    bump(accounts.get(auth.accountId))
    return send(res, 200, { ok: true })
  }
  if (url.pathname === '/api/events/toggle' && req.method === 'POST') {
    const body = await readBody(req)
    const key = `${String(body?.id ?? '')}:${String(body?.date ?? '')}`
    if (body?.done) data.done.add(key)
    else data.done.delete(key)
    bump(accounts.get(auth.accountId))
    return send(res, 200, { ok: true, done: Boolean(body?.done) })
  }
  if (url.pathname === '/api/events/skip' && req.method === 'POST') {
    const body = await readBody(req)
    data.skip.add(`${String(body?.id ?? '')}:${String(body?.date ?? '')}`)
    bump(accounts.get(auth.accountId))
    return send(res, 200, { ok: true })
  }
  if (url.pathname === '/api/events/unskip' && req.method === 'POST') {
    const body = await readBody(req)
    data.skip.delete(`${String(body?.id ?? '')}:${String(body?.date ?? '')}`)
    bump(accounts.get(auth.accountId))
    return send(res, 200, { ok: true })
  }

  return fail(res, 404, `没有这个接口：${url.pathname}`)
}

export function startMock({ port = PORT } = {}) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
      handle(req, res, url).catch((err) => {
        console.error('[mock] 处理失败', err)
        try {
          fail(res, 500, String(err?.message ?? err))
        } catch {
          /* 已经发过响应 */
        }
      })
    })
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address()
      resolve({
        port: Number(typeof addr === 'object' && addr ? addr.port : port),
        close: () => new Promise((r) => server.close(() => r()))
      })
    })
  })
}

/* 直接 `node scripts/mobile-mock-worker.mjs` 也能单独起 */
if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  const { port } = await startMock()
  console.log(`[mock] 假 Worker 已启动 http://127.0.0.1:${port}`)
}
