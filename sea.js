/* ============================================================
   愿海 · 星海（第二屏）
   每颗星 = 一条愿望。自己的星永远最亮，且豁免渲染上限。
   数据全部来自后端 /api/sea，不放假数据。
   坐标由服务端写入时用 Halton 低差异序列定好，前端只做只读消费。
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
  // 世界边长。星星坐标由服务端给 0~1 的归一化值，乘上它就是世界坐标 ——
  // 所以调这个数就能整体收紧或放开，不用动数据库。
  // 3000 是按"上百颗星时屏幕上还有合适间距"定的；6000 时几十颗星看着太空。
  const WORLD = 3000;
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
  let highlightUid = null;         // 搜索命中的用户，星会变青

  /* ---------------- 数据 ----------------
     坐标由服务端在写入时定好（Halton 低差异序列，均匀铺开），前端只做只读消费。
     这样刷新、换设备、换网络，星星位置都完全一致。 */
  function setData(list, mineUid) {
    myUid = mineUid || null;
    stars = list.map(w => ({
      id: String(w.id),
      uid: String(w.uid),
      name: w.name || '',
      text: w.text,
      x: w.x * WORLD,
      y: w.y * WORLD,
    }));

    // 登录了就把相机放到自己的星上，没登录就停在正中
    const mine = myUid ? stars.filter(s => s.uid === myUid) : [];
    if (mine.length) {
      cam.x = mine[0].x;
      cam.y = mine[0].y;
    } else {
      cam.x = WORLD / 2;
      cam.y = WORLD / 2;
    }
    draw();
  }

  // 从后端拉真实愿望。失败就保持空 —— 星海拉不到，不影响许愿。
  let loading = false;
  async function loadSea() {
    if (loading || !window.WM?.api) return;
    loading = true;
    try {
      const res = await fetch(WM.api.base + '/api/sea?limit=800', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      setData(data.wishes || [], WM.auth?.me?.id || null);
    } catch (e) {
      setData([], WM.auth?.me?.id || null);
    } finally {
      loading = false;
    }
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
    let mineLabels = 0;                    // 自己的标签也限量，否则传了几百条照样糊成一片

    for (const s of shown) {
      const isMine = s.uid === myUid;
      const isHit = highlightUid && s.uid === highlightUid;   // 搜索命中的那个用户
      // 半径写成"屏幕像素 ÷ 缩放"：无论放大缩小，星星在屏幕上大小恒定
      const r = (isMine ? 5.8 : isHit ? 4.8 : 2.9) / cam.k;

      // 光晕收紧一点，铺太开整颗星看着就是糊的
      const glowR = r * (isMine ? 3.6 : isHit ? 3.4 : 2.4);
      const gg = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, glowR);
      if (isMine) {
        gg.addColorStop(0, 'rgba(255,228,150,0.95)');
        gg.addColorStop(0.35, 'rgba(255,196,110,0.35)');
        gg.addColorStop(1, 'rgba(255,190,100,0)');
      } else if (isHit) {
        gg.addColorStop(0, 'rgba(160,255,235,0.95)');
        gg.addColorStop(0.35, 'rgba(90,220,255,0.32)');
        gg.addColorStop(1, 'rgba(90,200,255,0)');
      } else {
        gg.addColorStop(0, 'rgba(214,230,255,0.6)');
        gg.addColorStop(0.4, 'rgba(180,205,255,0.16)');
        gg.addColorStop(1, 'rgba(180,205,255,0)');
      }
      ctx.fillStyle = gg;
      ctx.beginPath(); ctx.arc(s.x, s.y, glowR, 0, 6.2832); ctx.fill();

      // 星核
      ctx.fillStyle = isMine ? '#fff7e0' : isHit ? '#dcfffa' : '#e6eeff';
      ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, 6.2832); ctx.fill();

      // 文字
      const drawLabel = s.text && (isMine ? mineLabels++ < 40 : (showLabels || isHit));
      if (drawLabel) {
        ctx.globalCompositeOperation = 'source-over';
        // 星海是数据展示，用无衬线 —— 宋体在这个字号下笔画太细，看着发灰
        ctx.font = `500 ${fs}px "PingFang SC","Hiragino Sans GB","Microsoft YaHei",-apple-system,sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        // shadowBlur 是设备像素、不受 canvas 变换影响。
        // 既不能除以 cam.k（缩小时会放大成光团），也不能设太大 ——
        // 屏幕字号恒定 12px，阴影超过 4px 就把字自己吞了，放大时尤其糊。
        if (isMine) {
          ctx.shadowColor = 'rgba(255,206,120,0.9)';
          ctx.shadowBlur = 3.5;
          ctx.fillStyle = 'rgba(255,248,228,1)';
        } else if (isHit) {
          ctx.shadowColor = 'rgba(90,235,255,0.9)';
          ctx.shadowBlur = 3.5;
          ctx.fillStyle = 'rgba(232,255,254,0.98)';
        } else {
          ctx.shadowColor = 'rgba(0,0,0,0.95)';
          ctx.shadowBlur = 3;
          ctx.fillStyle = 'rgba(228,238,255,0.9)';
        }
        ctx.fillText(s.text, s.x, s.y + r + 17 / cam.k);

        // 愿望底下跟上 @用户名
        if (s.name) {
          ctx.font = `400 ${fs * 0.82}px "PingFang SC","Hiragino Sans GB","Microsoft YaHei",-apple-system,sans-serif`;
          if (isMine) ctx.fillStyle = 'rgba(255,224,164,0.72)';
          else if (isHit) ctx.fillStyle = 'rgba(168,246,255,0.78)';
          else ctx.fillStyle = 'rgba(186,206,242,0.5)';
          ctx.fillText('@' + s.name, s.x, s.y + r + (17 + fs * 1.05) / cam.k);
        }

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
    cancelFly();
    // setPointerCapture 在部分浏览器/部分 pointerId 下会抛错 ——
    // 不包 try 的话整个处理函数中断，指针就永远凑不齐，双指缩放直接失效
    try { cvs.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }

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
    cancelFly();
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

  /* ---------------- 惯性 + 飞行 ---------------- */
  let tween = null;

  function tick() {
    requestAnimationFrame(tick);
    if (!active) return;

    // 相机飞行（搜索跳转用）—— 任何用户输入都该立刻打断它
    if (tween) {
      const p = Math.min(1, (performance.now() - tween.t0) / tween.dur);
      const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;  // easeInOutCubic
      cam.x = tween.fx + (tween.tx - tween.fx) * e;
      cam.y = tween.fy + (tween.ty - tween.fy) * e;
      cam.k = tween.fk + (tween.tk - tween.fk) * e;
      if (p >= 1) tween = null;
      draw();
      return;
    }

    if (Math.abs(vx) > 0.05 || Math.abs(vy) > 0.05) {
      cam.x += vx; cam.y += vy;
      vx *= 0.93; vy *= 0.93;
      clampCam();
      draw();
    } else if (vx || vy) {
      vx = vy = 0;
    }
  }

  function flyTo(tx, ty, tk, dur = 760) {
    tween = {
      fx: cam.x, fy: cam.y, fk: cam.k,
      tx, ty, tk: clamp(tk || cam.k, K_MIN, K_MAX),
      t0: performance.now(), dur,
    };
  }
  // 用户一动就取消飞行，别跟手感打架
  function cancelFly() { tween = null; }

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


  /* ---------------- 搜索：按用户名飞到那个人的星旁 ---------------- */
  const searchInput = document.getElementById('seaSearch');
  const searchBtn = document.getElementById('seaSearchBtn');
  let toastTimer = null;

  function toast(msg) {
    if (!hintEl) return;
    hintEl.textContent = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => updateHint(lastShown), 2600);
  }

  function doSearch() {
    const q = (searchInput && searchInput.value || '').trim();
    if (!q) return;

    // 先判自己：你可能还没往星海里放过星，那样会误报"没找到"
    if (WM.auth && WM.auth.me && WM.auth.me.name.toLowerCase() === q.toLowerCase()) {
      toast('这是你自己的星星呀');
      return;
    }

    const hits = stars.filter(s => s.name && s.name.toLowerCase() === q.toLowerCase());
    if (!hits.length) { toast('星海里没有找到「' + q + '」'); return; }
    if (myUid && hits[0].uid === myUid) { toast('这是你自己的星星呀'); return; }

    highlightUid = hits[0].uid;

    // 缩放到刚好能装下这个人的所有星 —— 否则飞过去只看得到一两颗，等于没找到
    const xs = hits.map(s => s.x), ys = hits.map(s => s.y);
    const minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
    const minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
    const spreadX = Math.max(maxX - minX, 900);
    const spreadY = Math.max(maxY - minY, 900);
    const kFit = Math.min(W / spreadX, H / spreadY) * 0.62;

    flyTo((minX + maxX) / 2, (minY + maxY) / 2, clamp(kFit, K_MIN, K_MAX));
    toast('找到了 ' + hits[0].name + ' 的 ' + hits.length + ' 颗星');
  }

  if (searchBtn) searchBtn.addEventListener('click', doSearch);
  if (searchInput) {
    searchInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); doSearch(); }
    });
    // 一改动输入就清掉上一次的命中高亮
    searchInput.addEventListener('input', () => { highlightUid = null; });
  }

  /* ---------------- 切页入口：桌面鼠标没有横滑手势 ----------------
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
  loadSea();                      // 拉真实愿望；库是空的星海就是空的
  onScroll();
  requestAnimationFrame(tick);

  // 登录 / 退出 / 愿望有变动时重新拉一次
  window.addEventListener('wm:login', () => loadSea());
  window.addEventListener('wm:logout', () => loadSea());
  window.addEventListener('wm:wishes-changed', () => loadSea());

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
