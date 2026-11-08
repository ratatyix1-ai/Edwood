const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJson(file, fallback) {
  const p = path.join(DATA_DIR, file);
  if (!fs.existsSync(p)) {
    saveJson(file, fallback);
    return fallback;
  }
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error('Ошибка чтения', file, e);
    return fallback;
  }
}

function saveJson(file, data) {
  const p = path.join(DATA_DIR, file);
  const temp = `${p}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(temp, p);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch (cleanupError) {}
    throw error;
  }
}

module.exports = { loadJson, saveJson };
