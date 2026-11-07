/**
 * D1 建表：Worker 启动时自动跑一次，不再依赖手工执行 SQL 文件。
 *
 * 为什么放在这里：仓库连到 Cloudflare 之后是"推代码即部署"，
 * 如果建表还要人去控制台粘 SQL，换台机器 / 新建环境就会漏。
 * 语句全部是 IF NOT EXISTS，重复执行无副作用；每个 isolate 只跑一次。
 *
 * 数据模型说明：
 * - accounts：一个账号 = 一份数据的归属者（多账号隔离的根）。
 *              账号凭据是「用户名 + 密码」，密码存 PBKDF2 哈希 + 随机盐。
 *              服务端存明文，encrypted 列只作历史兼容，不再写入也不再读取。
 * - devices ：账号下的设备，凭 secret_salt + sha256(salt||secret) 认人，
 *              status 是 approved / revoked；登录成功即 approved
 * - rows     ：所有集合共用一张表，payload 是整行的明文 JSON 字符串，
 *              服务端不加密、不改写；主键 (tbl, account_id, id) —— 带上
 *              account_id 是为了让不同账号可以用同一个行 id 而互不干扰
 *              origin_device 记录最后一次写入的 deviceId：updated_at 完全
 *              相等时用它按字典序定赢家（README 里的 LWW 平局规则）
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
  `CREATE TABLE IF NOT EXISTS rows (
     tbl           TEXT    NOT NULL,
     id            TEXT    NOT NULL,
     account_id    TEXT    NOT NULL,
     updated_at    INTEGER NOT NULL,
     deleted_at    INTEGER,
     payload       TEXT    NOT NULL,
     origin_device TEXT,
     PRIMARY KEY (tbl, account_id, id)
   )`,
  // 拉取 / 分页：WHERE tbl=? AND account_id=? AND updated_at>? ORDER BY updated_at, id
  `CREATE INDEX IF NOT EXISTS idx_rows_tbl_updated ON rows (tbl, updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_rows_account_tbl ON rows (account_id, tbl, updated_at)`,
  // /api/changes 的 MAX(updated_at) 与"按账号水位"的查询走这条，避免全表扫
  `CREATE INDEX IF NOT EXISTS idx_rows_account_updated ON rows (account_id, updated_at)`,
  // 登录 / 注册的失败计数：固定窗口，超限锁定一段时间。
  // 键是「用户名键|IP」或「reg|IP」，成功一次就清掉。
  `CREATE TABLE IF NOT EXISTS auth_fails (
     key          TEXT    PRIMARY KEY,
     count        INTEGER NOT NULL DEFAULT 0,
     window_at    INTEGER NOT NULL,
     locked_until INTEGER
   )`
]

/**
 * 建表只跑一次，但必须是**单飞**的。
 *
 * 以前这里是一个 `let ready = false`：同一 isolate 里两个并发首请求会同时
 * 看到 false，于是同时跑 CREATE / PRAGMA / ALTER。ALTER TABLE ADD COLUMN
 * 没有 IF NOT EXISTS，后到的那个直接 "duplicate column name" → 500。
 * 现在缓存的是 Promise：并发请求等同一个建表过程；失败则清空缓存，下次重试。
 */
let schemaReady: Promise<void> | null = null

export async function ensureSchema(db: D1Like): Promise<void> {
  if (!schemaReady) {
    schemaReady = runSchema(db).catch((err) => {
      schemaReady = null
      throw err
    })
  }
  return await schemaReady
}

async function runSchema(db: D1Like): Promise<void> {
  for (const sql of SCHEMA) {
    await db.prepare(sql).run()
  }
  await migrateRowsPrimaryKey(db)
  await ensureAccountColumns(db)
  await ensureRowsColumns(db)
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
  await addMissingColumns(db, 'accounts', ACCOUNT_COLUMNS)
  // 用户名大小写不敏感地唯一；空值（老账号还没 claim）允许重复
  await db
    .prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_username ON accounts (username_key)')
    .run()
}

/** rows 的 origin_device：LWW 平局时按 deviceId 字典序定赢家（老库要补列） */
const ROWS_COLUMNS: Array<[string, string]> = [['origin_device', 'TEXT']]

async function ensureRowsColumns(db: D1Like): Promise<void> {
  await addMissingColumns(db, 'rows', ROWS_COLUMNS)
}

async function addMissingColumns(
  db: D1Like,
  table: string,
  columns: Array<[string, string]>
): Promise<void> {
  const { results } = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()
  const have = new Set((results ?? []).map((r) => r.name))
  for (const [name, type] of columns) {
    if (!have.has(name)) {
      try {
        await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`).run()
      } catch (err) {
        // 另一个 isolate 刚补上同一列：重新看一眼，有了就算成功
        const again = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()
        if (!(again.results ?? []).some((r) => r.name === name)) throw err
      }
    }
  }
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
       tbl           TEXT    NOT NULL,
       id            TEXT    NOT NULL,
       account_id    TEXT    NOT NULL,
       updated_at    INTEGER NOT NULL,
       deleted_at    INTEGER,
       payload       TEXT    NOT NULL,
       origin_device TEXT,
       PRIMARY KEY (tbl, account_id, id)
     )`,
    `INSERT OR IGNORE INTO rows_migrate (tbl, id, account_id, updated_at, deleted_at, payload)
     SELECT tbl, id, account_id, updated_at, deleted_at, payload FROM rows`,
    `DROP TABLE rows`,
    `ALTER TABLE rows_migrate RENAME TO rows`,
    `CREATE INDEX IF NOT EXISTS idx_rows_tbl_updated ON rows (tbl, updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_rows_account_tbl ON rows (account_id, tbl, updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_rows_account_updated ON rows (account_id, updated_at)`
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
