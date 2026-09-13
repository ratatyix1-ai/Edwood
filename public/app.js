(() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // ---------------- состояние ----------------
  let token = localStorage.getItem('edward_token') || null;
  let me = null;
  let socket = null;
  let usersCache = [];               // все пользователи с сервера (кроме себя)
  let currentChatUserId = null;
  let recentChats = JSON.parse(localStorage.getItem('edward_recent') || '[]'); // [userId,...]
  const messagesByUser = {};         // userId -> [msg,...]

  // ---------------- вспомогательное ----------------
  function initials(name) { return (name || '?').trim().charAt(0).toUpperCase(); }

  function applyAvatar(el, user) {
    el.textContent = '';
    if (user && user.avatar) {
      el.style.backgroundImage = `url(${user.avatar})`;
      el.textContent = '';
    } else {
      el.style.backgroundImage = '';
      el.textContent = initials(user ? user.username : '?');
    }
  }

  async function api(path, opts = {}) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch(path, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Ошибка сервера');
    return data;
  }

  function saveRecent() { localStorage.setItem('edward_recent', JSON.stringify(recentChats)); }
  function touchRecent(userId) {
    recentChats = [userId, ...recentChats.filter(id => id !== userId)];
    saveRecent();
  }

  function userById(id) { return usersCache.find(u => u.id === id); }
  const onlineIds = new Set();

  // ---------------- АВТОРИЗАЦИЯ ----------------
  const authScreen = $('#auth-screen');
  const appScreen = $('#app-screen');

  $$('.auth-tab').forEach(btn => btn.addEventListener('click', () => {
    $$('.auth-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const form = btn.dataset.form;
    $('#login-form').classList.toggle('hidden', form !== 'login');
    $('#register-form').classList.toggle('hidden', form !== 'register');
    $('#auth-error').classList.add('hidden');
  }));

  function showAuthError(msg) {
    const el = $('#auth-error');
    el.textContent = msg;
    el.classList.remove('hidden');
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const data = await api('/api/login', {
        method: 'POST',
        body: { login: $('#login-login').value, password: $('#login-password').value }
      });
      onAuthSuccess(data);
    } catch (err) { showAuthError(err.message); }
  });

  $('#register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const data = await api('/api/register', {
        method: 'POST',
        body: {
          username: $('#reg-username').value,
          email: $('#reg-email').value,
          password: $('#reg-password').value
        }
      });
      onAuthSuccess(data);
    } catch (err) { showAuthError(err.message); }
  });

  function onAuthSuccess(data) {
    token = data.token;
    me = data.user;
    localStorage.setItem('edward_token', token);
    authScreen.classList.add('hidden');
    appScreen.classList.remove('hidden');
    connectSocket();
    renderProfile();
    refreshUsers();
  }

  $('#logout-btn').addEventListener('click', async () => {
    try { await api('/api/logout', { method: 'POST' }); } catch (e) {}
    localStorage.removeItem('edward_token');
    location.reload();
  });

  // ---------------- ВКЛАДКИ ----------------
  $$('.tab').forEach(tab => tab.addEventListener('click', () => {
    $$('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const name = tab.dataset.tab;
    $$('.tab-content').forEach(c => c.classList.add('hidden'));
    $('#tab-' + name).classList.remove('hidden');
    if (name === 'people') refreshUsers();
  }));

  // ---------------- ЛЮДИ / ЧАТЫ СПИСКИ ----------------
  async function refreshUsers() {
    try {
      const data = await api('/api/users');
      usersCache = data.users;
      onlineIds.clear();
      usersCache.forEach(u => { if (u.online) onlineIds.add(u.id); });
      renderPeople();
      renderChats();
    } catch (e) { console.error(e); }
  }

  function statusDot(userId) {
    return `<span class="status-dot ${onlineIds.has(userId) ? 'online' : ''}"></span>`;
  }

  function renderPeople(filter = '') {
    const list = $('#people-list');
    list.innerHTML = '';
    usersCache
      .filter(u => u.username.toLowerCase().includes(filter.toLowerCase()))
      .forEach(u => {
        const row = document.createElement('div');
        row.className = 'list-item';
        row.innerHTML = `<div class="avatar small"></div>
          <div class="texts"><div class="name">${escapeHtml(u.username)} ${statusDot(u.id)}</div>
          <div class="sub">${escapeHtml(u.bio || '@' + u.username)}</div></div>`;
        applyAvatar(row.querySelector('.avatar'), u);
        row.addEventListener('click', () => openChat(u.id));
        list.appendChild(row);
      });
  }

  function renderChats() {
    const list = $('#chats-list');
    const emptyHint = $('#chats-empty');
    list.innerHTML = '';
    const valid = recentChats.filter(id => userById(id));
    emptyHint.classList.toggle('hidden', valid.length > 0);
    valid.forEach(id => {
      const u = userById(id);
      const msgs = messagesByUser[id] || [];
      const last = msgs[msgs.length - 1];
      const row = document.createElement('div');
      row.className = 'list-item';
      row.innerHTML = `<div class="avatar small"></div>
        <div class="texts"><div class="name">${escapeHtml(u.username)} ${statusDot(id)}</div>
        <div class="sub">${last ? escapeHtml(last.text) : 'Начните общение'}</div></div>
        <div class="meta">${last ? timeAgo(last.ts) : ''}</div>`;
      applyAvatar(row.querySelector('.avatar'), u);
      row.addEventListener('click', () => openChat(id));
      list.appendChild(row);
    });
  }

  $('#people-search').addEventListener('input', (e) => renderPeople(e.target.value));
  $('#chats-search').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    $$('#chats-list .list-item').forEach(row => {
      row.style.display = row.querySelector('.name').textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  });

  function escapeHtml(s) {
    return (s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function timeAgo(ts) {
    const diff = Date.now() - ts;
    if (diff < 60000) return 'сейчас';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' мин';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' ч';
    return new Date(ts).toLocaleDateString();
  }

  // ---------------- ПРОФИЛЬ / НАСТРОЙКИ ----------------
  function renderProfile() {
    if (!me) return;
    applyAvatar($('#my-avatar'), me);
    $('#my-username').textContent = me.username;
    $('#my-email').textContent = me.email;
    $('#my-bio').value = me.bio || '';
  }

  $('#avatar-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const dataUrl = await resizeImageToDataUrl(file, 200);
    try {
      const data = await api('/api/avatar', { method: 'POST', body: { avatar: dataUrl } });
      me = data.user;
      renderProfile();
    } catch (err) { alert(err.message); }
  });

  function resizeImageToDataUrl(file, maxSize) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const reader = new FileReader();
      reader.onload = () => { img.src = reader.result; };
      reader.onerror = reject;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      reader.readAsDataURL(file);
    });
  }

  let bioTimer = null;
  $('#my-bio').addEventListener('input', (e) => {
    clearTimeout(bioTimer);
    bioTimer = setTimeout(async () => {
      try {
        const data = await api('/api/bio', { method: 'POST', body: { bio: e.target.value } });
        me = data.user;
      } catch (err) {}
    }, 500);
  });

  // ---------------- модалка «О приложении» ----------------
  const backdrop = $('#modal-backdrop');
  function openModal(modal) { backdrop.classList.remove('hidden'); modal.classList.remove('hidden'); }
  function closeModal(modal) { backdrop.classList.add('hidden'); modal.classList.add('hidden'); }
  $$('[data-close]').forEach(btn => btn.addEventListener('click', (e) => closeModal(e.target.closest('.modal'))));
  backdrop.addEventListener('click', () => {
    $$('.modal').forEach(m => m.classList.add('hidden'));
    backdrop.classList.add('hidden');
  });
  $('#about-btn').addEventListener('click', () => openModal($('#about-modal')));

  // ---------------- СОКЕТ ----------------
  function connectSocket() {
    // eslint-disable-next-line no-undef
    socket = io({ auth: { token } });
    socket.on('message:new', (msg) => {
      const otherId = msg.from === me.id ? msg.to : msg.from;
      if (!messagesByUser[otherId]) messagesByUser[otherId] = [];
      messagesByUser[otherId].push(msg);
      touchRecent(otherId);
      renderChats();
      if (currentChatUserId === otherId) appendMessageToView(msg);
    });
    socket.on('presence', ({ userId, online }) => {
      if (online) onlineIds.add(userId); else onlineIds.delete(userId);
      renderPeople($('#people-search').value);
      renderChats();
      if (currentChatUserId === userId) {
        $('#chat-peer-status').textContent = online ? 'в сети' : 'офлайн';
      }
    });
    socket.on('call:unavailable', () => {
      $('#call-status').textContent = 'Собеседник не в сети';
      setTimeout(() => endCall(false), 1200);
    });
    setupCallSignaling();
  }

  // ---------------- ЧАТ ----------------
  const chatScreen = $('#chat-screen');
  async function openChat(userId) {
    currentChatUserId = userId;
    const u = userById(userId);
    if (!u) return;
    applyAvatar($('#chat-peer-avatar'), u);
    $('#chat-peer-name').textContent = u.username;
    $('#chat-peer-status').textContent = onlineIds.has(userId) ? 'в сети' : 'офлайн';
    chatScreen.classList.remove('hidden');
    if (!messagesByUser[userId]) {
      const data = await api('/api/messages/' + userId);
      messagesByUser[userId] = data.messages;
    }
    renderMessages(userId);
    touchRecent(userId);
    renderChats();
  }

  $('#chat-back').addEventListener('click', () => {
    chatScreen.classList.add('hidden');
    currentChatUserId = null;
  });

  function renderMessages(userId) {
    const list = $('#messages-list');
    list.innerHTML = '';
    (messagesByUser[userId] || []).forEach(appendMessageToView);
  }

  function appendMessageToView(msg) {
    const otherId = msg.from === me.id ? msg.to : msg.from;
    if (otherId !== currentChatUserId) return;
    const list = $('#messages-list');
    const div = document.createElement('div');
    div.className = 'msg ' + (msg.from === me.id ? 'out' : 'in');
    const time = new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    div.innerHTML = `${escapeHtml(msg.text)}<span class="time">${time}</span>`;
    list.appendChild(div);
    list.scrollTop = list.scrollHeight;
  }

  $('#message-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#message-input');
    const text = input.value.trim();
    if (!text || !currentChatUserId) return;
    socket.emit('message:send', { toUserId: currentChatUserId, text });
    input.value = '';
  });

  // ================= ЗВОНКИ (WebRTC) =================
  const rtcConfig = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' }
      // Если звонок не соединяется через мобильный интернет/жёсткий NAT,
      // добавь сюда свой TURN-сервер, например:
      // { urls: 'turn:ВАШ_TURN_ХОСТ:3478', username: 'ЛОГИН', credential: 'ПАРОЛЬ' }
    ]
  };
  let pc = null;
  let localStream = null;
  let callPeerId = null;
  let pendingIce = [];

  function setupCallSignaling() {
    socket.on('call:offer', async ({ fromUserId, sdp, video }) => {
      if (pc) { socket.emit('call:busy', { toUserId: fromUserId }); return; }
      callPeerId = fromUserId;
      window.__incomingOffer = sdp;
      window.__incomingVideo = video;
      const u = userById(fromUserId);
      applyAvatar($('#incoming-avatar'), u);
      $('#incoming-name').textContent = u ? u.username : 'Кто-то';
      $('#incoming-type').textContent = video ? 'Входящий видеозвонок…' : 'Входящий голосовой звонок…';
      openModal($('#incoming-call-modal'));
    });
    socket.on('call:answer', async ({ sdp }) => {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      $('#call-status').textContent = 'Соединение…';
      flushIce();
    });
    socket.on('call:ice', async ({ candidate }) => {
      if (pc && pc.remoteDescription) await pc.addIceCandidate(candidate).catch(() => {});
      else pendingIce.push(candidate);
    });
    socket.on('call:end', () => endCall(false));
    socket.on('call:reject', () => { $('#call-status').textContent = 'Отклонено'; setTimeout(() => endCall(false), 800); });
    socket.on('call:busy', () => { $('#call-status').textContent = 'Собеседник занят'; setTimeout(() => endCall(false), 800); });
  }

  function flushIce() {
    pendingIce.forEach(c => pc.addIceCandidate(c).catch(() => {}));
    pendingIce = [];
  }

  function createPeerConnection(toUserId) {
    const conn = new RTCPeerConnection(rtcConfig);
    conn.onicecandidate = (e) => {
      if (e.candidate) socket.emit('call:ice', { toUserId, candidate: e.candidate });
    };
    conn.ontrack = (e) => {
      const remoteVideo = $('#remote-video');
      if (remoteVideo.srcObject !== e.streams[0]) remoteVideo.srcObject = e.streams[0];
      $('#call-status').textContent = 'Идёт звонок';
    };
    conn.onconnectionstatechange = () => {
      if (['disconnected', 'failed', 'closed'].includes(conn.connectionState)) endCall(false);
    };
    return conn;
  }

  async function startCall(toUserId, withVideo) {
    callPeerId = toUserId;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: withVideo });
    } catch (err) {
      alert('Нет доступа к камере/микрофону: ' + err.message);
      callPeerId = null;
      return;
    }
    showCallScreen(toUserId, withVideo, true);
    pc = createPeerConnection(toUserId);
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('call:offer', { toUserId, sdp: offer, video: withVideo });
  }

  $('#call-audio-btn').addEventListener('click', () => currentChatUserId && startCall(currentChatUserId, false));
  $('#call-video-btn').addEventListener('click', () => currentChatUserId && startCall(currentChatUserId, true));

  $('#accept-call-btn').addEventListener('click', async () => {
    closeModal($('#incoming-call-modal'));
    const withVideo = !!window.__incomingVideo;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: withVideo });
    } catch (err) {
      alert('Нет доступа к камере/микрофону: ' + err.message);
      socket.emit('call:reject', { toUserId: callPeerId });
      callPeerId = null;
      return;
    }
    showCallScreen(callPeerId, withVideo, false);
    pc = createPeerConnection(callPeerId);
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    await pc.setRemoteDescription(new RTCSessionDescription(window.__incomingOffer));
    flushIce();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('call:answer', { toUserId: callPeerId, sdp: answer });
    $('#call-status').textContent = 'Идёт звонок';
  });

  $('#reject-call-btn').addEventListener('click', () => {
    closeModal($('#incoming-call-modal'));
    socket.emit('call:reject', { toUserId: callPeerId });
    callPeerId = null;
  });

  function showCallScreen(peerId, withVideo, outgoing) {
    const u = userById(peerId);
    applyAvatar($('#call-peer-avatar'), u);
    $('#call-peer-name').textContent = u ? u.username : 'Звонок';
    $('#call-status').textContent = outgoing ? 'Вызов…' : 'Соединение…';
    const localVideo = $('#local-video');
    localVideo.srcObject = localStream;
    localVideo.style.display = withVideo ? '' : 'none';
    $('#toggle-cam-btn').style.display = withVideo ? '' : 'none';
    $('#call-screen').classList.remove('hidden');
  }

  $('#toggle-mic-btn').addEventListener('click', (e) => {
    if (!localStream) return;
    const track = localStream.getAudioTracks()[0];
    track.enabled = !track.enabled;
    e.target.style.opacity = track.enabled ? '1' : '.4';
  });
  $('#toggle-cam-btn').addEventListener('click', (e) => {
    if (!localStream) return;
    const track = localStream.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    e.target.style.opacity = track.enabled ? '1' : '.4';
  });
  $('#hangup-btn').addEventListener('click', () => {
    if (callPeerId) socket.emit('call:end', { toUserId: callPeerId });
    endCall(true);
  });

  function endCall() {
    if (pc) { pc.close(); pc = null; }
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    $('#remote-video').srcObject = null;
    $('#local-video').srcObject = null;
    $('#call-screen').classList.add('hidden');
    callPeerId = null;
    pendingIce = [];
  }

  // ---------------- СТАРТ ----------------
  (async function init() {
    if (!token) return;
    try {
      const data = await api('/api/me');
      me = data.user;
      authScreen.classList.add('hidden');
      appScreen.classList.remove('hidden');
      connectSocket();
      renderProfile();
      refreshUsers();
    } catch (e) {
      localStorage.removeItem('edward_token');
      token = null;
    }
  })();

  fetch('/api/me').catch(() => {}); // мягкая проверка доступности сервера
  $('#auth-server-hint').textContent = 'Сервер: ' + location.host;

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }
})();
