/**
 * 账号密码协议验收（**自带 Worker 启停**，不再需要先手工起服务）
 *
 *   node scripts/verify-auth.mjs                  # 自动起本地 wrangler（临时 D1，端口随便挑，跑完关掉）
 *   node scripts/verify-auth.mjs --state          # 用 worker/.wrangler/state（保留测试数据）
 *   node scripts/verify-auth.mjs --port 8787      # 打/复用 127.0.0.1:8787 上已经在跑的那个
 *   node scripts/verify-auth.mjs --no-start       # 只检测 --port，没起就提示并退出 2
 *   node scripts/verify-auth.mjs --url https://你的域名   # 打线上，不启停
 *   node scripts/verify-auth.mjs --keep           # 跑完不关 Worker（排查用）
 *
 * 为什么以前跑不起来：脚本直接 fetch http://127.0.0.1:8787/，但没有任何地方起 Worker，
 * 于是必然 ECONNREFUSED。现在默认自己 spawn `wrangler dev --local`，等 /health 就绪再跑。
 *
 * 覆盖：注册 / 用户名规则与大小写唯一 / 密码策略 / 并发注册同名 / SQL 注入字符 /
 *      登录（正确·错误·不存在·大小写）/ 登录耗时（不能用来枚举用户名）/ 第二台设备登录 /
 *      同账号共享数据 / 设备名上报 / 退出登录立刻 401 / 换账号后旧凭据失效 /
 *      跨账号隔离 / 凭据解析边界。
 *
 * 退出码：0 全过；1 有失败；2 环境问题（起不来 Worker / 缺依赖）。
 *
 * 这个文件同时是 `verify-sync-e2e.mjs`、`verify-worker-api.mjs` 的复用库：
 * 它们 import { startWorker, stopWorker, readDevVars } 就能拿到一个干净的本地 Worker。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const WORKER_DIR = join(ROOT, 'worker')
export const DEFAULT_PORT = 8787

/* ------------------------------ 环境 ------------------------------ */

/** 读 worker/.dev.vars（本地开发变量；wrangler dev 会自动加载它） */
export function readDevVars() {
  const file = join(WORKER_DIR, '.dev.vars')
  const out = {}
  if (!existsSync(file)) return out
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (!m) continue
    let value = m[2]
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1)
    out[m[1]] = value
  }
  return out
}

/** 让系统分一个空闲端口，避免和手工起的 8787 撞车 */
export async function freePort() {
  return await new Promise((ok, no) => {
    const srv = createServer()
    srv.once('error', no)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => ok(port))
    })
  })
}

async function portOpen(port, timeoutMs = 600) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    return res.ok
  } catch {
    return false
  }
}

export async function waitForHealth(base, { timeoutMs = 120_000, child } = {}) {
  const started = Date.now()
  for (;;) {
    if (child && child.exitCode !== null) {
      throw new Error(`wrangler 提前退出（exit ${child.exitCode}）`)
    }
    if (await portOpen(new URL(base).port || 80)) return true
    if (Date.now() - started > timeoutMs) throw new Error(`等 ${base}/health 超时（${timeoutMs}ms）`)
    await new Promise((r) => setTimeout(r, 400))
  }
}

let running = null

/**
 * 起一个本地 Worker。
 * stateDir 传 null 时用一个临时目录（每次都是全新的 D1，用来验证建表路径）；
 * 传具体路径就复用那份本地数据。
 */
export async function startWorker({ port, stateDir = null, quiet = true } = {}) {
  /*
   * 优先用 `node node_modules/wrangler/bin/wrangler.js`：
   * 直接起 node 子进程，不经过 cmd.exe，kill / 退出码 / 参数转义都干净
   * （spawn 一个 .cmd 必须 shell:true，Node 24 会因此报警告）。
   */
  const cli = join(WORKER_DIR, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
  const cmd = join(WORKER_DIR, 'node_modules', '.bin', 'wrangler.cmd')
  let command = process.execPath
  let argv
  let shell = false
  if (existsSync(cli)) {
    argv = [cli]
  } else if (existsSync(cmd)) {
    command = cmd
    argv = []
    shell = process.platform === 'win32'
  } else {
    throw new Error(`找不到 wrangler（${cli} / ${cmd}），先在 worker/ 里 npm install`)
  }
  const listenPort = port ?? (await freePort())
  const persist = stateDir ?? mkdtempSync(join(tmpdir(), 'caldesk-d1-'))
  argv = [...argv, 'dev', '--local', '--port', String(listenPort), '--persist-to', persist]
  /*
   * 这个会话里 ELECTRON_RUN_AS_NODE=1 默认开着（Electron 打包的 node 会用它），
   * 传给 wrangler 子进程会让某些工具把 electron 当成 node 用，行为不可预期 —— 删掉再传。
   */
  const childEnv = { ...process.env, WRANGLER_SEND_METRICS: 'false', BROWSER: 'none' }
  delete childEnv.ELECTRON_RUN_AS_NODE
  const child = spawn(command, argv, {
    cwd: WORKER_DIR,
    shell,
    windowsHide: true,
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: childEnv
  })
  let log = ''
  child.stdout?.on('data', (d) => {
    log += String(d)
    if (log.length > 8000) log = log.slice(-8000)
    if (!quiet) process.stdout.write(d)
  })
  child.stderr?.on('data', (d) => {
    log += String(d)
    if (log.length > 8000) log = log.slice(-8000)
  })

  const base = `http://127.0.0.1:${listenPort}`
  running = { child, base, persist }
  try {
    await waitForHealth(base, { child })
  } catch (err) {
    stopWorker()
    throw new Error(`${err.message}\n--- wrangler 输出 ---\n${log.slice(-2000)}`)
  }
  return { base, port: listenPort, persist, child, stop: stopWorker }
}

/** 关掉自己起的 Worker（Windows 下要 taskkill /t，否则 workerd 子进程会活下来占端口） */
export function stopWorker() {
  const current = running
  running = null
  if (!current?.child) return
  const { child, persist } = current
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
  } else {
    try {
      child.kill('SIGTERM')
    } catch {
      /* ignore */
    }
  }
  if (persist && persist.includes('caldesk-d1-')) {
    try {
      rmSync(persist, { recursive: true, force: true })
    } catch {
      /* Windows 上文件可能还被占着，留在 temp 里无所谓 */
    }
  }
}

/* ------------------------------ 小工具 ------------------------------ */

export const hex = (n) =>
  [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('')

export const uuid = () => crypto.randomUUID()

export function makeApi(base) {
  const call = async (path, { method = 'GET', body, token, headers = {} } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000)
    })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* 非 JSON 响应 */
    }
    return { status: res.status, json, text }
  }
  return { call }
}

export const STRONG_PASSWORD = 'Abcdef123!x'

/** 注册一个账号，返回可用凭据 */
export async function registerUser(api, { username, password = STRONG_PASSWORD, deviceId, secret, deviceName = 'verify-device' }) {
  const id = deviceId ?? uuid()
  const sec = secret ?? hex(32)
  const res = await api.call('/auth/register', {
    method: 'POST',
    body: { username, password, deviceId: id, secret: sec, deviceName }
  })
  return { ...res, deviceId: res.json?.deviceId, secret: res.json?.secret, token: res.json ? `${res.json.deviceId}.${res.json.secret}` : '' }
}

export async function loginUser(api, { username, password = STRONG_PASSWORD, deviceId, secret, deviceName = 'verify-device' }) {
  const id = deviceId ?? uuid()
  const sec = secret ?? hex(32)
  const res = await api.call('/auth/login', {
    method: 'POST',
    body: { username, password, deviceId: id, secret: sec, deviceName }
  })
  return { ...res, token: res.json ? `${res.json.deviceId}.${res.json.secret}` : '' }
}

/* ------------------------------ 断言集 ------------------------------ */

/**
 * 跑账号协议断言。返回 { pass, fail, results }，由调用方决定退出码。
 * 不打印退出码、不 process.exit，方便被 verify-all / e2e 复用。
 */
export async function runAuthSuite({ base, log = console.log }) {
  const api = makeApi(base)
  const results = []
  const check = (name, cond, detail = '') => {
    results.push({ name, ok: Boolean(cond), detail })
    log(cond ? `  ✓ ${name}` : `  ✗ ${name}${detail ? `\n      ${String(detail).slice(0, 300)}` : ''}`)
  }
  const tag = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const user = `t_${tag}`

  log('\n[0] 冷启动：并发首请求（建表）')
  const burst = await Promise.all(
    Array.from({ length: 8 }, () => api.call('/api/changes', { token: `${uuid()}.${hex(32)}` }))
  )
  check(
    '8 个并发首请求都正常返回（建表单飞，没有 500）',
    burst.every((r) => r.status === 401),
    burst.map((r) => r.status).join(',')
  )

  log('\n[1] 注册')
  const reg = await registerUser(api, { username: user })
  check('注册成功并返回 accountId', reg.status === 200 && Boolean(reg.json?.accountId), reg.text)
  const accountId = reg.json?.accountId
  const tokenA = reg.token

  /*
   * 注册对所有人开放（邀请码机制已删除）。这条是回归保护：
   * 万一以后有人把邀请码校验加回来，这里会立刻红。
   */
  const noInvite = await api.call('/auth/register', {
    method: 'POST',
    body: { username: `${user}_open`, password: STRONG_PASSWORD, deviceId: uuid(), secret: hex(32) }
  })
  check('不带任何邀请码也能注册（开放注册）', noInvite.status === 200, noInvite.text)

  const dup = await registerUser(api, { username: user.toUpperCase() })
  check('用户名大小写重名被拒（409）', dup.status === 409, dup.text)

  for (const [label, password] of [
    ['太短', 'Ab1!'],
    ['缺数字', 'Abcdefgh!x'],
    ['缺小写', 'ABCDEFG1!X'],
    ['缺大写', 'abcdefg1!x'],
    ['缺符号', 'Abcdefg123']
  ]) {
    const weak = await registerUser(api, { username: `${user}_${label}`, password })
    check(`弱密码被拒：${label}`, weak.status === 400, weak.text)
  }

  const empty = await registerUser(api, { username: '   ' })
  check('纯空格用户名被拒', empty.status === 400, empty.text)
  const longName = await registerUser(api, { username: 'x'.repeat(65) })
  check('65 字用户名被拒', longName.status === 400, longName.text)
  const ctrl = await registerUser(api, { username: 'a\u0001b' })
  check('控制字符用户名被拒', ctrl.status === 400, ctrl.text)
  const emoji = await registerUser(api, { username: `日历${'📅'.repeat(3)}_${tag}` })
  check('emoji 用户名可用', emoji.status === 200, emoji.text)

  // SQL 注入字符必须原样当字符串处理（所有查询都是 bind 参数化的）
  const injectName = `x'); DROP TABLE accounts;--${tag}`
  const inject = await registerUser(api, { username: injectName })
  check('SQL 注入字符用户名可用（参数化）', inject.status === 200, inject.text)
  const injectMe = await api.call('/auth/me', { token: inject.token })
  check('注入字符账号能正常读自己', injectMe.status === 200 && injectMe.json?.username === injectName, injectMe.text)
  const victimAlive = await api.call('/auth/me', { token: tokenA })
  check('accounts 表没被注入删掉', victimAlive.status === 200, victimAlive.text)

  // 并发注册同名：唯一索引必须挡住，只能有一个成功
  const raceName = `race_${tag}`
  const raced = await Promise.all(
    Array.from({ length: 5 }, () => registerUser(api, { username: raceName }))
  )
  const okCount = raced.filter((r) => r.status === 200).length
  const conflictCount = raced.filter((r) => r.status === 409).length
  check('并发注册同名：只成功 1 个', okCount === 1, `成功 ${okCount} / 409 ${conflictCount} / 状态 ${raced.map((r) => r.status).join(',')}`)
  check('并发注册同名：其余都是 409', conflictCount === 4, raced.map((r) => r.status).join(','))

  log('\n[2] 登录')
  const badLogin = await loginUser(api, { username: user, password: 'WrongPass123!' })
  check('错密码 401', badLogin.status === 401, badLogin.text)
  const noUser = await loginUser(api, { username: `nobody_${tag}`, password: 'WrongPass123!' })
  check('不存在的用户 401', noUser.status === 401, noUser.text)
  check('两种失败返回同一句文案（不泄漏用户是否存在）', badLogin.json?.message === noUser.json?.message, `${badLogin.json?.message} vs ${noUser.json?.message}`)

  // 登录耗时：不存在用户也必须跑一次 PBKDF2，否则可以按时间枚举用户名
  const timeIt = async (username) => {
    const samples = []
    for (let i = 0; i < 5; i += 1) {
      const t0 = performance.now()
      await api.call('/auth/login', {
        method: 'POST',
        body: { username, password: 'WrongPass123!', deviceId: uuid(), secret: hex(32) }
      })
      samples.push(performance.now() - t0)
    }
    samples.sort((a, b) => a - b)
    return samples[2]
  }
  const tExisting = await timeIt(user)
  const tMissing = await timeIt(`nobody_${tag}`)
  check(
    '不存在的用户耗时不低于存在用户的 1/3（不可用时间枚举）',
    tMissing > tExisting / 3,
    `存在 ${tExisting.toFixed(0)}ms / 不存在 ${tMissing.toFixed(0)}ms`
  )

  const loginB = await loginUser(api, { username: user.toUpperCase(), deviceId: uuid(), deviceName: 'second-device' })
  check('大小写不同的用户名也能登录（忽略大小写）', loginB.status === 200, loginB.text)
  check('第二台设备绑到同一个 accountId', loginB.json?.accountId === accountId, loginB.text)
  const tokenB = loginB.token
  const meB = await api.call('/auth/me', { token: tokenB, headers: { 'x-device-name': 'second-device' } })
  check('/auth/me 返回用户名与设备名', meB.json?.username === user && meB.json?.deviceName === 'second-device', meB.text)
  check('/auth/me 的 claimed=true', meB.json?.claimed === true, meB.text)

  log('\n[3] 同账号数据共享')
  const push = await api.call('/sync/push', {
    method: 'POST',
    token: tokenA,
    body: {
      table: 'calendars',
      rows: [{ id: `cal_shared_${tag}`, updatedAt: Date.now(), deletedAt: null, payload: JSON.stringify({ id: `cal_shared_${tag}`, name: '共享日历' }) }]
    }
  })
  check('A 推送成功', push.status === 200 && push.json?.written === 1, push.text)
  const pull = await api.call(`/sync/pull?table=calendars&since=0&limit=200`, { token: tokenB })
  check('B 能看到 A 的数据', (pull.json?.rows ?? []).some((r) => r.id === `cal_shared_${tag}`), pull.text)

  const devices = await api.call('/devices', { token: tokenA })
  check('设备列表里两台设备都在', (devices.json?.devices ?? []).length >= 2, devices.text)
  check('设备列表只显示本账号设备', (devices.json?.devices ?? []).every((d) => d.status === 'approved'), devices.text)

  log('\n[4] 跨账号隔离')
  const other = await registerUser(api, { username: `iso_${tag}` })
  const otherToken = other.token
  const leakPull = await api.call('/sync/pull?table=calendars&since=0&limit=200', { token: otherToken })
  check('B 账号拉不到 A 的行', (leakPull.json?.rows ?? []).length === 0, leakPull.text)
  const foreignNotes = await api.call('/api/notes/save', { method: 'POST', token: tokenA, body: { title: 'A 的便签', content: 'secret' } })
  const noteId = foreignNotes.json?.id
  const leakNote = await api.call(`/api/notes/get?id=${encodeURIComponent(noteId)}`, { token: otherToken })
  check('B 账号按 id 读不到 A 的便签（404）', leakNote.status === 404, leakNote.text)
  const stealDelete = await api.call('/api/notes/delete', { method: 'POST', token: otherToken, body: { id: noteId } })
  check('B 账号删不掉 A 的便签（404）', stealDelete.status === 404, stealDelete.text)
  const revokeOther = await api.call('/devices/revoke', { method: 'POST', token: otherToken, body: { deviceId: reg.deviceId } })
  check('B 账号撤不掉 A 的设备（404）', revokeOther.status === 404, revokeOther.text)
  const stillThere = await api.call('/auth/me', { token: tokenA })
  check('A 的设备没被跨账号撤销', stillThere.status === 200, stillThere.text)
  const changes = await api.call('/api/changes', { token: otherToken })
  check('B 账号的水位不含 A 的数据（0）', Number(changes.json?.token ?? -1) === 0, changes.text)

  log('\n[5] 凭据解析边界')
  const [deviceId, secret] = tokenA.split('.')
  for (const [label, auth] of [
    ['没有点', `Bearer ${deviceId}`],
    ['secret 为空', `Bearer ${deviceId}.`],
    ['多一段', `Bearer ${tokenA}.extra`],
    ['secret 大写', `Bearer ${deviceId}.${secret.toUpperCase()}`],
    ['secret 非 hex', `Bearer ${deviceId}.${'z'.repeat(64)}`],
    ['secret 太短', `Bearer ${deviceId}.${secret.slice(0, 32)}`],
    ['secret 太长', `Bearer ${deviceId}.${secret}${'0'.repeat(64)}`],
    ['没有 Bearer 前缀', tokenA],
    ['空 Bearer', 'Bearer '],
    ['小写 bearer', `bearer ${tokenA}`]
  ]) {
    const res = await fetch(base + '/auth/me', { headers: { authorization: auth } })
    check(`凭据边界被拒：${label}`, res.status === 401, `HTTP ${res.status}`)
  }
  const noAuth = await api.call('/api/changes')
  check('/api/* 没凭据 401', noAuth.status === 401, noAuth.text)

  log('\n[6] 退出登录 / 撤销')
  const logout = await api.call('/auth/logout', { method: 'POST', token: tokenB, body: {} })
  check('退出登录成功', logout.status === 200, logout.text)
  const meAfterLogout = await api.call('/auth/me', { token: tokenB })
  check('退出后立刻 401', meAfterLogout.status === 401, meAfterLogout.text)
  const apiAfterLogout = await api.call('/api/changes', { token: tokenB })
  check('退出后 REST 也立刻 401', apiAfterLogout.status === 401, apiAfterLogout.text)
  const meA = await api.call('/auth/me', { token: tokenA })
  check('另一台设备不受影响', meA.status === 200, meA.text)

  // 换账号登录：服务端换发新凭据，旧账号那边必须立刻失效
  const switchName = `sw_${tag}`
  const switchSecret = hex(32)
  const switchDevice = uuid()
  const first = await registerUser(api, { username: `${switchName}_a`, deviceId: switchDevice, secret: switchSecret })
  const oldToken = first.token
  const second = await registerUser(api, { username: `${switchName}_b`, deviceId: switchDevice, secret: switchSecret })
  check('同一台设备可以注册到新账号', second.status === 200, second.text)
  check('服务端换发了新凭据', Boolean(second.json?.deviceId) && second.json.deviceId !== switchDevice, second.text)
  const oldStill = await api.call('/auth/me', { token: oldToken })
  check('换账号后旧凭据失效（401，不留后门）', oldStill.status === 401, oldStill.text)
  const newMe = await api.call('/auth/me', { token: second.token })
  check('新凭据可用', newMe.status === 200 && newMe.json?.username === `${switchName}_b`, newMe.text)

  log('\n[7] 错误响应结构')
  const notFound = await api.call('/nope', { token: tokenA })
  check('未知路由 404 且结构统一（error/message）', notFound.status === 404 && notFound.json?.error === 'not_found' && typeof notFound.json?.message === 'string', notFound.text)
  const badJson = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' })
  check('坏 JSON 400 且结构统一', badJson.status === 400 && (await badJson.json()).error === 'bad_json')

  return { results, pass: results.filter((r) => r.ok).length, fail: results.filter((r) => !r.ok).length }
}

/* ------------------------------ CLI ------------------------------ */

function arg(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const remote = arg('--url')
  const noStart = process.argv.includes('--no-start')
  const keep = process.argv.includes('--keep')
  const useState = process.argv.includes('--state')
  const explicitPort = arg('--port')

  let base = remote
  let started = false

  if (!base) {
    /*
     * 默认不占 8787：本机可能同时有人开着 `wrangler dev`（别的验证/调试），
     * 撞上去会打到别人的数据上，结果看起来像是"我们的断言挂了"。
     * 只有显式 --port 才复用那个端口。
     */
    const port = explicitPort ? Number(explicitPort) : null
    if (port) {
      base = `http://127.0.0.1:${port}`
      if (await portOpen(port)) {
        console.log(`检测到 ${base} 已有 Worker，直接用它们`)
      } else if (noStart) {
        console.error(
          `\n✗ ${base} 没有在跑，而且指定了 --no-start。\n` +
            `  先起 Worker：cd worker && .\\node_modules\\.bin\\wrangler.cmd dev --local --port ${port}\n` +
            `  或者去掉 --no-start 让本脚本自己起。\n`
        )
        process.exit(2)
      } else {
        const stateDir = useState ? join(WORKER_DIR, '.wrangler', 'state') : undefined
        console.log(`启动本地 Worker（${stateDir ? `复用 ${stateDir}` : '临时 D1'}，端口 ${port}）…`)
        await startWorker({ port, stateDir })
        started = true
        console.log(`Worker 就绪：${base}`)
      }
    } else if (noStart) {
      console.error('\n✗ --no-start 必须配合 --port <端口>（否则不知道该打哪里）。\n')
      process.exit(2)
    } else {
      const stateDir = useState ? join(WORKER_DIR, '.wrangler', 'state') : undefined
      console.log(`启动本地 Worker（${stateDir ? `复用 ${stateDir}` : '临时 D1'}，空闲端口）…`)
      const worker = await startWorker({ stateDir })
      started = true
      base = worker.base
      console.log(`Worker 就绪：${base}`)
    }
  }

  const cleanup = () => {
    if (started && !keep) stopWorker()
  }
  process.on('exit', cleanup)
  process.on('SIGINT', () => {
    cleanup()
    process.exit(130)
  })

  console.log(`目标：${base}`)
  const { pass, fail } = await runAuthSuite({ base })
  console.log(`\n通过 ${pass} / ${pass + fail}`)
  if (started && keep) console.log(`（--keep：Worker 还在 ${base}，用完记得手动关）`)
  cleanup()
  process.exit(fail === 0 ? 0 : 1)
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]).replace(/\\/g, '/').endsWith('/scripts/verify-auth.mjs')
if (invokedDirectly) {
  main().catch((err) => {
    stopWorker()
    console.error('\n✗ 验收没跑起来：', err.message)
    process.exit(2)
  })
}
