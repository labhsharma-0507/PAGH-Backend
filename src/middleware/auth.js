const jwt = require('jsonwebtoken');
const cfg = require('../config');
const { User } = require('../models');
const { bad } = require('../lib/util');

// Admin sub-roles ke permissions (PRD: Super Admin, Ops, Support, Finance, Content/Ads). Exact-match permissions.
const PERMS = {
  super: '*',
  ops: ['orders:read', 'orders', 'orders:override', 'partners', 'verdict', 'pricing', 'batches', 'claims:review', 'users:read', 'analytics', 'brands', 'notifications'],
  support: ['orders:read', 'orders', 'claims:review', 'users:read', 'notifications'],
  finance: ['orders:read', 'payments', 'payouts', 'claims:review', 'claims:settle', 'analytics', 'wallet', 'users:read'],
  content: ['content', 'shop', 'ads', 'analytics'],
};
const can = (u, perm) => {
  if (u.role !== 'admin') return false;
  const p = PERMS[u.ar];
  return p === '*' || (Array.isArray(p) && p.includes(perm));
};
const sign = (u, tf) =>
  jwt.sign({ id: String(u._id), role: u.role, ar: u.adminRole, tf: u.role !== 'admin' || !!tf }, cfg.jwtSecret, { expiresIn: '15m' });

// Role/status hamesha DB se (10 sec cache): role badalte hi ya user block hote hi turant asar, token expire hone ka wait nahi
const liveCache = new Map();
const live = async (id) => {
  const c = liveCache.get(id);
  if (c && Date.now() - c.at < 10000) return c.v;
  const u = await User.findById(id, 'status role adminRole mustChangePassword').lean();
  const v = u ? { status: u.status, role: u.role, ar: u.adminRole, must: !!u.mustChangePassword } : { status: 'deleted' };
  liveCache.set(id, { v, at: Date.now() });
  return v;
};
const dropStatus = (id) => liveCache.delete(String(id));

const read = async (req) => {
  const t = (req.headers.authorization || '').slice(7);
  const p = jwt.verify(t, cfg.jwtSecret);
  const l = await live(p.id);
  if (l.status !== 'active') throw bad('Account active nahi hai', 403);
  if (l.role !== p.role) p.tf = l.role !== 'admin' && p.tf; // role badla hai: admin banne par 2FA dobara
  return { ...p, role: l.role, ar: l.ar, must: l.must };
};
// Temporary password wale (admin-created) users sirf password badal sakte hain
const MUST_OK = ['/auth/change-password', '/auth/logout', '/me'];
const auth = (...roles) => async (req, res, next) => {
  try {
    req.user = await read(req).catch((e) => { throw e.status ? e : bad('Login required', 401); });
    const url = req.originalUrl.split('?')[0];
    if (req.user.must && !MUST_OK.some((x) => url.endsWith(x))) return res.status(403).json({ error: 'Pehle apna temporary password badlo', code: 'CHANGE_PW' });
    if (req.user.role === 'admin' && !req.user.tf && !url.includes('/auth/2fa') && !MUST_OK.some((x) => url.endsWith(x)))
      return res.status(403).json({ error: 'Admin 2FA zaroori hai', code: '2FA' });
    if (roles.length && !roles.includes(req.user.role)) throw bad('Forbidden', 403);
    next();
  } catch (e) { next(e); }
};
const optionalAuth = async (req, res, next) => {
  try { if (req.headers.authorization) req.user = await read(req); } catch { /* anonymous */ }
  next();
};
const admin = (perm) => [auth('admin'), (req, res, next) => (can(req.user, perm) ? next() : next(bad(`Is kaam ki permission nahi (${perm})`, 403)))];
module.exports = { auth, admin, optionalAuth, sign, can, PERMS, dropStatus };
