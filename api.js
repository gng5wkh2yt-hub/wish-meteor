/* ============================================================
   愿海 · 后端通信
   统一走 api.huiliyi.site（Cloudflare Worker）。
   本地优先：网络失败一律静默降级，绝不阻塞许愿。
   ============================================================ */
window.WM = window.WM || {};

(function () {
  'use strict';

  const API_BASE = 'https://api.huiliyi.site';
  const TOKEN_KEY = 'wish-meteor:auth:v1';

  /* ---------------- 登录态 ---------------- */
  let token = null;
  try { token = localStorage.getItem(TOKEN_KEY) || null; } catch (e) { token = null; }

  function getToken() { return token; }

  function setToken(t) {
    token = t || null;
    try {
      if (t) localStorage.setItem(TOKEN_KEY, t);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (e) { /* 隐私模式，忽略 */ }
  }

  /* ---------------- 请求 ---------------- */
  async function request(path, { method = 'GET', body, auth = false, timeout = 12000 } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (auth && token) headers['Authorization'] = 'Bearer ' + token;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);

    try {
      const res = await fetch(API_BASE + path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const err = new Error((data && data.error) || ('HTTP ' + res.status));
        err.status = res.status;
        err.data = data;
        throw err;
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---------------- 客户端密钥拉伸 ----------------
     高成本计算放浏览器，服务端只做一次 HMAC —— 规避 Worker 10ms CPU 限制。 */
  async function stretchPassword(password, saltHex, iters) {
    const enc = new TextEncoder();
    const salt = hexToBytes(saltHex);
    const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: iters || 210000, hash: 'SHA-256' },
      key, 256
    );
    return bytesToHex(new Uint8Array(bits));
  }

  function hexToBytes(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }
  function bytesToHex(bytes) {
    return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /* ---------------- 头像压缩（零依赖，用内置 canvas） ---------------- */
  async function compressAvatar(file, size = 128) {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const c = canvas.getContext('2d');
    // 等比裁成方形（cover）
    const s = Math.min(bitmap.width, bitmap.height);
    const sx = (bitmap.width - s) / 2, sy = (bitmap.height - s) / 2;
    c.drawImage(bitmap, sx, sy, s, s, 0, 0, size, size);
    bitmap.close && bitmap.close();
    const blob = await new Promise(r => canvas.toBlob(r, 'image/webp', 0.8));
    // 极老浏览器不支持 webp 时回退 jpeg
    if (blob && blob.type !== 'image/webp') {
      return await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85));
    }
    return blob;
  }

  WM.api = {
    request,
    getToken,
    setToken,
    stretchPassword,
    compressAvatar,
    get base() { return API_BASE; },
    get loggedIn() { return !!token; },
  };
})();
