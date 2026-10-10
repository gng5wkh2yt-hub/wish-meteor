/* ============================================================
   愿海 · 账号
   左侧气泡（入口） / 注册登录面板 / 右上角头像
   依赖：api.js（WM.api）
   ============================================================ */
window.WM = window.WM || {};

(function () {
  'use strict';

  const harbor     = document.getElementById('harbor');
  const harborText = document.getElementById('harborText');
  const modal      = document.getElementById('regModal');
  const regTitle   = document.getElementById('regTitle');
  const regSub     = document.getElementById('regSub');
  const avPreview  = document.getElementById('avPreview');
  const avFile     = document.getElementById('avFile');
  const regName    = document.getElementById('regName');
  const regPass    = document.getElementById('regPass');
  const regErr     = document.getElementById('regErr');
  const regSubmit  = document.getElementById('regSubmit');
  const regCancel  = document.getElementById('regCancel');
  const regNote    = document.getElementById('regNote');
  const meBox      = document.getElementById('me');
  const meAvatar   = document.getElementById('meAvatar');

  if (!harbor) return;

  const MINI_KEY = 'wish-meteor:harbor:mini:v1';

  let me = null;
  let avatarBlob = null;
  let mode = 'register';          // 'register' | 'login'

  /* ---------------- 气泡：长按缩小（但关不掉） ---------------- */
  try {
    if (localStorage.getItem(MINI_KEY) === '1') harbor.classList.add('mini');
  } catch (e) { /* 隐私模式 */ }

  let pressTimer = null;
  let longPressed = false;

  harbor.addEventListener('pointerdown', () => {
    longPressed = false;
    pressTimer = setTimeout(() => {
      longPressed = true;
      const mini = harbor.classList.toggle('mini');
      try { localStorage.setItem(MINI_KEY, mini ? '1' : '0'); } catch (err) {}
    }, 480);
  });
  const cancelPress = () => clearTimeout(pressTimer);
  harbor.addEventListener('pointerup', cancelPress);
  harbor.addEventListener('pointercancel', cancelPress);
  harbor.addEventListener('pointerleave', cancelPress);

  harbor.addEventListener('click', () => {
    if (longPressed) { longPressed = false; return; }   // 长按不该同时触发点击
    if (me) {
      const dots = document.querySelectorAll('.dots i');
      if (dots[1]) dots[1].click();                     // 已登录 → 去看星海
    } else {
      openModal('register');
    }
  });

  /* ---------------- 面板 ---------------- */
  function openModal(m) {
    mode = m;
    regErr.textContent = '';
    if (m === 'register') {
      regTitle.textContent = '汇入愿海';
      regSub.textContent = '取个名字，让你的愿望成为星海里的一颗星';
      regSubmit.textContent = '汇入';
      regNote.textContent = '注册后，你本地已有的愿望会一并汇入星海';
    } else {
      regTitle.textContent = '欢迎回来';
      regSub.textContent = '登录后继续把你的愿望汇入星海';
      regSubmit.textContent = '登录';
      regNote.textContent = '忘记密码的话，换一个名字重新注册也可以';
    }
    modal.hidden = false;
    requestAnimationFrame(() => modal.classList.add('show'));
    setTimeout(() => regName.focus(), 340);
  }

  function closeModal() {
    modal.classList.remove('show');
    setTimeout(() => { modal.hidden = true; }, 320);
    avatarBlob = null;
    avPreview.style.backgroundImage = '';
    regPass.value = '';
  }

  regCancel.addEventListener('click', closeModal);
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

  /* ---------------- 头像选择 ---------------- */
  avFile.addEventListener('change', async () => {
    const f = avFile.files && avFile.files[0];
    if (!f) return;
    try {
      const blob = await WM.api.compressAvatar(f, 128);
      if (!blob) throw new Error('compress failed');
      if (blob.size > 64 * 1024) { regErr.textContent = '图片有点大，换一张试试'; return; }
      avatarBlob = blob;
      avPreview.style.backgroundImage = 'url(' + URL.createObjectURL(blob) + ')';
      regErr.textContent = '';
    } catch (e) {
      regErr.textContent = '这张图读不了，换一张试试';
    }
  });

  /* ---------------- 提交 ---------------- */
  regSubmit.addEventListener('click', submit);
  regPass.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });

  async function submit() {
    const name = regName.value.trim();
    const pass = regPass.value;
    regErr.textContent = '';

    if (name.length < 2 || name.length > 16) { regErr.textContent = '用户名需 2–16 位'; return; }
    if (!/^[一-龥A-Za-z0-9_]+$/.test(name)) { regErr.textContent = '只能用中英文、数字和下划线'; return; }
    if (pass.length < 6) { regErr.textContent = '密码至少 6 位'; return; }

    regSubmit.disabled = true;
    regSubmit.textContent = '处理中…';

    try {
      const saltInfo = await WM.api.request(
        '/api/auth/salt?u=' + encodeURIComponent(name)
      );
      // 昂贵的 PBKDF2 在本地跑，服务端只做一次 HMAC
      const authKey = await WM.api.stretchPassword(pass, saltInfo.salt, saltInfo.iters);

      let res;
      if (mode === 'register') {
        res = await WM.api.request('/api/auth/register', {
          method: 'POST',
          body: { name, authKey, salt: saltInfo.salt, iters: saltInfo.iters },
        });
      } else {
        res = await WM.api.request('/api/auth/login', {
          method: 'POST',
          body: { name, authKey },
        });
      }

      WM.api.setToken(res.token);
      me = res.user;
      renderMe();

      // 头像上传失败不该阻断注册 —— 可以以后在账号里换
      if (avatarBlob) {
        try { await uploadAvatar(avatarBlob); } catch (e) {}
      }

      closeModal();
      window.dispatchEvent(new CustomEvent('wm:login', { detail: me }));

    } catch (e) {
      regErr.textContent = (e && e.message) || '网络不太好，再试一次';
      if (e && e.status === 409) mode = 'login';   // 名字被占了，切到登录
    } finally {
      regSubmit.disabled = false;
      regSubmit.textContent = mode === 'register' ? '汇入' : '登录';
    }
  }

  /* ---------------- 头像上传 ---------------- */
  async function uploadAvatar(blob) {
    const res = await fetch(WM.api.base + '/api/avatar', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + WM.api.getToken(),
        'Content-Type': blob.type || 'image/webp',
      },
      body: blob,
    });
    if (!res.ok) throw new Error('avatar upload failed');
    const data = await res.json();
    if (me) me.avatarUrl = data.avatarUrl;
    renderMe();
    return data;
  }

  /* ---------------- 渲染 ---------------- */
  function renderMe() {
    if (!me) {
      meBox.hidden = true;
      harborText.textContent = '可汇入愿海';
      return;
    }
    meBox.hidden = false;
    harborText.textContent = '已汇入愿海';
    // 没有头像时保持纯黑圆（默认就是黑底）
    meAvatar.style.backgroundImage = me.avatarUrl
      ? 'url(' + WM.api.base + me.avatarUrl + ')'
      : '';
  }

  meAvatar.addEventListener('click', () => {
    if (!me) return;
    if (!window.confirm('退出 ' + me.name + ' 的账号？\n（你的愿望仍留在星海里）')) return;
    WM.api.setToken(null);
    me = null;
    renderMe();
    window.dispatchEvent(new CustomEvent('wm:logout'));
  });

  /* ---------------- 启动：校验登录态 ---------------- */
  (async () => {
    if (!WM.api.loggedIn) { renderMe(); return; }
    try {
      const res = await WM.api.request('/api/me', { auth: true, timeout: 9000 });
      me = res.user;
      renderMe();
      window.dispatchEvent(new CustomEvent('wm:login', { detail: me }));
    } catch (e) {
      // token 失效就清掉，但本地愿望一个字不动
      if (e && e.status === 401) WM.api.setToken(null);
      renderMe();
    }
  })();

  WM.auth = {
    get me() { return me; },
    openModal,
    uploadAvatar,
    render: renderMe,
  };
})();
