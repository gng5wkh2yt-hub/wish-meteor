-- 愿海 D1 schema
-- 用法：npx wrangler d1 execute wish-meteor --file=./schema.sql --remote

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,              -- 'u' + base36，服务端生成
  name        TEXT NOT NULL,                 -- 显示名 = 登录名 = 星海搜索名
  name_lower  TEXT NOT NULL,                 -- 小写，唯一索引用
  salt        TEXT NOT NULL,                 -- 客户端 PBKDF2 的盐（hex）
  iters       INTEGER NOT NULL DEFAULT 210000,
  pwd_hash    TEXT NOT NULL,                 -- HMAC-SHA256(authKey, PEPPER) 的 hex
  avatar_key  TEXT,                          -- R2 对象键；NULL = 默认纯黑圆（不发图片请求）
  avatar_ver  INTEGER NOT NULL DEFAULT 0,    -- 换头像 +1，做缓存破坏
  home_x      REAL NOT NULL,                 -- 该用户主星的世界坐标（搜索飞行目标）
  home_y      REAL NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_name ON users(name_lower);

CREATE TABLE IF NOT EXISTS wishes (
  id         TEXT PRIMARY KEY,   -- hash(userId + 客户端本地id)，天然幂等，重复上传不产生重复愿望
  user_id    TEXT NOT NULL,
  text       TEXT NOT NULL,      -- 服务端再截断到 24 字
  ts         INTEGER NOT NULL,   -- 客户端原始许愿时间（上传时原样保留）
  x          REAL NOT NULL,      -- 星海世界坐标，写入即定，永不改变
  y          REAL NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wishes_user ON wishes(user_id);
CREATE INDEX IF NOT EXISTS idx_wishes_ts   ON wishes(ts DESC);
CREATE INDEX IF NOT EXISTS idx_wishes_xy   ON wishes(x, y);   -- 视口矩形查询用
