/**
 * 线上端到端验收：直接打 https://caldesk.ilikeu.cc.cd
 *
 * 覆盖：建账号 → 扫码配对 → 批准 → 明文同步 → 账号隔离 → 吊销失效。
 * 用法：node scripts/verify-online.mjs [baseUrl]
 */
const BASE = (process.argv[2] || 'https://caldesk.ilikeu.cc.cd').replace(/\/$/, '')

let pass = 0
let fail = 0
function ok(msg) {
  pass += 1
  console.log(`✅ ${msg}`)
}
function bad(msg) {
  fail += 1
  console.log(`❌ ${msg}`)
}
function check(cond, msg) {
  if (cond) ok(msg)
  else bad(msg)
}

const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('')
const uuid = () => crypto.randomUUID()

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
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, json, text }
}

const device = () => ({ deviceId: uuid(), accountSecret: hex(32) })
const bearer = (d) => `${d.deviceId}.${d.accountSecret}`

async function main() {
  console.log(`目标：${BASE}\n`)

  // 1. 健康检查
  {
    const r = await api('/health')
    check(r.status === 200 && r.json?.ok === true, 'GET /health → 200 ok')
  }

  // 2. 无凭据访问同步接口 → 401
  {
    const r = await api('/devices')
    check(r.status === 401, `无凭据访问 /devices → 401（实际 ${r.status}）`)
  }

  // 3. 建账号 A
  const pc = device()
  const accountIdA = (await api('/account/create', {
    method: 'POST',
    body: {
      invite: '',
      accountName: '验收账号A',
      deviceId: pc.deviceId,
      accountSecret: pc.accountSecret,
      deviceName: '验收电脑'
    }
  })).json?.accountId
  check(Boolean(accountIdA), `POST /account/create → accountId=${accountIdA}`)

  // 4. 建账号 B
  const other = device()
  const accountIdB = (await api('/account/create', {
    method: 'POST',
    body: {
      invite: '',
      accountName: '验收账号B',
      deviceId: other.deviceId,
      accountSecret: other.accountSecret,
      deviceName: '别人的电脑'
    }
  })).json?.accountId
  check(Boolean(accountIdB) && accountIdB !== accountIdA, 'POST /account/create（第二个账号）')

  // 5. 电脑发起配对
  const started = await api('/pair/start', { method: 'POST', body: {}, token: bearer(pc) })
  const pairId = started.json?.pairId
  const code = started.json?.code
  check(started.status === 200 && Boolean(pairId) && /^\d{6}$/.test(code ?? ''), `POST /pair/start → 6 位配对码 ${code}`)

  // 6. 手机扫码加入
  const phone = device()
  const joined = await api('/pair/join', {
    method: 'POST',
    body: {
      pairId,
      code,
      deviceId: phone.deviceId,
      accountSecret: phone.accountSecret,
      deviceName: '验收手机'
    }
  })
  check(joined.status === 200, `POST /pair/join → ${joined.status}`)

  // 7. 待批准时手机不能同步
  {
    const r = await api('/sync/pull?table=calendars', { token: bearer(phone) })
    check(r.status === 401, `未批准的手机同步 → 401（实际 ${r.status}）`)
  }

  // 8. 状态查询
  {
    const r = await api(`/pair/status?pairId=${pairId}&deviceId=${phone.deviceId}&code=${code}`)
    check(r.json?.status === 'pending', `GET /pair/status → ${r.json?.status}`)
  }

  // 9. 待批准列表 + 批准
  {
    const list = await api(`/pair/pending?pairId=${pairId}`, { token: bearer(pc) })
    check(
      Array.isArray(list.json?.devices) && list.json.devices.some((d) => d.deviceId === phone.deviceId),
      'GET /pair/pending → 列出待批准手机'
    )
    const app = await api('/pair/approve', {
      method: 'POST',
      body: { pairId, deviceId: phone.deviceId },
      token: bearer(pc)
    })
    check(app.status === 200, 'POST /pair/approve → 批准成功')
  }

  // 10. 批准后手机可以同步
  {
    const st = await api(`/pair/status?pairId=${pairId}&deviceId=${phone.deviceId}&code=${code}`)
    check(st.json?.status === 'approved', `GET /pair/status → ${st.json?.status}`)

    const pull = await api('/sync/pull?table=calendars', { token: bearer(phone) })
    check(pull.status === 200 && Array.isArray(pull.json?.rows), '手机 GET /sync/pull → 200')
  }

  // 11. 明文 push/pull 往返
  const rowId = uuid()
  const rowPayload = JSON.stringify({ id: rowId, calendarId: 'cal-1', name: '测试视图', updatedAt: Date.now(), deletedAt: null })
  {
    const push = await api('/sync/push', {
      method: 'POST',
      body: { table: 'calendars', rows: [{ id: rowId, updatedAt: Date.now(), deletedAt: null, payload: rowPayload }] },
      token: bearer(phone)
    })
    check(push.json?.written === 1, `POST /sync/push → written=${push.json?.written}`)

    const pull = await api(`/sync/pull?table=calendars&since=0`, { token: bearer(pc) })
    const hit = pull.json?.rows?.find((r) => r.id === rowId)
    check(Boolean(hit), '电脑拉到手机推的行')
    check(hit?.payload === rowPayload, 'payload 明文原样往返')
    try {
      check(JSON.parse(hit?.payload ?? '{}').name === '测试视图', 'payload 能读出中文业务字段')
    } catch {
      bad('payload 不是合法 JSON')
    }
  }

  // 12. 账号隔离：B 拉不到 A 的数据
  {
    const pull = await api(`/sync/pull?table=calendars&since=0`, { token: bearer(other) })
    const hit = pull.json?.rows?.find((r) => r.id === rowId)
    check(!hit, 'B 账号拉不到 A 的数据')
  }

  // 13. 同一行 id 在两个账号下互不覆盖
  {
    const sameId = uuid()
    const now = Date.now()
    await api('/sync/push', {
      method: 'POST',
      body: { table: 'notes', rows: [{ id: sameId, updatedAt: now, deletedAt: null, payload: JSON.stringify({ id: sameId, title: 'A 的便签' }) }] },
      token: bearer(pc)
    })
    await api('/sync/push', {
      method: 'POST',
      body: { table: 'notes', rows: [{ id: sameId, updatedAt: now, deletedAt: null, payload: JSON.stringify({ id: sameId, title: 'B 的便签' }) }] },
      token: bearer(other)
    })
    const aPull = await api(`/sync/pull?table=notes&since=0`, { token: bearer(pc) })
    const bPull = await api(`/sync/pull?table=notes&since=0`, { token: bearer(other) })
    const aTitle = aPull.json?.rows?.find((r) => r.id === sameId)?.payload
    const bTitle = bPull.json?.rows?.find((r) => r.id === sameId)?.payload
    check(aTitle?.includes('A 的便签') && bTitle?.includes('B 的便签'), '同一行 id 在 A/B 账号下互不覆盖')
  }

  // 14. REST 隔离（手机端走 REST）
  {
    const created = await api('/api/calendars/create', {
      method: 'POST',
      body: { name: 'A 的视图' },
      token: bearer(pc)
    })
    check(created.status === 200, 'POST /api/calendars/create → 200')

    const aList = await api('/api/calendars', { token: bearer(pc) })
    const bList = await api('/api/calendars', { token: bearer(other) })
    const aNames = (aList.json ?? []).map((c) => c.name)
    const bNames = (bList.json ?? []).map((c) => c.name)
    check(aNames.includes('A 的视图'), 'A 的 REST 列表里有自己的视图')
    check(!bNames.includes('A 的视图'), 'B 的 REST 列表里没有 A 的视图')
  }

  // 15. 伪造凭据 → 401
  {
    const r = await api('/devices', { token: `${uuid()}.${hex(32)}` })
    check(r.status === 401, `伪造凭据 → 401（实际 ${r.status}）`)
  }

  // 16. 设备列表 + 在线数
  {
    const r = await api('/devices', { token: bearer(pc) })
    const devices = r.json?.devices ?? []
    check(devices.length >= 2, `GET /devices → ${devices.length} 台设备`)
    check(devices.some((d) => d.current === true), '设备列表里有「本机」标记')
  }

  // 17. 不能吊销自己
  {
    const r = await api('/devices/revoke', { method: 'POST', body: { deviceId: pc.deviceId }, token: bearer(pc) })
    check(r.status === 400, `吊销自己 → 400（实际 ${r.status}）`)
  }

  // 18. 吊销手机 → 手机立即失效
  {
    const r = await api('/devices/revoke', { method: 'POST', body: { deviceId: phone.deviceId }, token: bearer(pc) })
    check(r.status === 200, 'POST /devices/revoke → 吊销成功')
    const after = await api('/sync/pull?table=calendars', { token: bearer(phone) })
    check(after.status === 401, `吊销后手机同步 → 401（实际 ${after.status}）`)
  }

  console.log(`\n────────────────────────────────────────────────────`)
  console.log(`结果：${fail === 0 ? '全部通过 ✅' : '有失败 ❌'}  通过 ${pass} 项，失败 ${fail} 项`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('验收脚本异常：', err)
  process.exit(2)
})
