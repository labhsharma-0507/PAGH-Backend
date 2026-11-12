const express = require('express');
const bcrypt = require('bcryptjs');
const jwtlib = require('jsonwebtoken');
const crypto = require('crypto');
const { z } = require('zod');
const cfg = require('../config');
const { User, Session } = require('../models');
const { auth, sign, dropStatus } = require('../middleware/auth');
const { bad, sha, ah, clean, token, normPhone, DAY, limiter, encrypt, decrypt } = require('../lib/util');
const { okTotp, genSecret } = require('../lib/totp');
const otp = require('../lib/otp');
const { notify, sendOtp } = require('../lib/notify');
const { audit } = require('../lib/audit');

const R = express.Router();
const cookieOpts = { httpOnly: true, secure: cfg.cookie.secure, sameSite: cfg.cookie.sameSite, domain: cfg.cookie.domain, path: '/api/v1/auth', maxAge: 30 * DAY };
// needsPhone / mustChangePassword: frontend in flags se onboarding steps force karta hai
const publicUser = (u) => ({
  id: String(u._id), name: u.name, email: u.email, role: u.role, adminRole: u.adminRole, lang: u.lang, twoFA: !!u.twoFA?.enabled,
  emailVerified: !!u.emailVerified, phoneVerified: !!u.phoneVerified, needsPhone: u.role === 'customer' && !u.phone, mustChangePassword: !!u.mustChangePassword,
  googleLinked: !!u.googleId,
});

async function issue(u, req, res, tf = false, family) {
  const t = token(40);
  await Session.create({ userId: u._id, family: family || token(8), hash: sha(t), ua: req.headers['user-agent'], ip: req.ip, expiresAt: new Date(Date.now() + 30 * DAY) });
  res.cookie('rt', t, cookieOpts);
  return { token: sign(u, tf), user: publicUser(u) };
}
// Cookie-based endpoints par CSRF se bachne ke liye Origin check
const originOk = (req, res, next) => (cfg.isAllowedOrigin(req.headers.origin) ? next() : next(bad('Origin allowed nahi', 403)));
const cookie = (req, name) => ((req.headers.cookie || '').split(';').map((s) => s.trim().split('=')).find((a) => a[0] === name) || [])[1];

const Password = z.string().min(8, 'Password kam se kam 8 characters').max(100).regex(/[A-Za-z]/, 'Password mein letter chahiye').regex(/\d/, 'Password mein number chahiye');
const Signup = z.object({ name: z.string().trim().min(2).max(80), email: z.string().trim().email().max(120), phone: z.string(), password: Password, lang: z.enum(['en', 'hi', 'hg']).optional() });

async function sendVerifyLink(u) {
  const t = token(24);
  await User.updateOne({ _id: u._id }, { emailVerifyHash: sha(t), emailVerifyExp: new Date(Date.now() + DAY) });
  await notify(u._id, 'EMAIL_VERIFY', { link: `${cfg.webOrigin}/verify-email?token=${t}` });
}

R.post('/signup', limiter(15 * 60e3, 20), ah(async (q, r) => {
  const p = Signup.safeParse(clean(q.body));
  if (!p.success) throw bad(p.error.issues[0].message);
  const phone = normPhone(p.data.phone);
  if (!phone) throw bad('Valid 10-digit Indian mobile number do');
  const email = p.data.email.toLowerCase();
  if (await User.findOne({ $or: [{ email }, { phone }] })) throw bad('Ye email ya phone pehle se registered hai', 409);
  const u = await User.create({ name: p.data.name, email, phone, lang: p.data.lang, hash: await bcrypt.hash(p.data.password, 12) });
  sendVerifyLink(u).catch((e) => console.error('verify mail', e.message));
  audit({ user: { id: u._id, role: 'customer' }, ip: q.ip, headers: q.headers }, 'SIGNUP', 'User', u._id);
  r.json(await issue(u, q, r));
}));

R.post('/login', limiter(15 * 60e3, 30), ah(async (q, r) => {
  const { email, password, totp } = clean(q.body);
  const u = await User.findOne({ email: String(email || '').toLowerCase() });
  if (u?.lockUntil > new Date()) throw bad('Bahut zyada galat attempts. 15 minute baad try karo.', 423);
  const ok = u && u.hash && (await bcrypt.compare(String(password || ''), u.hash));
  if (!ok) {
    if (u) {
      const fails = (u.failedLogins || 0) + 1;
      await User.updateOne({ _id: u._id }, fails >= 5 ? { failedLogins: 0, lockUntil: new Date(Date.now() + 15 * 60e3) } : { failedLogins: fails });
      audit({ user: { id: u._id, role: u.role }, ip: q.ip, headers: q.headers }, 'LOGIN_FAILED', 'User', u._id);
    }
    throw bad('Galat email ya password', 401);
  }
  if (u.status !== 'active') throw bad('Account active nahi hai', 403);
  const tf = !!u.twoFA?.enabled;
  if (u.role === 'admin' && tf && !okTotp(decrypt(u.twoFA.secret), totp)) throw bad('Authenticator app ka 6-digit code chahiye', 401, 'TOTP');
  await User.updateOne({ _id: u._id }, { failedLogins: 0, lockUntil: null, lastLoginAt: new Date() });
  audit({ user: { id: u._id, role: u.role === 'admin' ? 'admin' : u.role, ar: u.adminRole }, ip: q.ip, headers: q.headers }, 'LOGIN', 'User', u._id);
  r.json(await issue(u, q, r, tf));
}));

// ---- phone OTP login (India-friendly). Admin ke liye band.
R.post('/otp/login-send', limiter(15 * 60e3, 10), ah(async (q, r) => {
  const phone = normPhone(q.body.phone);
  if (!phone) throw bad('Valid mobile number do');
  const u = await User.findOne({ phone });
  if (!u || u.role === 'admin' || u.status !== 'active') return r.json({ ok: true }); // user exist karta hai ya nahi, ye nahi batate
  r.json({ ok: true, devCode: await sendOtp(u, await otp.mk('login:' + phone, 'login')) });
}));
R.post('/otp/login', limiter(15 * 60e3, 20), ah(async (q, r) => {
  const phone = normPhone(q.body.phone);
  const u = phone && (await User.findOne({ phone }));
  if (!u || u.role === 'admin' || u.status !== 'active' || !(await otp.check('login:' + phone, 'login', String(q.body.code)))) throw bad('Code galat ya expire', 401);
  await User.updateOne({ _id: u._id }, { phoneVerified: true, lastLoginAt: new Date() });
  r.json(await issue(u, q, r));
}));

// ---- email/phone verification
R.get('/verify-email', ah(async (q, r) => {
  const u = await User.findOne({ emailVerifyHash: sha(String(q.query.token || '')), emailVerifyExp: { $gt: new Date() } });
  if (!u) throw bad('Link galat ya expire ho gaya');
  await User.updateOne({ _id: u._id }, { emailVerified: true, $unset: { emailVerifyHash: 1, emailVerifyExp: 1 } });
  r.json({ ok: true });
}));
R.post('/resend-verification', auth(), limiter(60 * 60e3, 5), ah(async (q, r) => {
  const u = await User.findById(q.user.id);
  if (u.emailVerified) return r.json({ ok: true });
  await sendVerifyLink(u);
  r.json({ ok: true });
}));
R.post('/otp/send', auth(), limiter(15 * 60e3, 10), ah(async (q, r) => {
  const u = await User.findById(q.user.id);
  if (!u.phone) throw bad('Profile mein phone number nahi hai');
  r.json({ ok: true, devCode: await sendOtp(u, await otp.mk('verify:' + u._id, 'verify')) });
}));
R.post('/otp/verify', auth(), ah(async (q, r) => {
  if (!(await otp.check('verify:' + q.user.id, 'verify', String(q.body.code)))) throw bad('Code galat ya expire');
  await User.updateOne({ _id: q.user.id }, { phoneVerified: true });
  r.json({ ok: true });
}));

// ---- password
R.post('/forgot', limiter(15 * 60e3, 10), ah(async (q, r) => {
  const u = await User.findOne({ email: String(q.body.email || '').toLowerCase() });
  if (!u || u.status !== 'active') return r.json({ ok: true });
  r.json({ ok: true, devCode: await sendOtp(u, await otp.mk('reset:' + u.email, 'reset')) });
}));
R.post('/reset', limiter(15 * 60e3, 10), ah(async (q, r) => {
  const u = await User.findOne({ email: String(q.body.email || '').toLowerCase() });
  const pw = Password.safeParse(String(q.body.password || ''));
  if (!pw.success) throw bad(pw.error.issues[0].message);
  if (!u || !(await otp.check('reset:' + u.email, 'reset', String(q.body.code)))) throw bad('Code galat ya expire');
  await User.updateOne({ _id: u._id }, { hash: await bcrypt.hash(pw.data, 12), failedLogins: 0, lockUntil: null });
  await Session.updateMany({ userId: u._id }, { revoked: true });
  audit({ user: { id: u._id, role: u.role }, ip: q.ip, headers: q.headers }, 'PASSWORD_RESET', 'User', u._id);
  r.json({ ok: true });
}));
R.post('/change-password', auth(), limiter(15 * 60e3, 10), ah(async (q, r) => {
  const u = await User.findById(q.user.id);
  if (!u.hash || !(await bcrypt.compare(String(q.body.current || ''), u.hash))) throw bad('Current password galat');
  const pw = Password.safeParse(String(q.body.password || ''));
  if (!pw.success) throw bad(pw.error.issues[0].message);
  if (String(q.body.password) === String(q.body.current)) throw bad('Naya password purane se alag hona chahiye');
  await User.updateOne({ _id: u._id }, { hash: await bcrypt.hash(pw.data, 12), mustChangePassword: false });
  dropStatus(u._id);
  await Session.updateMany({ userId: u._id, hash: { $ne: sha(cookie(q, 'rt') || '') } }, { revoked: true });
  audit(q, 'PASSWORD_CHANGE', 'User', u._id);
  r.json({ ok: true });
}));

// ---- Google Sign-In (ID token flow). Frontend Google se ID token leta hai; hum Google se verify karke apna session dete hain.
// Setup: Google Cloud Console > OAuth Client (Web) > Authorised JavaScript origins mein WEB_ORIGIN daalo; GOOGLE_CLIENT_ID env mein.
const verifyGoogle = async (idToken) => {
  const res = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken), { signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (!res || !res.ok) throw bad('Google token invalid ya expire', 401);
  const d = await res.json();
  if (d.aud !== cfg.googleClientId) throw bad('Google token is app ke liye nahi hai', 401);
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(d.iss)) throw bad('Google token issuer galat', 401);
  if (Number(d.exp) * 1000 < Date.now()) throw bad('Google token expire ho gaya', 401);
  if (String(d.email_verified) !== 'true' || !d.email || !d.sub) throw bad('Google account ka email verified nahi hai', 401);
  return d;
};
R.post('/google', limiter(15 * 60e3, 30), ah(async (q, r) => {
  if (!cfg.googleClientId) throw bad('Google login configure nahi hai (GOOGLE_CLIENT_ID)', 501);
  const idToken = String(q.body.idToken || '');
  if (idToken.length < 20 && !cfg.googleTestMode) throw bad('Google token missing', 401);
  const d = await verifyGoogle(idToken);
  const email = String(d.email).toLowerCase();
  let u = (await User.findOne({ googleId: d.sub })) || (await User.findOne({ email }));
  if (u?.googleId && u.googleId !== d.sub) throw bad('Is email par alag Google account linked hai', 409);
  if (!u) u = await User.create({ name: String(d.name || email.split('@')[0]).slice(0, 80), email, googleId: d.sub, emailVerified: true, hash: await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 12), lang: ['en', 'hi', 'hg'].includes(q.body.lang) ? q.body.lang : undefined });
  else {
    if (u.role === 'admin') throw bad('Admin account password + 2FA se login karega', 403);
    if (u.status !== 'active') throw bad('Account active nahi hai', 403);
    const set = { googleId: d.sub, emailVerified: true, lastLoginAt: new Date() };
    // admin-created temp password wale staff: Google se identity prove ho gayi, temp password ko random bana do
    if (u.mustChangePassword) { set.mustChangePassword = false; set.hash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 12); }
    await User.updateOne({ _id: u._id }, set); dropStatus(u._id);
    u = await User.findById(u._id);
  }
  audit({ user: { id: u._id, role: u.role }, ip: q.ip, headers: q.headers }, 'LOGIN_GOOGLE', 'User', u._id);
  r.json(await issue(u, q, r));
}));

// ---- refresh token rotation + reuse detection
R.post('/refresh', originOk, ah(async (q, r) => {
  const t = cookie(q, 'rt');
  if (!t) throw bad('Session nahi mila', 401);
  const s = await Session.findOne({ hash: sha(t) });
  if (!s || s.expiresAt < Date.now()) throw bad('Session expire ho gaya', 401);
  if (s.revoked) { await Session.updateMany({ family: s.family }, { revoked: true }); throw bad('Session expire ho gaya', 401); } // purana token dobara use hua = chori ka shak
  const used = await Session.findOneAndUpdate({ _id: s._id, revoked: { $ne: true } }, { revoked: true });
  if (!used) throw bad('Session expire ho gaya', 401);
  const u = await User.findById(s.userId);
  if (!u || u.status !== 'active') throw bad('Session expire ho gaya', 401);
  r.json(await issue(u, q, r, !!u.twoFA?.enabled, s.family));
}));
R.post('/logout', originOk, ah(async (q, r) => {
  const t = cookie(q, 'rt');
  if (t) await Session.updateMany({ hash: sha(t) }, { revoked: true });
  r.clearCookie('rt', { ...cookieOpts, maxAge: undefined });
  r.json({ ok: true });
}));
R.post('/logout-all', auth(), ah(async (q, r) => { await Session.updateMany({ userId: q.user.id }, { revoked: true }); r.json({ ok: true }); }));

// ---- 2FA (TOTP). Admin ke liye mandatory.
R.post('/2fa/setup', auth(), ah(async (q, r) => {
  const u = await User.findById(q.user.id);
  if (u.twoFA?.enabled) throw bad('2FA pehle se on hai');
  const secret = genSecret();
  await User.updateOne({ _id: u._id }, { twoFA: { enabled: false, secret: encrypt(secret) } });
  r.json({ secret, otpauth: `otpauth://totp/FootwearSOS:${encodeURIComponent(u.email)}?secret=${secret}&issuer=FootwearSOS` });
}));
R.post('/2fa/verify', auth(), ah(async (q, r) => {
  const u = await User.findById(q.user.id);
  if (!u.twoFA?.secret || !okTotp(decrypt(u.twoFA.secret), String(q.body.code))) throw bad('Code galat');
  await User.updateOne({ _id: u._id }, { 'twoFA.enabled': true });
  dropStatus(u._id);
  audit(q, '2FA_ENABLED', 'User', u._id);
  r.json(await issue(u, q, r, true));
}));
module.exports = { router: R, issue, publicUser };
