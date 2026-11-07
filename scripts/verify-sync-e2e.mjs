/**
 * 同步协议端到端验收（自带 Worker 启停，默认用全新的临时 D1）
 *
 *   node scripts/verify-sync-e2e.mjs            # 起 Worker → 跑断言 → 关掉，退出码 = 结果
 *   node scripts/verify-sync-e2e.mjs --keep     # 跑完不关（排查用，会打印地址）
 *   node scripts/verify-sync-e2e.mjs --port 8899
 *
 * 覆盖（全部是对真实 HTTP 接口的断言，不 mock 服务端）：
 *   1. 两个账号各自注册 → 各自推拉 → 互相看不到（账号隔离）
 *   2. 冲突：updatedAt 不同（新的赢 / 乱序旧数据不覆盖）+ updatedAt 完全相同
 *      （按 README 的规则 deviceId 字典序大者胜），最后两端必须收敛到同一份数据
 *   3. 删除墓碑参与同步，且会抬高 /api/changes 的水位
 *   4. 分页：250 行同一个 updatedAt 也要能全部拉到（复合游标，不能只按时间戳翻页）
 *   5. 慢钟：客户端时间戳比服务端水位还旧时，写入要被抬到水位之上，别的端拉得到
 *   6. REST 写入不会被 LWW 守卫静默吞掉（append 一行后读回来必须还在）
 *   7. 撤销设备后该凭据立刻 401（/auth/me、/sync/pull、/api/* 全挂）
 */
import { startWorker, stopWorker, freePort, readDevVars, makeApi, hex, uuid } from './verify-auth.mjs'

const argv = process.argv.slice(2)
const keep = argv.includes('--keep')
const portArg = argv.indexOf('--port')
const requestedPort = portArg >= 0 ? Number(argv[portArg + 1]) : undefined

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    fail += 1
    failures.push(name)
    console.log(`  ✗ ${name}${detail ? `\n      ${String(detail).slice(0, 400)}` : ''}`)
  }
}
function section(title) {
  console.log(`\n${title}`)
}

const STRONG = 'Abcdef123!x'
const TAG = Date.now().toString(36) + Math.random().toString(36).slice(2, 5)

let worker = null
let api = null

async function main() {
  console.log('启动本地 Worker（全新临时 D1）…')
  worker = await startWorker({ port: requestedPort ?? (await freePort()) })
  api = makeApi(worker.base)
  
  console.log(`Worker 就绪：${worker.base}`)

  /* ---------------- 1. 两个账号 ---------------- */
  section('[1] 注册两个账号，各自推拉')
  const devA1 = '11111111-1111-4111-8111-111111111111' // 故意固定：平局测试要用字典序
  const devA2 = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
  const regA = await api.call('/auth/register', {
    method: 'POST',
    body: { username: `e2e_a_${TAG}`, password: STRONG, deviceId: devA1, secret: hex(32), deviceName: 'A-pc' }
  })
  check('账号 A 注册成功', regA.status === 200 && Boolean(regA.json?.accountId), regA.text)
  const tokenA1 = `${regA.json.deviceId}.${regA.json.secret}`

  // 第二台设备登录同一个账号（deviceId 固定为 ffff…，login 时设备不存在会原样插入）
  const loginA2 = await api.call('/auth/login', {
    method: 'POST',
    body: { username: `e2e_a_${TAG}`, password: STRONG, deviceId: devA2, secret: hex(32), deviceName: 'A-phone' }
  })
  check('A 的第二台设备可以登录同一账号', loginA2.status === 200 && loginA2.json?.accountId === regA.json.accountId, loginA2.text)
  check('平局用的两台设备 id 都已就位', loginA2.json?.deviceId === devA2, JSON.stringify(loginA2.json))
  const tokenA2 = `${loginA2.json.deviceId}.${loginA2.json.secret}`

  const regB = await api.call('/auth/register', {
    method: 'POST',
    body: { username: `e2e_b_${TAG}`, password: STRONG, deviceId: uuid(), secret: hex(32), deviceName: 'B-pc' }
  })
  check('账号 B 注册成功', regB.status === 200, regB.text)
  const tokenB = `${regB.json.deviceId}.${regB.json.secret}`
  check('两个账号的 accountId 不同', regA.json.accountId !== regB.json.accountId)

  const push = (token, table, rows) => api.call('/sync/push', { method: 'POST', token, body: { table, rows } })
  const pullAll = async (token, table) => {
    const out = []
    let since = 0
    let sinceId = ''
    for (let i = 0; i < 30; i += 1) {
      const res = await api.call(`/sync/pull?table=${table}&since=${since}&sinceId=${encodeURIComponent(sinceId)}&limit=200`, { token })
      if (res.status !== 200) throw new Error(`pull ${res.status} ${res.text}`)
      out.push(...res.json.rows)
      if (res.json.rows.length === 0) break
      since = res.json.cursor
      sinceId = res.json.cursorId
    }
    return out
  }
  const rowOf = (id, name, updatedAt, deletedAt = null) => ({
    id,
    updatedAt,
    deletedAt,
    payload: JSON.stringify({ id, name, updatedAt, deletedAt })
  })
  const byId = (rows) => new Map(rows.map((r) => [r.id, r]))

  const t0 = Date.now()
  const aPush = await push(tokenA1, 'calendars', [rowOf('cal_a1', 'A 的日历', t0)])
  check('A 推送成功', aPush.status === 200 && aPush.json?.written === 1, aPush.text)
  const bRows = await pullAll(tokenB, 'calendars')
  check('B 拉不到 A 的行（账号隔离）', bRows.length === 0, JSON.stringify(bRows).slice(0, 200))
  const aRows = await pullAll(tokenA1, 'calendars')
  check('A 拉得到自己推的行', aRows.some((r) => r.id === 'cal_a1'), JSON.stringify(aRows).slice(0, 200))
  const aPullFromB = await api.call('/sync/pull?table=calendars&since=0&limit=200', { token: tokenA2 })
  check('A 的第二台设备也拉得到（同账号共享）', (aPullFromB.json?.rows ?? []).some((r) => r.id === 'cal_a1'), aPullFromB.text)

  /* ---------------- 2. 冲突 / LWW ---------------- */
  section('[2] 冲突：不同时间戳')
  const t1 = t0 + 10_000
  await push(tokenA1, 'notes', [rowOf('note_c1', '旧内容', t1)])
  const newer = await push(tokenA2, 'notes', [rowOf('note_c1', '新内容', t1 + 5000)])
  check('更新的时间戳被接受', newer.status === 200 && newer.json?.written === 1, newer.text)
  const stale = await push(tokenA1, 'notes', [rowOf('note_c1', '乱序到达的旧内容', t1 + 1000)])
  check('乱序的旧数据被拒（stale，不覆盖）', stale.status === 200 && stale.json?.written === 0 && stale.json?.stale >= 1, stale.text)
  let rowsA = await pullAll(tokenA1, 'notes')
  check('A 看到的是新内容', JSON.parse(byId(rowsA).get('note_c1')?.payload ?? '{}').name === '新内容', JSON.stringify(byId(rowsA).get('note_c1')))

  section('[3] 冲突：updatedAt 完全相等（README：deviceId 字典序大者胜）')
  // 场景一：小 deviceId 先写，大 deviceId 后写同一个时间戳 → 大的赢
  const tie1 = t0 + 20_000
  await push(tokenA1, 'calendars', [rowOf('cal_tie1', 'from-small', tie1)])
  const bigWin = await push(tokenA2, 'calendars', [rowOf('cal_tie1', 'from-large', tie1)])
  check('大 deviceId 的平局写入被接受', bigWin.status === 200 && bigWin.json?.written === 1, bigWin.text)
  // 场景二：大 deviceId 先写，小 deviceId 后写同一个时间戳 → 还是大的赢
  const token = Number((await api.call('/api/changes', { token: tokenA1 })).json?.token ?? 0)
  const tie2 = Math.max(t0, token) + 20_000
  await push(tokenA2, 'calendars', [rowOf('cal_tie2', 'from-large', tie2)])
  const smallLose = await push(tokenA1, 'calendars', [rowOf('cal_tie2', 'from-small', tie2)])
  check('小 deviceId 的平局写入被拒（stale）', smallLose.status === 200 && smallLose.json?.written === 0 && smallLose.json?.stale >= 1, smallLose.text)

  const aView = byId(await pullAll(tokenA1, 'calendars'))
  const bView = byId(await pullAll(tokenA2, 'calendars'))
  check('平局 1：两端内容一致', aView.get('cal_tie1')?.payload === bView.get('cal_tie1')?.payload, `${aView.get('cal_tie1')?.payload} vs ${bView.get('cal_tie1')?.payload}`)
  check('平局 1：赢家是大 deviceId', JSON.parse(aView.get('cal_tie1')?.payload ?? '{}').name === 'from-large', aView.get('cal_tie1')?.payload)
  check('平局 2：两端内容一致', aView.get('cal_tie2')?.payload === bView.get('cal_tie2')?.payload, `${aView.get('cal_tie2')?.payload} vs ${bView.get('cal_tie2')?.payload}`)
  check('平局 2：赢家是大 deviceId', JSON.parse(aView.get('cal_tie2')?.payload ?? '{}').name === 'from-large', aView.get('cal_tie2')?.payload)
  check(
    '平局后时间戳被抬高（输家下次一定拉得到）',
    Number(aView.get('cal_tie1')?.updatedAt) > tie1 && Number(aView.get('cal_tie2')?.updatedAt) > tie2,
    `${aView.get('cal_tie1')?.updatedAt} / ${aView.get('cal_tie2')?.updatedAt}`
  )

  section('[3b] 幂等：同一设备把同一版本再推一遍，不能抬高水位')
  const idemBefore = Number((await api.call('/api/changes', { token: tokenA2 })).json?.token ?? 0)
  const storedTie = aView.get('cal_tie1')
  const idem = await push(tokenA2, 'calendars', [
    { id: 'cal_tie1', updatedAt: storedTie.updatedAt, deletedAt: null, payload: storedTie.payload }
  ])
  const idemAfter = Number((await api.call('/api/changes', { token: tokenA2 })).json?.token ?? 0)
  check('重复推送同一版本 → written 0', idem.status === 200 && idem.json?.written === 0, idem.text)
  check('重复推送不改变水位（否则两端会无限追版本号）', idemAfter === idemBefore, `${idemBefore} → ${idemAfter}`)

  section('[4] 收敛：两端从 0 全量拉一遍，结果必须逐行相同')
  const fullA = await pullAll(tokenA1, 'calendars')
  const fullB = await pullAll(tokenA2, 'calendars')
  const norm = (rows) => rows.map((r) => `${r.id}|${r.updatedAt}|${r.deletedAt}|${r.payload}`).sort().join('\n')
  check(`全量视图一致（${fullA.length} 行）`, norm(fullA) === norm(fullB), `${norm(fullA).slice(0, 200)}\n---\n${norm(fullB).slice(0, 200)}`)

  /* ---------------- 3. 墓碑 ---------------- */
  section('[5] 删除墓碑')
  const noteSave = await api.call('/api/notes/save', { method: 'POST', token: tokenA1, body: { title: '待删便签', content: 'x' } })
  const noteId = noteSave.json?.id
  check('REST 建便签', noteSave.status === 200 && Boolean(noteId), noteSave.text)
  await new Promise((r) => setTimeout(r, 3)) // 让服务端时间戳明确变大
  const beforeToken = Number((await api.call('/api/changes', { token: tokenA1 })).json?.token ?? 0)
  const del = await api.call('/api/notes/delete', { method: 'POST', token: tokenA1, body: { id: noteId } })
  check('删除成功', del.status === 200, del.text)
  const afterToken = Number((await api.call('/api/changes', { token: tokenA1 })).json?.token ?? 0)
  check('/api/changes 水位因删除而升高', afterToken > beforeToken, `${beforeToken} → ${afterToken}`)
  const bNotes = await pullAll(tokenA2, 'notes')
  const tomb = byId(bNotes).get(noteId)
  check('墓碑同步到另一端（deletedAt 非空）', tomb && tomb.deletedAt !== null, JSON.stringify(tomb))

  /* ---------------- 4. 分页 ---------------- */
  section('[6] 分页：250 行同一个 updatedAt')
  const regP = await api.call('/auth/register', {
    method: 'POST',
    body: { username: `e2e_p_${TAG}`, password: STRONG, deviceId: uuid(), secret: hex(32), deviceName: 'P' }
  })
  const tokenP = `${regP.json.deviceId}.${regP.json.secret}`
  const sameAt = Date.now()
  const many = Array.from({ length: 250 }, (_, i) => rowOf(`pg_${String(i).padStart(4, '0')}`, `row-${i}`, sameAt))
  const pushMany = await push(tokenP, 'calendars', many)
  check('一次推 250 行成功', pushMany.status === 200 && pushMany.json?.written === 250, pushMany.text)
  const pulledMany = await pullAll(tokenP, 'calendars')
  check('250 行全部拉得到（不丢页）', pulledMany.length === 250, `实际 ${pulledMany.length}`)
  check('行内容无重复', new Set(pulledMany.map((r) => r.id)).size === 250)

  /* ---------------- 4b. 超过 500 行的推送 ---------------- */
  section('[6b] 推送循环：600 行要分多批推完（对应 sync.ts 的 PUSH_MAX_ROUNDS 循环）')
  const regBig = await api.call('/auth/register', {
    method: 'POST',
    body: { username: `e2e_big_${TAG}`, password: STRONG, deviceId: uuid(), secret: hex(32), deviceName: 'BIG' }
  })
  const tokenBig = `${regBig.json.deviceId}.${regBig.json.secret}`
  // 600 个日格，时间戳各不相同（真实场景：迁移导入时逐条写入）
  const bigRows = Array.from({ length: 600 }, (_, i) => {
    const day = String((i % 28) + 1).padStart(2, '0')
    const month = String((Math.floor(i / 28) % 12) + 1).padStart(2, '0')
    const date = `2026-${month}-${day}`
    const id = `cal:${i}:${date}`
    const calendarId = `cal:${i}`
    const updatedAt = 1_700_000_000_000 + i * 1000
    return {
      id,
      updatedAt,
      deletedAt: null,
      payload: JSON.stringify({ id, calendarId, date, text: `任务 ${i}`, updatedAt, deletedAt: null })
    }
  })
  /*
   * 复刻 sync.ts 的推送循环（exportRows 上限 500 + 整页退 1ms 再推）：
   * 这里不能直接 import 那个文件（它依赖 Electron 的 db 层），
   * 所以用同一套游标规则打真实接口，验证"600 行一定能全部推上去"。
   */
  const simulated = []
  let pushCursor = 0
  for (let round = 0; round < 10; round += 1) {
    const pending = bigRows
      .filter((r) => r.updatedAt > pushCursor)
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(0, 500)
    if (pending.length === 0) break
    const res = await push(tokenBig, 'day_cells', pending)
    if (res.status !== 200) {
      simulated.push(`round${round}: HTTP ${res.status}`)
      break
    }
    simulated.push(`round${round}: ${pending.length} 行 → written ${res.json.written}`)
    const max = pending.reduce((m, r) => Math.max(m, r.updatedAt), pushCursor)
    const fullPage = pending.length >= 500
    const next = fullPage ? Math.max(pushCursor, max - 1) : max
    if (next === pushCursor && fullPage) {
      pushCursor = max
      break
    }
    pushCursor = next
    if (!fullPage) break
  }
  console.log(`      轮次：${simulated.join(' | ')}`)
  check('推送循环至少跑了 2 轮（600 > 500）', simulated.length >= 2, simulated.join(' | '))
  const bigPulled = await pullAll(tokenBig, 'day_cells')
  check('600 行全部推上去了（另一端拉得到 600 行）', bigPulled.length === 600, `实际 ${bigPulled.length}`)
  check('600 行没有重复', new Set(bigPulled.map((r) => r.id)).size === 600)
  check('600 行内容都在', bigPulled.every((r) => JSON.parse(r.payload).text?.startsWith('任务')))

  /* ---------------- 5. 慢钟 ---------------- */
  section('[7] 慢钟：时间戳比服务端水位还旧')
  const slowAt = 1_600_000_000_000 // 2020 年，远早于服务端水位
  const slowPush = await push(tokenP, 'notes', [rowOf('note_slow', '慢钟写的内容', slowAt)])
  check('慢钟写入被接受', slowPush.status === 200 && slowPush.json?.written === 1, slowPush.text)
  const afterSlow = Number((await api.call('/api/changes', { token: tokenP })).json?.token ?? 0)
  check('慢钟写入抬高了水位', afterSlow > sameAt, `${sameAt} → ${afterSlow}`)
  const slowRows = await pullAll(tokenP, 'notes')
  const slowRow = byId(slowRows).get('note_slow')
  check('慢钟行能被拉到（不会被游标跳过）', Boolean(slowRow), JSON.stringify(slowRow))
  check('慢钟行的 updatedAt 被抬到水位之上', Number(slowRow?.updatedAt) > slowAt, String(slowRow?.updatedAt))

  /* ---------------- 6. REST 写入 ---------------- */
  section('[8] REST 写入不被 LWW 守卫吞掉')
  const futureCal = `cal:${uuid()}`
  await push(tokenP, 'day_cells', [
    rowOf(`${futureCal}:2026-11-02`, '旧文本', Date.now() + 3_600_000)
  ])
  const appended = await api.call('/api/cells/append', { method: 'POST', token: tokenP, body: { calendar: futureCal, date: '2026-11-02', text: '新任务' } })
  check('append 返回成功', appended.status === 200, appended.text)
  const cells = await api.call(`/api/cells?calendar=${encodeURIComponent(futureCal)}&from=2026-11-02&to=2026-11-02`, { token: tokenP })
  check('append 的内容真的落库了（不被更新的行吞掉）', (cells.json?.[0]?.text ?? '').includes('新任务'), cells.text)

  /* ---------------- 7. 撤销设备 ---------------- */
  section('[9] 撤销设备')
  const devices = await api.call('/devices', { token: tokenA1 })
  const listed = devices.json?.devices ?? []
  check('设备列表有 2 台', listed.length >= 2, devices.text)
  check('current 标记正确', listed.find((d) => d.deviceId === devA1)?.current === true, devices.text)
  const selfRevoke = await api.call('/devices/revoke', { method: 'POST', token: tokenA1, body: { deviceId: devA1 } })
  check('不能撤销自己（400）', selfRevoke.status === 400, selfRevoke.text)
  const revoke = await api.call('/devices/revoke', { method: 'POST', token: tokenA1, body: { deviceId: devA2 } })
  check('撤销另一台设备成功', revoke.status === 200, revoke.text)
  const revokedMe = await api.call('/auth/me', { token: tokenA2 })
  check('被撤销设备 /auth/me → 401', revokedMe.status === 401, revokedMe.text)
  const revokedPull = await api.call('/sync/pull?table=calendars&since=0&limit=10', { token: tokenA2 })
  check('被撤销设备 /sync/pull → 401', revokedPull.status === 401, revokedPull.text)
  const revokedRest = await api.call('/api/changes', { token: tokenA2 })
  check('被撤销设备 /api/* → 401', revokedRest.status === 401, revokedRest.text)
  const survivor = await api.call('/auth/me', { token: tokenA1 })
  check('没被撤销的设备不受影响', survivor.status === 200, survivor.text)
  const crossRevoke = await api.call('/devices/revoke', { method: 'POST', token: tokenB, body: { deviceId: devA1 } })
  check('跨账号撤销返回 404', crossRevoke.status === 404, crossRevoke.text)

  /* ---------------- 汇总 ---------------- */
  console.log('\n' + '─'.repeat(64))
  console.log(`通过 ${pass} / ${pass + fail}`)
  if (fail) console.log(`失败：${failures.join('、')}`)
  console.log('─'.repeat(64))
}

main()
  .catch((err) => {
    fail += 1
    console.error('\n✗ 跑挂了：', err?.stack ?? err)
  })
  .finally(() => {
    if (worker && !keep) stopWorker()
    if (worker && keep) console.log(`\n（--keep：Worker 仍在 ${worker.base}，用完请手动关）`)
    process.exit(fail === 0 && pass > 0 ? 0 : 1)
  })
