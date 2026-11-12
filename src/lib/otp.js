const { Otp } = require('../models');
const { bad, sha, otp6 } = require('./util');
const mk = async (target, purpose) => {
  const e = await Otp.findOne({ target, purpose });
  if (e && Date.now() - e.createdAt < 30000) throw bad('30 second baad dobara try karo', 429);
  const code = otp6();
  await Otp.deleteMany({ target, purpose });
  await Otp.create({ target, purpose, codeHash: sha(code), expiresAt: new Date(Date.now() + 6e5) });
  return code;
};
const check = async (target, purpose, code) => {
  const o = await Otp.findOne({ target, purpose });
  if (!o || o.expiresAt < Date.now() || o.attempts >= 5) return false;
  o.attempts++;
  await o.save();
  if (o.codeHash !== sha(code)) return false;
  await o.deleteOne();
  return true;
};
module.exports = { mk, check };
