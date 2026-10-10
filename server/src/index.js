/**
 * 愿海后端 —— 本机版
 *
 * 只监听 127.0.0.1，不暴露到局域网；对外靠 Cloudflare Tunnel。
 * 现在只有健康检查，用来验证 Tunnel 链路和实测延迟。
 */

import { createServer } from 'node:http';

const PORT = Number(process.env.PORT || 8787);
const HOST = '127.0.0.1';

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
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function send(res, status, body, origin, extra = {}) {
  res.writeHead(status, { ...corsHeaders(origin), ...extra });
  res.end(body);
}

function sendJson(res, data, status, origin) {
  send(res, status, JSON.stringify(data), origin, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
}

const server = createServer((req, res) => {
  const origin = req.headers.origin || '';
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') return send(res, 204, null, origin);

  if (url.pathname === '/api/health') {
    // Cloudflare 会在转发时注入这些头，用它就能看出流量实际落在哪个机房
    const cfRay = String(req.headers['cf-ray'] || '');        // 形如 "8a1b...-HKG"
    const colo = cfRay.includes('-') ? cfRay.split('-').pop() : null;
    return sendJson(res, {
      ok: true,
      service: 'wish-meteor-local',
      phase: 0,
      ts: Date.now(),
      uptime: Math.round(process.uptime()),
      node: process.version,
      colo,                                                      // Cloudflare 边缘机房
      country: req.headers['cf-ipcountry'] || null,
      via: cfRay ? 'cloudflare-tunnel' : 'local-direct',
    }, 200, origin);
  }

  sendJson(res, { error: 'not_found', path: url.pathname }, 404, origin);
});

server.listen(PORT, HOST, () => {
  console.log(`愿海本地服务已启动 → http://${HOST}:${PORT}`);
  console.log(`健康检查: http://${HOST}:${PORT}/api/health`);
});

process.on('SIGINT', () => {
  console.log('\n关闭中…');
  server.close(() => process.exit(0));
});
