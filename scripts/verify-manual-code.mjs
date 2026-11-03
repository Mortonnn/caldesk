/**
 * 模拟手机端「手动输入配对码」的完整流程（和 src/renderer/src/data.ts 的 pairJoin 一致）：
 *   1. POST /pair/join（只带 code，不带 pairId）
 *   2. GET /pair/status 轮询
 *   3. 批准后拉数据
 *
 * 用法：node scripts/verify-manual-code.mjs [serverUrl] [code]
 */
const BASE = (process.argv[2] || 'https://caldesk.ilikeu.cc.cd').replace(/\/$/, '')
const CODE = process.argv[3] || ''

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

async function main() {
  console.log(`目标：${BASE}`)
  console.log(`配对码：${CODE || '(没给)'}\n`)

  if (!/^\d{6}$/.test(CODE)) {
    console.error('需要一个 6 位配对码')
    process.exit(2)
  }

  const deviceId = crypto.randomUUID()
  const deviceSecret = hex(32)

  // 1. 只带 code 加入（没有 pairId）
  const joined = await api('/pair/join', {
    method: 'POST',
    body: {
      pairId: '',
      code: CODE,
      deviceId,
      accountSecret: deviceSecret,
      deviceName: '手动码手机'
    }
  })
  check(joined.status === 200, `POST /pair/join（只带 code）→ ${joined.status}`)
  if (joined.status !== 200) {
    console.log('响应：', joined.text.slice(0, 200))
    process.exit(1)
  }

  // 2. 状态查询（同样不带 pairId）
  const st = await api(`/pair/status?deviceId=${deviceId}&code=${CODE}`)
  check(st.json?.status === 'pending', `GET /pair/status（只带 code）→ ${st.json?.status}`)

  // 3. 未批准时不能同步
  const denied = await api('/sync/pull?table=calendars', { token: `${deviceId}.${deviceSecret}` })
  check(denied.status === 401, `未批准时同步 → 401（实际 ${denied.status}）`)

  // 4. 电脑批准（用本机真实凭据）
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { homedir } = await import('node:os')
  const identity = JSON.parse(
    readFileSync(join(homedir(), 'AppData', 'Roaming', 'caldesk', 'identity.json'), 'utf-8')
  )
  const pcToken = `${identity.deviceId}.${identity.deviceSecret}`

  const pending = await api('/pair/pending?pairId=`, { token: pcToken })
  const list = await api('/pair/pending', { token: pcToken })
  const devices = list.json?.devices ?? []
  check(Array.isArray(devices), `电脑待批准列表 → ${devices.length} 台`)

  // 通过 code 找到 pairId 再批准
  const pairs = await api(`/pair/status?deviceId=${deviceId}&code=${CODE}`, { token: pcToken })
  check(pairs.status === 200 || pairs.json?.status !== undefined, '电脑能查到这次配对')

  // 用 /pair/approve：pairId 从 pairings 里拿（通过 /pair/pending 之外我们直接用服务端能力）
  // 这里改为让电脑批准：从二维码文件里拿 pairId
  const qrPath = join(homedir(), 'AppData', 'Roaming', 'caldesk', 'pair-qr.txt')
  let pairId = ''
  try {
    pairId = JSON.parse(readFileSync(qrPath, 'utf-8')).p ?? ''
  } catch { /* 没有就用服务器查 */ }
  const approved = await api('/pair/approve', {
    method: 'POST',
    body: { pairId, deviceId },
    token: pcToken
  })
  check(approved.status === 200, `POST /pair/approve → ${approved.status}`)

  // 5. 批准后可以同步
  const st2 = await api(`/pair/status?deviceId=${deviceId}&code=${CODE}`)
  check(st2.json?.status === 'approved', `GET /pair/status → ${st2.json?.status}`)

  const pull = await api('/sync/pull?table=calendars&since=0', { token: `${deviceId}.${deviceSecret}` })
  check(pull.status === 200, `批准后手机同步 → ${pull.status}`)

  console.log(`\n────────────────────────────────────────────────────`)
  console.log(`结果：${fail === 0 ? '全部通过 ✅' : '有失败 ❌'}  通过 ${pass} 项，失败 ${fail} 项`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(2) })
