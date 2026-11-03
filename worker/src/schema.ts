/**
 * D1 建表：Worker 启动时自动跑一次，不再依赖手工执行 SQL 文件。
 *
 * 为什么放在这里：仓库连到 Cloudflare 之后是"推代码即部署"，
 * 如果建表还要人去控制台粘 SQL，换台机器 / 新建环境就会漏。
 * 语句全部是 IF NOT EXISTS，重复执行无副作用；每个 isolate 只跑一次。
 */

export interface D1Like {
  prepare(sql: string): { run(): Promise<unknown> }
}

const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS rows (
     tbl        TEXT    NOT NULL,
     id         TEXT    NOT NULL,
     updated_at INTEGER NOT NULL,
     deleted_at INTEGER,
     payload    TEXT    NOT NULL,
     PRIMARY KEY (tbl, id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rows_tbl_updated ON rows (tbl, updated_at)`
]

let ready = false

export async function ensureSchema(db: D1Like): Promise<void> {
  if (ready) return
  for (const sql of SCHEMA) {
    await db.prepare(sql).run()
  }
  ready = true
}
