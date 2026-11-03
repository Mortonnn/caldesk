/**
 * Worker REST 接口回归测试（针对本地 wrangler dev）
 * 运行： node scripts/verify-worker-api.mjs [baseUrl] [token]
 */
const base = process.argv[2] ?? 'http://127.0.0.1:8787'
const token = process.argv[3] ?? 'dev-token-123'

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

const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
const get = (p) => fetch(base + p, { headers: H }).then((r) => r.json())
const post = (p, b) => fetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(b) }).then((r) => r.json())

console.log('\n[1] 视图')
const cals = await get('/api/calendars')
const calId = Array.isArray(cals) && cals.length > 0 ? cals[0].id : 'demo-cal'
console.log(`  使用视图: ${calId}（共 ${cals.length} 个）`)

console.log('\n[2] 日格：追加 / 读取 / 勾选 / 删除行')
const d1 = '2026-11-02'
await post('/api/cells/append', { calendar: calId, date: d1, text: '任务甲' })
let r = await post('/api/cells/append', { calendar: calId, date: d1, text: '任务乙' })
eq(r.text, '任务甲\n任务乙', '追加两行后文本')

const cells = await get(`/api/cells?calendar=${calId}&from=${d1}&to=${d1}`)
eq(cells.length, 1, '区间内 1 个日格')
eq(cells[0].text, '任务甲\n任务乙', '日格文本一致')

r = await post('/api/cells/toggle', { calendar: calId, date: d1, index: 0, done: true })
eq(r.text, '~~任务甲~~\n任务乙', '勾选第一行写入删除线')

r = await post('/api/cells/toggle', { calendar: calId, date: d1, index: 9, done: true })
eq(typeof r.error, 'string', '越界行号返回错误而不是静默')

r = await post('/api/cells/remove-line', { calendar: calId, date: d1, index: 1 })
eq(r.text, '~~任务甲~~', '删除第二行')

console.log('\n[3] 事件：创建 / 展开 / 单次完成')
const ev = await post('/api/events/create', {
  calendar: calId,
  kind: 'task',
  title: '每周复盘',
  start: '2026-11-02',
  rrule: 'FREQ=WEEKLY;BYDAY=MO'
})
const evId = ev.id
eq(typeof evId, 'string', '创建返回 id')

let occ = await get(`/api/events?calendar=${calId}&from=2026-11-01&to=2026-11-30`)
eq(occ.length, 5, '每周一在 11 月展开 5 次')
eq(occ.every((o) => o.event.title === '每周复盘'), true, '展开的都是同一事件')
eq(occ.every((o) => o.done === false), true, '初始都未完成')

await post('/api/events/toggle', { id: evId, date: '2026-11-09', done: true })
occ = await get(`/api/events?calendar=${calId}&from=2026-11-01&to=2026-11-30`)
eq(occ.find((o) => o.date === '2026-11-09')?.done, true, '11-09 这次标为完成')
eq(occ.find((o) => o.date === '2026-11-16')?.done, false, '其他次不受影响')

console.log('\n[4] 事件删除')
const del = await post('/api/events/delete', { id: evId })
eq(del.ok, true, '删除返回 ok')
occ = await get(`/api/events?calendar=${calId}&from=2026-11-01&to=2026-11-30`)
eq(occ.length, 0, '删除后不再展开')

console.log('\n' + '─'.repeat(52))
if (failures === 0) {
  console.log('结果：全部通过 ✅  Worker REST 行为正确')
  process.exit(0)
} else {
  console.error(`结果：${failures} 项失败 ❌`)
  process.exit(1)
}
