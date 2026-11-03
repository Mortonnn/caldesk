/**
 * verify-auth.mjs — 真机跑一遍「每设备凭据 + 二维码配对 + 服务端明文存储 + 多账号隔离」。
 *
 * 用法：node scripts/verify-auth.mjs
 * 做的事：
 *   1. 起 `wrangler dev --local`（独立 persist 目录，跑完删掉），轮询 /health 就绪
 *   2. 用真实 HTTP 走完整流程，一条断言打一行
 *   3. finally 里一定杀进程，避免占着 8799 端口
 *
 * 覆盖：建账号 → 配对 → 批准 → 明文 push/pull 往返 → LWW →
 *       A/B 账号隔离（同步层 + REST 层）→ 伪造 secret 401 → 吊销后 401
 *
 * 只依赖 Node 内置模块，不引第三方包。
 */

import { spawn, spawnSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const WORKER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 8799
const BASE = `http://127.0.0.1:${PORT}`
const STATE_DIR = path.join(WORKER_DIR, '.wrangler', 'verify-state')
const INVITE = 'test-invite'
const IS_WIN = process.platform === 'win32'

let passed = 0
const failures = []

function check(label, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`✅ ${label}`)
  } else {
    failures.push(label)
    const extra =
      detail === undefined ? '' : `  → 实际：${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
    console.log(`❌ ${label}${extra}`)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 32 字节随机 secret → 64 位 hex（客户端持有的那份） */
const newSecret = () => randomBytes(32).toString('hex')

async function call(method, pathname, { token, body, query } = {}) {
  const url = new URL(BASE + pathname)
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
  }
  const headers = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'

  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  return { status: res.status, data, headers: res.headers }
}

/* ------------------------------ 启动 dev server ------------------------------ */

function devEnv() {
  return {
    ...process.env,
    CI: '1',
    NO_COLOR: '1',
    WRANGLER_SEND_METRICS: 'false',
    FORCE_COLOR: '0'
  }
}

function startServer() {
  // 每次从干净的 D1 开始，避免旧 schema / 旧数据干扰
  fs.rmSync(STATE_DIR, { recursive: true, force: true })
  fs.mkdirSync(STATE_DIR, { recursive: true })

  // 直接用本地 node_modules 里的 wrangler 入口跑，等价于 npx wrangler，
  // 但不经过 shell，Windows 上不会因为参数拼接出问题。
  const wranglerBin = path.join(WORKER_DIR, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
  const wranglerArgs = [
    'dev',
    '--ip',
    '127.0.0.1',
    '--port',
    String(PORT),
    '--local',
    // 冒号分隔：--var KEY:VALUE（用 = 会被当成整个键名，变量拿不到值）
    '--var',
    `INSTANCE_INVITE:${INVITE}`,
    '--persist-to',
    STATE_DIR
  ]

  const localBin = fs.existsSync(wranglerBin)
  const child = localBin
    ? spawn(process.execPath, [wranglerBin, ...wranglerArgs], {
        cwd: WORKER_DIR,
        env: devEnv(),
        stdio: ['ignore', 'pipe', 'pipe']
      })
    : spawn('npx', ['wrangler', ...wranglerArgs], {
        cwd: WORKER_DIR,
        env: devEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: IS_WIN
      })

  const logs = []
  const collect = (chunk) => {
    const text = chunk.toString()
    logs.push(text)
    if (logs.join('').length > 200_000) logs.splice(0, logs.length - 50)
  }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)

  let exited = false
  child.on('exit', () => {
    exited = true
  })

  return { child, logs, hasExited: () => exited }
}

async function waitForHealth(server, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (server.hasExited()) {
      throw new Error(`wrangler dev 提前退出（code=${server.child.exitCode}）\n${server.logs.join('')}`)
    }
    try {
      const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) {
        const body = await res.json()
        if (body && body.ok === true) return body
      }
    } catch {
      // 还没起来，继续等
    }
    await sleep(250)
  }
  throw new Error(`等待 /health 超时（${timeoutMs}ms）\n${server.logs.join('')}`)
}

function stopServer(server) {
  if (!server) return
  const { child } = server
  if (!child || child.exitCode !== null) return
  if (IS_WIN) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    child.kill('SIGTERM')
    setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* 已经没了 */
      }
    }, 3000)
  }
}

/* ------------------------------ 辅助 ------------------------------ */

/** 客户端把整行 camelCase 对象 stringify 后塞进 payload（服务端存明文） */
function makePayload(extra = {}) {
  return JSON.stringify({
    id: extra.id ?? 'row:1',
    calendarId: 'cal:main',
    date: '2026-03-01',
    text: '第一行\n第二行',
    color: null,
    updatedAt: extra.updatedAt ?? Date.now(),
    deletedAt: null,
    ...extra
  })
}

/* ------------------------------ 主流程 ------------------------------ */

async function main() {
  const server = startServer()

  try {
    const health = await waitForHealth(server)
    check('GET /health 返回 ok + d1', health.ok === true && health.service === 'caldesk-sync' && health.d1 === true, health)

    // CORS 预检必须在鉴权之前放行
    const preflight = await call('OPTIONS', '/sync/pull')
    check(
      'OPTIONS 预检 204 + CORS 头',
      preflight.status === 204 && preflight.headers.get('access-control-allow-origin') === '*',
      preflight.status
    )

    /* ---- 邀请码 ---- */
    const ownerAId = randomUUID()
    const ownerASecret = newSecret()
    const badInvite = await call('POST', '/account/create', {
      body: { invite: 'wrong-invite', accountName: 'A', deviceId: ownerAId, accountSecret: ownerASecret, deviceName: 'A-desktop' }
    })
    check('错误邀请码 → 403 invalid_invite', badInvite.status === 403 && badInvite.data?.error === 'invalid_invite', badInvite.data)

    /* ---- 创建账号 A ---- */
    const createdA = await call('POST', '/account/create', {
      body: { invite: INVITE, accountName: '账号A', deviceId: ownerAId, accountSecret: ownerASecret, deviceName: 'A-desktop' }
    })
    const accountA = createdA.data?.accountId
    check('POST /account/create 返回 accountId', createdA.status === 200 && typeof accountA === 'string' && accountA.length > 0, createdA.data)
    check(
      '响应里不出现 accountSecret / accountKey',
      !JSON.stringify(createdA.data).includes(ownerASecret) && !JSON.stringify(createdA.data).toLowerCase().includes('accountkey'),
      createdA.data
    )

    const dupA = await call('POST', '/account/create', {
      body: { invite: INVITE, accountName: '重复', deviceId: ownerAId, accountSecret: newSecret(), deviceName: 'dup' }
    })
    check('重复 deviceId → 409', dupA.status === 409, dupA.data)

    const tokenA = `${ownerAId}.${ownerASecret}`

    /* ---- A 生成配对码 ---- */
    const started = await call('POST', '/pair/start', { token: tokenA })
    const pairId = started.data?.pairId
    const code = started.data?.code
    check(
      'POST /pair/start 返回 6 位数字码 + 5 分钟 TTL',
      started.status === 200 &&
        typeof code === 'string' &&
        /^\d{6}$/.test(code) &&
        started.data.expiresAt - Date.now() > 4 * 60 * 1000 &&
        started.data.expiresAt - Date.now() <= 5 * 60 * 1000 + 2000,
      started.data
    )
    check(
      '二维码数据里没有 accountKey / secret',
      !JSON.stringify(started.data).toLowerCase().includes('accountkey') &&
        !JSON.stringify(started.data).includes(ownerASecret),
      started.data
    )

    /* ---- 手机配对（走 /pair/join） ---- */
    const phoneId = randomUUID()
    const phoneSecret = newSecret()
    const phoneToken = `${phoneId}.${phoneSecret}`
    const wrongCode = code === '000000' ? '000001' : '000000'

    const badCode = await call('POST', '/pair/join', {
      body: { pairId, code: wrongCode, deviceId: phoneId, accountSecret: phoneSecret, deviceName: 'phone' }
    })
    check('配对码错误 → 403 invalid_code', badCode.status === 403 && badCode.data?.error === 'invalid_code', badCode.data)

    const joined = await call('POST', '/pair/join', {
      body: { pairId, code, deviceId: phoneId, accountSecret: phoneSecret, deviceName: '手机' }
    })
    check('POST /pair/join 成功（pending）', joined.status === 200 && joined.data?.ok === true, joined.data)

    // /pair/request 保留为等价入口
    const phone2Id = randomUUID()
    const phone2Secret = newSecret()
    const requested = await call('POST', '/pair/request', {
      body: { pairId, code, deviceId: phone2Id, accountSecret: phone2Secret, deviceName: '平板' }
    })
    check('POST /pair/request 仍然可用（与 /pair/join 等价）', requested.status === 200 && requested.data?.ok === true, requested.data)

    const statusPending = await call('GET', '/pair/status', { query: { pairId, deviceId: phoneId, code } })
    check('pair/status = pending', statusPending.data?.status === 'pending', statusPending.data)

    const statusWrongCode = await call('GET', '/pair/status', { query: { pairId, deviceId: phoneId, code: wrongCode } })
    check('pair/status 码不匹配 → unknown', statusWrongCode.data?.status === 'unknown', statusWrongCode.data)

    const pendingDeviceSync = await call('GET', '/sync/pull', {
      token: phoneToken,
      query: { table: 'calendars', since: 0 }
    })
    check('pending 设备没有同步权限 → 401', pendingDeviceSync.status === 401, pendingDeviceSync.status)

    const pendingList = await call('GET', '/pair/pending', { token: tokenA, query: { pairId } })
    check(
      'GET /pair/pending 列出待批准设备',
      pendingList.status === 200 &&
        Array.isArray(pendingList.data?.devices) &&
        pendingList.data.devices.length === 2 &&
        pendingList.data.devices.some((d) => d.deviceId === phoneId && d.name === '手机'),
      pendingList.data
    )

    const approved = await call('POST', '/pair/approve', { token: tokenA, body: { pairId, deviceId: phoneId } })
    check('POST /pair/approve 成功', approved.status === 200 && approved.data?.ok === true, approved.data)

    // 另一台设备走拒绝分支
    const rejected = await call('POST', '/pair/reject', { token: tokenA, body: { pairId, deviceId: phone2Id } })
    check('POST /pair/reject 成功', rejected.status === 200 && rejected.data?.ok === true, rejected.data)
    const statusRejected = await call('GET', '/pair/status', { query: { pairId, deviceId: phone2Id, code } })
    check('pair/status = rejected（被拒绝的设备）', statusRejected.data?.status === 'rejected', statusRejected.data)
    const rejectedSync = await call('GET', '/sync/pull', {
      token: `${phone2Id}.${phone2Secret}`,
      query: { table: 'day_cells', since: 0 }
    })
    check('被拒绝的设备 → 401', rejectedSync.status === 401, rejectedSync.status)

    // 跨账号不能批准/拒绝别人账号的设备
    const crossApprove = await call('POST', '/pair/approve', {
      token: tokenA,
      body: { pairId: '00000000-0000-0000-0000-000000000000', deviceId: phone2Id }
    })
    check('跨账号/不存在的 pairId → 404 pairing_not_found', crossApprove.status === 404 && crossApprove.data?.error === 'pairing_not_found', crossApprove.data)

    const statusApproved = await call('GET', '/pair/status', { query: { pairId, deviceId: phoneId, code } })
    check('pair/status = approved', statusApproved.data?.status === 'approved', statusApproved.data)

    /* ---- 设备列表：此时手机还没同步过，在线只算 A ---- */
    const devices1 = await call('GET', '/devices', { token: tokenA })
    const list1 = devices1.data?.devices ?? []
    check(
      'GET /devices 显示 3 台设备（含 current 标记）',
      devices1.status === 200 &&
        list1.length === 3 &&
        list1.filter((d) => d.current === true).length === 1 &&
        list1.find((d) => d.current)?.deviceId === ownerAId,
      devices1.data
    )
    check('online=1（手机尚未同步）', devices1.data?.online === 1, devices1.data?.online)

    /* ---- 手机推送 + 拉取：payload 是明文 JSON，必须原样往返 ---- */
    const t1 = Date.now()
    const payload1 = makePayload({ id: 'cal:1', updatedAt: t1, text: '第一行\n第二行 "引号" 中文' })
    const pushed = await call('POST', '/sync/push', {
      token: phoneToken,
      body: { table: 'day_cells', rows: [{ id: 'cal:1', updatedAt: t1, deletedAt: null, payload: payload1 }] }
    })
    check('手机 /sync/push 写入 1 行', pushed.status === 200 && pushed.data?.written === 1 && pushed.data?.failed === 0, pushed.data)

    const pulledPhone = await call('GET', '/sync/pull', { token: phoneToken, query: { table: 'day_cells', since: 0 } })
    check(
      '手机 /sync/pull 拿回明文 payload（原样相等）',
      pulledPhone.data?.rows?.length === 1 && pulledPhone.data.rows[0].payload === payload1,
      pulledPhone.data
    )
    check(
      'pull 返回的行结构 { id, updatedAt, deletedAt, payload }',
      pulledPhone.data?.rows?.[0] &&
        pulledPhone.data.rows[0].id === 'cal:1' &&
        pulledPhone.data.rows[0].updatedAt === t1 &&
        pulledPhone.data.rows[0].deletedAt === null &&
        typeof pulledPhone.data.rows[0].payload === 'string',
      pulledPhone.data?.rows?.[0]
    )
    check(
      'payload 是可读的明文 JSON（服务端没加密）',
      (() => {
        try {
          const parsed = JSON.parse(pulledPhone.data?.rows?.[0]?.payload ?? 'null')
          return parsed && parsed.text === '第一行\n第二行 "引号" 中文'
        } catch {
          return false
        }
      })(),
      pulledPhone.data?.rows?.[0]?.payload
    )
    check('pull cursor = 本页最大 updatedAt', pulledPhone.data?.cursor === t1, pulledPhone.data?.cursor)

    const pulledA = await call('GET', '/sync/pull', { token: tokenA, query: { table: 'day_cells', since: 0 } })
    check('同账号 A 能看到手机写入的行', pulledA.data?.rows?.length === 1, pulledA.data)

    /* ---- LWW ---- */
    const stale = await call('POST', '/sync/push', {
      token: tokenA,
      body: { table: 'day_cells', rows: [{ id: 'cal:1', updatedAt: t1 - 5000, deletedAt: null, payload: 'STALE' }] }
    })
    const afterStale = await call('GET', '/sync/pull', { token: tokenA, query: { table: 'day_cells', since: 0 } })
    check(
      'LWW：旧 updatedAt 不覆盖新行',
      stale.status === 200 &&
        stale.data?.written === 0 &&
        afterStale.data?.rows?.length === 1 &&
        afterStale.data.rows[0].payload === payload1,
      { pushed: stale.data, rows: afterStale.data?.rows }
    )

    const newerPayload = makePayload({ id: 'cal:1', updatedAt: t1 + 5000, text: '新的内容' })
    const fresher = await call('POST', '/sync/push', {
      token: tokenA,
      body: { table: 'day_cells', rows: [{ id: 'cal:1', updatedAt: t1 + 5000, deletedAt: null, payload: newerPayload }] }
    })
    const afterFresh = await call('GET', '/sync/pull', { token: tokenA, query: { table: 'day_cells', since: 0 } })
    check(
      'LWW：新 updatedAt 正常覆盖',
      fresher.data?.written === 1 && afterFresh.data?.rows?.[0]?.payload === newerPayload,
      { pushed: fresher.data, rows: afterFresh.data?.rows }
    )

    const sincePull = await call('GET', '/sync/pull', { token: tokenA, query: { table: 'day_cells', since: t1 } })
    check('pull 支持 since 增量', sincePull.data?.rows?.length === 1 && sincePull.data.rows[0].payload === newerPayload, sincePull.data)

    /* ---- 多账号隔离（同步层） ---- */
    const ownerBId = randomUUID()
    const ownerBSecret = newSecret()
    const createdB = await call('POST', '/account/create', {
      body: { invite: INVITE, accountName: '账号B', deviceId: ownerBId, accountSecret: ownerBSecret, deviceName: 'B-desktop' }
    })
    const accountB = createdB.data?.accountId
    const tokenB = `${ownerBId}.${ownerBSecret}`
    check('创建账号 B', createdB.status === 200 && accountB !== accountA, createdB.data)

    const pulledB = await call('GET', '/sync/pull', { token: tokenB, query: { table: 'day_cells', since: 0 } })
    check('B 拉不到 A 的行', pulledB.data?.rows?.length === 0, pulledB.data)

    // 手机在 body 里伪造 accountId/account_id，也必须写进自己的账号
    const forge = await call('POST', '/sync/push', {
      token: phoneToken,
      body: {
        table: 'day_cells',
        accountId: accountB,
        rows: [
          {
            id: 'cal:forge',
            accountId: accountB,
            account_id: accountB,
            updatedAt: Date.now(),
            deletedAt: null,
            payload: makePayload({ id: 'cal:forge', updatedAt: Date.now() })
          }
        ]
      }
    })
    const pulledB2 = await call('GET', '/sync/pull', { token: tokenB, query: { table: 'day_cells', since: 0 } })
    const pulledA2 = await call('GET', '/sync/pull', { token: tokenA, query: { table: 'day_cells', since: 0 } })
    check(
      '手机伪造 accountId 推不到 B（仍落在 A）',
      forge.status === 200 &&
        pulledB2.data?.rows?.length === 0 &&
        pulledA2.data?.rows?.some((r) => r.id === 'cal:forge'),
      { forge: forge.data, b: pulledB2.data?.rows, a: pulledA2.data?.rows?.map((r) => r.id) }
    )

    const bPushIntoA = await call('POST', '/sync/push', {
      token: tokenB,
      body: { table: 'day_cells', rows: [{ id: 'cal:b-only', updatedAt: Date.now(), deletedAt: null, payload: makePayload({ id: 'cal:b-only' }) }] }
    })
    const pulledA3 = await call('GET', '/sync/pull', { token: tokenA, query: { table: 'day_cells', since: 0 } })
    check(
      'B 自己 push 的行不会进 A',
      bPushIntoA.data?.written === 1 && !pulledA3.data?.rows?.some((r) => r.id === 'cal:b-only'),
      pulledA3.data?.rows?.map((r) => r.id)
    )

    // 同一个行 id 在两个账号下各存一份，互不覆盖（用 event_skip 表，不污染后面的 notes 断言）
    const sameIdA = await call('POST', '/sync/push', {
      token: tokenA,
      body: { table: 'event_skip', rows: [{ id: 'same', updatedAt: Date.now(), deletedAt: null, payload: makePayload({ id: 'same', title: 'A 的便签' }) }] }
    })
    const sameIdB = await call('POST', '/sync/push', {
      token: tokenB,
      body: { table: 'event_skip', rows: [{ id: 'same', updatedAt: Date.now() + 1000, deletedAt: null, payload: makePayload({ id: 'same', title: 'B 的便签' }) }] }
    })
    const notesA = await call('GET', '/sync/pull', { token: tokenA, query: { table: 'event_skip', since: 0 } })
    const notesB = await call('GET', '/sync/pull', { token: tokenB, query: { table: 'event_skip', since: 0 } })
    check(
      '同一个行 id 在 A/B 下互不覆盖（主键带 account_id）',
      sameIdA.data?.written === 1 &&
        sameIdB.data?.written === 1 &&
        notesA.data?.rows?.length === 1 &&
        notesB.data?.rows?.length === 1 &&
        JSON.parse(notesA.data.rows[0].payload).title === 'A 的便签' &&
        JSON.parse(notesB.data.rows[0].payload).title === 'B 的便签',
      { a: notesA.data?.rows, b: notesB.data?.rows }
    )

    /* ---- REST 接口隔离（/api/*） ---- */
    // A 建一个视图 + 一条日格 + 一条便签
    const calA = await call('POST', '/api/calendars/create', { token: tokenA, body: { name: 'A视图', color: '#ff0000' } })
    check('POST /api/calendars/create 成功', calA.status === 200 && typeof calA.data?.id === 'string', calA.data)
    const calAId = calA.data?.id

    const cellA = await call('POST', '/api/cells/append', {
      token: tokenA,
      body: { calendar: calAId, date: '2026-03-01', text: 'A 的任务' }
    })
    check('POST /api/cells/append 成功', cellA.status === 200 && typeof cellA.data?.text === 'string', cellA.data)

    const noteA = await call('POST', '/api/notes/save', {
      token: tokenA,
      body: { calendarId: calAId, title: 'A 便签', content: '只有 A 能看到' }
    })
    check('POST /api/notes/save 成功', noteA.status === 200 && noteA.data?.id, noteA.data)

    // B 建自己的
    const calB = await call('POST', '/api/calendars/create', { token: tokenB, body: { name: 'B视图', color: '#00ff00' } })
    const calBId = calB.data?.id
    await call('POST', '/api/cells/append', { token: tokenB, body: { calendar: calBId, date: '2026-03-01', text: 'B 的任务' } })
    await call('POST', '/api/notes/save', { token: tokenB, body: { calendarId: calBId, title: 'B 便签', content: '只有 B 能看到' } })
    check('POST /api/calendars/create（B）成功', calB.status === 200 && typeof calBId === 'string', calB.data)

    const calsA = await call('GET', '/api/calendars', { token: tokenA })
    const calsB = await call('GET', '/api/calendars', { token: tokenB })
    check(
      'GET /api/calendars 只返回本账号视图',
      calsA.status === 200 &&
        calsB.status === 200 &&
        calsA.data.length === 1 &&
        calsA.data[0].name === 'A视图' &&
        calsB.data.length === 1 &&
        calsB.data[0].name === 'B视图',
      { a: calsA.data, b: calsB.data }
    )

    const cellsA = await call('GET', '/api/cells', { token: tokenA, query: { calendar: calAId, from: '2026-01-01', to: '2026-12-31' } })
    const cellsB = await call('GET', '/api/cells', { token: tokenB, query: { calendar: calAId, from: '2026-01-01', to: '2026-12-31' } })
    check(
      'GET /api/cells 按账号隔离（B 查 A 的 calendarId 看不到数据）',
      cellsA.status === 200 &&
        cellsA.data.length === 1 &&
        cellsA.data[0].text === 'A 的任务' &&
        cellsB.data.length === 0,
      { a: cellsA.data, b: cellsB.data }
    )

    const notesRestA = await call('GET', '/api/notes', { token: tokenA })
    const notesRestB = await call('GET', '/api/notes', { token: tokenB })
    check(
      'GET /api/notes 按账号隔离',
      notesRestA.data.length === 1 &&
        notesRestA.data[0].title === 'A 便签' &&
        notesRestB.data.length === 1 &&
        notesRestB.data[0].title === 'B 便签',
      { a: notesRestA.data, b: notesRestB.data }
    )

    // B 按 A 的便签 id 去取，取不到
    const noteGetB = await call('GET', '/api/notes/get', { token: tokenB, query: { id: noteA.data.id } })
    check('GET /api/notes/get 跨账号取不到 → 404', noteGetB.status === 404, noteGetB.data)

    // B 删 A 的便签 → 找不到
    const noteDelB = await call('POST', '/api/notes/delete', { token: tokenB, body: { id: noteA.data.id } })
    check('POST /api/notes/delete 跨账号删不掉 → 404', noteDelB.status === 404, noteDelB.data)
    const noteStillA = await call('GET', '/api/notes/get', { token: tokenA, query: { id: noteA.data.id } })
    check('A 的便签还在', noteStillA.status === 200 && noteStillA.data?.title === 'A 便签', noteStillA.data)

    // REST 搜索也按账号隔离
    const searchA = await call('GET', '/api/search', { token: tokenA, query: { q: '任务' } })
    const searchB = await call('GET', '/api/search', { token: tokenB, query: { q: '任务' } })
    check(
      'GET /api/search 按账号隔离',
      searchA.data.length === 1 &&
        searchA.data[0].title === 'A 的任务' &&
        searchB.data.length === 1 &&
        searchB.data[0].title === 'B 的任务',
      { a: searchA.data, b: searchB.data }
    )

    // REST 写入的行也进得了同步层，并且仍然按账号隔离
    const pullRestA = await call('GET', '/sync/pull', { token: tokenA, query: { table: 'day_cells', since: 0 } })
    const pullRestB = await call('GET', '/sync/pull', { token: tokenB, query: { table: 'day_cells', since: 0 } })
    check(
      'REST 写入的行对同步层可见且不串号',
      pullRestA.data.rows.some((r) => r.id === `${calAId}:2026-03-01`) &&
        !pullRestB.data.rows.some((r) => r.id === `${calAId}:2026-03-01`) &&
        pullRestB.data.rows.some((r) => r.id === `${calBId}:2026-03-01`),
      { a: pullRestA.data.rows.map((r) => r.id), b: pullRestB.data.rows.map((r) => r.id) }
    )

    // 事件接口：创建后能在自己的账号里查到
    const evtA = await call('POST', '/api/events/create', {
      token: tokenA,
      body: { calendar: calAId, title: 'A 的事件', start: '2026-03-01' }
    })
    check('POST /api/events/create 成功', evtA.status === 200 && evtA.data?.id, evtA.data)
    const evtsA = await call('GET', '/api/events', { token: tokenA, query: { calendar: calAId, from: '2026-03-01', to: '2026-03-31' } })
    const evtsB = await call('GET', '/api/events', { token: tokenB, query: { calendar: calAId, from: '2026-03-01', to: '2026-03-31' } })
    check(
      'GET /api/events 按账号隔离',
      evtsA.data.length === 1 &&
        evtsA.data[0].event.title === 'A 的事件' &&
        evtsB.data.length === 0,
      { a: evtsA.data, b: evtsB.data }
    )

    // REST 需要设备凭据
    const restNoAuth = await call('GET', '/api/calendars')
    check('REST 无凭据 → 401', restNoAuth.status === 401, restNoAuth.status)
    const restBadToken = await call('GET', '/api/calendars', { token: `${ownerAId}.${newSecret()}` })
    check('REST 伪造 secret → 401', restBadToken.status === 401, restBadToken.status)

    /* ---- 凭据伪造 ---- */
    const forgedToken = `${phoneId}.${newSecret()}`
    const forged = await call('GET', '/sync/pull', { token: forgedToken, query: { table: 'day_cells', since: 0 } })
    check('伪造 secret → 401', forged.status === 401, forged.status)

    const malformed = await call('GET', '/sync/pull', { token: 'not-a-token' })
    check('格式错误的 Authorization → 401', malformed.status === 401, malformed.status)

    /* ---- 在线数：手机已同步过 ---- */
    const devices2 = await call('GET', '/devices', { token: tokenA })
    check('手机同步后 online=2', devices2.data?.online === 2, devices2.data?.online)

    /* ---- 吊销 ---- */
    const selfRevoke = await call('POST', '/devices/revoke', { token: tokenA, body: { deviceId: ownerAId } })
    check('不能吊销自己 → 400 cannot_revoke_self', selfRevoke.status === 400 && selfRevoke.data?.error === 'cannot_revoke_self', selfRevoke.data)

    const revoked = await call('POST', '/devices/revoke', { token: tokenA, body: { deviceId: phoneId } })
    check('POST /devices/revoke 成功', revoked.status === 200 && revoked.data?.ok === true, revoked.data)

    const revokedPull = await call('GET', '/sync/pull', { token: phoneToken, query: { table: 'day_cells', since: 0 } })
    check('吊销后手机 → 401', revokedPull.status === 401, revokedPull.status)

    const revokedRest = await call('GET', '/api/calendars', { token: phoneToken })
    check('吊销后手机走 REST → 401', revokedRest.status === 401, revokedRest.status)

    const statusRevoked = await call('GET', '/pair/status', { query: { pairId, deviceId: phoneId, code } })
    check('pair/status = rejected（设备被吊销）', statusRevoked.data?.status === 'rejected', statusRevoked.data)

    /* ---- 表名 / 参数校验 ---- */
    const unknownPull = await call('GET', '/sync/pull', { token: tokenA, query: { table: 'secrets', since: 0 } })
    check('未知表 → 400 unknown_table', unknownPull.status === 400 && unknownPull.data?.error === 'unknown_table', unknownPull.data)

    const unknownPush = await call('POST', '/sync/push', {
      token: tokenA,
      body: { table: 'secrets', rows: [] }
    })
    check('push 未知表 → 400 unknown_table', unknownPush.status === 400 && unknownPush.data?.error === 'unknown_table', unknownPush.data)

    const badRows = await call('POST', '/sync/push', {
      token: tokenA,
      body: { table: 'events', rows: [{ id: 'e1', updatedAt: Date.now() }, { updatedAt: Date.now(), payload: 'x' }, { id: 'e3', payload: 'y' }] }
    })
    check(
      '缺字段的行被拒（failed=3, written=0）',
      badRows.status === 200 && badRows.data?.failed === 3 && badRows.data?.written === 0 && badRows.data.errors.length === 3,
      badRows.data
    )

    const badPayload = await call('POST', '/sync/push', {
      token: tokenA,
      body: { table: 'events', rows: [{ id: 'e4', updatedAt: Date.now(), payload: 'not-json' }] }
    })
    check(
      'payload 不是合法 JSON → 该行被拒',
      badPayload.status === 200 && badPayload.data?.failed === 1 && badPayload.data?.written === 0,
      badPayload.data
    )

    const tooMany = await call('POST', '/sync/push', {
      token: tokenA,
      body: { table: 'events', rows: Array.from({ length: 501 }, (_, i) => ({ id: `e${i}`, updatedAt: 1, payload: 'x' })) }
    })
    check('超过 500 行 → 400', tooMany.status === 400, tooMany.status)

    const unknownApi = await call('GET', '/api/nope', { token: tokenA })
    check('未知 /api/* → 404', unknownApi.status === 404, unknownApi.status)
  } finally {
    stopServer(server)
    await sleep(300)
    try {
      fs.rmSync(STATE_DIR, { recursive: true, force: true })
    } catch {
      /* 文件可能还被 wrangler 占着，忽略 */
    }
  }
}

try {
  await main()
} catch (err) {
  console.error('❌ 验证脚本异常：', err instanceof Error ? err.message : err)
  process.exitCode = 1
  process.exit(1)
}

if (failures.length > 0) {
  console.log(`\n${passed} 项通过，${failures.length} 项失败：`)
  for (const label of failures) console.log(`  - ${label}`)
  process.exit(1)
} else {
  console.log(`\n全部通过 ✅（${passed} 项断言）`)
  process.exit(0)
}
