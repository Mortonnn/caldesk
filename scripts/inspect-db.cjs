/** 读库自检：确认回滚链路在真实应用里生效（临时脚本，用完可删） */
const { DatabaseSync } = require('node:sqlite')
const path = require('node:path')

const p = path.join(process.env.APPDATA || '', 'caldesk', 'caldesk.db')
const db = new DatabaseSync(p, { readOnly: true })

const snaps = db
  .prepare('SELECT label, count, created_at, updated_at FROM snapshots ORDER BY updated_at DESC LIMIT 10')
  .all()
console.log('snapshots:', JSON.stringify(snaps))

const leftover = db.prepare("SELECT date, text FROM day_cells WHERE text LIKE '%回滚自检%'").all()
console.log('leftover test rows:', leftover.length, JSON.stringify(leftover))

const total = db.prepare('SELECT COUNT(*) AS n FROM snapshots').get()
console.log('total snapshots:', total.n)

const skip = db.prepare('PRAGMA table_info(event_skip)').all().map((c) => c.name)
console.log('event_skip columns:', JSON.stringify(skip))

db.close()
