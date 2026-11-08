const express = require('express');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const { Server } = require('socket.io');
const { loadJson, saveJson } = require('./db');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });

// ---------- хранилище и активные подключения ----------
let users = loadJson('users.json', []);
let messages = loadJson('messages.json', []);
const tokens = new Map();                     // token -> userId
const socketsByUser = new Map();              // userId -> Set<socketId>
const MAX_MESSAGE_LENGTH = 4000;
const MAX_BIO_LENGTH = 120;
const MAX_AVATAR_LENGTH = 500_000;
const MAX_USERS = Number.parseInt(process.env.EDWARD_MAX_USERS || '2', 10);

const saveUsers = () => saveJson('users.json', users);
const saveMessages = () => saveJson('messages.json', messages);

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64);
}
function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function publicUser(u) {
  if (!u) return null;
  return { id: u.id, username: u.username, email: u.email, avatar: u.avatar || null, bio: u.bio || '' };
}
function makeToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  tokens.set(token, userId);
  return token;
}
function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const userId = token && tokens.get(token);
  if (!userId) return res.status(401).json({ error: 'Не авторизован' });
  req.userId = userId;
  req.token = token;
  next();
}
function validString(value, maxLength) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}
function isOnline(userId) {
  return (socketsByUser.get(userId) || new Set()).size > 0;
}
function addSocket(userId, socketId) {
  const sockets = socketsByUser.get(userId) || new Set();
  sockets.add(socketId);
  socketsByUser.set(userId, sockets);
  return sockets.size === 1;
}
function removeSocket(userId, socketId) {
  const sockets = socketsByUser.get(userId);
  if (!sockets) return false;
  sockets.delete(socketId);
  if (sockets.size) return false;
  socketsByUser.delete(userId);
  return true;
}

// ---------- регистрация / вход ----------
app.post('/api/register', (req, res) => {
  const { username, email, password, inviteCode } = req.body || {};
  const configuredInvite = process.env.EDWARD_INVITE_CODE;
  if (!configuredInvite) {
    return res.status(503).json({ error: 'Регистрация закрыта: администратор должен настроить EDWARD_INVITE_CODE на сервере' });
  }
  if (typeof inviteCode !== 'string' || !safeEqual(inviteCode, configuredInvite)) {
    return res.status(403).json({ error: 'Неверный код приглашения' });
  }
  if (!validString(username, 32) || !validString(email, 254) || !validString(password, 1024)) {
    return res.status(400).json({ error: 'Проверьте логин, почту и пароль' });
  }
  const uname = username.trim();
  const mail = email.trim().toLowerCase();
  if (uname.length < 2 || password.length < 8) {
    return res.status(400).json({ error: 'Логин должен быть не короче 2 символов, пароль — не короче 8' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
    return res.status(400).json({ error: 'Укажите корректный адрес почты' });
  }
  if (Number.isFinite(MAX_USERS) && MAX_USERS > 0 && users.length >= MAX_USERS) {
    return res.status(403).json({ error: 'Достигнут лимит аккаунтов на этом сервере' });
  }
  if (users.some(u => u.username.toLowerCase() === uname.toLowerCase())) {
    return res.status(400).json({ error: 'Такой логин уже занят' });
  }
  if (users.some(u => u.email.toLowerCase() === mail)) {
    return res.status(400).json({ error: 'Эта почта уже зарегистрирована' });
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const user = {
    id: crypto.randomUUID(), username: uname, email: mail, salt,
    hash: hashPassword(password, salt).toString('hex'), avatar: null, bio: ''
  };
  users.push(user);
  try { saveUsers(); } catch (error) {
    users.pop();
    console.error('Не удалось сохранить пользователя:', error);
    return res.status(500).json({ error: 'Не удалось сохранить аккаунт' });
  }
  res.json({ token: makeToken(user.id), user: publicUser(user) });
});

app.post('/api/login', (req, res) => {
  const { login, password } = req.body || {};
  if (!validString(login, 254) || typeof password !== 'string' || password.length > 1024) {
    return res.status(400).json({ error: 'Укажите логин и пароль' });
  }
  const q = login.trim().toLowerCase();
  const user = users.find(u => u.username.toLowerCase() === q || u.email.toLowerCase() === q);
  if (!user || !safeEqual(hashPassword(password, user.salt).toString('hex'), user.hash)) {
    return res.status(400).json({ error: 'Неверный логин или пароль' });
  }
  res.json({ token: makeToken(user.id), user: publicUser(user) });
});

app.post('/api/logout', auth, (req, res) => {
  tokens.delete(req.token);
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data.token === req.token) socket.disconnect(true);
  }
  res.json({ ok: true });
});

// ---------- профиль ----------
app.get('/api/me', auth, (req, res) => {
  res.json({ user: publicUser(users.find(u => u.id === req.userId)) });
});

app.get('/api/users', auth, (req, res) => {
  res.json({ users: users.filter(u => u.id !== req.userId).map(u => ({ ...publicUser(u), online: isOnline(u.id) })) });
});

app.post('/api/avatar', auth, (req, res) => {
  const { avatar } = req.body || {};
  const user = users.find(u => u.id === req.userId);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  if (avatar !== null && avatar !== '' && (typeof avatar !== 'string' || avatar.length > MAX_AVATAR_LENGTH || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(avatar))) {
    return res.status(400).json({ error: 'Некорректное или слишком большое изображение' });
  }
  user.avatar = avatar || null;
  try { saveUsers(); } catch (error) { return res.status(500).json({ error: 'Не удалось сохранить аватар' }); }
  res.json({ user: publicUser(user) });
});

app.post('/api/bio', auth, (req, res) => {
  const { bio } = req.body || {};
  const user = users.find(u => u.id === req.userId);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  if (typeof bio !== 'string') return res.status(400).json({ error: 'Некорректный статус' });
  user.bio = bio.slice(0, MAX_BIO_LENGTH);
  try { saveUsers(); } catch (error) { return res.status(500).json({ error: 'Не удалось сохранить статус' }); }
  res.json({ user: publicUser(user) });
});

// ---------- история сообщений ----------
app.get('/api/messages/:withId', auth, (req, res) => {
  const withId = req.params.withId;
  if (!users.some(u => u.id === withId) || withId === req.userId) {
    return res.status(404).json({ error: 'Собеседник не найден' });
  }
  const chat = messages.filter(m =>
    (m.from === req.userId && m.to === withId) || (m.from === withId && m.to === req.userId)
  ).sort((a, b) => a.ts - b.ts);
  res.json({ messages: chat });
});

// ---------- сокеты: сообщения + сигналинг звонков ----------
io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  const userId = token && tokens.get(token);
  if (!userId) return next(new Error('unauthorized'));
  socket.userId = userId;
  socket.data.token = token;
  next();
});

io.on('connection', (socket) => {
  if (addSocket(socket.userId, socket.id)) io.emit('presence', { userId: socket.userId, online: true });
  socket.join(`user:${socket.userId}`);
  let messageWindowStart = Date.now();
  let messageCount = 0;

  socket.on('message:send', (payload, acknowledge) => {
    const reply = typeof acknowledge === 'function' ? acknowledge : () => {};
    if (!payload || typeof payload !== 'object') return reply({ error: 'Некорректное сообщение' });
    const { toUserId, text } = payload;
    if (typeof toUserId !== 'string' || toUserId === socket.userId || !users.some(u => u.id === toUserId)) {
      return reply({ error: 'Собеседник не найден' });
    }
    if (!validString(text, MAX_MESSAGE_LENGTH)) return reply({ error: `Сообщение должно содержать не более ${MAX_MESSAGE_LENGTH} символов` });
    const now = Date.now();
    if (now - messageWindowStart >= 60_000) { messageWindowStart = now; messageCount = 0; }
    if (++messageCount > 60) return reply({ error: 'Слишком часто. Подождите минуту.' });
    const msg = { id: crypto.randomUUID(), from: socket.userId, to: toUserId, text: text.trim(), ts: now };
    messages.push(msg);
    try { saveMessages(); } catch (error) {
      messages.pop();
      console.error('Не удалось сохранить сообщение:', error);
      return reply({ error: 'Не удалось сохранить сообщение' });
    }
    io.to(`user:${socket.userId}`).emit('message:new', msg);
    io.to(`user:${toUserId}`).emit('message:new', msg);
    reply({ ok: true, id: msg.id });
  });

  socket.on('call:offer', (data) => {
    if (!data || typeof data.toUserId !== 'string' || data.toUserId === socket.userId || !users.some(u => u.id === data.toUserId) || !data.sdp) return;
    if (!isOnline(data.toUserId)) {
      socket.emit('call:unavailable', { toUserId: data.toUserId });
      return;
    }
    io.to(`user:${data.toUserId}`).emit('call:offer', { fromUserId: socket.userId, sdp: data.sdp, video: Boolean(data.video) });
  });

  ['call:answer', 'call:ice', 'call:end', 'call:reject', 'call:busy'].forEach((evt) => {
    socket.on(evt, (data) => {
      if (!data || typeof data.toUserId !== 'string' || data.toUserId === socket.userId || !users.some(u => u.id === data.toUserId)) return;
      const safeData = evt === 'call:ice' ? { candidate: data.candidate } : evt === 'call:answer' ? { sdp: data.sdp } : {};
      io.to(`user:${data.toUserId}`).emit(evt, { ...safeData, fromUserId: socket.userId });
    });
  });

  socket.on('disconnect', () => {
    if (removeSocket(socket.userId, socket.id)) io.emit('presence', { userId: socket.userId, online: false });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Edward запущен: http://0.0.0.0:${PORT}`);
});
