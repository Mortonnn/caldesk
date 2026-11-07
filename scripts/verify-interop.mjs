/**
 * 跨端契约联调：桌面端同步协议 ↔ 手机端 REST 接口。
 *
 * 为什么需要这个脚本：
 *   桌面端走 `POST /sync/push`（payload = 整行 camelCase JSON 字符串），
 *   手机端走 `/api/cells` `/api/events`（Worker 把 payload 解析成业务字段）。
 *   两边各自有自己的单元测试，**但没有任何一个能发现「这边 stringify 的字段名和
 *   那边解析的键对不上」**——这类错误不会报错，只会让手机上少一条任务。
 *
 * 覆盖：
 *   1. 桌面端 push（含中文 / emoji / 引号 / 换行）→ 手机端 REST 逐字符一致
 *   2. 手机端写 → 桌面端 pull 拿到的 payload 结构正确（camelCase、updatedAt 是数字）
 *   3. 冲突收敛：旧版本被判定 stale、不覆盖新版本
 *   4. 跨账号隔离、无令牌 / 错令牌 / 设备撤销后立刻 401
 *   5. 单行 payload 超限按行拒绝（不炸整批）
 *
 * 自包含：自己起一个隔离的 `wrangler dev --local`（独立 `--persist-to` 临时目录），
 * 跑完杀掉，不碰 `worker/.wrangler/state` 里的开发数据。
 *
 * 用法：
 *   node scripts/verify-interop.mjs              # 自己起本地 Worker
 *   node scripts/verify-interop.mjs --url http://127.0.0.1:8787   # 用已经起好的
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const urlIdx = argv.indexOf('--url')
const EXTERNAL_URL = urlIdx >= 0 ? argv[urlIdx + 1] : null

let pass = 0
let fail = 0
const ok = (m) => {
  pass += 1
  console.log('  ✓', m)
}
const bad = (m) => {
  fail += 1
  console.error('  ✗', m)
}
const check = (cond, m) => (cond ? ok(m) : bad(m))
const section = (t) => console.log(`\n[${t}]`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 在 worker/ 下起一个隔离的本地 Worker，返回 { url, stop } */
async function startWorker() {
  const wranglerJs = join(root, 'worker/node_modules/wrangler/bin/wrangler.js')
  if (!existsSync(wranglerJs)) {
    throw new Error(`找不到 ${wranglerJs}，请先在 worker/ 里 npm install`)
  }
  const persistDir = mkdtempSync(join(tmpdir(), 'caldesk-interop-d1-'))

  for (const port of [8811, 8812, 8813, 8814, 8815]) {
    const child = spawn(
      process.execPath,
      [wranglerJs, 'dev', '--local', '--port', String(port), '--persist-to', persistDir],
      {
        cwd: join(root, 'worker'),
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '', WRANGLER_SEND_METRICS: 'false' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      }
    )
    let log = ''
    child.stdout.on('data', (d) => {
      log += d
    })
    child.stderr.on('data', (d) => {
      log += d
    })
    let exited = false
    child.on('exit', () => {
      exited = true
    })

    const base = `http://127.0.0.1:${port}`
    let ready = false
    for (let i = 0; i < 60; i += 1) {
      if (exited) break
      try {
        const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) })
        if (res.ok) {
          const json = await res.json()
          if (json?.ok) {
            ready = true
            break
          }
        }
      } catch {
        /* 还没起来 */
      }
      await sleep(700)
    }

    if (ready) {
      console.log(`（本地 Worker 已就绪：${base}，D1 持久化目录 ${persistDir}）`)
      return {
        url: base,
        stop: async () => {
          await killTree(child)
          try {
            rmSync(persistDir, { recursive: true, force: true })
          } catch {
            /* ignore */
          }
        }
      }
    }

    await killTree(child)
    if (!/Address already in use/i.test(log)) {
      // 不是端口冲突，没必要换端口再试
      throw new Error(`wrangler dev 启动失败：\n${log.slice(-1500)}`)
    }
  }
  try {
    rmSync(persistDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  throw new Error('8811-8815 都被占用，起不来本地 Worker')
}

async function killTree(child) {
  if (!child || child.exitCode !== null) return
  try {
    if (process.platform === 'win32') {
      // wrangler 会再拉一个 workerd 子进程，只 kill 父进程会留下占着端口的孤儿
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } else {
      child.kill('SIGTERM')
    }
  } catch {
    /* ignore */
  }
  for (let i = 0; i < 20 && child.exitCode === null; i += 1) await sleep(250)
}

/* ------------------------------------------------------------------ */

let worker = null
let BASE = EXTERNAL_URL
if (!BASE) {
  try {
    worker = await startWorker()
    BASE = worker.url
  } catch (e) {
    console.error(`\n起不来本地 Worker：${e.message}`)
    console.error('可以手动起一个再传 --url：\n  cd worker && npx wrangler dev --local --port 8787')
    console.error('  node scripts/verify-interop.mjs --url http://127.0.0.1:8787\n')
    process.exit(2)
  }
}


async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, json, text }
}

const hex = (n) =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('')

async function register(username, deviceName) {
  const r = await api('/auth/register', {
    method: 'POST',
    body: {
      username,
      password: 'Abcdef123!@#',
      deviceId: crypto.randomUUID(),
      secret: hex(32),
      deviceName,
    }
  })
  if (r.status !== 200) throw new Error(`注册失败 ${r.status}: ${r.text}`)
  return { accountId: r.json.accountId, deviceId: r.json.deviceId, token: `${r.json.deviceId}.${r.json.secret}` }
}

try {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`
  const CAL = `cal-${stamp}`
  const CELL_ID = `${CAL}:2026-11-07`
  const EV_ID = `ev-${stamp}`
  const now = Date.now()

  /* ---------------------------------------------------------------- */
  section('1. 桌面端 /sync/push（整行 camelCase JSON payload）')
  const desktop = await register(`d_${stamp}`, '桌面端')
  const other = await register(`o_${stamp}`, '别人')
  ok(`账号 D = ${desktop.accountId}`)
  ok(`账号 O = ${other.accountId}`)

  const pushSets = [
    [
      'calendars',
      [
        {
          id: CAL,
          // 中文 / emoji / JSON 特殊字符 / 换行，一条全踩到
          name: '工作 "主力" 🎯 \n 第二行',
          color: '#5b8cff',
          sort: 0,
          createdAt: now,
          updatedAt: now,
          deletedAt: null
        }
      ]
    ],
    [
      'day_cells',
      [
        {
          id: CELL_ID,
          calendarId: CAL,
          date: '2026-11-07',
          text: '买牛奶\n~~已完成的~~\n🎉 带 emoji 的一行',
          color: null,
          updatedAt: now,
          deletedAt: null
        }
      ]
    ],
    [
      'events',
      [
        {
          id: EV_ID,
          calendarId: CAL,
          kind: 'countdown',
          title: '倒数日 "测试"',
          notes: null,
          allDay: true,
          start: '2026-11-07T00:00:00.000Z',
          end: null,
          rrule: null,
          remindMinutes: null,
          targetDate: '2026-12-31',
          color: null,
          completed: false,
          createdAt: now,
          updatedAt: now,
          deletedAt: null
        }
      ]
    ]
  ]
  for (const [table, set] of pushSets) {
    const r = await api('/sync/push', {
      method: 'POST',
      token: desktop.token,
      body: {
        table,
        rows: set.map((row) => ({
          id: row.id,
          updatedAt: row.updatedAt,
          deletedAt: row.deletedAt,
          payload: JSON.stringify(row)
        }))
      }
    })
    check(r.status === 200 && r.json?.failed === 0, `push ${table} → ${r.status} ${r.text.slice(0, 80)}`)
  }

  /* ---------------------------------------------------------------- */
  section('2. 手机端 REST 读到桌面端推的数据（字段名 / 类型 / 编码对齐）')
  const cals = await api('/api/calendars', { token: desktop.token })
  const calList = Array.isArray(cals.json) ? cals.json : (cals.json?.calendars ?? [])
  const cal = calList.find((c) => c.id === CAL)
  check(Boolean(cal), '/api/calendars 含刚推的视图')
  check(cal?.name === '工作 "主力" 🎯 \n 第二行', `视图名逐字符一致 → ${JSON.stringify(cal?.name)}`)
  check(cal?.color === '#5b8cff', `视图颜色一致 → ${cal?.color}`)

  const cells = await api(`/api/cells?calendar=${encodeURIComponent(CAL)}&from=2026-11-01&to=2026-11-30`, {
    token: desktop.token
  })
  const cellList = Array.isArray(cells.json) ? cells.json : (cells.json?.cells ?? [])
  const cell = cellList.find((c) => c.date === '2026-11-07')
  check(Boolean(cell), '/api/cells 含 2026-11-07')
  check(
    cell?.text === '买牛奶\n~~已完成的~~\n🎉 带 emoji 的一行',
    `日格文本逐字符一致 → ${JSON.stringify(cell?.text)}`
  )

  const events = await api(`/api/events?calendar=${encodeURIComponent(CAL)}&from=2026-11-01&to=2026-11-30`, {
    token: desktop.token
  })
  const evList = Array.isArray(events.json) ? events.json : (events.json?.events ?? [])
  const ev = evList.find((e) => (e.id ?? e.event?.id) === EV_ID)
  check(Boolean(ev), '/api/events 含倒数日事件')
  const evObj = ev?.event ?? ev
  check(evObj?.kind === 'countdown', `kind 一致 → ${evObj?.kind}`)
  check(evObj?.targetDate === '2026-12-31', `targetDate 一致 → ${evObj?.targetDate}`)
  check(evObj?.title === '倒数日 "测试"', `标题逐字符一致 → ${JSON.stringify(evObj?.title)}`)

  /* ---------------------------------------------------------------- */
  section('3. 手机端写 → 桌面端 /sync/pull 读到')
  // 注意：REST 层字段叫 `calendar`，sync payload 里叫 `calendarId`（跨层命名不一致，已知）
  const setRes = await api('/api/cells/set', {
    method: 'POST',
    token: desktop.token,
    body: { calendar: CAL, date: '2026-11-09', text: '手机写的\n第二行' }
  })
  check([200, 201].includes(setRes.status), `手机端 /api/cells/set → ${setRes.status}`)

  const pulled = await api('/sync/pull?table=day_cells&since=0&limit=500', { token: desktop.token })
  const rows = pulled.json?.rows ?? []
  const phoneRow = rows.find((r) => String(r.id).endsWith(':2026-11-09'))
  check(Boolean(phoneRow), `桌面端 pull 到手机写的那一行（共 ${rows.length} 行）`)
  let phonePayload = null
  try {
    phonePayload = JSON.parse(phoneRow?.payload ?? 'null')
  } catch {
    /* ignore */
  }
  check(Boolean(phonePayload), 'payload 是合法 JSON（桌面端能 JSON.parse）')
  check(phonePayload?.text === '手机写的\n第二行', `payload.text 一致 → ${JSON.stringify(phonePayload?.text)}`)
  check(typeof phonePayload?.updatedAt === 'number', 'payload.updatedAt 是数字')
  check('calendarId' in (phonePayload ?? {}), 'payload 字段是 camelCase（calendarId），与 db.ts 一致')

  /* ---------------------------------------------------------------- */
  section('4. 冲突收敛（LWW：updatedAt 大者胜）')
  await api('/api/cells/set', {
    method: 'POST',
    token: desktop.token,
    body: { calendar: CAL, date: '2026-11-09', text: '手机端后来的版本' }
  })
  const stalePush = await api('/sync/push', {
    method: 'POST',
    token: desktop.token,
    body: {
      table: 'day_cells',
      rows: [
        {
          id: `${CAL}:2026-11-09`,
          updatedAt: 1,
          deletedAt: null,
          payload: JSON.stringify({
            id: `${CAL}:2026-11-09`,
            calendarId: CAL,
            date: '2026-11-09',
            text: '过期版本不该覆盖',
            color: null,
            updatedAt: 1,
            deletedAt: null
          })
        }
      ]
    }
  })
  check(stalePush.json?.stale === 1, `旧版本被判 stale（stale=${stalePush.json?.stale}）`)
  const after = await api(`/api/cells?calendar=${encodeURIComponent(CAL)}&from=2026-11-09&to=2026-11-09`, {
    token: desktop.token
  })
  const afterList = Array.isArray(after.json) ? after.json : (after.json?.cells ?? [])
  check(afterList[0]?.text === '手机端后来的版本', `旧版本没覆盖新版本 → ${JSON.stringify(afterList[0]?.text)}`)

  /* ---------------------------------------------------------------- */
  section('5. 跨账号隔离')
  const leakCals = await api('/api/calendars', { token: other.token })
  const leakList = Array.isArray(leakCals.json) ? leakCals.json : (leakCals.json?.calendars ?? [])
  check(!leakList.some((c) => c.id === CAL), `别人看不到 D 的视图（${leakList.length} 个）`)
  const leakPull = await api('/sync/pull?table=day_cells&since=0&limit=500', { token: other.token })
  check(
    !(leakPull.json?.rows ?? []).some((r) => String(r.id).includes(CAL)),
    `别人 pull 不到 D 的日格（${(leakPull.json?.rows ?? []).length} 行）`
  )
  const noAuth = await api('/api/calendars')
  check(noAuth.status === 401 || noAuth.status === 403, `无令牌访问 → ${noAuth.status}`)
  const badToken = await api('/api/calendars', { token: `${desktop.deviceId}.${'0'.repeat(64)}` })
  check(badToken.status === 401, `错误 secret → ${badToken.status}`)

  /* ---------------------------------------------------------------- */
  section('6. 撤销设备后立刻 401')
  check((await api('/auth/me', { token: desktop.token })).status === 200, '/auth/me 撤销前 200')
  const second = await api('/auth/login', {
    method: 'POST',
    body: {
      username: `d_${stamp}`,
      password: 'Abcdef123!@#',
      deviceId: crypto.randomUUID(),
      secret: hex(32),
      deviceName: '第二台'
    }
  })
  check(second.status === 200, `同账号登录第二台设备 → ${second.status}`)
  if (second.status === 200) {
    const secondToken = `${second.json.deviceId}.${second.json.secret}`
    const revoked = await api('/devices/revoke', {
      method: 'POST',
      token: desktop.token,
      body: { deviceId: second.json.deviceId }
    })
    check(revoked.status === 200, `撤销第二台 → ${revoked.status}`)
    check((await api('/api/calendars', { token: secondToken })).status === 401, '被撤销的设备立刻 401')
  }

  /* ---------------------------------------------------------------- */
  section('7. 单行 payload 超限按行拒绝（不炸整批）')
  const big = await api('/sync/push', {
    method: 'POST',
    token: desktop.token,
    body: {
      table: 'notes',
      rows: [
        {
          id: `big-${stamp}`,
          updatedAt: Date.now(),
          deletedAt: null,
          payload: JSON.stringify({
            id: `big-${stamp}`,
            calendarId: CAL,
            title: 'big',
            content: 'x'.repeat(600 * 1024),
            pinned: false,
            color: null,
            createdAt: now,
            updatedAt: Date.now(),
            deletedAt: null
          })
        }
      ]
    }
  })
  check(
    big.status === 200 && big.json?.failed === 1,
    `600KB 单行被拒且整批不失败 → ${big.text.slice(0, 100)}`
  )
} catch (e) {
  bad(`异常：${e?.stack ?? e}`)
} finally {
  if (worker) await worker.stop()
}

console.log(`\n${'─'.repeat(60)}`)
if (fail === 0) {
  console.log(`结果：全部通过 ✅  通过 ${pass} 项`)
} else {
  console.log(`结果：${fail} 项失败 ❌  通过 ${pass} 项`)
}
console.log('─'.repeat(60))
process.exit(fail === 0 ? 0 : 1)
