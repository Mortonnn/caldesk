/**
 * verify-auth.mjs — 真机跑一遍「每设备凭据 + 二维码配对 + 端到端加密 + 多账号隔离」。
 *
 * 用法：node scripts/verify-auth.mjs
 * 做的事：
 *   1. 起 `wrangler dev --local`（独立 persist 目录，跑完删掉），轮询 /health 就绪
 *   2. 用真实 HTTP 走完整流程，一条断言打一行
 *   3. finally 里一定杀进程，避免占着 8799 端口
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
    const ownerAId = `${randomUUID()}`
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

    /* ---- 手机配对 ---- */
    const phoneId = randomUUID()
    const phoneSecret = newSecret()
    const phoneToken = `${phoneId}.${phoneSecret}`
    const wrongCode = code === '000000' ? '000001' : '000000'

    const badCode = await call('POST', '/pair/request', {
      body: { pairId, code: wrongCode, deviceId: phoneId, accountSecret: phoneSecret, deviceName: 'phone' }
    })
    check('配对码错误 → 403 invalid_code', badCode.status === 403 && badCode.data?.error === 'invalid_code', badCode.data)

    const requested = await call('POST', '/pair/request', {
      body: { pairId, code, deviceId: phoneId, accountSecret: phoneSecret, deviceName: '手机' }
    })
    check('POST /pair/request 成功', requested.status === 200 && requested.data?.ok === true, requested.data)

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
        pendingList.data.devices.length === 1 &&
        pendingList.data.devices[0].deviceId === phoneId &&
        pendingList.data.devices[0].name === '手机',
      pendingList.data
    )

    const approved = await call('POST', '/pair/approve', { token: tokenA, body: { pairId, deviceId: phoneId } })
    check('POST /pair/approve 成功', approved.status === 200 && approved.data?.ok === true, approved.data)

    const statusApproved = await call('GET', '/pair/status', { query: { pairId, deviceId: phoneId, code } })
    check('pair/status = approved', statusApproved.data?.status === 'approved', statusApproved.data)

    /* ---- 设备列表：此时手机还没同步过，在线只算 A ---- */
    const devices1 = await call('GET', '/devices', { token: tokenA })
    const list1 = devices1.data?.devices ?? []
    check(
      'GET /devices 显示 2 台设备（含 current 标记）',
      devices1.status === 200 &&
        list1.length === 2 &&
        list1.filter((d) => d.current === true).length === 1 &&
        list1.find((d) => d.current)?.deviceId === ownerAId,
      devices1.data
    )
    check('online=1（手机尚未同步）', devices1.data?.online === 1, devices1.data?.online)

    /* ---- 手机推送 + 拉取：payload 必须原样往返 ---- */
    const payload1 = '{"v":1,"ct":"aB+/==\\n引号\\"中文","iv":"3f0"}'
    const t1 = Date.now()
    const pushed = await call('POST', '/sync/push', {
      token: phoneToken,
      body: { table: 'calendars', rows: [{ id: 'cal:1', updatedAt: t1, deletedAt: null, payload: payload1 }] }
    })
    check('手机 /sync/push 写入 1 行', pushed.status === 200 && pushed.data?.written === 1 && pushed.data?.failed === 0, pushed.data)

    const pulledPhone = await call('GET', '/sync/pull', { token: phoneToken, query: { table: 'calendars', since: 0 } })
    check(
      '手机 /sync/pull 拿到不透明 payload（原样）',
      pulledPhone.data?.rows?.length === 1 && pulledPhone.data.rows[0].payload === payload1,
      pulledPhone.data
    )
    check('pull cursor = 本页最大 updatedAt', pulledPhone.data?.cursor === t1, pulledPhone.data?.cursor)

    const pulledA = await call('GET', '/sync/pull', { token: tokenA, query: { table: 'calendars', since: 0 } })
    check('同账号 A 能看到手机写入的行', pulledA.data?.rows?.length === 1, pulledA.data)

    /* ---- LWW ---- */
    const stale = await call('POST', '/sync/push', {
      token: tokenA,
      body: { table: 'calendars', rows: [{ id: 'cal:1', updatedAt: t1 - 5000, deletedAt: null, payload: 'STALE' }] }
    })
    const afterStale = await call('GET', '/sync/pull', { token: tokenA, query: { table: 'calendars', since: 0 } })
    check(
      'LWW：旧 updatedAt 不覆盖新行',
      stale.status === 200 &&
        stale.data?.written === 0 &&
        afterStale.data?.rows?.length === 1 &&
        afterStale.data.rows[0].payload === payload1,
      { pushed: stale.data, rows: afterStale.data?.rows }
    )

    const fresher = await call('POST', '/sync/push', {
      token: tokenA,
      body: { table: 'calendars', rows: [{ id: 'cal:1', updatedAt: t1 + 5000, deletedAt: null, payload: 'NEWER' }] }
    })
    const afterFresh = await call('GET', '/sync/pull', { token: tokenA, query: { table: 'calendars', since: 0 } })
    check(
      'LWW：新 updatedAt 正常覆盖',
      fresher.data?.written === 1 && afterFresh.data?.rows?.[0]?.payload === 'NEWER',
      { pushed: fresher.data, rows: afterFresh.data?.rows }
    )

    const sincePull = await call('GET', '/sync/pull', { token: tokenA, query: { table: 'calendars', since: t1 } })
    check('pull 支持 since 增量', sincePull.data?.rows?.length === 1 && sincePull.data.rows[0].payload === 'NEWER', sincePull.data)

    /* ---- 多账号隔离 ---- */
    const ownerBId = randomUUID()
    const ownerBSecret = newSecret()
    const createdB = await call('POST', '/account/create', {
      body: { invite: INVITE, accountName: '账号B', deviceId: ownerBId, accountSecret: ownerBSecret, deviceName: 'B-desktop' }
    })
    const accountB = createdB.data?.accountId
    const tokenB = `${ownerBId}.${ownerBSecret}`
    check('创建账号 B', createdB.status === 200 && accountB !== accountA, createdB.data)

    const pulledB = await call('GET', '/sync/pull', { token: tokenB, query: { table: 'calendars', since: 0 } })
    check('B 拉不到 A 的行', pulledB.data?.rows?.length === 0, pulledB.data)

    // 手机在 body 里伪造 accountId/account_id，也必须写进自己的账号
    const forge = await call('POST', '/sync/push', {
      token: phoneToken,
      body: {
        table: 'calendars',
        accountId: accountB,
        rows: [{ id: 'cal:forge', accountId: accountB, account_id: accountB, updatedAt: Date.now(), deletedAt: null, payload: 'X' }]
      }
    })
    const pulledB2 = await call('GET', '/sync/pull', { token: tokenB, query: { table: 'calendars', since: 0 } })
    const pulledA2 = await call('GET', '/sync/pull', { token: tokenA, query: { table: 'calendars', since: 0 } })
    check(
      '手机伪造 accountId 推不到 B（仍落在 A）',
      forge.status === 200 &&
        pulledB2.data?.rows?.length === 0 &&
        pulledA2.data?.rows?.some((r) => r.id === 'cal:forge'),
      { forge: forge.data, b: pulledB2.data?.rows, a: pulledA2.data?.rows?.map((r) => r.id) }
    )

    const bPushIntoA = await call('POST', '/sync/push', {
      token: tokenB,
      body: { table: 'calendars', rows: [{ id: 'cal:b-only', updatedAt: Date.now(), deletedAt: null, payload: 'B' }] }
    })
    const pulledA3 = await call('GET', '/sync/pull', { token: tokenA, query: { table: 'calendars', since: 0 } })
    check(
      'B 自己 push 的行不会进 A',
      bPushIntoA.data?.written === 1 && !pulledA3.data?.rows?.some((r) => r.id === 'cal:b-only'),
      pulledA3.data?.rows?.map((r) => r.id)
    )

    /* ---- 凭据伪造 ---- */
    const forgedToken = `${phoneId}.${newSecret()}`
    const forged = await call('GET', '/sync/pull', { token: forgedToken, query: { table: 'calendars', since: 0 } })
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

    const revokedPull = await call('GET', '/sync/pull', { token: phoneToken, query: { table: 'calendars', since: 0 } })
    check('吊销后手机 → 401', revokedPull.status === 401, revokedPull.status)

    const statusRevoked = await call('GET', '/pair/status', { query: { pairId, deviceId: phoneId, code } })
    check('pair/status = revoked', statusRevoked.data?.status === 'revoked', statusRevoked.data)

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

    const tooMany = await call('POST', '/sync/push', {
      token: tokenA,
      body: { table: 'events', rows: Array.from({ length: 501 }, (_, i) => ({ id: `e${i}`, updatedAt: 1, payload: 'x' })) }
    })
    check('超过 500 行 → 400', tooMany.status === 400, tooMany.status)

    const oldApi = await call('GET', '/api/calendars', { token: tokenA })
    check('旧 /api/* 已下线 → 404', oldApi.status === 404, oldApi.status)
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
