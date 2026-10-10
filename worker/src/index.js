/**
 * 愿海后端 —— Phase 0 骨架
 *
 * /api/health  JSON 健康检查（诊断用）
 * /test        手机友好的自检页，打开就是大字结果
 */

const CORS_ORIGINS = [
  'https://gng5wkh2yt-hub.github.io',
  'https://huiliyi.site',
  'https://www.huiliyi.site',
];

function corsHeaders(origin) {
  const allow = CORS_ORIGINS.includes(origin) ? origin : CORS_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    // 预检缓存一天。大陆到境外节点延迟高，这个能省掉一整个 RTT
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

const TEST_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#04050e">
<title>愿海 · 连通性自检</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{
    min-height:100vh;background:#04050e;
    color:#eef2ff;
    font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Songti SC",sans-serif;
    padding:32px 20px 60px;
    background-image:radial-gradient(circle at 20% 20%,rgba(70,94,196,.16),transparent 55%),
                     radial-gradient(circle at 85% 75%,rgba(148,84,190,.13),transparent 55%);
  }
  h1{font-size:17px;font-weight:400;letter-spacing:.3em;text-align:center;color:rgba(200,215,250,.7);margin-bottom:28px}
  .card{
    max-width:520px;margin:0 auto;
    background:rgba(255,255,255,.06);
    border:1px solid rgba(255,255,255,.14);
    border-radius:22px;padding:22px 20px;
    backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
    box-shadow:0 10px 40px rgba(0,0,0,.4);
  }
  .status{font-size:38px;text-align:center;margin-bottom:6px;line-height:1.2}
  .status-sub{text-align:center;color:rgba(190,206,244,.6);font-size:13px;margin-bottom:22px}
  .big{text-align:center;font-size:56px;font-weight:600;letter-spacing:.06em;
       color:#ffd88a;text-shadow:0 0 34px rgba(255,200,110,.5);margin:10px 0 4px}
  .big-label{text-align:center;font-size:12px;letter-spacing:.24em;color:rgba(190,206,244,.5);margin-bottom:24px}
  .row{display:flex;justify-content:space-between;padding:11px 2px;font-size:14px;
       border-top:1px solid rgba(255,255,255,.08)}
  .row span:first-child{color:rgba(180,196,236,.65)}
  .row span:last-child{font-variant-numeric:tabular-nums;color:#fff}
  .hint{margin-top:20px;font-size:12px;line-height:1.7;color:rgba(170,186,226,.55);text-align:center}
  .bad{color:#ff9a9a}
  .good{color:#8ce0a8}
</style>
</head>
<body>
  <h1>愿 海 · 连 通 自 检</h1>
  <div class="card">
    <div class="status" id="status">…</div>
    <div class="status-sub" id="sub">正在测试，请稍候</div>
    <div class="big" id="median">--</div>
    <div class="big-label">响 应 中 位 数</div>
    <div id="rows"></div>
    <div class="hint" id="hint"></div>
  </div>
<script>
(async () => {
  const status = document.getElementById('status');
  const sub = document.getElementById('sub');
  const med = document.getElementById('median');
  const rowsEl = document.getElementById('rows');
  const hint = document.getElementById('hint');
  const samples = [];
  let info = null, fails = 0;

  for (let i = 0; i < 6; i++) {
    const t0 = performance.now();
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      const j = await r.json();
      samples.push(Math.round(performance.now() - t0));
      if (!info) info = j;
    } catch (e) { fails++; }
  }

  const ok = samples.length > 0;
  status.textContent = ok ? '✅' : '❌';
  status.className = 'status ' + (ok ? 'good' : 'bad');
  sub.textContent = ok ? '后端可达' : '连不上后端';

  if (ok) {
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)];
    med.textContent = median + ' ms';
    rowsEl.innerHTML = [
      ['云端机房', info.colo || '?'],
      ['出口国家', info.country || '?'],
      ['数据库', info.db && info.db.ok ? '正常 · ' + info.db.ms + ' ms' : '异常'],
      ['最快 / 最慢', samples[0] + ' / ' + samples[samples.length - 1] + ' ms'],
      ['成功 / 失败', samples.length + ' / ' + fails],
    ].map(([k, v]) => '<div class="row"><span>' + k + '</span><span>' + v + '</span></div>').join('');
    hint.innerHTML = median < 600
      ? '速度可以，星海能流畅用'
      : (median < 1200 ? '偏慢但能用，前端会做缓存兜底' : '偏慢，可能要优化机房或加缓存');
  } else {
    med.textContent = '×';
    rowsEl.innerHTML = '<div class="row"><span>失败次数</span><span>' + fails + '</span></div>';
    hint.textContent = '请确认是用流量打开的，而不是 Wi-Fi。仍失败请把这一页截图给我。';
  }
})();
<\/script>
</body>
</html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // 手机友好自检页
    if (url.pathname === '/test') {
      return new Response(TEST_HTML, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    if (url.pathname === '/api/health') {
      // 顺带量一次 D1 往返，这样单个请求就能反映"Worker + 数据库"的端到端延迟
      const t0 = Date.now();
      let db = { ok: false, ms: null, wishes: null, users: null };
      try {
        const row = await env.DB
          .prepare('SELECT (SELECT COUNT(*) FROM wishes) AS w, (SELECT COUNT(*) FROM users) AS u')
          .first();
        db = { ok: true, ms: Date.now() - t0, wishes: row?.w ?? 0, users: row?.u ?? 0 };
      } catch (e) {
        db = { ok: false, ms: Date.now() - t0, error: String(e && e.message || e) };
      }

      return json({
        ok: true,
        service: 'wish-meteor-api',
        phase: 0,
        ts: Date.now(),
        // 请求实际落地的 Cloudflare 机房与出口国家 —— 诊断国内速度就看这个
        colo: request.cf?.colo ?? null,
        country: request.cf?.country ?? null,
        city: request.cf?.city ?? null,
        asn: request.cf?.asn ?? null,
        db,
      }, 200, origin);
    }

    return json({ error: 'not_found', path: url.pathname }, 404, origin);
  },
};
