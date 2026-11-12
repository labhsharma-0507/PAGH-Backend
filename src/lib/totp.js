const crypto = require('crypto');
const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const enc = (b) => {
  let s = '',
    o = '';
  for (const x of b) s += x.toString(2).padStart(8, '0');
  for (let i = 0; i < s.length; i += 5) o += A[parseInt(s.slice(i, i + 5).padEnd(5, '0'), 2)];
  return o;
};
const dec = (s) => {
  let b = '';
  for (const c of s) b += A.indexOf(c).toString(2).padStart(5, '0');
  const o = [];
  for (let i = 0; i + 8 <= b.length; i += 8) o.push(parseInt(b.slice(i, i + 8), 2));
  return Buffer.from(o);
};
const hotp = (k, c) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(c));
  const h = crypto.createHmac('sha1', dec(k)).update(b).digest();
  const o = h[19] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
};
const okTotp = (k, code) => {
  const c = Math.floor(Date.now() / 3e4);
  return [-1, 0, 1].some((w) => hotp(k, c + w) === String(code));
};
module.exports = { hotp, okTotp, genSecret: () => enc(crypto.randomBytes(20)) };
