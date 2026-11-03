-- caldesk-sync 初始表结构
-- 通用行表：一个集合一张"逻辑表"，物理上共用这一张
CREATE TABLE IF NOT EXISTS rows (
  tbl        TEXT    NOT NULL,
  id         TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  payload    TEXT    NOT NULL,
  PRIMARY KEY (tbl, id)
);

-- 增量拉取走 (tbl, updated_at) 索引
CREATE INDEX IF NOT EXISTS idx_rows_tbl_updated ON rows (tbl, updated_at);
