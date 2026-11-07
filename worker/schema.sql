-- caldesk Cloudflare D1 数据库初始化表结构
--
-- 说明：
-- 1. accounts: 账号根表，支持用户名密码认证（PBKDF2 哈希 + 盐）与多账号隔离。
-- 2. devices: 账号绑定的设备表，凭 secret_salt + sha256(salt||secret) 认证。
-- 3. rows: 统一存储所有数据集合（calendars, day_cells, events, event_done, event_skip, notes, snapshots 等）。
--    主键为 (tbl, account_id, id)，保证多账号数据完全隔离；
--    origin_device 配合 updated_at 实现基于 LWW（最后写入者赢）的分布式平局裁决。

-- 1. 账号表
CREATE TABLE IF NOT EXISTS accounts (
  id             TEXT    PRIMARY KEY,
  name           TEXT    NOT NULL DEFAULT '',
  encrypted      INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  username       TEXT,
  username_key   TEXT,
  password_hash  TEXT,
  password_salt  TEXT,
  password_iters INTEGER,
  updated_at     INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_username ON accounts (username_key);

-- 2. 设备表
CREATE TABLE IF NOT EXISTS devices (
  device_id    TEXT    PRIMARY KEY,
  account_id   TEXT    NOT NULL,
  name         TEXT    NOT NULL DEFAULT '',
  secret_salt  TEXT    NOT NULL,
  secret_hash  TEXT    NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'pending',
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER,
  last_ip      TEXT
);

CREATE INDEX IF NOT EXISTS idx_devices_account ON devices (account_id);

-- 3. 数据行统一存储表
CREATE TABLE IF NOT EXISTS rows (
  tbl           TEXT    NOT NULL,
  id            TEXT    NOT NULL,
  account_id    TEXT    NOT NULL,
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER,
  payload       TEXT    NOT NULL,
  origin_device TEXT,
  PRIMARY KEY (tbl, account_id, id)
);

CREATE INDEX IF NOT EXISTS idx_rows_tbl_updated ON rows (tbl, updated_at);
CREATE INDEX IF NOT EXISTS idx_rows_account_tbl ON rows (account_id, tbl, updated_at);
CREATE INDEX IF NOT EXISTS idx_rows_account_updated ON rows (account_id, updated_at);

-- 4. 登录 / 注册失败计数（固定窗口限流）
--    key = 「login|用户名键|IP」或「reg|IP」；成功一次即删除。
CREATE TABLE IF NOT EXISTS auth_fails (
  key          TEXT    PRIMARY KEY,
  count        INTEGER NOT NULL DEFAULT 0,
  window_at    INTEGER NOT NULL,
  locked_until INTEGER
);
