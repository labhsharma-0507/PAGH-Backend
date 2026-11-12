const express = require('express');
const bcrypt = require('bcryptjs');
const M = require('../models');
const S = require('../lib/settings');
const wallet = require('../lib/wallet');
const O = require('../lib/orders');
const ads = require('../lib/ads');
const { processQueue } = require('../lib/notify');
const { auth, admin, can, dropStatus } = require('../middleware/auth');
const { crud } = require('../lib/crud');
const { bad, ah, clean, str, num, csv, page, rx, DAY } = require('../lib/util');
const { audit } = require('../lib/audit');
const { pub } = require('./orders');
const R = express.Router();
const ID = (v) => { if (!M.mongoose.isValidObjectId(v)) throw bad('Bad id'); return v; };

// ---------------- analytics / KPIs (PRD section 13)
async function analytics() {
  const [orders, verdicts, quotesN, users, claims, reviews, payouts, ledgerSla, camps, shopPaid] = await Promise.all([
    M.Order.find({ rework: { $ne: true } }, 'status userId total paidAmount createdAt deliveredAt committedDate events').lean(),
    M.VerdictRequest.countDocuments(), M.Quote.countDocuments({ extraWorkOf: null }), M.User.countDocuments({ role: 'customer', status: 'active' }),
    M.Claim.find().lean(), M.Review.find().lean(), M.Payout.find().lean(), M.Ledger.find({ reason: 'SLA' }).lean(), M.Campaign.find().lean(), M.ShopOrder.find({ status: { $nin: ['PENDING', 'CANCELLED'] } }).lean(),
  ]);
  const ev = (o, to) => o.events.find((e) => e.to === to);
  const approved = orders.filter((o) => ev(o, 'QUOTE_APPROVED')).length, rejected = orders.filter((o) => ev(o, 'QUOTE_REJECTED')).length;
  const timed = orders.filter((o) => o.deliveredAt && o.committedDate);
  const hit = timed.filter((o) => { const r = ev(o, 'READY'); return r && new Date(r.ts) <= new Date(o.committedDate); }).length;
  const tats = orders.map((o) => (ev(o, 'READY') && ev(o, 'QUOTE_APPROVED') ? (+new Date(ev(o, 'READY').ts) - +new Date(ev(o, 'QUOTE_APPROVED').ts)) / DAY : null)).filter((x) => x !== null);
  const revenue = orders.reduce((s, o) => s + (o.paidAmount || 0), 0);
  const payoutTotal = payouts.reduce((s, p) => s + p.amount + (p.adjustments || []).reduce((a, x) => a + x.amount, 0), 0);
  const claimsPaid = claims.filter((c) => c.status === 'SETTLED' && c.settlement !== 'REDO').reduce((s, c) => s + (c.amount || 0), 0);
  const slaCredits = ledgerSla.reduce((s, x) => s + x.amount, 0);
  const byUser = {}; for (const o of orders) (byUser[o.userId] ||= []).push(o);
  const buyers = Object.values(byUser), repeaters = buyers.filter((l) => l.length > 1).length;
  // monthly cohorts: first order month -> % jinhone 90 din mein dobara order kiya
  const cohorts = {};
  for (const l of buyers) {
    l.sort((a, b) => a.createdAt - b.createdAt);
    const m = new Date(l[0].createdAt).toISOString().slice(0, 7), c = (cohorts[m] ||= { users: 0, repeat90: 0 });
    c.users++; if (l[1] && +new Date(l[1].createdAt) - +new Date(l[0].createdAt) <= 90 * DAY) c.repeat90++;
  }
  const avg = (k) => (reviews.length ? +(reviews.reduce((s, x) => s + x[k], 0) / reviews.length).toFixed(2) : null);
  const byStatus = {}; for (const o of orders) byStatus[o.status] = (byStatus[o.status] || 0) + 1;
  const adRevenue = +camps.reduce((s, c) => s + ads.revenue(c), 0).toFixed(2);
  const shopRevenue = shopPaid.reduce((s, o) => s + o.total, 0);
  const reservePct = +(await S.get('reservePct'));
  return {
    funnel: { verdicts, orders: orders.length, quotesSent: quotesN, quotesApproved: approved, delivered: orders.filter((o) => o.deliveredAt).length },
    byStatus, quoteApprovalPct: approved + rejected ? Math.round((approved * 100) / (approved + rejected)) : null,
    slaHitRatePct: timed.length ? Math.round((hit * 100) / timed.length) : null, avgTatDays: tats.length ? +(tats.reduce((s, x) => s + x, 0) / tats.length).toFixed(1) : null,
    revenue, payouts: payoutTotal, slaCredits, claims: { total: claims.length, open: claims.filter((c) => O.OPEN_CLAIM.concat('SUBMITTED').includes(c.status)).length, paid: claimsPaid, ratePct: orders.length ? +((claims.length * 100) / orders.length).toFixed(1) : 0 },
    reserve: { pct: reservePct, target: Math.round((revenue * reservePct) / 100), used: claimsPaid + slaCredits, healthy: claimsPaid + slaCredits <= (revenue * reservePct) / 100 },
    grossMarginEstimate: { amount: revenue - payoutTotal - slaCredits - claimsPaid, note: 'Logistics/ops/tech cost shamil NAHI hai. Ye sirf rough estimate hai.' },
    repeatPct: buyers.length ? Math.round((repeaters * 100) / buyers.length) : null, cohorts,
    csat: { quality: avg('quality'), communication: avg('communication'), delivery: avg('delivery'), reviews: reviews.length },
    revenueMix: { services: revenue, shop: shopRevenue, ads: adRevenue }, customers: users,
  };
}
R.get('/admin/analytics', admin('analytics'), ah(async (q, r) => {
  const a = await analytics();
  if (q.query.format === 'csv') {
    const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v, p + k + '.') : [[p + k, v]]));
    return r.type('text/csv').send(csv(flat(a).map(([metric, value]) => ({ metric, value }))));
  }
  r.json(a);
}));
R.get('/admin/stats', admin('analytics'), ah(async (q, r) => {
  const a = await analytics();
  const risk = await M.Order.countDocuments({ status: { $in: O.SLA_ACTIVE }, committedDate: { $lt: new Date(Date.now() + DAY) }, 'hold.active': { $ne: true } });
  r.json({ orders: a.funnel.orders, delivered: a.funnel.delivered, byStatus: a.byStatus, revenue: a.revenue, claimsOpen: a.claims.open, slaAtRisk: risk, pendingPartners: await M.Partner.countDocuments({ status: 'PENDING' }), reviewQueue: await M.VerdictRequest.countDocuments({ reviewStatus: 'PENDING' }), reserve: a.reserve });
}));

// ---------------- orders (ops)
R.get('/admin/orders', admin('orders:read'), ah(async (q, r) => {
  const f = {}, Q = q.query;
  if (Q.status) f.status = String(Q.status); if (Q.partnerId) f.partnerId = ID(Q.partnerId); if (Q.pincode) f.pincode = String(Q.pincode);
  if (Q.q) f.orderNo = rx(String(Q.q).slice(0, 30));
  if (Q.sla === 'risk') { f.status = { $in: O.SLA_ACTIVE }; f.committedDate = { $lt: new Date(Date.now() + DAY) }; }
  if (Q.from || Q.to) f.createdAt = { ...(Q.from && { $gte: new Date(Q.from) }), ...(Q.to && { $lte: new Date(Q.to) }) };
  const { limit, skip } = page(Q);
  const [items, total] = await Promise.all([M.Order.find(f).sort('-createdAt').skip(skip).limit(limit), M.Order.countDocuments(f)]);
  r.json({ items: items.map((o) => ({ ...pub(o, q), delayed: !!(o.committedDate && o.committedDate < Date.now() && O.SLA_ACTIVE.includes(o.status)) })), total });
}));
R.get('/admin/orders/:id', admin('orders:read'), ah(async (q, r) => {
  const o = await M.Order.findById(ID(q.params.id));
  if (!o) throw bad('Nahi mila', 404);
  const [cond, quotes, custody, job, payments, claims, user] = await Promise.all([M.Cond.findOne({ orderId: o._id }).lean(), M.Quote.find({ orderId: o._id }).lean(), M.Custody.find({ orderId: o._id }).sort('createdAt').lean(), M.Job.findOne({ orderId: o._id }).lean(), M.Payment.find({ orderId: o._id }).lean(), M.Claim.find({ orderId: o._id }).lean(), M.User.findById(o.userId, 'name email phone').lean()]);
  r.json({ order: pub(o, q), condition: cond, quotes, custody, job, payments, claims, user });
}));
R.post('/admin/orders/:id/assign', admin('orders'), ah(async (q, r) => {
  const o = await M.Order.findById(ID(q.params.id));
  if (!o) throw bad('Nahi mila', 404);
  const set = {};
  if (q.body.partnerId) { const u = await M.User.findOne({ _id: ID(q.body.partnerId), role: 'partner', status: 'active' }); if (!u) throw bad('Partner nahi mila'); set.partnerId = u._id; await M.Job.updateOne({ orderId: o._id }, { $set: { partnerId: u._id } }, { upsert: true }); }
  if (q.body.agentId) { const u = await M.User.findOne({ _id: ID(q.body.agentId), role: 'agent', status: 'active' }); if (!u) throw bad('Agent nahi mila'); set.agentId = u._id; }
  await M.Order.updateOne({ _id: o._id }, set);
  audit(q, 'ORDER_ASSIGN', 'Order', o._id, null, set);
  r.json({ ok: true });
}));
// Emergency: kisi bhi status par force. Har override audit-logged.
R.post('/admin/orders/:id/override', admin('orders:override'), ah(async (q, r) => {
  const o = await M.Order.findById(ID(q.params.id));
  if (!o) throw bad('Nahi mila', 404);
  if (!str(q.body.note)) throw bad('Reason zaroori hai');
  const n = await O.move(o, String(q.body.to), { by: 'admin', byId: q.user.id, note: 'OVERRIDE: ' + str(q.body.note, 200) }, true);
  audit(q, 'ORDER_OVERRIDE', 'Order', o._id, { status: o.status }, { status: n.status, note: q.body.note });
  r.json(pub(n, q));
}));

// ---------------- users / staff
R.get('/admin/users', admin('users:read'), ah(async (q, r) => {
  const f = {}; if (q.query.role) f.role = String(q.query.role);
  if (q.query.q) { const x = rx(String(q.query.q).slice(0, 40)); f.$or = [{ name: x }, { email: x }, { phone: x }]; }
  const { limit, skip } = page(q.query);
  const [items, total] = await Promise.all([M.User.find(f, 'name email phone role adminRole status twoFA.enabled createdAt lastLoginAt').sort('-createdAt').skip(skip).limit(limit).lean(), M.User.countDocuments(f)]);
  r.json({ items: items.map((u) => ({ ...u, twoFA: !!u.twoFA?.enabled })), total });
}));
R.post('/admin/users', admin('partners'), ah(async (q, r) => {
  const b = clean(q.body), role = String(b.role);
  if (!['admin', 'partner', 'agent', 'droppoint', 'brand', 'customer'].includes(role)) throw bad('Role invalid');
  if (role === 'admin') {
    if (!can(q.user, 'super')) throw bad('Admin/staff sirf Super admin bana sakta hai', 403);
    if (!['super', 'ops', 'support', 'finance', 'content'].includes(b.adminRole)) throw bad('adminRole chuno: super/ops/support/finance/content');
  }
  if (role === 'brand' && !can(q.user, 'brands')) throw bad('Brand user ke liye brands permission chahiye', 403);
  if (!/^\S+@\S+\.\S+$/.test(b.email || '') || String(b.password || '').length < 8) throw bad('Valid email aur 8+ char password do');
  if (await M.User.findOne({ email: b.email.toLowerCase() })) throw bad('Email pehle se hai', 409);
  const u = await M.User.create({ name: str(b.name, 80) || b.email, email: b.email, role, adminRole: role === 'admin' ? b.adminRole : undefined, hash: await bcrypt.hash(b.password, 12), emailVerified: true, mustChangePassword: role !== 'customer', brandId: role === 'brand' && M.mongoose.isValidObjectId(b.brandId) ? b.brandId : undefined });
  if (['partner', 'agent', 'droppoint'].includes(role)) await M.Partner.create({ userId: u._id, businessName: str(b.businessName, 100) || u.name, type: { partner: 'COBBLER', agent: 'AGENT', droppoint: 'DROP_POINT' }[role], address: str(b.address, 200), city: str(b.city, 60), pincodes: String(b.pincodes || '').split(',').map((s) => s.trim()).filter(Boolean), status: 'APPROVED' });
  audit(q, 'USER_CREATE', 'User', u._id, null, { role, adminRole: b.adminRole });
  r.json({ id: u._id, email: u.email, role, adminRole: u.adminRole, note: role === 'admin' ? 'Pehle login par temporary password badalna aur 2FA setup karna hoga' : role !== 'customer' ? 'Pehle login par temporary password badalna hoga' : undefined });
}));
R.patch('/admin/users/:id', admin('users:read'), ah(async (q, r) => {
  const u = await M.User.findById(ID(q.params.id));
  if (!u) throw bad('Nahi mila', 404);
  if (u.role === 'admin' && !can(q.user, 'super')) throw bad('Admin user sirf Super admin badal sakta hai', 403);
  if (!can(q.user, 'partners') && !can(q.user, 'super')) throw bad('Permission nahi', 403);
  const set = {};
  if (['active', 'blocked'].includes(q.body.status)) { if (String(u._id) === q.user.id) throw bad('Apne aap ko block nahi kar sakte'); set.status = q.body.status; }
  if (q.body.adminRole && u.role === 'admin' && can(q.user, 'super')) set.adminRole = q.body.adminRole;
  if (q.body.name) set.name = str(q.body.name, 80);
  await M.User.updateOne({ _id: u._id }, set);
  if (set.status === 'blocked') await M.Session.updateMany({ userId: u._id }, { revoked: true });
  dropStatus(u._id);
  audit(q, 'USER_UPDATE', 'User', u._id, { status: u.status, adminRole: u.adminRole }, set);
  r.json({ ok: true });
}));
R.post('/admin/users/:id/wallet', admin('wallet'), ah(async (q, r) => {
  const amt = num(q.body.amount);
  if (!(amt > 0) || !str(q.body.reason)) throw bad('Amount aur reason do');
  const type = q.body.type === 'DEBIT' ? 'DEBIT' : 'CREDIT';
  if (type === 'DEBIT' && (await wallet.balance(q.params.id)) < amt) throw bad('Balance kam hai');
  await (type === 'DEBIT' ? wallet.debit : wallet.credit)(ID(q.params.id), amt, 'ADMIN', { note: str(q.body.reason, 200), createdBy: q.user.id });
  audit(q, 'WALLET_ADJUST', 'User', q.params.id, null, { type, amt, reason: q.body.reason });
  r.json({ balance: await wallet.balance(q.params.id) });
}));

// ---------------- settings, rate card, plans, brands
R.get('/admin/settings', admin('pricing'), ah(async (q, r) => r.json(await S.all())));
R.put('/admin/settings/:key', admin('pricing'), ah(async (q, r) => {
  const old = await S.get(q.params.key);
  const v = await S.set(q.params.key, q.body.value);
  audit(q, 'SETTING_UPDATE', 'Setting', q.params.key, { value: old }, { value: v });
  r.json({ key: q.params.key, value: v });
}));
// partner quote builder ke liye active rate card
R.get('/rates', auth('partner', 'admin'), ah(async (q, r) => r.json(await M.RateItem.find({ active: true }).sort('sort').lean())));
crud(R, '/admin/rates', M.RateItem, { perm: 'pricing', name: 'RateItem', fields: ['code', 'name', 'category', 'description', 'price', 'cap', 'tatDays', 'warrantyDays', 'materials', 'active', 'sort'], search: ['code', 'name'], filters: ['category', 'active'], sort: 'sort', del: false,
  before: (d, q, old) => { if (!old && (!/^[A-Z0-9_]{2,30}$/.test(d.code || '') || !d.name || !(+d.price > 0))) throw bad('code (A-Z0-9_), name, price (>0) zaroori'); if (d.cap !== undefined && +d.cap < +(d.price ?? old?.price)) throw bad('cap price se kam nahi ho sakta'); } });
crud(R, '/admin/plans', M.Plan, { perm: 'pricing', name: 'Plan', fields: ['code', 'name', 'description', 'feePct', 'limit', 'fullDeclared', 'active'], search: ['code', 'name'], del: false });
crud(R, '/admin/brands', M.Brand, { perm: 'brands', name: 'Brand', fields: ['name', 'code', 'contactEmail', 'commissionPct', 'notes', 'active'], search: ['name', 'code'], del: false,
  before: (d, q, old) => { if (!old && (!d.name || !/^[A-Za-z0-9]{3,12}$/.test(d.code || ''))) throw bad('name aur code (3-12 letters/digits) zaroori'); } });
R.get('/admin/audit', admin('super'), ah(async (q, r) => {
  const f = {}; if (q.query.action) f.action = rx(String(q.query.action).slice(0, 40)); if (q.query.actorId) f.actorId = ID(q.query.actorId); if (q.query.entity) f.entity = String(q.query.entity);
  const { limit, skip } = page(q.query);
  r.json(await M.Audit.find(f).sort('-createdAt').skip(skip).limit(limit).lean());
}));

// ---------------- background jobs (manual trigger) + notification queue
R.post('/admin/jobs/run', admin('orders'), ah(async (q, r) => {
  const sla = await O.runSla(), lifecycle = await O.runLifecycle(), notifications = await processQueue();
  r.json({ sla, lifecycle, notifications });
}));
R.get('/admin/notifications', admin('notifications'), ah(async (q, r) => {
  const f = { channel: { $ne: 'inapp' } }; if (q.query.status) f.status = String(q.query.status);
  r.json(await M.Notif.find(f).sort('-createdAt').limit(100).lean());
}));
R.post('/admin/notifications/:id/retry', admin('notifications'), ah(async (q, r) => { await M.Notif.updateOne({ _id: ID(q.params.id), status: 'FAILED' }, { status: 'PENDING', attempts: 0, nextAt: new Date() }); r.json({ ok: true }); }));
module.exports = { router: R, analytics };
