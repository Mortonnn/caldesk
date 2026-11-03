/**
 * D1 建表：Worker 启动时自动跑一次，不再依赖手工执行 SQL 文件。
 *
 * 为什么放在这里：仓库连到 Cloudflare 之后是"推代码即部署"，
 * 如果建表还要人去控制台粘 SQL，换台机器 / 新建环境就会漏。
 * 语句全部是 IF NOT EXISTS，重复执行无副作用；每个 isolate 只跑一次。
 *
 * 数据模型说明：
 * - accounts：一个账号 = 一份加密数据的归属者（多账号隔离的根）
 * - devices ：账号下的设备，凭 secret_salt + sha256(salt||secret) 认人，
 *              status 走 pending → approved / revoked 的配对流程
 * - pairings ：一次性配对码（6 位数字，5 分钟有效），授权端生成、新设备消费
 * - rows     ：所有集合共用一张表，payload 是客户端加密后的不透明字符串，
 *              服务端永远看不到明文；主键 (tbl, id) 与旧版保持一致
 */

export interface D1Like {
  prepare(sql: string): { run(): Promise<unknown> }
}

const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS accounts (
     id         TEXT    PRIMARY KEY,
     name       TEXT    NOT NULL DEFAULT '',
     encrypted  INTEGER NOT NULL DEFAULT 1,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS devices (
     device_id    TEXT PRIMARY KEY,
     account_id   TEXT NOT NULL,
     name         TEXT NOT NULL DEFAULT '',
     secret_salt  TEXT NOT NULL,
     secret_hash  TEXT NOT NULL,
     status       TEXT NOT NULL DEFAULT 'pending',
     created_at   INTEGER NOT NULL,
     last_seen_at INTEGER,
     last_ip      TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_devices_account ON devices (account_id)`,
  `CREATE TABLE IF NOT EXISTS pairings (
     id         TEXT    PRIMARY KEY,
     account_id TEXT    NOT NULL,
     code       TEXT    NOT NULL,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     status     TEXT    NOT NULL DEFAULT 'open'
   )`,
  `CREATE TABLE IF NOT EXISTS rows (
     tbl        TEXT    NOT NULL,
     id         TEXT    NOT NULL,
     account_id TEXT    NOT NULL,
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
