-- 愿海 D1 schema
-- 用法：npx wrangler d1 execute wish-meteor --file=./schema.sql --remote

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,              -- 'u' + base36，服务端生成
  name        TEXT NOT NULL,                 -- 显示名 = 登录名 = 星海搜索名
  name_lower  TEXT NOT NULL,                 -- 小写，唯一索引用
  salt        TEXT NOT NULL,                 -- 客户端 PBKDF2 的盐（hex）
  iters       INTEGER NOT NULL DEFAULT 210000,
  pwd_hash    TEXT NOT NULL,                 -- HMAC-SHA256(authKey, PEPPER) 的 hex
  avatar_key  TEXT,                          -- 头像键；NULL = 默认纯黑圆（不发图片请求）
  avatar_ver  INTEGER NOT NULL DEFAULT 0,    -- 换头像 +1，做缓存破坏
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_name ON users(name_lower);

CREATE TABLE IF NOT EXISTS wishes (
  id         TEXT PRIMARY KEY,   -- hash(userId + 客户端本地id)，天然幂等，重复上传不产生重复愿望
  user_id    TEXT NOT NULL,
  text       TEXT NOT NULL,      -- 服务端再截断到 24 字
  ts         INTEGER NOT NULL,   -- 客户端原始许愿时间（上传时原样保留）
  x          REAL NOT NULL,      -- 星海位置 0~1，服务端按 rowid 走 Halton 序列写入，永不改变
  y          REAL NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wishes_user ON wishes(user_id);
CREATE INDEX IF NOT EXISTS idx_wishes_ts   ON wishes(ts DESC);

-- 头像：存 base64（每张只有几 KB，不值得为它单独开通 R2）
CREATE TABLE IF NOT EXISTS avatars (
  key        TEXT PRIMARY KEY,   -- <userId>_<avatarVer>.<ext>，换头像时 key 变化
  data       TEXT NOT NULL,      -- base64
  created_at INTEGER NOT NULL
);

-- 限流：按 IP + 分钟窗口计数。没有它，任何脚本都能一分钟灌几百个账号。
CREATE TABLE IF NOT EXISTS rate (
  ip     TEXT NOT NULL,
  window INTEGER NOT NULL,       -- 分钟桶：Math.floor(Date.now()/60000)
  hits   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip, window)
);
