/**
 * 桌面端 ↔ 线上 Worker 的真实验证：
 *   1. 用真实应用（Electron）建账号、写 identity.json
 *   2. 用 curl 模拟手机扫码加入（pair/join）
 *   3. 电脑端批准
 *   4. 手机推数据 → 电脑拉回来
 *   5. 电脑写数据 → 手机拉得到
 *
 * 用法：node scripts/verify-desktop-e2e.mjs
 */
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const BASE = 'https://your-worker.example.com'
const APP = join(process.cwd(), 'release', 'win-unpacked', 'caldesk.exe')
const USER_DATA = join(tmpdir(), 'caldesk-e2e-' + Date.now())

let pass = 0
let fail = 0
const ok = (m) => { pass += 1; console.log(`✅ ${m}`) }
const bad = (m) => { fail += 1; console.log(`❌ ${m}`) }
const check = (c, m) => (c ? ok(m) : bad(m))

const hex = (n) =>
  [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('')

async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, json, text }
}

function runApp(args, timeoutMs = 60000) {
  const env = { ...process.env }
  // 必须彻底删掉，否则 Electron 会以纯 Node 模式启动（报 bad option）
  delete env.ELECTRON_RUN_AS_NODE
  return new Promise((resolve) => {
    const child = spawn(APP, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { out += d.toString() })
    const timer = setTimeout(() => { try { child.kill() } catch { /* ignore */ } resolve(out) }, timeoutMs)
    child.on('exit', () => { clearTimeout(timer); resolve(out) })
  })
}

async function main() {
  console.log(`目标：${BASE}`)
  console.log(`用户数据目录：${USER_DATA}\n`)

  // 1. 先用「账号创建 + 手动写 identity.json」模拟应用行为
  const deviceId = crypto.randomUUID()
  const deviceSecret = hex(32)
  const created = await api('/account/create', {
    method: 'POST',
    body: {
      invite: '',
      accountName: '桌面端验收',
      deviceId,
      accountSecret: deviceSecret,
      deviceName: '验收电脑'
    }
  })
  const accountId = created.json?.accountId
  check(Boolean(accountId), `建账号 → accountId=${accountId}`)

  const identity = {
    accountId,
    deviceId,
    deviceSecret,
    deviceName: '验收电脑',
    serverUrl: BASE,
    createdAt: Date.now()
  }
  const idPath = join(USER_DATA, 'identity.json')
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(idPath, JSON.stringify(identity, null, 2))
  ok(`写入 identity.json：${idPath}`)

  // 2. 模拟手机扫码加入
  const phone = { deviceId: crypto.randomUUID(), deviceSecret: hex(32) }
  const started = await api('/pair/start', { method: 'POST', body: {}, token: `${deviceId}.${deviceSecret}` })
  const pairId = started.json?.pairId
  const code = started.json?.code
  check(Boolean(pairId), `电脑发起配对 → 码 ${code}`)

  const joined = await api('/pair/join', {
    method: 'POST',
    body: {
      pairId,
      code,
      deviceId: phone.deviceId,
      accountSecret: phone.deviceSecret,
      deviceName: '验收手机'
    }
  })
  check(joined.status === 200, `手机扫码加入 → ${joined.status}`)

  // 3. 电脑批准（用真实接口路径，和 UI 走同一条）
  const pending = await api(`/pair/pending?pairId=${pairId}`, { token: `${deviceId}.${deviceSecret}` })
  check(pending.json?.devices?.some((d) => d.deviceId === phone.deviceId), '电脑看到待批准设备')
  const approved = await api('/pair/approve', {
    method: 'POST',
    body: { pairId, deviceId: phone.deviceId },
    token: `${deviceId}.${deviceSecret}`
  })
  check(approved.status === 200, '电脑批准手机')

  // 4. 手机推数据 → 电脑拉
  const rowId = crypto.randomUUID()
  const payload = JSON.stringify({
    id: rowId,
    calendarId: 'e2e-cal',
    date: '2026-11-03',
    text: '手机写的任务',
    updatedAt: Date.now(),
    deletedAt: null
  })
  await api('/sync/push', {
    method: 'POST',
    body: { table: 'day_cells', rows: [{ id: rowId, updatedAt: Date.now(), deletedAt: null, payload }] },
    token: `${phone.deviceId}.${phone.deviceSecret}`
  })
  const pulled = await api('/sync/pull?table=day_cells&since=0', { token: `${deviceId}.${deviceSecret}` })
  const hit = pulled.json?.rows?.find((r) => r.id === rowId)
  check(Boolean(hit), '电脑拉到手机推的数据')
  check(hit?.payload?.includes('手机写的任务'), '内容正确（明文可见）')

  // 5. 真实应用跑一次同步（用 --sync-once + 指定 userData）
  console.log('\n启动真实应用跑一次同步…')
  const log = await runApp([
    '--user-data-dir=' + USER_DATA,
    '--sync-once'
  ], 90000)
  const syncLine = log.split('\n').find((l) => l.includes('sync-once'))
  ok(`应用输出：${syncLine ? syncLine.slice(0, 260) : '(没抓到 sync-once 行)'}`)
  check(log.includes('"ok":true'), '应用同步成功（ok:true）')
  const missing = log.includes('还没有加入账号')
  check(!missing, '应用认出了 identity.json（不是"未加入账号"）')

  // 6. 设备列表
  const devices = await api('/devices', { token: `${deviceId}.${deviceSecret}` })
  check(devices.json?.devices?.length >= 2, `设备列表：${devices.json?.devices?.length} 台`)

  // 7. 清理
  try { rmSync(USER_DATA, { recursive: true, force: true }) } catch { /* ignore */ }

  console.log(`\n────────────────────────────────────────────────────`)
  console.log(`结果：${fail === 0 ? '全部通过 ✅' : '有失败 ❌'}  通过 ${pass} 项，失败 ${fail} 项`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error('异常：', e); process.exit(2) })
