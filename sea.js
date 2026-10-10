/* ============================================================
   愿海 · 星海（第二屏）
   每颗星 = 一条愿望。自己的星永远最亮，且豁免渲染上限。
   Phase 1：先用种子数据跑通渲染与手势，Phase 3 再接真实数据。
   ============================================================ */
window.WM = window.WM || {};

(function () {
  'use strict';

  const cvs = document.getElementById('sea');
  const ctx = cvs.getContext('2d');
  const pager = document.getElementById('pager');
  const hintEl = document.getElementById('seaHint');

  let W = 0, H = 0, DPR = 1;
  let active = false;              // 星海是否在视野里（不在就不跑绘制）

  /* ---------------- 世界与相机 ---------------- */
  const WORLD = 6000;              // 世界边长（世界坐标）
  const K0 = 0.34;                 // 默认缩放
  const K_MIN = K0 * 0.42;         // 缩到最小（看全貌）
  const K_MAX = 1.2;               // 放到最大
  const RENDER_MIN = 50;           // 默认缩放下的渲染上限
  const RENDER_MAX = 400;          // 硬顶，保性能
  const LABEL_K = K0 * 0.72;       // 高于此缩放才画所有文字

  const cam = { x: WORLD / 2, y: WORLD / 2, k: K0 };

  let stars = [];
  let myUid = null;
  let lastShown = 0;

  /* ---------------- 稳定哈希：同一个 id 永远落在同一处 ---------------- */
  function hash32(str, seed) {
    let h = (seed >>> 0) || 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  // FNV 对 'u0'/'u1' 这类相似输入雪崩不足，再走一遍 murmur3 finalizer 打散
  function r01(str, salt) {
    let h = hash32(str + '#' + salt);
    h ^= h >>> 16; h = Math.imul(h, 2246822507);
    h ^= h >>> 13; h = Math.imul(h, 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  // 用户主星：决定这一簇星分布在世界的哪里
  function homeOf(uid) {
    return { x: r01(uid, 'hx') * WORLD, y: r01(uid, 'hy') * WORLD };
  }
  // 愿望星：在自家主星周围散开，形成"星座"感。
  // 半径要够大 —— 太小的话同一用户的几条愿望会在屏幕上叠成一团文字。
  function posOf(wishId, uid) {
    const home = homeOf(uid);
    const ang = r01(wishId, 'a') * Math.PI * 2;
    const rad = 130 + r01(wishId, 'r') * 470;
    return { x: home.x + Math.cos(ang) * rad, y: home.y + Math.sin(ang) * rad };
  }

  /* ---------------- 数据 ---------------- */
  function setData(list, mineUid) {
    myUid = mineUid || null;
    stars = list.map(w => {
      const p = posOf(String(w.id), String(w.uid));
      return { id: String(w.id), uid: String(w.uid), name: w.name || '', text: w.text, x: p.x, y: p.y };
    });
    // 初始把相机放在自己主星上（没登录则放世界中心）
    if (myUid) {
      const h = homeOf(myUid);
      cam.x = h.x; cam.y = h.y;
    }
    draw();
  }

  /* ---------------- 尺寸 ---------------- */
  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = cvs.clientWidth;
    H = cvs.clientHeight;
    cvs.width = Math.round(W * DPR);
    cvs.height = Math.round(H * DPR);
    draw();
  }

  /* ---------------- 渲染 ---------------- */
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

  function draw() {
    if (!W || !H) return;

    // 背景（用 DPR 变换铺满屏幕）
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    const bg = ctx.createLinearGradient(0, 0, W * 0.3, H);
    bg.addColorStop(0, '#05060f');
    bg.addColorStop(1, '#0b0a20');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    if (!stars.length) { updateHint(0); return; }

    // 视口对应的世界矩形
    const halfW = W / (2 * cam.k);
    const halfH = H / (2 * cam.k);
    const minX = cam.x - halfW, maxX = cam.x + halfW;
    const minY = cam.y - halfH, maxY = cam.y + halfH;

    const visible = stars.filter(s => s.x >= minX && s.x <= maxX && s.y >= minY && s.y <= maxY);

    // 渲染上限随缩放放开：默认 50，缩得越小放得越开
    const limit = clamp(Math.round(RENDER_MIN * Math.pow(K0 / cam.k, 2)), RENDER_MIN, RENDER_MAX);

    // 自己的星豁免上限，永远在场
    const mine = visible.filter(s => s.uid === myUid);
    const others = visible
      .filter(s => s.uid !== myUid)
      .sort((a, b) => {
        const da = (a.x - cam.x) ** 2 + (a.y - cam.y) ** 2;
        const db = (b.x - cam.x) ** 2 + (b.y - cam.y) ** 2;
        return da - db;
      });

    const shown = mine.concat(others.slice(0, Math.max(0, limit - mine.length)));
    lastShown = shown.length;

    // 相机变换
    ctx.setTransform(
      DPR * cam.k, 0, 0, DPR * cam.k,
      DPR * (W / 2 - cam.x * cam.k),
      DPR * (H / 2 - cam.y * cam.k)
    );
    ctx.globalCompositeOperation = 'lighter';

    const showLabels = cam.k > LABEL_K;
    const fs = 12 / cam.k;                 // 文字在屏幕上恒定 12px

    for (const s of shown) {
      const isMine = s.uid === myUid;
      // 半径写成"屏幕像素 ÷ 缩放"：无论放大缩小，星星在屏幕上大小恒定
      const r = (isMine ? 5.2 : 2.4) / cam.k;

      // 光晕
      const glowR = r * (isMine ? 5 : 3.4);
      const gg = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, glowR);
      if (isMine) {
        gg.addColorStop(0, 'rgba(255,228,150,0.95)');
        gg.addColorStop(0.35, 'rgba(255,196,110,0.35)');
        gg.addColorStop(1, 'rgba(255,190,100,0)');
      } else {
        gg.addColorStop(0, 'rgba(214,230,255,0.6)');
        gg.addColorStop(0.4, 'rgba(180,205,255,0.16)');
        gg.addColorStop(1, 'rgba(180,205,255,0)');
      }
      ctx.fillStyle = gg;
      ctx.beginPath(); ctx.arc(s.x, s.y, glowR, 0, 6.2832); ctx.fill();

      // 星核
      ctx.fillStyle = isMine ? '#fff7e0' : '#e6eeff';
      ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, 6.2832); ctx.fill();

      // 文字
      if (s.text && (isMine || showLabels)) {
        ctx.globalCompositeOperation = 'source-over';
        ctx.font = `${fs}px "Songti SC","STSong","SimSun",serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        if (isMine) {
          ctx.shadowColor = 'rgba(255,214,140,0.9)';
          ctx.shadowBlur = 12 / cam.k;
          ctx.fillStyle = 'rgba(255,246,220,0.98)';
        } else {
          // 深色阴影压住背景，避免文字糊在星云上看不清
          ctx.shadowColor = 'rgba(0,0,0,0.85)';
          ctx.shadowBlur = 6 / cam.k;
          ctx.fillStyle = 'rgba(214,228,255,0.78)';
        }
        ctx.fillText(s.text, s.x, s.y + r + 11 / cam.k);
        ctx.shadowBlur = 0;
        ctx.globalCompositeOperation = 'lighter';
      }
    }

    ctx.globalCompositeOperation = 'source-over';
    updateHint(lastShown);
  }

  function updateHint(n) {
    if (hintEl) hintEl.textContent = n ? `${n} 颗星` : '';
  }

  /* ---------------- 手势：拖动平移 / 双指缩放 / 滚轮缩放 ---------------- */
  const pointers = new Map();
  let dragging = false;
  let lastX = 0, lastY = 0;
  let pinchDist = 0;
  let vx = 0, vy = 0, lastMoveT = 0;

  function clampCam() {
    cam.k = clamp(cam.k, K_MIN, K_MAX);
    // 不让相机跑出世界太远
    const pad = WORLD * 0.25;
    cam.x = clamp(cam.x, -pad, WORLD + pad);
    cam.y = clamp(cam.y, -pad, WORLD + pad);
  }

  cvs.addEventListener('pointerdown', e => {
    cvs.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 1) {
      dragging = true;
      lastX = e.clientX; lastY = e.clientY;
      vx = vy = 0; lastMoveT = performance.now();
    } else if (pointers.size === 2) {
      dragging = false;
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
  });

  cvs.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist > 0) {
        const midX = (a.x + b.x) / 2, midY = (a.y + b.y) / 2;
        zoomAt(midX, midY, d / pinchDist);
      }
      pinchDist = d;
      return;
    }

    if (dragging) {
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      cam.x -= dx / cam.k;
      cam.y -= dy / cam.k;
      const now = performance.now();
      const dt = Math.max(1, now - lastMoveT);
      vx = -dx / cam.k / dt * 16;      // 换算成"每帧世界位移"
      vy = -dy / cam.k / dt * 16;
      lastMoveT = now;
      lastX = e.clientX; lastY = e.clientY;
      clampCam();
      draw();
    }
  });

  function endPointer(e) {
    pointers.delete(e.pointerId);
    if (pointers.size === 0) {
      dragging = false;
      pinchDist = 0;
    } else if (pointers.size === 1) {
      const p = [...pointers.values()][0];
      lastX = p.x; lastY = p.y;
      dragging = true;
      pinchDist = 0;
    }
  }
  cvs.addEventListener('pointerup', endPointer);
  cvs.addEventListener('pointercancel', endPointer);

  // 滚轮缩放（锚定光标）
  cvs.addEventListener('wheel', e => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0016));
  }, { passive: false });

  function zoomAt(sx, sy, factor) {
    const oldK = cam.k;
    const newK = clamp(oldK * factor, K_MIN, K_MAX);
    if (newK === oldK) return;
    // 让光标下的世界点保持不动
    const wx = cam.x + (sx - W / 2) / oldK;
    const wy = cam.y + (sy - H / 2) / oldK;
    cam.k = newK;
    cam.x = wx - (sx - W / 2) / newK;
    cam.y = wy - (sy - H / 2) / newK;
    clampCam();
    draw();
  }

  /* ---------------- 惯性 ---------------- */
  function tick() {
    requestAnimationFrame(tick);
    if (!active) return;
    if (Math.abs(vx) > 0.05 || Math.abs(vy) > 0.05) {
      cam.x += vx; cam.y += vy;
      vx *= 0.93; vy *= 0.93;
      clampCam();
      draw();
    } else if (vx || vy) {
      vx = vy = 0;
    }
  }

  /* ---------------- 页面切换 ---------------- */
  function onScroll() {
    const p = pager.scrollLeft / Math.max(1, pager.clientWidth);
    const seaOn = p > 0.5;
    if (seaOn !== active) {
      active = seaOn;
      if (active) { resize(); draw(); }
    }
    // 圆点跟随拖动进度实时变化
    const d0 = document.querySelectorAll('.dots i')[0];
    const d1 = document.querySelectorAll('.dots i')[1];
    if (d0 && d1) {
      d0.style.opacity = String(1 - p * 0.78);
      d1.style.opacity = String(0.22 + p * 0.78);
      d0.style.transform = `scale(${1 - p * 0.25})`;
      d1.style.transform = `scale(${0.75 + p * 0.25})`;
    }
  }

  /* ---------------- 种子数据（Phase 3 换成真实数据） ---------------- */
  function seed() {
    const names = [
      '小林', '阿泽', 'Nina', '老陈', '阿May', '十七', 'Leo', '小满', '阿禾', '沉舟',
      '青栀', '白鹿', '阿橘', '木木', '山风', '阿棠', '雾岛', '柚子', '江晚', '拾光',
      '半夏', '星河', '阿松', '南风', '迟迟', '小鹿', '云舟', '阿满', '朝暮', '长明',
      'echo', '宁宁', '阿屿', '九月', '青禾', '望舒'
    ];
    const texts = [
      '考研上岸', '家人平安健康', '自由自在', '攒够首付', '身体健康',
      '遇见对的人', '事业顺利', '回到家乡', '学会游泳', '少熬夜',
      '去一次冰岛', '和好如初', '写出自己的书', '开一家小店', '不再焦虑',
      '陪爸妈旅行', '养一只猫', '把吉他学会', '升职加薪', '世界和平',
      '看完一百本书', '早睡早起', '做喜欢的工作', '和朋友常联系',
      '有个自己的家', '不再失眠', '学会说不', '种一棵树', '去看一次海', '慢一点也没关系'
    ];
    const out = [];
    for (let u = 0; u < names.length; u++) {
      const uid = 'u' + u;
      const n = 3 + Math.floor(r01(uid, 'n') * 6);   // 每人 3–8 条
      for (let i = 0; i < n; i++) {
        const id = uid + '-w' + i;
        out.push({
          id,
          uid,
          name: names[u],
          text: texts[Math.floor(r01(id, 'p') * texts.length)],
        });
      }
    }
    return out;
  }

  /* ---------------- 切页入口：桌面鼠标用户没有横滑手势 ----------------
     触摸板双指横滑是原生滚动；鼠标用户靠点圆点和方向键。 */
  function goTo(index) {
    pager.scrollTo({ left: pager.clientWidth * index, behavior: 'smooth' });
  }
  document.querySelectorAll('.dots i').forEach((dot, i) => {
    dot.addEventListener('click', () => goTo(i));
  });
  window.addEventListener('keydown', e => {
    // 输入框里按方向键是在移动光标，不能抢
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    if (e.key === 'ArrowRight') goTo(1);
    else if (e.key === 'ArrowLeft') goTo(0);
  });

  /* ---------------- 启动 ---------------- */
  window.addEventListener('resize', () => { resize(); });
  pager.addEventListener('scroll', onScroll, { passive: true });

  resize();
  setData(seed(), null);          // Phase 1：还没登录，没有"自己的星"
  onScroll();
  requestAnimationFrame(tick);

  // 暴露给其他模块用
  WM.sea = {
    setData,
    flyTo: (x, y, k) => {
      cam.x = x; cam.y = y;
      if (k) cam.k = clamp(k, K_MIN, K_MAX);
      draw();
    },
    getCam: () => ({ ...cam }),
  };
})();
