-- memo · 数据库结构
-- 执行：npx wrangler d1 execute <你的库名> --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  content    TEXT    NOT NULL,
  created_at INTEGER NOT NULL,          -- 毫秒时间戳
  updated_at INTEGER,
  pinned     INTEGER NOT NULL DEFAULT 0 -- 0/1
);

CREATE INDEX IF NOT EXISTS idx_notes_time ON notes (pinned DESC, created_at DESC);

-- 后台可改的站点配置（键值对，目前只用到 key = 'site'）
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0
);
