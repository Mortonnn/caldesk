/**
 * 回滚（快照）引擎校验。
 *
 * 目标：不启动 Electron，直接跑 src/main/db.ts 的真实实现。
 * 做法：
 *   1. 用项目自带的 typescript 把 db.ts / shared/*.ts 转成 ESM 写进临时目录；
 *   2. 给 db.ts 补一个 require 垫片（它用 require('node:sqlite') 规避缺类型）；
 *   3. 在临时目录里 initDb，然后逐条验证回滚语义。
 *
 * 时间用可控时钟推进：合并窗口是 100 秒，靠 advance() 跨窗口，脚本才稳定可重复。
 *
 * 运行： node scripts/verify-snapshots.mjs
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tmp = mkdtempSync(join(tmpdir(), 'caldesk-snap-'))
const gen = join(tmp, 'gen')

let failures = 0
function ok(cond, msg) {
  if (cond) {
    console.log('  ✓', msg)
    return
  }
  failures += 1
  console.error('  ✗', msg)
}

function throws(fn, msg) {
  try {
    fn()
    ok(false, `${msg}（预期抛错却成功了）`)
  } catch {
    ok(true, msg)
  }
}

/** 把 TS 源码转成 ESM 模块，顺便把 @shared/* 重写成相对路径 */
function emit(srcRel, outRel, head = '') {
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
  const out = join(gen, outRel)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, head + patched)
}

emit('src/shared/types.ts', 'shared/types.mjs')
emit('src/shared/rrule.ts', 'shared/rrule.mjs')
emit(
  'src/main/db.ts',
  'db.mjs',
  "import { createRequire as __createRequire } from 'node:module'\nconst require = __createRequire(import.meta.url)\n"
)

/* ------------------------------ 可控时钟 ------------------------------ */

const realNow = Date.now
let clock = realNow()
Date.now = () => clock
const advance = (ms) => {
  clock += ms
}

let db = null
try {
  db = await import(pathToFileURL(join(gen, 'db.mjs')).href)

  /* ------------------------------ 1. 日格 ------------------------------ */

  console.log('日格：新建 + 连续修改')
  const dataDir = join(tmp, 'data')
  mkdirSync(dataDir, { recursive: true })
  db.initDb(dataDir)
  const cal = db.listCalendars()[0].id

  db.setDayCellText(cal, '2026-01-05', '第一行')
  let list = db.listSnapshots()
  ok(list.length === 1, '第一次写入产生 1 条记录')
  ok(list[0].label === '修改日格', '标签是「修改日格」')
  ok(list[0].count === 1 && list[0].tables.join(',') === 'day_cells', '摘要 count/tables 正确')

  advance(30_000)
  db.setDayCellText(cal, '2026-01-05', '第一行\n第二行')
  list = db.listSnapshots()
  ok(list.length === 1 && list[0].count === 1, '100 秒窗口内同一行合并成一条（不新增）')

  advance(200_000)
  db.setDayCellText(cal, '2026-01-05', '第一行\n第二行\n第三行')
  list = db.listSnapshots()
  ok(list.length === 2, '超出窗口后另起一条记录')

  const target = list[0]
  const r1 = db.restoreSnapshot(target.id)
  ok(r1.restored === 1 && r1.deleted === 0 && r1.failed === 0, '回滚结果 restored=1 / deleted=0 / failed=0')
  ok(db.getDayCell(cal, '2026-01-05').text === '第一行\n第二行', '日格文本回到编辑前')
  ok(!db.listSnapshots().some((s) => s.id === target.id), '已应用的记录被删除（不可重复应用）')
  const backup = db.listSnapshots()[0]
  ok(backup.label === '回滚前的自动备份', '回滚前自动生成「回滚前的自动备份」')
  const r2 = db.restoreSnapshot(backup.id)
  ok(
    r2.restored === 1 && db.getDayCell(cal, '2026-01-05').text === '第一行\n第二行\n第三行',
    '备份记录能把这次回滚再撤销'
  )

  /* ------------------------------ 2. 事件 ------------------------------ */

  console.log('事件：新建 / 修改 / 删除')
  advance(200_000)
  const ev = db.createEvent({
    calendarId: cal,
    kind: 'task',
    title: '写周报',
    start: '2026-02-01',
    allDay: true
  })
  ok(db.listSnapshots()[0].label === '新建事件', '新建事件记录标签正确')
  const rNew = db.restoreSnapshot(db.listSnapshots()[0].id)
  ok(rNew.deleted === 1, '撤销新建 = 删除该行')
  throws(() => db.getEvent(ev.id), '撤销后事件确实不存在')

  advance(200_000)
  const ev2 = db.createEvent({ calendarId: cal, kind: 'task', title: '标题A', start: '2026-02-02' })
  advance(200_000)
  db.updateEvent(ev2.id, { title: '标题B' })
  ok(db.listSnapshots()[0].label === '修改事件', '修改事件记录标签正确')
  const rUpd = db.restoreSnapshot(db.listSnapshots()[0].id)
  ok(rUpd.restored === 1 && db.getEvent(ev2.id).title === '标题A', '修改可回滚到原标题')

  advance(200_000)
  db.deleteEvent(ev2.id)
  ok(db.listSnapshots()[0].label === '删除事件', '删除事件记录标签正确')
  db.restoreSnapshot(db.listSnapshots()[0].id)
  ok(db.getEvent(ev2.id).title === '标题A', '软删除的事件能恢复')

  /* ---------------------- 3. 重复事件：完成 / 仅删本次 ---------------------- */

  console.log('重复事件：完成状态与「仅删除本次」')
  advance(200_000)
  const rec = db.createEvent({
    calendarId: cal,
    kind: 'task',
    title: '每周例会',
    start: '2026-01-05',
    rrule: 'FREQ=WEEKLY;BYDAY=MO'
  })
  const doneDates = () =>
    db.listOccurrences(cal, '2026-01-01', '2026-02-28').filter((o) => o.event.id === rec.id)

  advance(200_000)
  db.setOccurrenceDone(rec.id, '2026-01-12', true)
  ok(db.listSnapshots()[0].label === '切换完成状态', '完成状态记录标签正确')
  ok(db.listSnapshots()[0].tables.join(',') === 'event_done', '重复事件记在 event_done 上')
  ok(doneDates().find((o) => o.date === '2026-01-12').done === true, '本次被标记完成')
  db.restoreSnapshot(db.listSnapshots()[0].id)
  ok(doneDates().find((o) => o.date === '2026-01-12').done === false, '回滚后完成标记消失')

  advance(200_000)
  db.skipOccurrence(rec.id, '2026-01-19')
  ok(db.listSnapshots()[0].label === '仅删除本次', '「仅删除本次」记录标签正确')
  const skipRows = db.exportRows('event_skip', 0)
  ok(skipRows.length === 1 && skipRows[0].id === `${rec.id}:2026-01-19`, 'event_skip 行带上了 id')
  ok(!doneDates().some((o) => o.date === '2026-01-19'), '被跳过的日期已从展开结果里消失')
  db.restoreSnapshot(db.listSnapshots()[0].id)
  ok(doneDates().some((o) => o.date === '2026-01-19'), '回滚后该次发生重新出现')

  /* ------------------------------ 4. 视图 ------------------------------ */

  console.log('视图：新建 / 修改 / 删除（连带日格）')
  advance(200_000)
  const cal2 = db.createCalendar('临时视图')
  ok(db.listSnapshots()[0].label === '新建视图', '新建视图记录标签正确')
  advance(200_000)
  db.setDayCellText(cal2.id, '2026-03-01', '视图内的任务')
  advance(200_000)
  db.deleteCalendar(cal2.id)
  const delSnap = db.listSnapshots()[0]
  ok(delSnap.label === '删除视图', '删除视图记录标签正确')
  ok(delSnap.count === 2 && delSnap.tables.sort().join(',') === 'calendars,day_cells', '删除视图同时带上它的日格行')
  const rDel = db.restoreSnapshot(delSnap.id)
  ok(rDel.restored === 2, '视图与其日格一起恢复')
  ok(db.listCalendars().some((c) => c.id === cal2.id), '视图回到列表里')
  ok(db.getDayCell(cal2.id, '2026-03-01').text === '视图内的任务', '视图下的日格内容也回来了')

  advance(200_000)
  db.updateCalendar(cal2.id, { name: '改过的名字' })
  ok(db.listSnapshots()[0].label === '修改视图', '修改视图记录标签正确')

  /* ------------------------------ 5. 便签 ------------------------------ */

  console.log('便签：新建 / 修改 / 删除')
  advance(200_000)
  const note = db.createNote({ calendarId: cal, content: '初稿' })
  ok(db.listSnapshots()[0].label === '新建便签', '新建便签记录标签正确')
  advance(200_000)
  db.updateNote(note.id, { content: '改过的正文' })
  ok(db.listSnapshots()[0].label === '修改便签', '修改便签记录标签正确')
  db.restoreSnapshot(db.listSnapshots()[0].id)
  ok(db.getNote(note.id).content === '初稿', '便签正文可回滚')
  advance(200_000)
  db.deleteNote(note.id)
  ok(db.listSnapshots()[0].label === '删除便签', '删除便签记录标签正确')
  db.restoreSnapshot(db.listSnapshots()[0].id)
  ok(db.getNote(note.id).content === '初稿', '软删除的便签能恢复')

  /* --------------------------- 6. 清理与上限 --------------------------- */

  console.log('记录上限与清空')
  for (let i = 0; i < 105; i += 1) {
    advance(200_000)
    db.setDayCellText(cal, '2026-04-01', `第 ${i} 版`)
  }
  ok(db.listSnapshots().length === 100, '最多只保留 100 条记录')

  const cleared = db.clearSnapshots()
  ok(cleared > 0 && db.listSnapshots().length === 0, `清空返回删除条数（${cleared}）`)

  /* --------------------------- 7. 老库迁移 --------------------------- */

  console.log('老库迁移：event_skip 补 id 列')
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
  );`)
  legacy.prepare('INSERT INTO event_skip (event_id, occurrence_date, updated_at) VALUES (?, ?, ?)').run(
    'evt-1',
    '2026-01-05',
    1
  )
  legacy.close()

  db.initDb(legacyDir)
  const migrated = db.exportRows('event_skip', 0)
  ok(
    migrated.length === 1 && migrated[0].id === 'evt-1:2026-01-05',
    '老库的 event_skip 行被回填出 id（并可通过同步接口导出）'
  )
} finally {
  try {
    db?.closeDb()
  } catch {
    /* 已经关过了 */
  }
  Date.now = realNow
  // Windows 下 sqlite 文件句柄释放稍慢，删不掉就留给系统临时目录
  try {
    rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* 忽略清理失败 */
  }
}

console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
