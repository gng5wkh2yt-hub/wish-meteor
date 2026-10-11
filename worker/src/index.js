/**
 * 愿海后端 —— Cloudflare Worker
 *
 * 密码方案：浏览器跑 PBKDF2（昂贵），服务端只做一次 HMAC（便宜）。
 * 这样规避 Workers 免费版 10ms CPU 限制 —— 10 万次 PBKDF2 会直接打爆它。
 *
 * 登录态：无状态签名 token，校验只验签不查库。
 */

const CORS_ORIGINS = [
  'https://gng5wkh2yt-hub.github.io',
  'https://huiliyi.site',
  'https://www.huiliyi.site',
  // 本地开发用（file:// 的 Origin 是 null，没法白名单，所以用 http server 预览）
  'http://localhost:8765',
  'http://127.0.0.1:8765',
];

const TOKEN_TTL = 30 * 24 * 3600 * 1000;   // 30 天

/* ============================ 基础工具 ============================ */
const enc = new TextEncoder();

function corsHeaders(origin) {
  const allow = CORS_ORIGINS.includes(origin) ? origin : CORS_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(data, status = 200, origin = '') {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...corsHeaders(origin),
    },
  });
}

function toHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function b64urlEncode(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return decodeURIComponent(escape(atob(s)));
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

// 常数时间比较，避免用 === 泄露前缀信息
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function randomId(prefix) {
  const b = crypto.getRandomValues(new Uint8Array(9));
  return prefix + [...b].map(x => x.toString(36)).join('').slice(0, 12);
}

/* ---------------- 简易限流 ----------------
   免费版没有 Rate Limiting 绑定，用一张轻量表按 IP + 分钟窗口计数。
   注册接口最需要它 —— 没有的话任何脚本都能一分钟灌几百个账号。 */
async function rateOk(env, ip, limit) {
  if (!ip) return true;                       // 拿不到 IP 就不拦，别误伤
  const win = Math.floor(Date.now() / 60000);
  const row = await env.DB.prepare(
    'SELECT hits FROM rate WHERE ip = ? AND window = ?'
  ).bind(ip, win).first();
  if ((row && row.hits) >= limit) return false;

  await env.DB.prepare(
    'INSERT INTO rate (ip, window, hits) VALUES (?, ?, 1) ' +
    'ON CONFLICT(ip, window) DO UPDATE SET hits = hits + 1'
  ).bind(ip, win).run();

  // 顺手清掉一小时前的窗口，表不会无限涨
  if (Math.random() < 0.02) {
    await env.DB.prepare('DELETE FROM rate WHERE window < ?').bind(win - 60).run();
  }
  return true;
}

/* ---------------- 星星坐标：Halton 低差异序列 ----------------
   真随机会出现肉眼可见的聚集和空洞；Halton 按序号铺点，视觉上均匀得多，
   而且坐标只跟 rowid 有关 —— 删掉几颗星，其余的一颗都不会挪位。 */
function halton(index, base) {
  let f = 1, r = 0, i = index;
  while (i > 0) { f /= base; r += f * (i % base); i = Math.floor(i / base); }
  return r;
}

// 给还没有坐标的愿望补上（-1 是"待分配"标记）
async function assignCoords(env) {
  const rows = await env.DB.prepare(
    'SELECT rowid AS rid, id FROM wishes WHERE x < 0 OR y < 0'
  ).all();
  const list = rows.results || [];
  if (!list.length) return;
  // 留 4% 边距，别贴着世界边界
  const stmts = list.map(r => env.DB.prepare('UPDATE wishes SET x = ?, y = ? WHERE id = ?')
    .bind(0.04 + halton(r.rid, 2) * 0.92, 0.04 + halton(r.rid, 3) * 0.92, r.id));
  await env.DB.batch(stmts);
}

/* ============================ token ============================ */
async function signToken(uid, secret) {
  const payload = b64urlEncode(JSON.stringify({ uid, exp: Date.now() + TOKEN_TTL }));
  const sig = await hmacHex(secret, payload);
  return payload + '.' + sig;
}

async function verifyToken(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const payload = token.slice(0, i);
  const sig = token.slice(i + 1);
  const expect = await hmacHex(secret, payload);
  if (!safeEqual(sig, expect)) return null;
  try {
    const data = JSON.parse(b64urlDecode(payload));
    if (!data.uid || !data.exp || data.exp < Date.now()) return null;
    return data;
  } catch (e) { return null; }
}

async function authUser(request, env) {
  const h = request.headers.get('Authorization') || '';
  if (!h.startsWith('Bearer ')) return null;
  const data = await verifyToken(h.slice(7), env.JWT_SECRET);
  if (!data) return null;
  const user = await env.DB.prepare(
    'SELECT id, name, name_lower, avatar_key, avatar_ver, created_at FROM users WHERE id = ?'
  ).bind(data.uid).first();
  return user || null;
}

/* ============================ 校验 ============================ */
function normalizeName(name) {
  if (typeof name !== 'string') return null;
  const n = name.trim();
  if (n.length < 2 || n.length > 16) return null;
  // 中文、字母、数字、下划线
  if (!/^[一-龥A-Za-z0-9_]+$/.test(n)) return null;
  return n;
}

function publicUser(u) {
  return {
    id: u.id,
    name: u.name,
    avatarUrl: u.avatar_key ? `/av/${u.avatar_key}` : null,
  };
}

/* ============================ 路由 ============================ */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    try {
      /* ---------- 自检页 ---------- */
      if (path === '/test') {
        return new Response(TEST_HTML, {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        });
      }

      /* ---------- 健康检查 ---------- */
      if (path === '/api/health') {
        const t0 = Date.now();
        let db = { ok: false, ms: null };
        try {
          const row = await env.DB.prepare(
            'SELECT (SELECT COUNT(*) FROM wishes) AS w, (SELECT COUNT(*) FROM users) AS u'
          ).first();
          db = { ok: true, ms: Date.now() - t0, wishes: row?.w ?? 0, users: row?.u ?? 0 };
        } catch (e) {
          db = { ok: false, ms: Date.now() - t0, error: String(e?.message || e) };
        }
        return json({
          ok: true, service: 'wish-meteor-api',
          colo: request.cf?.colo ?? null,
          country: request.cf?.country ?? null,
          db,
        }, 200, origin);
      }

      /* ---------- 取盐（登录前） ---------- */
      if (path === '/api/auth/salt' && request.method === 'GET') {
        const name = normalizeName(url.searchParams.get('u'));
        if (!name) return json({ error: 'bad_name' }, 400, origin);
        const u = await env.DB.prepare(
          'SELECT salt, iters FROM users WHERE name_lower = ?'
        ).bind(name.toLowerCase()).first();
        if (u) return json({ salt: u.salt, iters: u.iters }, 200, origin);
        // 用户不存在也返回一个确定性的伪 salt。
        // 这里绝不能多带任何字段 —— 之前我加了 exists:false，等于把
        // "这个名字没被注册" 直接写在响应里，前面整套伪盐防御全废。
        // 两条响应的字段必须逐字一致，只有 salt 值不同。
        const fake = await hmacHex(env.PEPPER, 'salt:' + name.toLowerCase());
        return json({ salt: fake.slice(0, 32), iters: 210000 }, 200, origin);
      }

      /* ---------- 注册 ---------- */
      if (path === '/api/auth/register' && request.method === 'POST') {
        const ip = request.headers.get('cf-connecting-ip') || '';
        if (!(await rateOk(env, ip, 5))) {
          return json({ error: '操作太频繁了，过一分钟再试' }, 429, origin);
        }
        const body = await request.json().catch(() => null);
        const name = normalizeName(body?.name);
        const authKey = typeof body?.authKey === 'string' ? body.authKey : '';
        const salt = typeof body?.salt === 'string' ? body.salt : '';
        const iters = Number(body?.iters) || 210000;
        if (!name) return json({ error: '用户名需 2–16 位，仅限中英文、数字、下划线' }, 400, origin);
        if (authKey.length < 32) return json({ error: 'bad_authkey' }, 400, origin);

        const exists = await env.DB.prepare(
          'SELECT id FROM users WHERE name_lower = ?'
        ).bind(name.toLowerCase()).first();
        if (exists) return json({ error: '这个名字已经有人用了' }, 409, origin);

        const id = randomId('u');
        const pwdHash = await hmacHex(env.PEPPER, authKey);

        await env.DB.prepare(
          `INSERT INTO users (id, name, name_lower, salt, iters, pwd_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(id, name, name.toLowerCase(), salt, iters, pwdHash, Date.now()).run();

        const user = await env.DB.prepare(
          'SELECT id, name, name_lower, avatar_key, avatar_ver, created_at FROM users WHERE id = ?'
        ).bind(id).first();

        return json({ token: await signToken(id, env.JWT_SECRET), user: publicUser(user) }, 200, origin);
      }

      /* ---------- 登录 ---------- */
      if (path === '/api/auth/login' && request.method === 'POST') {
        const ip = request.headers.get('cf-connecting-ip') || '';
        if (!(await rateOk(env, ip, 10))) {
          return json({ error: '尝试太频繁了，过一分钟再试' }, 429, origin);
        }
        const body = await request.json().catch(() => null);
        const name = normalizeName(body?.name);
        const authKey = typeof body?.authKey === 'string' ? body.authKey : '';
        if (!name || !authKey) return json({ error: 'bad_request' }, 400, origin);

        const u = await env.DB.prepare('SELECT * FROM users WHERE name_lower = ?')
          .bind(name.toLowerCase()).first();
        if (!u) return json({ error: '用户名或密码不对' }, 401, origin);

        const pwdHash = await hmacHex(env.PEPPER, authKey);
        if (!safeEqual(pwdHash, u.pwd_hash)) {
          return json({ error: '用户名或密码不对' }, 401, origin);
        }

        return json({ token: await signToken(u.id, env.JWT_SECRET), user: publicUser(u) }, 200, origin);
      }

      /* ---------- 当前用户 ---------- */
      if (path === '/api/me' && request.method === 'GET') {
        const me = await authUser(request, env);
        if (!me) return json({ error: 'unauthorized' }, 401, origin);
        const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM wishes WHERE user_id = ?')
          .bind(me.id).first();
        return json({ user: publicUser(me), wishCount: c?.n ?? 0 }, 200, origin);
      }

      /* ---------- 上传愿望（单条 / 批量） ---------- */
      if ((path === '/api/wishes' || path === '/api/wishes/bulk') && request.method === 'POST') {
        const me = await authUser(request, env);
        if (!me) return json({ error: 'unauthorized' }, 401, origin);

        const body = await request.json().catch(() => null);
        const list = path.endsWith('/bulk')
          ? (Array.isArray(body?.wishes) ? body.wishes.slice(0, 200) : [])
          : (body && body.text ? [body] : []);
        if (!list.length) return json({ error: '没有可上传的愿望' }, 400, origin);

        const now = Date.now();
        const out = [];
        const stmts = [];

        for (const w of list) {
          const text = typeof w?.text === 'string' ? w.text.trim().slice(0, 24) : '';
          if (!text) continue;

          // 客户端本地 id → 服务端 id：同一愿望重复上传不会产生重复记录
          const clientId = String(w.id || text + ':' + (w.ts || 0));
          const raw = await hmacHex(env.PEPPER, me.id + ':' + clientId);
          const id = 'w' + raw.slice(0, 16);

          // 时间戳取客户端原始值，但不接受未来或太离谱的值
          let ts = Number(w.ts) || now;
          if (!(ts > 946684800000 && ts <= now + 86400000)) ts = now;

          stmts.push(env.DB.prepare(
            'INSERT OR IGNORE INTO wishes (id, user_id, text, ts, x, y, created_at) VALUES (?, ?, ?, ?, -1, -1, ?)'
          ).bind(id, me.id, text, ts, now));
          out.push({ clientId, id });
        }

        // 逐条 run 是 N 次网络往返，几十条就会超时；batch 一次最多 50 条，分批跑
        let inserted = 0;
        for (let i = 0; i < stmts.length; i += 45) {
          const rs = await env.DB.batch(stmts.slice(i, i + 45));
          inserted += rs.reduce((n, r) => n + ((r.meta && r.meta.changes) || 0), 0);
        }

        // 坐标按 rowid 走 Halton 低差异序列 —— 视觉上均匀，且删星不会让其他星挪位
        await assignCoords(env);

        return json({ inserted, skipped: out.length - inserted, wishes: out }, 200, origin);
      }

      /* ---------- 删除愿望 ---------- */
      if (path.startsWith('/api/wishes/') && request.method === 'DELETE') {
        const me = await authUser(request, env);
        if (!me) return json({ error: 'unauthorized' }, 401, origin);
        const id = path.slice('/api/wishes/'.length);
        await env.DB.prepare('DELETE FROM wishes WHERE id = ? AND user_id = ?')
          .bind(id, me.id).run();
        return json({ ok: true }, 200, origin);
      }

      /* ---------- 拉取星海（公开，不看登录也能看） ---------- */
      if (path === '/api/sea' && request.method === 'GET') {
        const limit = Math.min(Number(url.searchParams.get('limit')) || 800, 2000);
        const rows = await env.DB.prepare(
          `SELECT w.id, w.text, w.ts, w.x, w.y, u.id AS uid, u.name, u.avatar_key, u.avatar_ver
           FROM wishes w JOIN users u ON u.id = w.user_id
           ORDER BY w.ts DESC LIMIT ?`
        ).bind(limit).all();

        const me = await authUser(request, env).catch(() => null);
        // total 必须是真总数。之前直接拿本页条数当 total，limit=1 时它返回 1，
        // 名字骗人 —— 前端一旦拿它做分页或显示"共 N 颗星"就会错。
        const cnt = await env.DB.prepare('SELECT COUNT(*) AS n FROM wishes').first();

        return json({
          total: cnt?.n ?? 0,
          returned: rows.results?.length || 0,
          mine: me ? me.id : null,
          wishes: (rows.results || []).map(r => ({
            id: r.id,
            text: r.text,
            ts: r.ts,
            x: r.x,
            y: r.y,
            uid: r.uid,
            name: r.name,
            avatarUrl: r.avatar_key ? `/av/${r.avatar_key}` : null,
          })),
        }, 200, origin);
      }

      /* ---------- 头像上传 ---------- */
      if (path === '/api/avatar' && request.method === 'POST') {
        const me = await authUser(request, env);
        if (!me) return json({ error: 'unauthorized' }, 401, origin);

        const buf = await request.arrayBuffer();
        if (!buf.byteLength || buf.byteLength > 64 * 1024) {
          return json({ error: '头像需小于 64KB' }, 413, origin);
        }
        // 校验确实是图片（webp: RIFF....WEBP / jpeg: FFD8FF / png: 89504E47）
        const b = new Uint8Array(buf.slice(0, 12));
        const isWebp = b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45;
        const isJpg = b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF;
        const isPng = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47;
        if (!isWebp && !isJpg && !isPng) return json({ error: '不是有效的图片' }, 400, origin);

        const ext = isWebp ? 'webp' : isJpg ? 'jpg' : 'png';
        const ver = (me.avatar_ver || 0) + 1;
        const key = `${me.id}_${ver}.${ext}`;
        // 存 base64（头像只有几 KB，不值得为它开通 R2）
        let bin = '';
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        const b64 = btoa(bin);

        await env.DB.prepare('UPDATE users SET avatar_key = ?, avatar_ver = ? WHERE id = ?')
          .bind(key, ver, me.id).run();
        await env.DB.prepare(
          'INSERT OR REPLACE INTO avatars (key, data, created_at) VALUES (?, ?, ?)'
        ).bind(key, b64, Date.now()).run();

        return json({ avatarUrl: `/av/${key}`, avatarVer: ver }, 200, origin);
      }

      /* ---------- 取头像 ---------- */
      if (path.startsWith('/av/') && request.method === 'GET') {
        const key = path.slice(4);
        const row = await env.DB.prepare('SELECT data FROM avatars WHERE key = ?').bind(key).first();
        if (!row) return new Response('not found', { status: 404, headers: corsHeaders(origin) });
        const bin = atob(row.data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        // 按实际格式回，别硬编码 —— 前端回退到 jpeg 时标成 webp 会解析错
        const mime = key.endsWith('.jpg') ? 'image/jpeg'
                   : key.endsWith('.png') ? 'image/png'
                   : 'image/webp';
        return new Response(bytes, {
          headers: {
            'content-type': mime,
            // 文件名带版本号，换头像时 URL 变化，可以放心长缓存
            'cache-control': 'public, max-age=31536000, immutable',
            ...corsHeaders(origin),
          },
        });
      }

      return json({ error: 'not_found', path }, 404, origin);
    } catch (e) {
      return json({ error: 'server_error', detail: String(e?.message || e) }, 500, origin);
    }
  },
};

/* ============================ 自检页 ============================ */
const TEST_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>愿海 · 自检</title>
<style>
body{min-height:100vh;background:#04050e;color:#eef2ff;margin:0;padding:28px 18px;
font-family:-apple-system,"PingFang SC",sans-serif}
.card{max-width:520px;margin:0 auto;background:rgba(255,255,255,.06);
border:1px solid rgba(255,255,255,.14);border-radius:22px;padding:22px 20px}
.big{text-align:center;font-size:52px;font-weight:600;color:#ffd88a;margin:8px 0}
.lbl{text-align:center;font-size:12px;letter-spacing:.24em;color:rgba(190,206,244,.5);margin-bottom:20px}
.row{display:flex;justify-content:space-between;padding:10px 2px;font-size:14px;
border-top:1px solid rgba(255,255,255,.08)}
.row span:first-child{color:rgba(180,196,236,.65)}
</style></head><body>
<div class="card">
  <div class="big" id="med">--</div>
  <div class="lbl">响 应 中 位 数</div>
  <div id="rows"></div>
</div>
<script>
(async () => {
  const s = [];
  let info = null, fails = 0;
  for (let i = 0; i < 6; i++) {
    const t0 = performance.now();
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      const j = await r.json();
      s.push(Math.round(performance.now() - t0));
      if (!info) info = j;
    } catch (e) { fails++; }
  }
  if (!s.length) { document.getElementById('med').textContent = '×'; return; }
  s.sort((a, b) => a - b);
  const m = s[Math.floor(s.length / 2)];
  document.getElementById('med').textContent = m + ' ms';
  document.getElementById('rows').innerHTML = [
    ['云端机房', info.colo || '?'],
    ['出口国家', info.country || '?'],
    ['数据库', info.db?.ok ? '正常 · ' + info.db.ms + ' ms' : '异常'],
    ['愿望总数', info.db?.wishes ?? '?'],
    ['注册用户', info.db?.users ?? '?'],
    ['成功 / 失败', s.length + ' / ' + fails],
  ].map(([k, v]) => '<div class="row"><span>' + k + '</span><span>' + v + '</span></div>').join('');
})();
<\/script></body></html>`;
