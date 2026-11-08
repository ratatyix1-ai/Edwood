(() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  let token = localStorage.getItem('edward_token') || null;
  let me = null;
  let socket = null;
  let usersCache = [];
  let currentChatUserId = null;
  let recentChats;
  try { recentChats = JSON.parse(localStorage.getItem('edward_recent') || '[]'); }
  catch (error) { recentChats = []; }
  if (!Array.isArray(recentChats)) recentChats = [];
  const messagesByUser = {};
  const onlineIds = new Set();

  function initials(name) { return (name || '?').trim().charAt(0).toUpperCase(); }
  function applyAvatar(el, user) {
    el.textContent = '';
    if (user && user.avatar) el.style.backgroundImage = `url(${user.avatar})`;
    else { el.style.backgroundImage = ''; el.textContent = initials(user ? user.username : '?'); }
  }
  async function api(path, opts = {}) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    if (token) headers.Authorization = 'Bearer ' + token;
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
  function mergeMessages(...groups) {
    const byId = new Map();
    groups.flat().forEach(msg => { if (msg && msg.id) byId.set(msg.id, msg); });
    return Array.from(byId.values()).sort((a, b) => a.ts - b.ts);
  }

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

  // Код приглашения нужен, потому что серверная регистрация закрыта без EDWARD_INVITE_CODE.
  const registerForm = $('#register-form');
  const registerSubmit = registerForm.querySelector('[type="submit"]');
  const inviteInput = document.createElement('input');
  inviteInput.type = 'password';
  inviteInput.id = 'reg-invite-code';
  inviteInput.placeholder = 'Код приглашения';
  inviteInput.autocomplete = 'off';
  inviteInput.required = true;
  inviteInput.setAttribute('aria-label', 'Код приглашения');
  registerForm.insertBefore(inviteInput, registerSubmit);

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      onAuthSuccess(await api('/api/login', { method: 'POST', body: { login: $('#login-login').value, password: $('#login-password').value } }));
    } catch (err) { showAuthError(err.message); }
  });
  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      onAuthSuccess(await api('/api/register', { method: 'POST', body: {
        username: $('#reg-username').value, email: $('#reg-email').value,
        password: $('#reg-password').value, inviteCode: inviteInput.value
      } }));
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
    if (socket) socket.disconnect();
    try { await api('/api/logout', { method: 'POST' }); } catch (e) {}
    localStorage.removeItem('edward_token');
    location.reload();
  });

  $$('.tab').forEach(tab => tab.addEventListener('click', () => {
    $$('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const name = tab.dataset.tab;
    $$('.tab-content').forEach(c => c.classList.add('hidden'));
    $('#tab-' + name).classList.remove('hidden');
    if (name === 'people') refreshUsers();
  }));
  $('#new-chat-btn').addEventListener('click', () => {
    const peopleTab = $('.tab[data-tab="people"]');
    if (peopleTab) peopleTab.click();
    $('#people-search').focus();
  });

  async function refreshUsers() {
    try {
      const data = await api('/api/users');
      usersCache = data.users;
      onlineIds.clear();
      usersCache.forEach(u => { if (u.online) onlineIds.add(u.id); });
      renderPeople($('#people-search').value);
      renderChats();
    } catch (e) { console.error(e); }
  }
  function statusDot(userId) { return `<span class="status-dot ${onlineIds.has(userId) ? 'online' : ''}"></span>`; }
  function renderPeople(filter = '') {
    const list = $('#people-list');
    list.innerHTML = '';
    usersCache.filter(u => u.username.toLowerCase().includes(filter.toLowerCase())).forEach(u => {
      const row = document.createElement('div');
      row.className = 'list-item';
      row.innerHTML = `<div class="avatar small"></div><div class="texts"><div class="name">${escapeHtml(u.username)} ${statusDot(u.id)}</div><div class="sub">${escapeHtml(u.bio || '@' + u.username)}</div></div>`;
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
      row.innerHTML = `<div class="avatar small"></div><div class="texts"><div class="name">${escapeHtml(u.username)} ${statusDot(id)}</div><div class="sub">${last ? escapeHtml(last.text) : 'Начните общение'}</div></div><div class="meta">${last ? timeAgo(last.ts) : ''}</div>`;
      applyAvatar(row.querySelector('.avatar'), u);
      row.addEventListener('click', () => openChat(id));
      list.appendChild(row);
    });
    const q = $('#chats-search').value.toLowerCase();
    $$('#chats-list .list-item').forEach(row => { row.style.display = row.querySelector('.name').textContent.toLowerCase().includes(q) ? '' : 'none'; });
  }
  $('#people-search').addEventListener('input', e => renderPeople(e.target.value));
  $('#chats-search').addEventListener('input', e => {
    const q = e.target.value.toLowerCase();
    $$('#chats-list .list-item').forEach(row => { row.style.display = row.querySelector('.name').textContent.toLowerCase().includes(q) ? '' : 'none'; });
  });
  function escapeHtml(s) {
    return (s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function timeAgo(ts) {
    const diff = Date.now() - ts;
    if (diff < 60000) return 'сейчас';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' мин';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' ч';
    return new Date(ts).toLocaleDateString();
  }

  function renderProfile() {
    if (!me) return;
    applyAvatar($('#my-avatar'), me);
    $('#my-username').textContent = me.username;
    $('#my-email').textContent = me.email;
    $('#my-bio').value = me.bio || '';
  }
  $('#avatar-input').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const dataUrl = await resizeImageToDataUrl(file, 200);
      const data = await api('/api/avatar', { method: 'POST', body: { avatar: dataUrl } });
      me = data.user;
      renderProfile();
    } catch (err) { alert('Не удалось обновить аватар: ' + err.message); }
    finally { e.target.value = ''; }
  });
  function resizeImageToDataUrl(file, maxSize) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const reader = new FileReader();
      reader.onload = () => { img.src = reader.result; };
      reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
      img.onerror = () => reject(new Error('Файл не является корректным изображением'));
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const context = canvas.getContext('2d');
        if (!context) return reject(new Error('Браузер не поддерживает обработку изображений'));
        context.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      reader.readAsDataURL(file);
    });
  }
  let bioTimer = null;
  $('#my-bio').addEventListener('input', e => {
    clearTimeout(bioTimer);
    bioTimer = setTimeout(async () => {
      try { me = (await api('/api/bio', { method: 'POST', body: { bio: e.target.value } })).user; }
      catch (err) { console.error('Не удалось сохранить статус:', err); }
    }, 500);
  });

  const backdrop = $('#modal-backdrop');
  function openModal(modal) { backdrop.classList.remove('hidden'); modal.classList.remove('hidden'); }
  function closeModal(modal) { backdrop.classList.add('hidden'); modal.classList.add('hidden'); }
  $$('[data-close]').forEach(btn => btn.addEventListener('click', e => closeModal(e.target.closest('.modal'))));
  backdrop.addEventListener('click', () => { $$('.modal').forEach(m => m.classList.add('hidden')); backdrop.classList.add('hidden'); });
  $('#about-btn').addEventListener('click', () => openModal($('#about-modal')));

  function connectSocket() {
    socket = io({ auth: { token } });
    socket.on('message:new', msg => {
      const otherId = msg.from === me.id ? msg.to : msg.from;
      messagesByUser[otherId] = mergeMessages(messagesByUser[otherId] || [], [msg]);
      touchRecent(otherId);
      renderChats();
      if (currentChatUserId === otherId) renderMessages(otherId);
    });
    socket.on('message:error', data => alert(data.error || 'Не удалось отправить сообщение'));
    socket.on('presence', ({ userId, online }) => {
      if (online) onlineIds.add(userId); else onlineIds.delete(userId);
      renderPeople($('#people-search').value);
      renderChats();
      if (currentChatUserId === userId) $('#chat-peer-status').textContent = online ? 'в сети' : 'офлайн';
    });
    socket.on('connect_error', err => {
      if (err.message === 'unauthorized') {
        localStorage.removeItem('edward_token');
        token = null;
        location.reload();
      }
    });
    socket.on('call:unavailable', () => {
      $('#call-status').textContent = 'Собеседник не в сети';
      setTimeout(() => endCall(), 1200);
    });
    setupCallSignaling();
  }

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
      try {
        const data = await api('/api/messages/' + encodeURIComponent(userId));
        messagesByUser[userId] = mergeMessages(data.messages || [], messagesByUser[userId] || []);
      } catch (err) { alert('Не удалось загрузить историю: ' + err.message); }
    }
    if (currentChatUserId !== userId) return;
    renderMessages(userId);
    touchRecent(userId);
    renderChats();
  }
  $('#chat-back').addEventListener('click', () => { chatScreen.classList.add('hidden'); currentChatUserId = null; });
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
  $('#message-form').addEventListener('submit', e => {
    e.preventDefault();
    const input = $('#message-input');
    const text = input.value.trim();
    if (!text || !currentChatUserId) return;
    if (!socket || !socket.connected) { alert('Нет соединения с сервером'); return; }
    socket.emit('message:send', { toUserId: currentChatUserId, text }, result => {
      if (result && result.error) alert(result.error);
    });
    input.value = '';
  });

  // ================= ЗВОНКИ (WebRTC) =================
  const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  let pc = null;
  let localStream = null;
  let callPeerId = null;
  let pendingIce = [];
  let callTimeout = null;
  function clearCallTimeout() { clearTimeout(callTimeout); callTimeout = null; }
  function setupCallSignaling() {
    socket.on('call:offer', ({ fromUserId, sdp, video }) => {
      if (pc || callPeerId) { socket.emit('call:busy', { toUserId: fromUserId }); return; }
      callPeerId = fromUserId;
      window.__incomingOffer = sdp;
      window.__incomingVideo = Boolean(video);
      const u = userById(fromUserId);
      applyAvatar($('#incoming-avatar'), u);
      $('#incoming-name').textContent = u ? u.username : 'Кто-то';
      $('#incoming-type').textContent = video ? 'Входящий видеозвонок…' : 'Входящий голосовой звонок…';
      openModal($('#incoming-call-modal'));
      callTimeout = setTimeout(() => {
        if (callPeerId !== fromUserId || pc) return;
        socket.emit('call:reject', { toUserId: fromUserId });
        closeModal($('#incoming-call-modal'));
        callPeerId = null;
      }, 30000);
    });
    socket.on('call:answer', async ({ sdp }) => {
      if (!pc) return;
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        clearCallTimeout();
        $('#call-status').textContent = 'Соединение…';
        await flushIce();
      } catch (err) { console.error('Ошибка ответа на звонок:', err); endCall(); }
    });
    socket.on('call:ice', async ({ candidate }) => {
      if (pc && pc.remoteDescription) await pc.addIceCandidate(candidate).catch(() => {});
      else if (candidate) pendingIce.push(candidate);
    });
    socket.on('call:end', () => endCall());
    socket.on('call:reject', () => { $('#call-status').textContent = 'Отклонено'; clearCallTimeout(); setTimeout(() => endCall(), 800); });
    socket.on('call:busy', () => { $('#call-status').textContent = 'Собеседник занят'; clearCallTimeout(); setTimeout(() => endCall(), 800); });
  }
  async function flushIce() {
    if (!pc || !pc.remoteDescription) return;
    const candidates = pendingIce;
    pendingIce = [];
    await Promise.all(candidates.map(c => pc.addIceCandidate(c).catch(() => {})));
  }
  function createPeerConnection(toUserId) {
    const conn = new RTCPeerConnection(rtcConfig);
    conn.onicecandidate = e => { if (e.candidate) socket.emit('call:ice', { toUserId, candidate: e.candidate }); };
    conn.ontrack = e => {
      const remoteVideo = $('#remote-video');
      if (remoteVideo.srcObject !== e.streams[0]) remoteVideo.srcObject = e.streams[0];
      $('#call-status').textContent = 'Идёт звонок';
    };
    conn.onconnectionstatechange = () => {
      if (conn.connectionState === 'connected') clearCallTimeout();
      if (['disconnected', 'failed', 'closed'].includes(conn.connectionState)) endCall();
    };
    return conn;
  }
  async function startCall(toUserId, withVideo) {
    if (callPeerId || pc) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { alert('Звонки доступны только в защищённом контексте HTTPS или localhost'); return; }
    callPeerId = toUserId;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: withVideo });
      showCallScreen(toUserId, withVideo, true);
      pc = createPeerConnection(toUserId);
      localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('call:offer', { toUserId, sdp: offer, video: withVideo });
      callTimeout = setTimeout(() => { $('#call-status').textContent = 'Нет ответа'; setTimeout(() => endCall(), 1200); }, 30000);
    } catch (err) {
      alert('Не удалось начать звонок: ' + err.message);
      endCall();
    }
  }
  $('#call-audio-btn').addEventListener('click', () => currentChatUserId && startCall(currentChatUserId, false));
  $('#call-video-btn').addEventListener('click', () => currentChatUserId && startCall(currentChatUserId, true));
  $('#accept-call-btn').addEventListener('click', async () => {
    clearCallTimeout();
    closeModal($('#incoming-call-modal'));
    const peerId = callPeerId;
    const withVideo = Boolean(window.__incomingVideo);
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('Для звонков нужен HTTPS или localhost');
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: withVideo });
      showCallScreen(peerId, withVideo, false);
      pc = createPeerConnection(peerId);
      localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
      await pc.setRemoteDescription(new RTCSessionDescription(window.__incomingOffer));
      await flushIce();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('call:answer', { toUserId: peerId, sdp: answer });
      callTimeout = setTimeout(() => endCall(), 30000);
    } catch (err) {
      alert('Не удалось принять звонок: ' + err.message);
      if (peerId) socket.emit('call:reject', { toUserId: peerId });
      endCall();
    }
  });
  $('#reject-call-btn').addEventListener('click', () => {
    clearCallTimeout();
    closeModal($('#incoming-call-modal'));
    if (callPeerId) socket.emit('call:reject', { toUserId: callPeerId });
    callPeerId = null;
    window.__incomingOffer = null;
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
  $('#toggle-mic-btn').addEventListener('click', e => {
    const track = localStream && localStream.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    e.currentTarget.style.opacity = track.enabled ? '1' : '.4';
  });
  $('#toggle-cam-btn').addEventListener('click', e => {
    const track = localStream && localStream.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    e.currentTarget.style.opacity = track.enabled ? '1' : '.4';
  });
  $('#hangup-btn').addEventListener('click', () => {
    if (callPeerId) socket.emit('call:end', { toUserId: callPeerId });
    endCall();
  });
  function endCall() {
    clearCallTimeout();
    if (pc) { pc.onconnectionstatechange = null; pc.close(); pc = null; }
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    $('#remote-video').srcObject = null;
    $('#local-video').srcObject = null;
    $('#call-screen').classList.add('hidden');
    closeModal($('#incoming-call-modal'));
    callPeerId = null;
    window.__incomingOffer = null;
    pendingIce = [];
  }

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
  $('#auth-server-hint').textContent = 'Сервер: ' + location.host;
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('service-worker.js').catch(() => {});
})();
