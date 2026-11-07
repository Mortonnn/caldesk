/**
 * 数据层回归：不启动 Electron，直接跑 src/main/db.ts 的真实实现。
 *
 * 与 verify-snapshots.mjs 同一套做法：
 *   1. 用项目自带的 typescript 把 db.ts / shared/*.ts 转成 ESM 写进临时目录；
 *   2. @shared/* 改写成相对路径；源码里若还留着 require(...) 就补一个垫片；
 *   3. 在临时目录 initDb，逐节验证。
 *
 * 覆盖：初始化/播种、视图 CRUD、断言边界、日格行操作、事件校验、重复展开、
 *      软删除恢复、便签、搜索（含 LIKE 通配符与反斜杠）、回滚快照、同步导入导出、
 *      SQL 拼接静态扫描、多表操作的事务性。
 *
 * 运行：node scripts/verify-db.mjs          # 全部
 *      node scripts/verify-db.mjs 事务      # 只跑名字包含「事务」的一节
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tmp = mkdtempSync(join(tmpdir(), 'caldesk-db-'))
const gen = join(tmp, 'gen')
const filter = process.argv[2] ?? ''

let failures = 0
let checks = 0
let sectionChecks = 0

function ok(cond, msg) {
  checks += 1
  sectionChecks += 1
  if (cond) return true
  failures += 1
  console.error('  ✗', msg)
  return false
}

function eq(actual, expected, msg) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  return ok(a === b, `${msg}（期望 ${b}，实际 ${a}）`)
}

function throws(fn, msg, pattern) {
  try {
    fn()
  } catch (err) {
    const text = String(err?.message ?? err)
    if (pattern && !pattern.test(text)) {
      return ok(false, `${msg}（抛了，但信息不对：${text}）`)
    }
    return ok(true, msg)
  }
  return ok(false, `${msg}（预期抛错却成功了）`)
}

function passes(fn, msg) {
  try {
    fn()
    return ok(true, msg)
  } catch (err) {
    return ok(false, `${msg}（抛错：${err?.message ?? err}）`)
  }
}

/* ------------------------------ 编译 db.ts ------------------------------ */

function emit(srcRel, outRel) {
  const src = readFileSync(join(root, srcRel), 'utf-8')
  const js = ts.transpileModule(src, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      isolatedModules: true
    }
  }).outputText
  const patched = js
    .replace(/'@shared\/types'/g, "'./shared/types.mjs'")
    .replace(/'@shared\/rrule'/g, "'./shared/rrule.mjs'")
    .replace(/'@shared\/countdown'/g, "'./shared/countdown.mjs'")
    // shared/ 内部互相引用（countdown → rrule）补上扩展名，Node 的 ESM 才认
    .replace(/(from\s+')(\.\/[A-Za-z0-9_-]+)(')/g, '$1$2.mjs$3')
  // 过渡期兼容：db.ts 曾经用 require('node:sqlite') 规避类型缺失
  const head = /\brequire\(/.test(src)
    ? "import { createRequire as __createRequire } from 'node:module'\nconst require = __createRequire(import.meta.url)\n"
    : ''
  const out = join(gen, outRel)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, head + patched)
}

emit('src/shared/types.ts', 'shared/types.mjs')
emit('src/shared/rrule.ts', 'shared/rrule.mjs')
emit('src/shared/countdown.ts', 'shared/countdown.mjs')
emit('src/main/db.ts', 'db.mjs')

const dbSource = readFileSync(join(root, 'src/main/db.ts'), 'utf-8')

/* ------------------------------ 可控时钟 ------------------------------ */

const realNow = Date.now
let clock = realNow()
Date.now = () => clock
const advance = (ms) => {
  clock += ms
}

/* ------------------------------ 小工具 ------------------------------ */

const palette = [
  '#5b8cff',
  '#3ddc97',
  '#ffb020',
  '#ff6b6b',
  '#a78bfa',
  '#22d3ee',
  '#f472b6',
  '#94a3b8'
]

let db = null

/** 切到一个干净的数据目录（会先关掉上一个库） */
function useDir(name) {
  const dir = join(tmp, name)
  mkdirSync(dir, { recursive: true })
  try {
    db.closeDb()
  } catch {
    /* 没开过 */
  }
  db.initDb(dir)
  return dir
}

/** 用第二条连接直接摸 sqlite 文件（模拟"外部篡改"/制造故障） */
async function raw(dir, fn) {
  const { DatabaseSync } = await import('node:sqlite')
  const conn = new DatabaseSync(join(dir, 'caldesk.db'))
  try {
    return fn(conn)
  } finally {
    conn.close()
  }
}

/* ------------------------------ 测试节 ------------------------------ */

const plan = []
const section = (name, fn) => plan.push({ name, fn })

/* ============================ 1. 初始化与播种 ============================ */

section('初始化：DDL / 播种 / 幂等', async () => {
  const dir = join(tmp, 'init')
  mkdirSync(dir, { recursive: true })
  db.initDb(dir)

  let cals = db.listCalendars()
  eq(cals.map((c) => c.name), ['工作', '生活'], '空库自动播种「工作」「生活」')
  eq(cals.map((c) => c.color), [palette[0], palette[1]], '内置视图用前两支配色')
  eq(cals.map((c) => c.sort), [0, 1], '内置视图 sort 从 0 递增')
  const ids = cals.map((c) => c.id)

  db.initDb(dir) // 重复调用
  cals = db.listCalendars()
  eq(cals.map((c) => c.id), ids, 'initDb 重复调用不重建、不重复播种')

  db.closeDb()
  db.initDb(dir) // 关掉再开
  eq(db.listCalendars().map((c) => c.id), ids, '重开同一个库仍是同一批视图')

  // 空目录也能自己建（--user-data 指到新目录时不该崩）
  const fresh = join(tmp, 'init', 'nested', 'deeper')
  db.closeDb()
  passes(() => db.initDb(fresh), 'initDb 会自动创建不存在的 userData 目录')
  eq(db.listCalendars().length, 2, '新目录照样播种两个视图')

  // 全部视图都被同步墓碑掉之后，启动时不能留一个"零视图"的界面
  const dir2 = useDir('init-tombstone')
  const now = Date.now()
  await raw(dir2, (conn) => {
    conn.prepare('UPDATE calendars SET deleted_at = ?, updated_at = ?').run(now, now)
  })
  eq(db.listCalendars().length, 0, '（构造）所有视图都被软删除后列表为空')
  db.closeDb()
  db.initDb(dir2)
  eq(db.listCalendars().length, 2, '视图全被删光的库重新启动会补回内置视图')
})

/* ============================ 2. 视图 CRUD ============================ */

section('视图：新建 / 重名 / 排序 / 配色轮转 / 删除', async () => {
  useDir('cal')
  const a = db.createCalendar('  工作安排  ')
  eq(a.name, '工作安排', '名称两端空白被裁掉')
  eq(a.sort, 2, '新视图 sort 接在最大值后面')
  eq(a.color, palette[2], '默认配色取第一支没用过的')

  throws(() => db.createCalendar('工作安排'), '重名（裁掉空白后）被拒绝', /已存在同名视图/)
  throws(() => db.createCalendar('   '), '空名称被拒绝', /不能为空/)
  throws(() => db.createCalendar('x'.repeat(25)), '超过 24 字被拒绝', /最多 24/)
  eq(db.createCalendar('y'.repeat(24)).name.length, 24, '正好 24 字可以通过')

  const explicit = db.createCalendar('显式配色', '#000000')
  eq(explicit.color, '#000000', '显式传色不改写')
  eq(db.createCalendar('接着分').color, palette[4], '显式用的色不占用色池里的下一支')

  // 8 色用满后轮转
  const dirColor = useDir('cal-color')
  for (const n of ['a', 'b', 'c', 'd', 'e', 'f']) db.createCalendar(n)
  const colors = db.listCalendars().map((c) => c.color)
  eq(colors.length, 8, '（前置）一共 8 个视图')
  eq(colors.slice().sort().join(','), palette.slice().sort().join(','), '8 个视图正好占满色板，无重复')
  eq(db.createCalendar('h').color, palette[0], '色板用满后按数量轮转，回到第一支')
  void dirColor

  // 改名 / 改色
  useDir('cal')
  const first = db.listCalendars()[0]
  eq(db.updateCalendar(first.id, { name: '工作计划' }).find((c) => c.id === first.id).name, '工作计划', '改名生效')
  throws(() => db.updateCalendar(first.id, { name: '  ' }), '改成空名被拒绝', /不能为空/)
  throws(() => db.updateCalendar('no-such-id', { name: 'x' }), '改不存在的视图报错', /不存在/)
  const another = db.listCalendars().find((c) => c.id !== first.id)
  throws(() => db.updateCalendar(first.id, { name: another.name }), '改名撞上已有视图名被拒绝', /已存在同名视图/)
  eq(db.updateCalendar(first.id, { color: '#111111' }).find((c) => c.id === first.id).color, '#111111', '改配色生效')

  // 删到只剩一个
  useDir('cal-del')
  const keep = db.listCalendars()[0]
  const drop = db.listCalendars()[1]
  eq(db.deleteCalendar(drop.id).map((c) => c.id), [keep.id], '删除后只剩一个视图')
  throws(() => db.deleteCalendar(keep.id), '最后一个视图不允许删除', /至少需要保留/)
  throws(() => db.deleteCalendar('ghost'), '删不存在的视图报错', /不存在|至少/)

  // 删除视图要连带它名下的日格、事件、便签
  useDir('cal-cascade')
  const victim = db.createCalendar('要删的')
  db.setDayCellText(victim.id, '2026-05-01', '任务一')
  const ev = db.createEvent({ calendarId: victim.id, kind: 'task', title: '事件一', start: '2026-05-01' })
  const note = db.createNote({ calendarId: victim.id, content: '便签一' })
  advance(200_000) // 拉开合并窗口，删除记录才会单独成一条
  db.deleteCalendar(victim.id)
  eq(db.listCalendars().some((c) => c.id === victim.id), false, '视图从列表消失')
  eq(
    db.exportRows('day_cells', 0).filter((r) => r.calendarId === victim.id && r.deletedAt === null).length,
    0,
    '视图下的日格被软删除'
  )
  eq(
    db.exportRows('events', 0).filter((r) => r.calendarId === victim.id && r.deletedAt === null).length,
    0,
    '视图下的事件被一起软删除（不留孤儿行）'
  )
  eq(
    db.exportRows('notes', 0).filter((r) => r.calendarId === victim.id && r.deletedAt === null).length,
    0,
    '视图下的便签被一起软删除（不留孤儿行）'
  )
  const delSnap = db.listSnapshots()[0]
  eq(delSnap.label, '删除视图', '删除视图留下一条回滚记录')
  eq(delSnap.tables.slice().sort().join(','), 'calendars,day_cells,events,notes', '回滚记录覆盖四张表')
  const restored = db.restoreSnapshot(delSnap.id)
  eq(restored.deleted + restored.restored, delSnap.count, '回滚把删除涉及的行全部处理了')
  ok(db.listCalendars().some((c) => c.id === victim.id), '回滚后视图回来')
  eq(db.getEvent(ev.id).title, '事件一', '回滚后事件回来')
  eq(db.getNote(note.id).content, '便签一', '回滚后便签回来')
  eq(db.getDayCell(victim.id, '2026-05-01').text, '任务一', '回滚后日格回来')
})

/* ============================ 3. 断言边界 ============================ */

section('断言边界：日期 / 行号 / 类型 / 视图', async () => {
  useDir('assert')
  const cal = db.listCalendars()[0].id

  for (const bad of [
    '2026-13-01',
    '2026-02-30',
    '2026-2-3',
    '',
    '2026-02-29',
    '20260201',
    '2026-01-32',
    '2026-00-10',
    "' OR 1=1 --",
    '2026-01-05 ',
    null,
    undefined
  ]) {
    throws(() => db.getDayCell(cal, bad), `非法日期 ${JSON.stringify(bad)} 被拒绝`)
  }
  for (const good of ['2024-02-29', '2026-12-31', '2026-01-01', '1970-01-01']) {
    passes(() => db.getDayCell(cal, good), `合法日期「${good}」通过`)
  }

  db.setDayCellText(cal, '2026-01-05', '甲\n乙')
  throws(() => db.updateDayLine(cal, '2026-01-05', -1, 'x'), '行号 -1 被拒绝', /超出范围/)
  throws(() => db.updateDayLine(cal, '2026-01-05', 999, 'x'), '行号 999 被拒绝', /超出范围/)
  throws(() => db.updateDayLine(cal, '2026-01-05', '0', 'x'), '字符串行号被拒绝', /超出范围/)
  throws(() => db.updateDayLine(cal, '2026-01-05', 1.5, 'x'), '小数行号被拒绝', /超出范围/)
  throws(() => db.deleteDayLine(cal, '2026-01-05', 2), '删除越界行号被拒绝', /超出范围/)
  throws(() => db.setDayLineDone(cal, '2026-01-05', Number.NaN, true), 'NaN 行号被拒绝', /超出范围/)

  throws(
    () => db.createEvent({ calendarId: cal, kind: 'bogus', title: 'x', start: '2026-01-01' }),
    '非法 kind 被拒绝',
    /kind 必须是/
  )
  throws(() => db.createEvent({ calendarId: cal, title: 'x', start: '2026-01-01' }), '缺 kind 被拒绝')
  throws(() => db.setDayCellText('no-such-cal', '2026-01-05', 'x'), '不存在的视图写日格被拒绝', /视图不存在/)
  eq(db.listOccurrences(cal, '2026-01-05', '2026-01-01').length, 0, '区间倒置返回空数组')
})

/* ============================ 4. 日格行操作 ============================ */

section('日格：空文本 / 完成态往返 / 增删改 / 移动', async () => {
  useDir('cells')
  const cal = db.listCalendars()[0].id
  const d1 = '2026-06-01'
  const d2 = '2026-06-02'

  eq(db.getDayCell(cal, d1).text, '', '空日格返回空文本')
  eq(db.getDayCell(cal, d1).deletedAt, null, '空日格 not deleted')
  eq(db.getDayCell(cal, d1).updatedAt, 0, '空日格 updatedAt 为 0（未落库）')

  db.setDayCellText(cal, d1, '')
  eq(db.getDayCell(cal, d1).text, '', '写入空文本不产生内容')
  eq(db.listDayCells(cal, d1, d1).length, 0, '写入空文本后列表里看不到（空行等于没有内容）')

  db.appendDayLine(cal, d1, '  第一行  ')
  eq(db.getDayCell(cal, d1).text, '第一行', '追加时裁掉两端空白')
  db.appendDayLine(cal, d1, '第二行')
  eq(db.getDayCell(cal, d1).text, '第一行\n第二行', '第二次追加接在下一行')
  throws(() => db.appendDayLine(cal, d1, '  '), '追加空内容被拒绝', /不能为空/)
  throws(() => db.appendDayLine(cal, d1, 'a\nb'), '追加多行被拒绝', /单行/)

  db.setDayLineDone(cal, d1, 0, true)
  eq(db.getDayCell(cal, d1).text, '~~第一行~~\n第二行', '标完成写成删除线')
  db.setDayLineDone(cal, d1, 0, true)
  eq(db.getDayCell(cal, d1).text, '~~第一行~~\n第二行', '重复标完成是幂等的')
  db.setDayLineDone(cal, d1, 0, false)
  eq(db.getDayCell(cal, d1).text, '第一行\n第二行', '取消完成还原成纯文本')
  db.setDayLineDone(cal, d1, 0, false)
  eq(db.getDayCell(cal, d1).text, '第一行\n第二行', '重复取消完成也是幂等的')

  db.setDayCellText(cal, d1, 'a~~b~~\n普通')
  db.setDayLineDone(cal, d1, 0, true)
  eq(db.getDayCell(cal, d1).text, '~~a~~b~~\n普通', '中间带 ~~ 的行按"整行"包一层删除线')
  db.setDayLineDone(cal, d1, 0, false)
  eq(db.getDayCell(cal, d1).text, 'a~~b\n普通', '再取消会退化成去掉尾部 ~~（已知有损，至少不抛错）')

  db.setDayCellText(cal, d1, '~~旧的~~\n第二行')
  db.updateDayLine(cal, d1, 0, '新的')
  eq(db.getDayCell(cal, d1).text, '~~新的~~\n第二行', '改已完成的行保留删除线')
  throws(() => db.updateDayLine(cal, d1, 0, '  '), '改成空内容被拒绝', /不能为空/)
  throws(() => db.updateDayLine(cal, d1, 0, 'a\nb'), '改成多行被拒绝', /单行/)

  db.setDayCellText(cal, d1, 'a\r\nb\nc')
  eq(db.getDayCell(cal, d1).text, 'a\r\nb\nc', '原样保存用户文本（不动 \\r）')
  db.appendDayLine(cal, d1, 'd')
  eq(db.getDayCell(cal, d1).text, 'a\nb\nc\nd', '追加一行后统一成 \\n')
  eq(db.listDayCells(cal, d1, d1)[0].text, 'a\nb\nc\nd', '按区间读到的也是统一换行')

  db.setDayCellText(cal, d1, 'a\nb\nc')
  db.deleteDayLine(cal, d1, 1)
  eq(db.getDayCell(cal, d1).text, 'a\nc', '删中间一行')
  db.deleteDayLine(cal, d1, 0)
  db.deleteDayLine(cal, d1, 0)
  eq(db.getDayCell(cal, d1).text, '', '删空最后一行得到空文本')

  db.setDayCellText(cal, d1, '甲\n乙')
  db.setDayCellText(cal, d2, '丙')
  eq(db.moveDayLine(cal, d1, 0, d2), { moved: '甲', from: d1, to: d2 }, '移动返回被移动的文本')
  eq(db.getDayCell(cal, d1).text, '乙', '源日期少了那一行')
  eq(db.getDayCell(cal, d2).text, '丙\n甲', '目标日期追加到末尾')
  throws(() => db.moveDayLine(cal, d1, 5, d2), '越界行号被拒绝', /超出范围/)
  throws(() => db.moveDayLine(cal, d1, 0, '2026-02-30'), '目标日期非法被拒绝', /真实存在/)
  eq(db.getDayCell(cal, d1).text, '乙', '移动失败时源日期没被破坏')

  db.setDayCellText(cal, d1, '一\n二\n三')
  const same = db.moveDayLine(cal, d1, 0, d1)
  eq(same.moved, '一', '同天移动返回被移动的文本')
  eq(db.getDayCell(cal, d1).text, '一\n二\n三', '同天移动是空操作（不会把行挪到末尾）')

  advance(200_000)
  const snapCountBefore = db.listSnapshots().length
  db.moveDayLine(cal, d1, 0, d2)
  const moveSnaps = db.listSnapshots()
  eq(moveSnaps.length - snapCountBefore, 1, '跨天移动只产生一条回滚记录（原子撤销）')
  eq(moveSnaps[0].tables.join(','), 'day_cells', '移动记录只涉及 day_cells')
  eq(moveSnaps[0].count, 2, '移动记录同时覆盖源与目标两格')
  db.restoreSnapshot(moveSnaps[0].id)
  eq(db.getDayCell(cal, d1).text, '一\n二\n三', '撤销移动后源日期恢复')
  eq(db.getDayCell(cal, d2).text, '丙\n甲', '撤销移动后目标日期恢复')
})

/* ============================ 5. 事件校验 ============================ */

section('事件：入参校验 / allDay / 重复规则', async () => {
  useDir('ev-validate')
  const cal = db.listCalendars()[0].id
  const mk = (patch) => () =>
    db.createEvent({ calendarId: cal, kind: 'task', title: 't', start: '2026-02-01', ...patch })

  throws(mk({ title: '   ' }), '空标题被拒绝', /不能为空/)
  throws(mk({ title: 'x'.repeat(201) }), '标题超 200 被拒绝', /过长/)
  passes(() => db.createEvent({ calendarId: cal, kind: 'task', title: 'x'.repeat(200), start: '2026-02-01' }), '标题正好 200 字通过')
  throws(mk({ start: '2026-02-30' }), 'start 非法日期被拒绝', /真实存在/)
  throws(mk({ start: 'garbage' }), 'start 非日期被拒绝', /必须是 YYYY-MM-DD/)
  throws(mk({ start: '' }), 'start 空串被拒绝')

  const timed = db.createEvent({ calendarId: cal, kind: 'task', title: '带时间', start: '2026-02-03T09:30:00+08:00' })
  eq(timed.start, '2026-02-03T09:30:00+08:00', 'start 原样保存 ISO 时间')
  eq(timed.allDay, true, '不传 allDay 时默认全天（保持旧行为）')
  eq(
    db.listOccurrences(cal, '2026-02-03', '2026-02-03').filter((o) => o.event.id === timed.id).map((o) => o.date),
    ['2026-02-03'],
    '带时间的 start 按日历日展开'
  )
  eq(db.createEvent({ calendarId: cal, kind: 'task', title: '非全天', start: '2026-02-04', allDay: false }).allDay, false, 'allDay: false 被尊重')

  throws(mk({ kind: 'countdown' }), '倒数日缺 targetDate 被拒绝', /targetDate/)
  throws(mk({ kind: 'countdown', targetDate: '2026-13-01' }), '倒数日 targetDate 非法被拒绝', /真实存在/)
  throws(mk({ kind: 'countdown', targetDate: '2026-03-01', rrule: 'FREQ=YEARLY' }), '倒数日不允许 rrule', /不支持重复/)
  eq(
    db.createEvent({ calendarId: cal, kind: 'countdown', title: '倒数', start: '2026-02-01', targetDate: '2026-02-10' }).targetDate,
    '2026-02-10',
    '倒数日 targetDate 保存'
  )

  throws(mk({ remindMinutes: -1 }), '提醒 -1 分钟被拒绝', /0–10080/)
  throws(mk({ remindMinutes: 10081 }), '提醒 10081 分钟被拒绝', /0–10080/)
  throws(mk({ remindMinutes: 1.5 }), '提醒小数被拒绝', /0–10080/)
  passes(() => db.createEvent({ calendarId: cal, kind: 'reminder', title: 'r', start: '2026-02-05', remindMinutes: 0 }), '提醒 0 分钟通过')
  passes(() => db.createEvent({ calendarId: cal, kind: 'reminder', title: 'r2', start: '2026-02-05', remindMinutes: 10080 }), '提醒 10080 分钟通过')
  throws(mk({ kind: 'reminder', rrule: 'FREQ=DAILY', targetDate: '2026-03-01' }), '提醒不能同时带 targetDate', /提醒事件不能同时带/)

  throws(mk({ rrule: 'FREQ=WEEKLY;INTERVAL=1000' }), '重复间隔过大被拒绝', /间隔过大/)
  throws(mk({ rrule: 'WEEKLY' }), '缺 FREQ 的 rrule 被拒绝', /FREQ/)
  throws(mk({ rrule: 'FREQ=BOGUS' }), 'FREQ 值非法被拒绝（不能悄悄当成每天）', /FREQ/)
  throws(mk({ rrule: 'FREQ=' }), 'FREQ 空值被拒绝', /FREQ/)
  eq(db.createEvent({ calendarId: cal, kind: 'task', title: '每周', start: '2026-02-02', rrule: 'FREQ=WEEKLY;BYDAY=MO' }).rrule, 'FREQ=WEEKLY;BYDAY=MO', '合法 rrule 保存')
})

/* ============================ 6. 重复展开 ============================ */

section('展开：rrule / 跳过 / 完成 / 倒数日 / 区间裁剪 / 性能 / 脏规则', async () => {
  const dir = useDir('occur')
  const cal = db.listCalendars()[0].id
  const dates = (id, from, to) =>
    db.listOccurrences(cal, from, to).filter((o) => o.event.id === id).map((o) => o.date)

  const weekly = db.createEvent({ calendarId: cal, kind: 'task', title: '例会', start: '2026-01-05', rrule: 'FREQ=WEEKLY;BYDAY=MO' })
  eq(dates(weekly.id, '2026-01-01', '2026-01-31'), ['2026-01-05', '2026-01-12', '2026-01-19', '2026-01-26'], '每周一展开正确')
  eq(dates(weekly.id, '2026-01-13', '2026-01-20'), ['2026-01-19'], '区间裁剪只留窗口内的实例')
  eq(dates(weekly.id, '2026-01-20', '2026-02-02'), ['2026-01-26', '2026-02-02'], '跨月区间正确')

  db.setOccurrenceDone(weekly.id, '2026-01-12', true)
  eq(
    db.listOccurrences(cal, '2026-01-01', '2026-01-31').find((o) => o.event.id === weekly.id && o.date === '2026-01-12').done,
    true,
    '某一次标记完成'
  )
  eq(db.exportRows('event_done', 0).filter((r) => r.eventId === weekly.id).length, 1, '完成状态落在 event_done')
  db.setOccurrenceDone(weekly.id, '2026-01-12', false)
  eq(
    db.listOccurrences(cal, '2026-01-01', '2026-01-31').find((o) => o.event.id === weekly.id && o.date === '2026-01-12').done,
    false,
    '取消完成'
  )
  const doneRows = db.exportRows('event_done', 0).filter((r) => r.eventId === weekly.id)
  eq(doneRows.length, 1, '取消完成后行还在（软删除留墓碑）')
  ok(doneRows[0].deletedAt !== null, '取消完成的行带 deletedAt（同步能传播删除）')

  db.skipOccurrence(weekly.id, '2026-01-19')
  eq(dates(weekly.id, '2026-01-01', '2026-01-31'), ['2026-01-05', '2026-01-12', '2026-01-26'], '「仅删除本次」把那天摘掉')
  db.unskipOccurrence(weekly.id, '2026-01-19')
  eq(dates(weekly.id, '2026-01-01', '2026-01-31').length, 4, '撤销「仅删除本次」后那天回来')
  eq(db.exportRows('event_skip', 0).find((r) => r.id === `${weekly.id}:2026-01-19`).deletedAt !== null, true, '撤销后留的是墓碑')

  const once = db.createEvent({ calendarId: cal, kind: 'task', title: '一次性', start: '2026-03-10' })
  eq(dates(once.id, '2026-03-01', '2026-03-31'), ['2026-03-10'], '不重复的事件只出现一次')
  eq(dates(once.id, '2026-03-11', '2026-03-31'), [], '不在区间内就查不到')

  const cd = db.createEvent({ calendarId: cal, kind: 'countdown', title: '倒数', start: '2026-04-01', targetDate: '2026-04-05' })
  eq(dates(cd.id, '2026-04-01', '2026-04-30'), ['2026-04-01', '2026-04-02', '2026-04-03', '2026-04-04', '2026-04-05'], '倒数日按天展开到目标日')
  eq(dates(cd.id, '2026-04-04', '2026-04-30'), ['2026-04-04', '2026-04-05'], '倒数日按区间裁剪')
  eq(dates(cd.id, '2026-04-06', '2026-04-30'), [], '过了目标日就不再出现')

  db.createEvent({ calendarId: cal, kind: 'task', title: '每日', start: '2020-01-01', rrule: 'FREQ=DAILY' })
  const t0 = realNow()
  const many = db.listOccurrences(cal, '2026-01-01', '2027-01-01')
  const cost = realNow() - t0
  ok(many.length > 300, `366 天区间能展开出足够多的实例（${many.length} 条）`)
  ok(cost < 1500, `366 天 × 多条重复展开耗时 ${cost}ms（< 1500ms）`)

  const dirtyId = 'dirty-rrule-1'
  await raw(dir, (conn) => {
    conn
      .prepare(
        `INSERT INTO events (id, calendar_id, kind, title, notes, all_day, start, end, rrule,
                             remind_minutes, target_date, color, completed, created_at, updated_at, deleted_at)
         VALUES (?, ?, 'task', '脏规则', NULL, 1, '2026-01-01', NULL, 'FREQ=NONSENSE;BYDAY=XX', NULL, NULL, NULL, 0, 1, 1, NULL)`
      )
      .run(dirtyId, cal)
  })
  let dirtyCount = 0
  ok(
    (() => {
      try {
        dirtyCount = db.listOccurrences(cal, '2026-01-01', '2026-01-10').filter((o) => o.event.id === dirtyId).length
        return true
      } catch (err) {
        console.error('    脏 rrule 让 listOccurrences 抛错：', err.message)
        return false
      }
    })(),
    '非法 rrule 不会让 listOccurrences 抛错'
  )
  ok(dirtyCount > 0, `非法 rrule 退化成基础频率仍然可见（${dirtyCount} 条）`)
  // 老库里的脏规则不该拦住"只改标题"这种编辑；显式写脏规则仍然要报错
  passes(() => db.updateEvent(dirtyId, { title: '改个名' }), '带脏 rrule 的事件仍然可以改标题')
  throws(() => db.updateEvent(dirtyId, { rrule: 'FREQ=BOGUS' }), '显式把 rrule 改成非法值被拒绝', /FREQ/)

  const kinds = db.listOccurrences(cal, '2026-01-01', '2026-12-31', 'countdown')
  ok(kinds.length > 0 && kinds.every((o) => o.event.kind === 'countdown'), 'kind 过滤只留倒数日')
})

/* ============================ 6.5 倒数日文案 ============================ */

section('倒数日：唯一实现 / 含头语义 / 时区无关', async () => {
  const { countdownDays, countdownText } = await import(
    pathToFileURL(join(gen, 'shared/countdown.mjs')).href
  )
  eq(countdownDays('2026-02-10', '2026-02-10'), 0, '目标日当天是 0 天')
  eq(countdownDays('2026-02-11', '2026-02-10'), 1, '目标日次日是 1 天')
  eq(countdownDays('2026-02-09', '2026-02-10'), -1, '已过一天是 -1')
  eq(countdownText('2026-02-10', '2026-02-10'), '今天', '当天文案「今天」')
  eq(countdownText('2026-02-11', '2026-02-10'), '还有 1 天', '未来文案')
  eq(countdownText('2026-02-09', '2026-02-10'), '已过 1 天', '已过文案')
  eq(countdownText(null, '2026-02-10'), null, '不是倒数日返回 null')
  eq(countdownText(undefined, '2026-02-10'), null, 'undefined 也返回 null')
  eq(countdownDays('2028-03-01', '2028-02-28'), 2, '跨闰年 2 月按真实天数算（2028 是闰年）')
  eq(countdownDays('2027-03-01', '2027-02-28'), 1, '非闰年 2 月少一天')
  eq(countdownDays('2027-01-01', '2026-12-31'), 1, '跨年正常')
  // 时区无关：同一组日期在任何时刻都算出同一个数
  const realDateNow = Date.now
  try {
    eq(countdownDays('2026-06-01', '2026-05-01'), 31, '5 月 31 天')
    Date.now = () => realDateNow() + 36_000_000
    eq(countdownDays('2026-06-01', '2026-05-01'), 31, '换个时刻还是同一个数（不受本地时区/夏令时影响）')
  } finally {
    Date.now = realDateNow
  }
  // 主进程/data 层不再自己算一遍
  eq(typeof db.daysUntil, 'undefined', 'db.ts 里不再重复导出 daysUntil')
})

/* ============================ 7. 事件软删除 ============================ */

section('事件软删除 / 恢复 / 修改', async () => {
  useDir('ev-del')
  const cal = db.listCalendars()[0].id
  const ev = db.createEvent({ calendarId: cal, kind: 'task', title: '删我', start: '2026-07-01' })

  advance(200_000)
  db.deleteEvent(ev.id)
  throws(() => db.getEvent(ev.id), '删除后按 id 取不到')
  eq(db.listOccurrences(cal, '2026-07-01', '2026-07-31').filter((o) => o.event.id === ev.id).length, 0, '删除后不参与展开')
  const tomb = db.exportRows('events', 0).find((r) => r.id === ev.id)
  ok(tomb && tomb.deletedAt !== null, '导出带上墓碑（deletedAt 非空）')
  throws(() => db.deleteEvent(ev.id), '重复删除报错', /不存在|已删除/)

  advance(200_000)
  db.restoreEvent(ev.id)
  eq(db.getEvent(ev.id).title, '删我', '恢复后事件回来了')
  throws(() => db.restoreEvent('ghost'), '恢复不存在的事件报错', /不存在/)

  advance(200_000)
  db.updateEvent(ev.id, { title: '改了', rrule: 'FREQ=DAILY', start: '2026-07-02' })
  eq(db.getEvent(ev.id).title, '改了', 'updateEvent 生效')
  eq(db.getEvent(ev.id).rrule, 'FREQ=DAILY', 'updateEvent 能设置 rrule')
  db.updateEvent(ev.id, { rrule: null, targetDate: null })
  eq(db.getEvent(ev.id).rrule, null, 'updateEvent 能清空 rrule')
  throws(() => db.updateEvent(ev.id, { kind: 'countdown' }), '改成倒数日却没目标日被拒绝', /targetDate/)
  throws(() => db.updateEvent('ghost', { title: 'x' }), '改不存在的事件报错', /不存在/)
  const cd = db.createEvent({ calendarId: cal, kind: 'countdown', title: '倒数', start: '2026-07-05', targetDate: '2026-07-10' })
  eq(db.updateEvent(cd.id, { kind: 'task' }).targetDate, null, '从倒数日切回普通任务时清掉 targetDate')

  // 单次事件勾完成
  const single = db.createEvent({ calendarId: cal, kind: 'task', title: '单次', start: '2026-07-20' })
  db.setOccurrenceDone(single.id, '2026-07-20', true)
  eq(db.getEvent(single.id).completed, true, '单次事件完成状态写在 events.completed')
  eq(db.exportRows('event_done', 0).filter((r) => r.eventId === single.id).length, 0, '单次事件不写 event_done')
})

/* ============================ 8. 便签 ============================ */

section('便签：CRUD / 排序 / 上限', async () => {
  useDir('notes')
  const cal = db.listCalendars()[0].id
  const other = db.createCalendar('另一个')

  throws(() => db.createNote({ calendarId: cal, content: '   ' }), '空便签被拒绝', /不能为空/)
  const n1 = db.createNote({ calendarId: cal, content: '正文' })
  eq(n1.title, '', '默认标题为空')
  eq(db.createNote({ calendarId: other.id, title: '只有标题', content: '' }).title, '只有标题', '只填标题也能建')
  throws(() => db.createNote({ calendarId: cal, content: 'x'.repeat(100_001) }), '内容超长被拒绝', /过长/)
  throws(() => db.createNote({ calendarId: 'ghost', content: 'x' }), '视图不存在被拒绝', /视图不存在/)

  const pinned = db.createNote({ calendarId: cal, content: '置顶', pinned: true })
  eq(db.listNotes(cal)[0].id, pinned.id, '置顶便签排最前')
  eq(db.listNotes(cal).length, 2, '按视图过滤')
  eq(db.listNotes().length, 3, '不传视图返回全部')

  db.updateNote(n1.id, { content: '改过', title: '标题' })
  eq(db.getNote(n1.id).title, '标题', '改标题')
  throws(() => db.updateNote(n1.id, { content: '  ', title: '' }), '改成空便签被拒绝', /不能为空/)
  throws(() => db.getNote('ghost'), '取不存在的便签报错', /不存在/)

  db.deleteNote(n1.id)
  throws(() => db.getNote(n1.id), '删除后取不到')
  eq(db.listNotes(cal).some((n) => n.id === n1.id), false, '删除后不在列表里')

  // limit 参数：非法值不能把 SQL 打挂
  passes(() => db.listNotes(undefined, Number.NaN), 'limit=NaN 不抛错')
  const nanRows = (() => {
    try {
      return db.listNotes(undefined, Number.NaN)
    } catch {
      return []
    }
  })()
  ok(nanRows.length <= 500, `limit=NaN 不会变成"不限条数"（实际 ${nanRows.length} 条）`)
  eq(db.listNotes(undefined, 1).length, 1, 'limit=1 生效')
  eq(db.listNotes(undefined, 99_999).length <= 500, true, 'limit 超过上限被钳到 500')
})

/* ============================ 9. 搜索 ============================ */

section('搜索：中文 / 大小写 / LIKE 通配符 / 反斜杠', async () => {
  useDir('search')
  const cal = db.listCalendars()[0].id

  db.setDayCellText(cal, '2026-08-01', '写周报\n开会')
  db.setDayCellText(cal, '2026-08-02', '100%完成\n进度_快')
  db.setDayCellText(cal, '2026-08-03', 'a\\b')
  db.createEvent({ calendarId: cal, kind: 'task', title: 'Weekly Report', start: '2026-08-04' })
  db.createNote({ calendarId: cal, title: '备忘录', content: '里面有周报模板' })

  const hit = (q, ...rest) => db.search(q, ...rest)
  eq(hit('周报').filter((h) => h.type === 'task').map((h) => h.title), ['写周报'], '中文子串命中，返回整行文本')
  eq(hit('周报').find((h) => h.type === 'task').lineIndex, 0, '命中行号正确')
  eq(hit('周报').filter((h) => h.type === 'note').length, 1, '便签内容也能命中')
  eq(hit('report').length, 1, '搜索不区分大小写')
  eq(hit('REPORT').length, 1, '搜索不区分大小写（全大写）')
  eq(hit('100%').length, 1, '关键词里的 % 当字面量')
  eq(hit('%').length, 1, '% 不会匹配所有行（只命中真含 % 的那格）')
  eq(hit('_').length, 1, '_ 不会匹配任意单字符（只命中真含 _ 的那格）')
  eq(hit('a\\b').length, 1, '关键词里的反斜杠当字面量（不会退化成 "ab"）')
  eq(hit('ab').length, 0, '搜 ab 不会误中 a\\b')
  throws(() => db.search('   '), '空关键词被拒绝', /不能为空/)
  ok(hit('周报', cal).length >= 1, '限定视图搜索')
  eq(hit('周报', 'ghost').length, 0, '搜索不存在的视图返回空')
  eq(hit('周报', cal, 1).length, 1, 'limit 生效')
  const noteId = db.listNotes(cal)[0].id
  db.deleteNote(noteId)
  eq(hit('备忘录').length, 0, '已删除的便签不出现在搜索里')
  eq(hit("x%' OR 1=1 --").length, 0, '带引号/通配符的注入串不报错也不误命中')
  ok(db.listCalendars().length > 0, '注入尝试后库仍然可用')
  // 长文本 + 多行命中
  db.setDayCellText(cal, '2026-08-05', ['周报', '周报', '无关'].join('\n'))
  eq(hit('周报').filter((h) => h.date === '2026-08-05').length, 2, '同一格多行命中会分别列出')
})

/* ============================ 10. 回滚快照 ============================ */

section('回滚：合并窗口 / 上限 / 游标 / 计数 / 清空', async () => {
  const dir = useDir('snap')
  const cal = db.listCalendars()[0].id

  advance(200_000)
  db.setDayCellText(cal, '2026-09-01', 'v1')
  eq(db.listSnapshots().length, 1, '第一次改动产生一条记录')
  advance(30_000)
  db.setDayCellText(cal, '2026-09-01', 'v2')
  eq(db.listSnapshots().length, 1, '100 秒内同一行合并')
  eq(db.listSnapshots()[0].count, 1, '合并后 count 仍为 1')
  advance(120_000)
  db.setDayCellText(cal, '2026-09-01', 'v3')
  eq(db.listSnapshots().length, 2, '超出窗口另起一条')

  const snaps = db.listSnapshots()
  eq(snaps.filter((s) => s.current).length, 1, '任何时候只有一条是「当前」')
  eq(snaps[0].current, true, '「当前」默认是最新那条')

  const [newest, oldest] = db.listSnapshots()
  eq(db.restoreSnapshot(newest.id), { restored: 1, deleted: 0, failed: 0 }, '恢复结果计数正确')
  eq(db.getDayCell(cal, '2026-09-01').text, 'v2', '回到「第三条改动之前」那个时间点')
  eq(db.listSnapshots().length, 2, '恢复不新增记录')
  eq(db.listSnapshots().find((s) => s.id === newest.id).current, true, '被恢复的记录成为「当前」')
  eq(db.listSnapshots().filter((s) => s.current).length, 1, '「当前」仍然唯一')
  eq(db.restoreSnapshot(oldest.id), { restored: 0, deleted: 1, failed: 0 }, '再往前一站：那行当时还不存在 → 删除')
  eq(db.getDayCell(cal, '2026-09-01').text, '', '再往回退，那一行整个消失')
  throws(() => db.restoreSnapshot('ghost'), '恢复不存在的记录报错', /回滚记录不存在/)

  advance(200_000)
  db.setDayCellText(cal, '2026-09-02', 'v4')
  eq(db.listSnapshots()[0].current, true, '有新改动后「当前」回到最新')

  advance(200_000)
  db.setDayCellText(cal, '2026-09-03', '要撤销的新行')
  advance(200_000)
  const addSnap = db.listSnapshots()[0]
  eq(db.restoreSnapshot(addSnap.id), { restored: 0, deleted: 1, failed: 0 }, '撤销"新建"表现为删除')
  eq(db.listDayCells(cal, '2026-09-03', '2026-09-03').length, 0, '撤销后这一格彻底消失')

  // 单行失败只计数，不中断其余行（用一条"修改"的记录，entries 里才有 data）
  advance(200_000)
  db.setDayCellText(cal, '2026-09-10', 'good1')
  advance(200_000)
  db.setDayCellText(cal, '2026-09-10', 'good2')
  advance(200_000)
  const lastSnap = db.listSnapshots()[0]
  const entries = JSON.parse(
    await raw(dir, (conn) => conn.prepare('SELECT entries FROM snapshots WHERE id = ?').get(lastSnap.id).entries)
  )
  entries.push({
    table: 'day_cells',
    id: 'evil:1',
    data: { id: 'evil:1', calendar_id: cal, date: '2026-09-10', text: 'x', color: null, updated_at: 1, deleted_at: null, bogus_col: 1 }
  })
  await raw(dir, (conn) => {
    conn
      .prepare('UPDATE snapshots SET entries = ?, count = ? WHERE id = ?')
      .run(JSON.stringify(entries), entries.length, lastSnap.id)
  })
  const mixed = db.restoreSnapshot(lastSnap.id)
  eq(mixed.failed, 1, '坏行计入 failed')
  eq(mixed.restored >= 1, true, '坏行不影响其余行')

  // 未知表名不能被执行
  const evilEntries = [{ table: 'snapshots', id: 'x', data: null }]
  await raw(dir, (conn) => {
    conn.prepare('UPDATE snapshots SET entries = ? WHERE id = ?').run(JSON.stringify(evilEntries), lastSnap.id)
  })
  eq(db.restoreSnapshot(lastSnap.id), { restored: 0, deleted: 0, failed: 0 }, '白名单之外的表被忽略')

  // 上限裁剪
  for (let i = 0; i < 105; i += 1) {
    advance(200_000)
    db.setDayCellText(cal, '2026-10-01', `第 ${i} 版`)
  }
  eq(db.listSnapshots().length, 100, '最多保留 100 条记录')
  eq(db.listSnapshots().filter((s) => s.current).length, 1, '裁剪后「当前」仍唯一')
  eq(db.listSnapshots(5).length, 5, 'limit 参数生效')

  const cleared = db.clearSnapshots()
  eq(cleared, 100, `清空返回删除条数（${cleared}）`)
  eq(db.listSnapshots().length, 0, '清空后列表为空')
  eq(db.listSnapshots().filter((s) => s.current).length, 0, '清空后没有「当前」')
  advance(200_000)
  db.setDayCellText(cal, '2026-10-02', 'x')
  eq(db.listSnapshots().length, 1, '清空后还能继续记录')
  eq(db.listSnapshots()[0].current, true, '清空后新记录是「当前」')
})

/* ============================ 11. 同步导入导出 ============================ */

section('同步：camelCase / since / LWW / 墓碑 / 兜底', async () => {
  useDir('sync')
  const cal = db.listCalendars()[0].id

  advance(1_000)
  const ev = db.createEvent({ calendarId: cal, kind: 'task', title: '同步我', start: '2026-11-01' })
  const rows = db.exportRows('events', 0).filter((r) => r.id === ev.id)
  eq(rows.length, 1, '导出事件')
  const row = rows[0]
  eq(row.calendarId, cal, '导出用 camelCase（calendarId）')
  eq(row.allDay, 1, '布尔列导出成 0/1（与 importRows 对齐）')
  eq(row.deletedAt, null, '未删除的行 deletedAt 为 null')
  ok(typeof row.updatedAt === 'number', 'updatedAt 是数字')
  ok(!('calendar_id' in row), '导出结果没有 snake_case 字段')
  eq(db.exportRows('events', row.updatedAt + 1).length, 0, 'since 之后的增量不含这一行')

  eq(db.importRows('events', [{ ...row, title: '旧标题', updatedAt: row.updatedAt - 1 }]), { written: 0, failed: 0, errors: [] }, '更旧的远端行被丢弃')
  eq(db.getEvent(ev.id).title, '同步我', '丢弃后本地标题不变')
  eq(db.importRows('events', [{ ...row, title: '同时间戳', updatedAt: row.updatedAt }]).written, 0, '时间戳相等时不覆盖（严格大于）')
  eq(db.importRows('events', [{ ...row, title: '新标题', updatedAt: row.updatedAt + 10 }]).written, 1, '更新的远端行写入')
  eq(db.getEvent(ev.id).title, '新标题', 'LWW 生效')

  db.importRows('events', [{ ...row, updatedAt: row.updatedAt + 20, deletedAt: 12345 }])
  throws(() => db.getEvent(ev.id), '墓碑导入后本地也看不到')
  eq(db.exportRows('events', 0).find((r) => r.id === ev.id).deletedAt, 12345, '墓碑能再导出（别的设备拉得到）')

  eq(db.importRows('calendars', [{ id: 'remote-cal', updatedAt: 5000, deletedAt: null, color: '#123456' }]).written, 1, '缺 name/sort 的远端视图也能导入')
  eq(db.listCalendars().find((c) => c.id === 'remote-cal').name, '', '缺省 name 兜底成空串')

  eq(db.importRows('events', [null, { id: 1 }, { id: 'x' }]).failed, 3, '缺 id/updatedAt 的行计入 failed')
  eq(db.importRows('events', []), { written: 0, failed: 0, errors: [] }, '空数组直接返回')

  // 带引号/注入的远端值也是绑定的
  eq(
    db.importRows('notes', [
      { id: 'n-evil', updatedAt: 7000, deletedAt: null, calendarId: cal, title: "'); DROP TABLE notes;--", content: 'x', pinned: 0 }
    ]).written,
    1,
    '远端带引号的行能导入'
  )
  eq(db.getNote('n-evil').title, "'); DROP TABLE notes;--", '注入串原样保存，notes 表还在')
})

/* ============================ 11b. 导出复合游标 ============================ */

section('导出：复合游标 (updated_at, id) 不会卡在同一时间戳', async () => {
  useDir('cursor')
  const cal = db.listCalendars()[0].id

  /*
   * 造 1200 个日格，**全部同一个 updatedAt**（模拟迁移脚本用常量时间戳批量插入，
   * 或首次登录全量推）。单时间戳游标的老实现会：第一页 500 行 → 游标 = 那个时间戳
   * → 第二页 `updated_at > cursor` 返回 0 行 → 剩下 700 行永远推不上去。
   */
  const STAMP = 1_800_000_000_000
  const total = 1200
  const rowsToImport = []
  for (let i = 0; i < total; i += 1) {
    const date = `2026-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`
    rowsToImport.push({ id: `${cal}:${date}`, calendarId: cal, date, text: `第 ${i} 条`, color: null, updatedAt: STAMP, deletedAt: null })
  }
  db.importRows('day_cells', rowsToImport)

  const seen = new Set()
  let cursor = 0
  let cursorId = ''
  let rounds = 0
  for (; rounds < 20; rounds += 1) {
    const page = db.exportRows('day_cells', cursor, cursorId)
    if (page.length === 0) break
    for (const r of page) seen.add(r.id)
    const last = page[page.length - 1]
    cursor = last.updatedAt
    cursorId = last.id
  }
  eq(seen.size, total, `1200 行同一时间戳靠 (updated_at, id) 游标全部翻到（实际 ${seen.size}）`)
  eq(rounds, 3, '分了 3 页翻完（500 + 500 + 200）')

  eq(db.exportRows('day_cells', STAMP, '').length, 500, '省略 sinceId 时等价单游标：仍返回第一页 500 行')
  eq(db.exportRows('day_cells', STAMP + 1, '').length, 0, '时间戳越过之后没有剩余行')

  // 顺序必须是 (updated_at, id)，否则复合游标会漏
  const firstPage = db.exportRows('day_cells', 0, '')
  const sorted = [...firstPage].sort((a, b) => (a.updatedAt - b.updatedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  eq(firstPage.map((r) => r.id), sorted.map((r) => r.id), '导出按 (updated_at, id) 升序')
})

/* ============================ 12. SQL 拼接静态扫描 ============================ */

section('SQL：拼接点静态扫描 + 运行时注入', async () => {
  eq(scanSql(dbSource), [], '所有 prepare/exec 的模板插值都在白名单里')

  useDir('inject')
  const cal = db.listCalendars()[0].id
  const evilName = "x';DROP TABLE events;--"
  eq(db.createCalendar(evilName).name, evilName, '视图名可以包含引号（参数绑定）')
  db.setDayCellText(cal, '2026-12-01', "a'); DELETE FROM notes;--")
  eq(db.getDayCell(cal, '2026-12-01').text, "a'); DELETE FROM notes;--", '日格文本原样保存')
  db.createNote({ calendarId: cal, content: "'); DROP TABLE notes;--" })
  ok(db.exportRows('events', 0).length >= 0, 'events 表还在')
  ok(db.exportRows('notes', 0).length >= 1, 'notes 表还在')
  eq(db.listCalendars().length, 3, 'calendars 表还在且多了那条视图')
  throws(() => db.exportRows('events; DROP TABLE notes', 0), 'exportRows 拒绝非白名单表名')
  throws(() => db.importRows('notes--', []), 'importRows 拒绝非白名单表名')
})

/* ============================ 13. 多表操作的事务性 ============================ */

section('事务：删除视图 = 全成或全不成', async () => {
  const dir = useDir('tx')
  const victim = db.createCalendar('要删的')
  db.setDayCellText(victim.id, '2026-05-01', '任务一')
  advance(200_000)

  await raw(dir, (conn) => {
    conn.exec(`CREATE TRIGGER boom BEFORE UPDATE ON day_cells
               BEGIN SELECT RAISE(ABORT, 'boom'); END;`)
  })
  let threw = false
  try {
    db.deleteCalendar(victim.id)
  } catch {
    threw = true
  }
  ok(threw, '删除中途失败会抛出（不是静默半截）')
  eq(db.listCalendars().some((c) => c.id === victim.id), true, '失败后视图仍然是活的（整条语句回滚）')
  eq(db.getDayCell(victim.id, '2026-05-01').text, '任务一', '失败后日格内容没被破坏')
  await raw(dir, (conn) => conn.exec('DROP TRIGGER boom'))
  eq(db.deleteCalendar(victim.id).some((c) => c.id === victim.id), false, '去掉故障后删除成功')
})

/* ------------------------------ 跑起来 ------------------------------ */

try {
  db = await import(pathToFileURL(join(gen, 'db.mjs')).href)
  for (const item of plan) {
    if (filter && !item.name.includes(filter)) continue
    console.log(item.name)
    sectionChecks = 0
    try {
      await item.fn()
    } catch (err) {
      failures += 1
      console.error('  ✗ 这一节没跑完：', err?.stack ?? err)
    }
    console.log(`  （${sectionChecks} 项）`)
  }

  /* ---------- 迁移：老库补列 ---------- */

  if (!filter || '老库迁移'.includes(filter)) {
    console.log('老库迁移：补 id / deleted_at 列')
    db.closeDb()
    const legacyDir = join(tmp, 'legacy')
    mkdirSync(legacyDir, { recursive: true })
    const { DatabaseSync } = await import('node:sqlite')
    const legacy = new DatabaseSync(join(legacyDir, 'caldesk.db'))
    legacy.exec(`CREATE TABLE event_skip (
      event_id TEXT NOT NULL,
      occurrence_date TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (event_id, occurrence_date)
    );
    CREATE TABLE event_done (
      event_id TEXT NOT NULL,
      occurrence_date TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (event_id, occurrence_date)
    );`)
    const ins = legacy.prepare('INSERT INTO event_skip (event_id, occurrence_date, updated_at) VALUES (?, ?, ?)')
    ins.run('evt-1', '2026-01-05', 1)
    legacy.prepare('INSERT INTO event_done (event_id, occurrence_date, updated_at) VALUES (?, ?, ?)').run('evt-1', '2026-01-06', 2)
    legacy.close()

    db.initDb(legacyDir)
    const migrated = db.exportRows('event_skip', 0)
    eq(migrated.length, 1, '老库 event_skip 行还在')
    eq(migrated[0].id, 'evt-1:2026-01-05', 'event_skip 回填出 id')
    eq(migrated[0].deletedAt, null, 'event_skip 补出的 deleted_at 为 NULL（不是墓碑）')
    const done = db.exportRows('event_done', 0)
    eq(done.length, 1, '老库 event_done 行还在')
    eq(done[0].id, 'evt-1:2026-01-06', 'event_done 回填出 id')
    eq(done[0].deletedAt, null, 'event_done 补出的 deleted_at 为 NULL（不是墓碑）')
  }
} finally {
  try {
    db?.closeDb()
  } catch {
    /* 已经关了 */
  }
  Date.now = realNow
  try {
    rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* Windows 上偶尔删不掉，留给系统临时目录 */
  }
}

/**
 * 扫描 db.ts 里所有 prepare(`...`) / exec(`...`) 的模板插值。
 * 允许的插值只有两类：白名单表名变量，或纯结构片段（列名拼接/占位符/绑定值片段）。
 */
function scanSql(src) {
  const allowed = [
    /^pair\.table$/,
    /^entry\.table$/,
    /^table$/,
    /^t$/,
    // exportRows/importRows 里已经过 assertSyncTable 白名单校验的表名
    /^name$/,
    // 模块级常量（全大写）才能直接拼进 SQL
    /^[A-Z][A-Z0-9_]*$/,
    /^calendarId \? 'AND calendar_id = \?' : ''$/,
    /^cols\.join\(', '\)$/,
    /^placeholders$/,
    /^updates$/,
    /^updates\.join\(', '\)$/
  ]
  const findings = []
  const callRe = /\b(?:prepare|exec)\(\s*`/g
  let m
  while ((m = callRe.exec(src))) {
    const line = src.slice(0, m.index).split('\n').length
    const start = callRe.lastIndex
    let i = start
    let depth = 0
    while (i < src.length) {
      const ch = src[i]
      if (depth === 0 && ch === '`') break
      if (ch === '$' && src[i + 1] === '{') {
        depth += 1
        i += 2
        continue
      }
      if (depth > 0 && ch === '}') depth -= 1
      i += 1
    }
    const body = src.slice(start, i)
    for (const expr of topLevelInterpolations(body)) {
      if (!allowed.some((re) => re.test(expr.trim()))) findings.push(`db.ts:${line} → \${${expr}}`)
    }
  }
  return findings
}

function topLevelInterpolations(raw) {
  const out = []
  let i = 0
  while (i < raw.length) {
    if (raw[i] === '$' && raw[i + 1] === '{') {
      let depth = 1
      let j = i + 2
      while (j < raw.length && depth > 0) {
        if (raw[j] === '{') depth += 1
        else if (raw[j] === '}') depth -= 1
        j += 1
      }
      out.push(raw.slice(i + 2, j - 1))
      i = j
    } else {
      i += 1
    }
  }
  return out
}

console.log(failures === 0 ? `\n全部通过 ✅（${checks} 项）` : `\n${failures} 项失败 ❌（共 ${checks} 项）`)
process.exit(failures === 0 ? 0 : 1)
