const express = require('express');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const { Server } = require('socket.io');
const { loadJson, saveJson } = require('./db');

const app = express();

// Простой CORS — на случай если фронтенд когда-нибудь откроется не с того же
// адреса, что и сервер (сейчас всё на одном origin, но не помешает).
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: '8mb' })); // достаточно для аватарки в base64
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e7 });

// ---------- хранилище ----------
let users = loadJson('users.json', []);       // {id, username, email, salt, hash, avatar, bio}
let messages = loadJson('messages.json', []); // {id, from, to, text, ts}
const tokens = new Map();                     // token -> userId
const online = new Map();                     // userId -> socket.id

const saveUsers = () => saveJson('users.json', users);
const saveMessages = () => saveJson('messages.json', messages);

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function publicUser(u) {
  if (!u) return null;
  return { id: u.id, username: u.username, email: u.email, avatar: u.avatar || null, bio: u.bio || '' };
}
function makeToken(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  tokens.set(token, userId);
  return token;
}
function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const userId = token && tokens.get(token);
  if (!userId) return res.status(401).json({ error: 'Не авторизован' });
  req.userId = userId;
  next();
}

// ---------- регистрация / вход ----------
app.post('/api/register', (req, res) => {
  const { username, email, password } = req.body || {};
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Заполните логин, почту и пароль' });
  }
  if (username.length < 2 || password.length < 4) {
    return res.status(400).json({ error: 'Логин или пароль слишком короткие' });
  }
  const uname = username.trim();
  const mail = email.trim().toLowerCase();
  if (users.find(u => u.username.toLowerCase() === uname.toLowerCase())) {
    return res.status(400).json({ error: 'Такой логин уже занят' });
  }
  if (users.find(u => u.email.toLowerCase() === mail)) {
    return res.status(400).json({ error: 'Эта почта уже зарегистрирована' });
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  const user = { id: crypto.randomUUID(), username: uname, email: mail, salt, hash, avatar: null, bio: '' };
  users.push(user);
  saveUsers();
  const token = makeToken(user.id);
  res.json({ token, user: publicUser(user) });
});

app.post('/api/login', (req, res) => {
  const { login, password } = req.body || {};
  const q = (login || '').trim().toLowerCase();
  const user = users.find(u => u.username.toLowerCase() === q || u.email.toLowerCase() === q);
  if (!user) return res.status(400).json({ error: 'Пользователь не найден' });
  const hash = hashPassword(password || '', user.salt);
  if (hash !== user.hash) return res.status(400).json({ error: 'Неверный пароль' });
  const token = makeToken(user.id);
  res.json({ token, user: publicUser(user) });
});

app.post('/api/logout', auth, (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) tokens.delete(token);
  res.json({ ok: true });
});

// ---------- профиль ----------
app.get('/api/me', auth, (req, res) => {
  res.json({ user: publicUser(users.find(u => u.id === req.userId)) });
});

app.get('/api/users', auth, (req, res) => {
  res.json({
    users: users
      .filter(u => u.id !== req.userId)
      .map(u => ({ ...publicUser(u), online: online.has(u.id) }))
  });
});

app.post('/api/avatar', auth, (req, res) => {
  const { avatar } = req.body || {};
  const user = users.find(u => u.id === req.userId);
  user.avatar = avatar || null;
  saveUsers();
  res.json({ user: publicUser(user) });
});

app.post('/api/bio', auth, (req, res) => {
  const { bio } = req.body || {};
  const user = users.find(u => u.id === req.userId);
  user.bio = (bio || '').slice(0, 120);
  saveUsers();
  res.json({ user: publicUser(user) });
});

// ---------- история сообщений ----------
app.get('/api/messages/:withId', auth, (req, res) => {
  const withId = req.params.withId;
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
  next();
});

io.on('connection', (socket) => {
  online.set(socket.userId, socket.id);
  io.emit('presence', { userId: socket.userId, online: true });

  socket.on('message:send', ({ toUserId, text }) => {
    if (!toUserId || !text || !text.trim()) return;
    const msg = { id: crypto.randomUUID(), from: socket.userId, to: toUserId, text: text.trim(), ts: Date.now() };
    messages.push(msg);
    saveMessages();
    socket.emit('message:new', msg);
    const targetSocketId = online.get(toUserId);
    if (targetSocketId) io.to(targetSocketId).emit('message:new', msg);
  });

  // WebRTC-сигналинг для звонков (голос/видео)
  socket.on('call:offer', (data) => {
    const targetSocketId = online.get(data.toUserId);
    if (!targetSocketId) {
      socket.emit('call:unavailable', { toUserId: data.toUserId });
      return;
    }
    io.to(targetSocketId).emit('call:offer', { ...data, fromUserId: socket.userId });
  });

  ['call:answer', 'call:ice', 'call:end', 'call:reject', 'call:busy'].forEach((evt) => {
    socket.on(evt, (data) => {
      const targetSocketId = online.get(data.toUserId);
      if (targetSocketId) io.to(targetSocketId).emit(evt, { ...data, fromUserId: socket.userId });
    });
  });

  socket.on('disconnect', () => {
    if (online.get(socket.userId) === socket.id) {
      online.delete(socket.userId);
      io.emit('presence', { userId: socket.userId, online: false });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Edward запущен: http://0.0.0.0:${PORT}`);
});
