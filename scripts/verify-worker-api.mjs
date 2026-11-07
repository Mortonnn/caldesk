/**
 * Worker REST 接口回归测试（手机端用的那套 /api/*）
 *
 *   node scripts/verify-worker-api.mjs                 # 自己起本地 Worker（临时 D1）→ 建临时账号 → 断言 → 关掉
 *   node scripts/verify-worker-api.mjs --url https://你的域名   # 打线上
 *
 * 以前这里是 `token ?? 'dev-token-123'`：共享令牌那套早就删了，脚本必然全 401。
 * 现在改成先注册一个临时账号拿设备凭据，再跑断言。
 */
import { startWorker, stopWorker, freePort, readDevVars, makeApi, hex, uuid } from './verify-auth.mjs'

const argv = process.argv.slice(2)
const urlIdx = argv.indexOf('--url')
const remote = urlIdx >= 0 ? argv[urlIdx + 1] : undefined

let failures = 0
function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) {
    failures += 1
    console.error(`  ✗ ${label}\n      期望 ${b}\n      实际 ${a}`)
  } else {
    console.log(`  ✓ ${label}`)
  }
}

async function main() {
  let base = remote
  let worker = null
  if (!base) {
    worker = await startWorker({ port: await freePort() })
    base = worker.base
    console.log(`本地 Worker：${base}`)
  }
  const api = makeApi(base)
  

  const reg = await api.call('/auth/register', {
    method: 'POST',
    body: {
      username: `api_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      password: 'Abcdef123!x',
      deviceId: uuid(),
      secret: hex(32),
      deviceName: 'verify-worker-api',
        }
  })
  if (reg.status !== 200) throw new Error(`注册失败 ${reg.status}：${reg.text}`)
  const token = `${reg.json.deviceId}.${reg.json.secret}`
  const H = { authorization: `Bearer ${token}` }
  const get = (p) => api.call(p, { token })
  const post = (p, b) => api.call(p, { method: 'POST', token, body: b })

  console.log('\n[1] 视图')
  const cals = await get('/api/calendars')
  const calId = Array.isArray(cals.json) && cals.json.length > 0 ? cals.json[0].id : 'demo-cal'
  console.log(`  使用视图: ${calId}（共 ${Array.isArray(cals.json) ? cals.json.length : 0} 个）`)

  console.log('\n[2] 日格：追加 / 读取 / 勾选 / 删除行')
  const d1 = '2026-11-02'
  await post('/api/cells/append', { calendar: calId, date: d1, text: '任务甲' })
  let r = await post('/api/cells/append', { calendar: calId, date: d1, text: '任务乙' })
  eq(r.json?.text, '任务甲\n任务乙', '追加两行后文本')

  const cells = await get(`/api/cells?calendar=${encodeURIComponent(calId)}&from=${d1}&to=${d1}`)
  eq(cells.json?.length, 1, '区间内 1 个日格')
  eq(cells.json?.[0]?.text, '任务甲\n任务乙', '日格文本一致')

  r = await post('/api/cells/toggle', { calendar: calId, date: d1, index: 0, done: true })
  eq(r.json?.text, '~~任务甲~~\n任务乙', '勾选第一行写入删除线')

  r = await post('/api/cells/toggle', { calendar: calId, date: d1, index: 9, done: true })
  eq(typeof r.json?.error, 'string', '越界行号返回错误而不是静默')

  r = await post('/api/cells/remove-line', { calendar: calId, date: d1, index: 1 })
  eq(r.json?.text, '~~任务甲~~', '删除第二行')

  console.log('\n[3] 参数校验')
  eq((await post('/api/cells/append', { calendar: calId, date: d1 })).status, 400, '缺 text → 400')
  eq((await post('/api/cells/append', { calendar: calId, date: '2026-13-40', text: 'x' })).status, 400, '坏日期 → 400')
  eq((await post('/api/cells/append', { calendar: calId, date: d1, text: 'a\nb' })).status, 400, '多行任务 → 400')
  eq((await get('/api/events')).status, 400, 'events 缺 from/to → 400')
  eq((await get('/api/notes/get')).status, 400, 'notes/get 缺 id → 400')
  eq((await post('/api/events/toggle', { done: true })).status, 400, 'events/toggle 缺 id/date → 400')

  console.log('\n[4] 事件：创建 / 展开 / 单次完成')
  const ev = await post('/api/events/create', {
    calendar: calId,
    kind: 'task',
    title: '每周复盘',
    start: '2026-11-02',
    rrule: 'FREQ=WEEKLY;BYDAY=MO'
  })
  const evId = ev.json?.id
  eq(typeof evId, 'string', '创建返回 id')
  eq((await post('/api/events/create', { calendar: calId, title: 'x', start: 'not-a-date' })).status, 400, '坏 start → 400')

  let occ = await get(`/api/events?calendar=${encodeURIComponent(calId)}&from=2026-11-01&to=2026-11-30`)
  eq(occ.json?.length, 5, '每周一在 11 月展开 5 次')
  eq((occ.json ?? []).every((o) => o.event.title === '每周复盘'), true, '展开的都是同一事件')
  eq((occ.json ?? []).every((o) => o.done === false), true, '初始都未完成')

  await post('/api/events/toggle', { id: evId, date: '2026-11-09', done: true })
  occ = await get(`/api/events?calendar=${encodeURIComponent(calId)}&from=2026-11-01&to=2026-11-30`)
  eq(occ.json?.find?.((o) => o.date === '2026-11-09')?.done, true, '11-09 这次标为完成')
  eq(occ.json?.find?.((o) => o.date === '2026-11-16')?.done, false, '其他次不受影响')

  console.log('\n[5] 仅删这天 / 撤销')
  await post('/api/events/skip', { id: evId, date: '2026-11-16' })
  occ = await get(`/api/events?calendar=${encodeURIComponent(calId)}&from=2026-11-01&to=2026-11-30`)
  eq(occ.json?.some?.((o) => o.date === '2026-11-16'), false, 'skip 掉的那天不再出现')
  await post('/api/events/unskip', { id: evId, date: '2026-11-16' })
  occ = await get(`/api/events?calendar=${encodeURIComponent(calId)}&from=2026-11-01&to=2026-11-30`)
  eq(occ.json?.some?.((o) => o.date === '2026-11-16'), true, '撤销后那天回来了')

  console.log('\n[6] 事件删除')
  const del = await post('/api/events/delete', { id: evId })
  eq(del.json?.ok, true, '删除返回 ok')
  occ = await get(`/api/events?calendar=${encodeURIComponent(calId)}&from=2026-11-01&to=2026-11-30`)
  eq(occ.json?.length, 0, '删除后不再展开')

  console.log('\n[7] 便签 / 视图 / 搜索')
  const note = await post('/api/notes/save', { calendarId: calId, title: '周会', content: '记一下' })
  const noteId = note.json?.id
  eq((await get(`/api/notes/get?id=${encodeURIComponent(noteId)}`)).json?.title, '周会', '便签读回')
  eq((await get('/api/notes')).json?.length, 1, '便签列表 1 条')
  const created = await post('/api/calendars/create', { name: '工作' })
  eq(typeof created.json?.created?.id, 'string', '新建视图')
  eq((await post('/api/calendars/create', { name: '工作' })).status, 400, '同名视图被拒')
  const hits = await get(`/api/search?q=${encodeURIComponent('周会')}`)
  eq((hits.json ?? []).some((h) => h.noteId === noteId), true, '搜得到便签')
  eq((await post('/api/notes/delete', { id: noteId })).json?.ok, true, '删便签')
  eq((await get(`/api/notes/get?id=${encodeURIComponent(noteId)}`)).status, 404, '删掉后 404')

  console.log('\n[8] 未知接口 / 无凭据')
  eq((await get('/api/nope')).status, 404, '未知 /api 路径 404')
  const noAuth = await api.call('/api/changes')
  eq(noAuth.status, 401, '没凭据 401')

  if (worker) stopWorker()
  console.log('\n' + '─'.repeat(52))
  if (failures === 0) {
    console.log('结果：全部通过 ✅  Worker REST 行为正确')
    process.exit(0)
  }
  console.error(`结果：${failures} 项失败 ❌`)
  process.exit(1)
}

main().catch((err) => {
  stopWorker()
  console.error('跑挂了：', err?.stack ?? err)
  process.exit(2)
})
