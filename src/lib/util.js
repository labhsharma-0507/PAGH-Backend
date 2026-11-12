const crypto = require('crypto');
const bad = (message, status = 400, code) => Object.assign(new Error(message), { status, code });
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const eq = (a, b) => {
  a = String(a); b = String(b);
  return a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
};
// async route wrapper: error ko express error handler tak pahunchata hai
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
// NoSQL-injection se bachav: body ke keys mein "$" ko "_" bana do
const clean = (o) => JSON.parse(JSON.stringify(o ?? {}).replace(/"\$/g, '"_'));
const otp6 = () => String(100000 + crypto.randomInt(900000));
const otp4 = () => String(1000 + crypto.randomInt(9000));
const token = (n = 32) => crypto.randomBytes(n).toString('hex');
const orderNo = (p = 'FS') => p + Date.now().toString(36).toUpperCase() + crypto.randomBytes(1).toString('hex').toUpperCase();
const normPhone = (p) => {
  let d = String(p || '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
};
const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
const DAY = 864e5, HOUR = 36e5;
const csv = (rows) => {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
};
const page = (q, max = 100) => {
  const limit = Math.min(max, Math.max(1, +q.limit || 50));
  const skip = Math.max(0, (+q.page || 1) - 1) * limit;
  return { limit, skip };
};
// regex injection se bachne ke liye search text escape
const rx = (s) => new RegExp(String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
module.exports = { bad, sha, eq, ah, clean, otp6, otp4, token, orderNo, normPhone, str, num, DAY, HOUR, csv, page, rx };

// 2FA secret jaise sensitive fields DB mein encrypted (AES-256-GCM) rakhte hain
const cfgKey = () => crypto.createHash('sha256').update((process.env.DATA_KEY || process.env.JWT_SECRET || 'dev-secret-change-me') + ':data').digest();
const encrypt = (text) => {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', cfgKey(), iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return [iv.toString('hex'), c.getAuthTag().toString('hex'), enc.toString('hex')].join(':');
};
const decrypt = (s) => {
  const [iv, tag, data] = String(s).split(':');
  const d = crypto.createDecipheriv('aes-256-gcm', cfgKey(), Buffer.from(iv, 'hex'));
  d.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([d.update(Buffer.from(data, 'hex')), d.final()]).toString('utf8');
};
const rate = require('express-rate-limit');
const limiter = (windowMs, limit, message = 'Bahut zyada requests, thodi der baad try karo') =>
  process.env.NODE_ENV === 'test' ? (q, r, n) => n() : rate({ windowMs, limit, message: { error: message }, standardHeaders: true, legacyHeaders: false });
Object.assign(module.exports, { encrypt, decrypt, limiter });
