/**
 * D1 建表：Worker 启动时自动跑一次，不再依赖手工执行 SQL 文件。
 *
 * 为什么放在这里：仓库连到 Cloudflare 之后是"推代码即部署"，
 * 如果建表还要人去控制台粘 SQL，换台机器 / 新建环境就会漏。
 * 语句全部是 IF NOT EXISTS，重复执行无副作用；每个 isolate 只跑一次。
 *
 * 数据模型说明：
 * - accounts：一个账号 = 一份数据的归属者（多账号隔离的根）。
 *              服务端存明文，encrypted 列只作历史兼容，不再写入也不再读取。
 * - devices ：账号下的设备，凭 secret_salt + sha256(salt||secret) 认人，
 *              status 走 pending → approved / revoked 的配对流程
 * - pairings ：一次性配对码（6 位数字，5 分钟有效），授权端生成、新设备消费
 * - rows     ：所有集合共用一张表，payload 是整行的明文 JSON 字符串，
 *              服务端不加密、不改写；主键 (tbl, account_id, id) —— 带上
 *              account_id 是为了让不同账号可以用同一个行 id 而互不干扰
 */

export interface D1Like {
  prepare(sql: string): {
    run(): Promise<unknown>
    all<T = unknown>(): Promise<{ results: T[] }>
  }
  batch?(statements: Array<{ run(): Promise<unknown> }>): Promise<unknown>
}

const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS accounts (
     id         TEXT    PRIMARY KEY,
     name       TEXT    NOT NULL DEFAULT '',
     encrypted  INTEGER NOT NULL DEFAULT 0,
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
  `CREATE INDEX IF NOT EXISTS idx_pairings_account ON pairings (account_id)`,
  `CREATE TABLE IF NOT EXISTS rows (
     tbl        TEXT    NOT NULL,
     id         TEXT    NOT NULL,
     account_id TEXT    NOT NULL,
     updated_at INTEGER NOT NULL,
     deleted_at INTEGER,
     payload    TEXT    NOT NULL,
     PRIMARY KEY (tbl, account_id, id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rows_tbl_updated ON rows (tbl, updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_rows_account_tbl ON rows (account_id, tbl, updated_at)`
]

let ready = false

export async function ensureSchema(db: D1Like): Promise<void> {
  if (ready) return
  for (const sql of SCHEMA) {
    await db.prepare(sql).run()
  }
  await migrateRowsPrimaryKey(db)
  await ensureAccountColumns(db)
  ready = true
}

/**
 * 账号密码登录替代了旧的配对流程：accounts 需要补上凭据列。
 *
 * D1/SQLite 的 ALTER TABLE 没有 IF NOT EXISTS，只能先 PRAGMA 看现有列再补，
 * 这样老库（只有 id/name/encrypted/created_at）也能平滑升级，已有账号的
 * rows 数据一行不动 —— 老设备用现有凭据调 /auth/claim 设一次用户名密码即可。
 */
const ACCOUNT_COLUMNS: Array<[string, string]> = [
  ['username', 'TEXT'],
  ['username_key', 'TEXT'],
  ['password_hash', 'TEXT'],
  ['password_salt', 'TEXT'],
  ['password_iters', 'INTEGER'],
  ['updated_at', 'INTEGER']
]

async function ensureAccountColumns(db: D1Like): Promise<void> {
  const { results } = await db.prepare('PRAGMA table_info(accounts)').all<{ name: string }>()
  const have = new Set((results ?? []).map((r) => r.name))
  for (const [name, type] of ACCOUNT_COLUMNS) {
    if (!have.has(name)) {
      await db.prepare(`ALTER TABLE accounts ADD COLUMN ${name} ${type}`).run()
    }
  }
  // 用户名大小写不敏感地唯一；空值（老账号还没 claim）允许重复
  await db
    .prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_username ON accounts (username_key)')
    .run()
}

/**
 * 旧库里的 rows 主键是 (tbl, id)：不同账号用同一个行 id 会撞在一起，
 * 后写的那条会被 LWW 守卫吞掉 —— 账号之间就互相丢数据了。
 * 而且新代码用 ON CONFLICT(tbl, account_id, id)，在旧主键上会直接报错。
 *
 * 这里把老表搬成新表（主键带上 account_id）。老数据本身是端到端加密时代的
 * 密文，客户端已经不再需要它，搬迁只是保持"别丢行"，不做任何解码。
 */
async function migrateRowsPrimaryKey(db: D1Like): Promise<void> {
  const { results } = await db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'rows'`)
    .all<{ sql: string | null }>()

  const current = results?.[0]?.sql ?? ''
  if (!current) return // 表刚建好（主键已经正确），什么都不用做
  if (/PRIMARY KEY\s*\(\s*tbl\s*,\s*account_id\s*,\s*id\s*\)/i.test(current)) return

  const steps = [
    `DROP TABLE IF EXISTS rows_migrate`,
    `CREATE TABLE rows_migrate (
       tbl        TEXT    NOT NULL,
       id         TEXT    NOT NULL,
       account_id TEXT    NOT NULL,
       updated_at INTEGER NOT NULL,
       deleted_at INTEGER,
       payload    TEXT    NOT NULL,
       PRIMARY KEY (tbl, account_id, id)
     )`,
    `INSERT OR IGNORE INTO rows_migrate (tbl, id, account_id, updated_at, deleted_at, payload)
     SELECT tbl, id, account_id, updated_at, deleted_at, payload FROM rows`,
    `DROP TABLE rows`,
    `ALTER TABLE rows_migrate RENAME TO rows`,
    `CREATE INDEX IF NOT EXISTS idx_rows_tbl_updated ON rows (tbl, updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_rows_account_tbl ON rows (account_id, tbl, updated_at)`
  ]

  try {
    if (typeof db.batch === 'function') {
      // 一次事务搬完，中途失败不会留下半张表
      await db.batch(steps.map((sql) => db.prepare(sql)))
    } else {
      for (const sql of steps) await db.prepare(sql).run()
    }
  } catch (err) {
    // 多个 isolate 可能同时迁移：后到的那个会撞上已经搬完的表。
    // 这种情况下重新看一眼当前主键，已经是新主键就算成功。
    const check = await db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'rows'`)
      .all<{ sql: string | null }>()
    const sql = check.results?.[0]?.sql ?? ''
    if (!/PRIMARY KEY\s*\(\s*tbl\s*,\s*account_id\s*,\s*id\s*\)/i.test(sql)) {
      throw err
    }
  }
}
