/** 看桌面端本地库的表和同步状态 */
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { homedir } from 'node:os'

const db = new DatabaseSync(join(homedir(), 'AppData', 'Roaming', 'caldesk', 'caldesk.db'))
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
console.log('表：', tables.map((t) => t.name).join(', '))
for (const t of tables) {
  try {
    const n = db.prepare(`SELECT COUNT(*) c FROM "${t.name}"`).get()
    console.log(`  ${t.name}: ${n.c} 行`)
  } catch (e) {
    console.log(`  ${t.name}: 读不了 (${e.message})`)
  }
}
for (const t of tables.map((x) => x.name)) {
  if (t.startsWith('sync')) {
    console.log(`\n${t} 内容：`)
    console.log(JSON.stringify(db.prepare(`SELECT * FROM "${t}" LIMIT 10`).all(), null, 2))
  }
}
