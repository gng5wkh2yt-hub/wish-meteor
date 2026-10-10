/* ============================================================
   愿海 · 许愿页（第一屏）
   从原单文件 index.html 原样搬出，逻辑未改。
   依赖：DOM 结构（index.html）
   ============================================================ */
window.WM = window.WM || {};

(() => {
'use strict';

const cvs    = document.getElementById('sky');
const ctx    = cvs.getContext('2d');
const input  = document.getElementById('wishInput');
const btn    = document.getElementById('releaseBtn');
const bubble = document.getElementById('bubble');
const dock   = document.getElementById('dock');
const stack  = document.getElementById('stack');
const stackBody = document.getElementById('stackBody');
const stackFoot = document.getElementById('stackFoot');
const stackLabel= document.getElementById('stackLabel');

let W = 0, H = 0, DPR = 1;
let stars = [];
let bgMeteors = [];
let hero = null;
let heroAlpha = 0;
let busy = false;
let time = 0, last = 0, bgTimer = 0;
let storm = 0, stormTarget = 0;      // 长按背景时的流星雨强度 0→1

/* 背景流星：方向与颜色统一，只有速度/长度/明暗保留随机，
   这样既整齐又有层次；暖金的愿望流星才好从冷色流星雨里跳出来 */
let bgAngle = Math.PI * 0.78;
const BG_COLOR = [205, 226, 255];

const rand  = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

/* ==================================================================
   愿望存储 —— localStorage，天然按设备/浏览器隔离
   ================================================================== */
const STORE_KEY = 'wish-meteor:wishes:v1';
const MAX_KEEP  = 200;
const MAX_RENDER= 60;

let storeOK = true;
try {
  localStorage.setItem('__wm_probe__', '1');
  localStorage.removeItem('__wm_probe__');
} catch (e) { storeOK = false; }

function loadWishes() {
  if (!storeOK) return [];
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(w => w && typeof w.text === 'string' && w.text.trim());
  } catch (e) { return []; }
}

function persist() {
  if (!storeOK) return;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(wishes.slice(0, MAX_KEEP)));
  } catch (e) { /* 配额满或隐私模式，静默降级 */ }
}

let wishes = loadWishes();   // 新的在前

/* ---------------- 时间格式化 ---------------- */
function fmtTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const hm = String(d.getHours()).padStart(2, '0') + ':' +
             String(d.getMinutes()).padStart(2, '0');
  const day = x => x.getFullYear() + '/' + x.getMonth() + '/' + x.getDate();
  if (day(d) === day(now)) return '今天 ' + hm;
  const y = new Date(now); y.setDate(y.getDate() - 1);
  if (day(d) === day(y)) return '昨天 ' + hm;
  if (d.getFullYear() === now.getFullYear())
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
  return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
}

/* ==================================================================
   气泡堆叠渲染
   ================================================================== */
let stackOpen = false;

function renderStack(newId) {
  if (!wishes.length) {
    stack.hidden = true;
    stackBody.innerHTML = '';
    return;
  }
  stack.hidden = false;

  const list = stackOpen ? wishes.slice(0, MAX_RENDER) : wishes.slice(0, 1);

  stack.classList.toggle('open', stackOpen);
  stack.classList.toggle('has-more', wishes.length > 1);
  stackLabel.textContent = stackOpen ? '收起' : ('共 ' + wishes.length + ' 个愿望');

  stackBody.innerHTML = list.map(w => `
    <div class="wish-bubble${w.id === newId ? ' new' : ''}" data-id="${w.id}">
      <div class="wb-text"></div>
      <div class="wb-time">${fmtTime(w.ts)}</div>
      <button class="wb-send" type="button" aria-label="汇入星海"></button>
      <button class="wb-del" type="button" aria-label="删除这个愿望">✕</button>
    </div>
  `).join('');

  // 文字用 textContent 写入，避免任何注入
  const nodes = stackBody.querySelectorAll('.wish-bubble');
  const synced = getSynced();
  list.forEach((w, i) => {
    nodes[i].querySelector('.wb-text').textContent = w.text;
    const sb = nodes[i].querySelector('.wb-send');
    const on = !!synced[w.id];
    sb.classList.toggle('on', on);
    sb.title = on ? '已汇入星海，点击撤下' : '汇入星海';
  });
}

function addWish(text) {
  const w = {
    id: 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    text: text.slice(0, 24),
    ts: Date.now()
  };
  wishes.unshift(w);
  if (wishes.length > MAX_KEEP) wishes.length = MAX_KEEP;
  persist();
  stackOpen = false;
  renderStack(w.id);
  return w;
}

/* ---------------- 星海同步 ----------------
   记下每条愿望对应的服务端 id。默认不自动上传 —— 由用户在列表里逐条决定。 */
const SYNC_KEY = 'wish-meteor:synced:v1';

function getSynced() {
  try { return JSON.parse(localStorage.getItem(SYNC_KEY) || '{}') || {}; }
  catch (e) { return {}; }
}
function saveSynced(map) {
  try { localStorage.setItem(SYNC_KEY, JSON.stringify(map)); } catch (e) {}
}

async function toggleSync(clientId) {
  const w = wishes.find(x => x.id === clientId);
  if (!w) return;

  // 没登录就先引导注册 —— 星海要先有身份
  if (!WM.api || !WM.api.loggedIn) {
    if (WM.auth) WM.auth.openModal('register');
    return;
  }

  const synced = getSynced();
  const el = stackBody.querySelector('.wish-bubble[data-id="' + clientId + '"] .wb-send');
  if (el) el.classList.add('busy');

  try {
    if (synced[clientId]) {
      await WM.api.request('/api/wishes/' + synced[clientId], { method: 'DELETE', auth: true });
      delete synced[clientId];
    } else {
      const res = await WM.api.request('/api/wishes', {
        method: 'POST',
        auth: true,
        body: { id: w.id, text: w.text, ts: w.ts },
      });
      const got = res.wishes && res.wishes[0];
      if (got) synced[clientId] = got.id;
    }
    saveSynced(synced);
    renderStack(null);
    window.dispatchEvent(new CustomEvent('wm:wishes-changed'));
  } catch (e) {
    if (el) { el.classList.remove('busy'); el.title = '同步失败，再试一次'; }
  }
}

function removeWish(id) {
  const el = stackBody.querySelector(`.wish-bubble[data-id="${id}"]`);
  const drop = () => {
    wishes = wishes.filter(w => w.id !== id);
    persist();
    renderStack(null);
  };
  if (el) {
    el.classList.add('removing');
    setTimeout(drop, 400);
  } else drop();
}

stackBody.addEventListener('click', e => {
  const del = e.target.closest('.wb-del');
  if (del) {
    e.stopPropagation();
    removeWish(del.closest('.wish-bubble').dataset.id);
    return;
  }
  const send = e.target.closest('.wb-send');
  if (send) {
    e.stopPropagation();
    toggleSync(send.closest('.wish-bubble').dataset.id);
  }
});

function toggleStack(force) {
  const next = typeof force === 'boolean' ? force : !stackOpen;
  if (next === stackOpen) return;
  stackOpen = next;
  renderStack(null);
}

stackFoot.addEventListener('click', e => { e.stopPropagation(); toggleStack(); });
stackBody.addEventListener('click', e => {
  if (!stackOpen && !e.target.closest('.wb-del')) toggleStack(true);
});

/* ==================================================================
   画布尺寸 / 星空
   ================================================================== */
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  cvs.width  = Math.round(W * DPR);
  cvs.height = Math.round(H * DPR);
  cvs.style.width  = W + 'px';
  cvs.style.height = H + 'px';
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  bgAngle = Math.atan2(H * 0.92, -W);   // 与愿望流星同一角度，全屏平行
  buildStars();
}

function buildStars() {
  const n = clamp(Math.round(W * H / 3400), 160, 640);
  stars = [];
  for (let i = 0; i < n; i++) {
    const p = Math.random();
    const color = p < 0.68 ? [255, 255, 255]
                : p < 0.88 ? [186, 212, 255]
                           : [255, 226, 174];
    stars.push({
      x: Math.random() * W,
      y: Math.random() * H,
      r: rand(0.4, 1.45),
      base: rand(0.24, 0.88),
      phase: Math.random() * Math.PI * 2,
      speed: rand(0.35, 1.5),
      color
    });
  }
}

function drawSky() {
  const g = ctx.createLinearGradient(0, 0, W * 0.32, H);
  g.addColorStop(0,   '#04050e');
  g.addColorStop(0.46,'#070b1e');
  g.addColorStop(1,   '#0e0b26');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  ctx.globalCompositeOperation = 'lighter';
  nebula(W * 0.2,  H * 0.26, Math.max(W, H) * 0.46, 'rgba(70,94,196,0.11)');
  nebula(W * 0.84, H * 0.74, Math.max(W, H) * 0.4,  'rgba(148,84,190,0.085)');
  ctx.globalCompositeOperation = 'source-over';
}

function nebula(x, y, r, color) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, color);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
}

function drawStars() {
  for (let i = 0; i < stars.length; i++) {
    const s = stars[i];
    const a = s.base * (0.55 + 0.45 * Math.sin(time * s.speed + s.phase));
    ctx.fillStyle = `rgba(${s.color[0]},${s.color[1]},${s.color[2]},${a})`;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, 6.2832);
    ctx.fill();
  }
}

/* ==================================================================
   背景流星
   ================================================================== */
function spawnBgMeteor() {
  const ang   = bgAngle;
  const speed = rand(300, 700) * (1 + storm * 1.05);
  bgMeteors.push({
    x: rand(W * 0.02, W * 1.12),
    y: rand(-H * 0.32, H * 0.3),
    vx: Math.cos(ang) * speed,
    vy: Math.sin(ang) * speed,
    len: rand(100, 300) * (1 + storm * 0.35),
    width: rand(0.7, 2) * (1 + storm * 0.22),
    alpha: Math.min(rand(0.3, 0.86) * (1 + storm * 0.18), 1),
    color: BG_COLOR,
    life: 0,
    maxLife: rand(2.4, 5)
  });
}

function drawMeteor(m, a) {
  const sp = Math.hypot(m.vx, m.vy) || 1;
  const ux = m.vx / sp, uy = m.vy / sp;
  const tx = m.x - ux * m.len;
  const ty = m.y - uy * m.len;
  const r = m.color[0], gg = m.color[1], b = m.color[2];

  const g = ctx.createLinearGradient(m.x, m.y, tx, ty);
  g.addColorStop(0,    `rgba(255,255,255,${a})`);
  g.addColorStop(0.1,  `rgba(${r},${gg},${b},${a * 0.75})`);
  g.addColorStop(0.5,  `rgba(${r},${gg},${b},${a * 0.18})`);
  g.addColorStop(1,    `rgba(${r},${gg},${b},0)`);
  ctx.strokeStyle = g;
  ctx.lineWidth = m.width;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(m.x, m.y);
  ctx.lineTo(tx, ty);
  ctx.stroke();

  const hr = m.width * 3.6;
  const hg = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, hr);
  hg.addColorStop(0,   `rgba(255,255,255,${a})`);
  hg.addColorStop(0.34,`rgba(${r},${gg},${b},${a * 0.55})`);
  hg.addColorStop(1,   `rgba(${r},${gg},${b},0)`);
  ctx.fillStyle = hg;
  ctx.beginPath();
  ctx.arc(m.x, m.y, hr, 0, 6.2832);
  ctx.fill();
}

/* ==================================================================
   主流星（愿望升空）
   ================================================================== */
function launchWish(text) {
  // 与背景流星严格同角度：自右上角斜穿向左下角
  const ang = bgAngle;
  const ux = Math.cos(ang), uy = Math.sin(ang);   // ux<0, uy>0

  const m  = Math.min(W, H) * 0.3;
  const sx = W + m * 0.8;    // 从屏幕右上外侧切入
  const sy = -m * 0.5;

  let D = Infinity;
  if (ux < 0) D = Math.min(D, (-160 - sx) / ux);
  if (uy > 0) D = Math.min(D, (H + 160 - sy) / uy);
  if (!isFinite(D) || D <= 0) D = Math.hypot(W, H);

  hero = {
    sx, sy, x: sx, y: sy,
    dx: ux * D * 1.02,
    dy: uy * D * 1.02,
    ux, uy,
    age: 0,
    duration: 2.8,                 // 固定时长，划得慢一点看得清
    maxLen: Math.min(W, H) * 0.62,
    trail: 0,
    text
  };
  heroAlpha = 0;
  return hero.duration;
}

function updateHero(dt) {
  if (!hero) return;
  hero.age += dt;
  const t = hero.age / hero.duration;

  if (t >= 1 || hero.x < -260 || hero.y > H + 260) {
    hero = null;
    heroAlpha = 0;
    return;
  }

  const e = t * (0.6 + 0.4 * t);        // 平缓加速，不再末尾狂冲
  hero.x = hero.sx + hero.dx * e;
  hero.y = hero.sy + hero.dy * e;

  hero.trail = Math.max(hero.maxLen * (0.35 + 0.65 * t), 40);
  heroAlpha = clamp(t / 0.14, 0, 1);
}

function drawHero() {
  if (!hero) return;
  const a = heroAlpha;

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';

  const glowR = Math.min(W, H) * 0.17;
  const og = ctx.createRadialGradient(hero.x, hero.y, 0, hero.x, hero.y, glowR);
  og.addColorStop(0,   `rgba(255,228,168,${a * 0.4})`);
  og.addColorStop(0.4, `rgba(255,198,110,${a * 0.14})`);
  og.addColorStop(1,   'rgba(255,190,100,0)');
  ctx.fillStyle = og;
  ctx.beginPath(); ctx.arc(hero.x, hero.y, glowR, 0, 6.2832); ctx.fill();

  const tx = hero.x - hero.ux * hero.trail;
  const ty = hero.y - hero.uy * hero.trail;
  const g = ctx.createLinearGradient(hero.x, hero.y, tx, ty);
  g.addColorStop(0,    `rgba(255,252,240,${a * 0.95})`);
  g.addColorStop(0.09, `rgba(255,230,170,${a * 0.7})`);
  g.addColorStop(0.34, `rgba(255,204,124,${a * 0.24})`);
  g.addColorStop(0.72, `rgba(220,180,255,${a * 0.07})`);
  g.addColorStop(1,    'rgba(200,170,255,0)');
  ctx.strokeStyle = g;
  ctx.lineWidth = Math.min(W, H) * 0.012;
  ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(hero.x, hero.y); ctx.lineTo(tx, ty); ctx.stroke();

  const g2 = ctx.createLinearGradient(hero.x, hero.y, tx, ty);
  g2.addColorStop(0,   `rgba(255,255,255,${a})`);
  g2.addColorStop(0.22,`rgba(255,246,220,${a * 0.5})`);
  g2.addColorStop(1,   'rgba(255,240,200,0)');
  ctx.strokeStyle = g2;
  ctx.lineWidth = Math.min(W, H) * 0.0035;
  ctx.beginPath(); ctx.moveTo(hero.x, hero.y); ctx.lineTo(tx, ty); ctx.stroke();

  const hr = Math.min(W, H) * 0.032;
  const hg = ctx.createRadialGradient(hero.x, hero.y, 0, hero.x, hero.y, hr);
  hg.addColorStop(0,   `rgba(255,255,255,${a})`);
  hg.addColorStop(0.3, `rgba(255,240,200,${a * 0.8})`);
  hg.addColorStop(1,   'rgba(255,214,140,0)');
  ctx.fillStyle = hg;
  ctx.beginPath(); ctx.arc(hero.x, hero.y, hr, 0, 6.2832); ctx.fill();

  ctx.restore();

  if (hero.text && a > 0.02) {
    const len = hero.text.length;
    const fs = clamp(Math.min(W * 0.86 / len, H * 0.05), 13, 30);
    const ty2 = hero.y - fs * 1.5;
    ctx.save();
    ctx.font = `400 ${fs}px "Songti SC","STSong","SimSun",serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = `rgba(255,226,158,${a * 0.95})`;
    ctx.shadowBlur = 28;
    ctx.fillStyle = `rgba(255,252,242,${a})`;
    ctx.fillText(hero.text, hero.x, ty2);
    ctx.shadowBlur = 0;
    ctx.fillText(hero.text, hero.x, ty2);
    ctx.restore();
  }
}

/* ==================================================================
   主循环
   ================================================================== */
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  time += dt;

  drawSky();
  drawStars();

  // 长按背景 → 流星雨增强，松开后平滑回落
  storm += (stormTarget - storm) * (1 - Math.exp(-dt * 4.5));
  if (storm < 0.003) storm = 0;

  bgTimer += dt;
  if (bgTimer >= rand(0.16, 0.62) * (1 - storm * 0.78)) {
    bgTimer = 0;
    if (bgMeteors.length < 90) {
      spawnBgMeteor();
      if (Math.random() < 0.45 + storm * 0.5 && bgMeteors.length < 90) spawnBgMeteor();
    }
  }

  ctx.globalCompositeOperation = 'lighter';

  for (let i = bgMeteors.length - 1; i >= 0; i--) {
    const m = bgMeteors[i];
    m.x += m.vx * dt;
    m.y += m.vy * dt;
    m.life += dt;

    const out = m.x < -400 || m.x > W + 400 || m.y > H + 400 || m.y < -400;
    if (out || m.life > m.maxLife) { bgMeteors.splice(i, 1); continue; }

    let a = m.alpha;
    if (m.life < 0.3) a *= m.life / 0.3;
    const rest = m.maxLife - m.life;
    if (rest < 0.7) a *= Math.max(0, rest / 0.7);

    drawMeteor(m, a);
  }

  updateHero(dt);
  drawHero();

  ctx.globalCompositeOperation = 'source-over';
  requestAnimationFrame(frame);
}

/* ==================================================================
   交互
   ================================================================== */
function release() {
  if (busy) return;
  const text = input.value.trim();
  if (!text) {
    dock.classList.remove('shake');
    void dock.offsetWidth;
    dock.classList.add('shake');
    input.placeholder = '先写下你的愿望…';
    input.focus();
    return;
  }

  busy = true;
  btn.disabled = true;
  input.blur();
  dock.classList.add('sending');
  toggleStack(false);

  const dur = launchWish(text);

  // 用固定时序驱动落地与提示，而不是挂在动画帧上：
  // 页面切到后台时 rAF 会被浏览器暂停，定时器不会 —— 愿望不能因此丢掉
  const landAt = dur * 1000 + 180;
  setTimeout(() => addWish(text), landAt);
  setTimeout(showBubble, landAt + 700);

  input.value = '';
  input.placeholder = '输入你的愿望…';
}

function showBubble() {
  bubble.classList.add('show');
  // 提示还在飘，但输入区先解锁 —— 想连着许几个愿不用干等
  setTimeout(() => {
    busy = false;
    btn.disabled = false;
    dock.classList.remove('sending');
  }, 500);
  setTimeout(() => bubble.classList.remove('show'), 2900);
}

btn.addEventListener('click', release);
input.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); release(); }
});
window.addEventListener('resize', resize);

/* ---- 长按星空背景：流星增多、加速 ---- */
const UI_SEL = 'input, button, .wish-bubble, .stack, .bubble, .credit';
function stormPress(e) {
  if (e.target && e.target.closest && e.target.closest(UI_SEL)) return;
  stormTarget = 1;
}
function stormRelease() { stormTarget = 0; }

window.addEventListener('pointerdown', stormPress, { passive: true });
window.addEventListener('pointerup', stormRelease, { passive: true });
window.addEventListener('pointercancel', stormRelease, { passive: true });
window.addEventListener('blur', stormRelease);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stormRelease();
});

/* ==================================================================
   启动
   ================================================================== */
resize();
renderStack(null);
setTimeout(() => dock.classList.add('ready'), 1100);   // 入场淡入
requestAnimationFrame(t => { last = t; requestAnimationFrame(frame); });

/* ---------------- 给其他模块的接口 ---------------- */
WM.wish = {
  // 本地愿望（用于注册时批量汇入星海）
  list: () => wishes.map(w => ({ id: w.id, text: w.text, ts: w.ts })),
  count: () => wishes.length,
};

})();
