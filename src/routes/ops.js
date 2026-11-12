// Partner (cobbler/hub), Agent, Drop-point, Brand panels + batches + payouts + serviceability
const express = require('express');
const M = require('../models');
const S = require('../lib/settings');
const O = require('../lib/orders');
const { auth, admin, dropStatus } = require('../middleware/auth');
const { bad, ah, clean, str, num, csv, page, limiter } = require('../lib/util');
const { saveImages } = require('../lib/storage');
const { notify } = require('../lib/notify');
const { audit } = require('../lib/audit');
const { pub } = require('./orders');
const R = express.Router();
const ID = (v) => { if (!M.mongoose.isValidObjectId(v)) throw bad('Bad id'); return v; };
const ROLE_OF = { COBBLER: 'partner', HUB: 'partner', DROP_POINT: 'droppoint', AGENT: 'agent' };

// ---------------- onboarding (apply -> admin approval)
R.post('/partners/apply', auth('customer'), limiter(60 * 60e3, 5), ah(async (q, r) => {
  if (await M.Partner.findOne({ userId: q.user.id, status: { $in: ['PENDING', 'APPROVED'] } })) throw bad('Application pehle se hai', 409);
  const type = String(q.body.type);
  if (!ROLE_OF[type]) throw bad('Type chuno: COBBLER / HUB / DROP_POINT / AGENT');
  const businessName = str(q.body.businessName, 100);
  if (businessName.length < 2) throw bad('Business/naam likho');
  const pincodes = String(q.body.pincodes || '').split(',').map((s) => s.trim()).filter((s) => /^\d{6}$/.test(s));
  if (type !== 'AGENT' && !pincodes.length) throw bad('Kam se kam ek 6-digit pincode do');
  const docs = q.body.docs?.length ? await saveImages(q.body.docs, 'partner', { min: 1, max: 4 }) : [];
  r.json(await M.Partner.create({ userId: q.user.id, businessName, type, address: str(q.body.address, 200), city: str(q.body.city, 60), pincodes, docs, capacity: num(q.body.capacity) || undefined }));
}));
R.get('/partners/me', auth(), ah(async (q, r) => r.json(await M.Partner.findOne({ userId: q.user.id }).sort('-createdAt').lean())));
R.get('/admin/partners', admin('partners'), ah(async (q, r) => {
  const f = {}; if (q.query.status) f.status = String(q.query.status); if (q.query.type) f.type = String(q.query.type);
  const list = await M.Partner.find(f).sort('-createdAt').limit(200).lean();
  const users = await M.User.find({ _id: { $in: list.map((p) => p.userId) } }, 'name email phone').lean();
  r.json(list.map((p) => ({ ...p, user: users.find((u) => String(u._id) === String(p.userId)) })));
}));
R.post('/admin/partners/:id/decision', admin('partners'), ah(async (q, r) => {
  const p = await M.Partner.findById(ID(q.params.id));
  if (!p) throw bad('Nahi mila', 404);
  const before = p.toObject();
  p.status = q.body.approve ? 'APPROVED' : q.body.suspend ? 'SUSPENDED' : 'REJECTED';
  if (q.body.commissionPct !== undefined) { const c = num(q.body.commissionPct, -1); if (c < 0 || c > 100) throw bad('Commission 0-100'); p.commissionPct = c; }
  await p.save();
  const u = await M.User.findById(p.userId);
  if (u && u.role !== 'admin') {
    u.role = p.status === 'APPROVED' ? ROLE_OF[p.type] : 'customer';
    await u.save();
    dropStatus(u._id); // role DB se live padha jaata hai, isliye naya role turant lagu (re-login ki zaroorat nahi)
    await notify(u._id, 'PARTNER_DECISION', { status: p.status, next: p.status === 'APPROVED' ? 'Ab aapko apna panel mil gaya hai (menu mein "Mera panel").' : 'Zyada jaankari ke liye support se baat karo.' });
  }
  audit(q, 'PARTNER_' + p.status, 'Partner', p._id, before, p.toObject());
  r.json(p);
}));
R.patch('/admin/partners/:id', admin('partners'), ah(async (q, r) => {
  const b = clean(q.body), set = {};
  for (const k of ['businessName', 'address', 'city']) if (b[k] !== undefined) set[k] = str(b[k], 150);
  if (b.pincodes !== undefined) set.pincodes = String(b.pincodes).split(',').map((s) => s.trim()).filter(Boolean);
  if (b.capacity !== undefined) set.capacity = num(b.capacity);
  if (b.commissionPct !== undefined) set.commissionPct = num(b.commissionPct);
  r.json(await M.Partner.findByIdAndUpdate(ID(q.params.id), set, { new: true }));
}));

// ---------------- scorecard
async function scorecard(userId) {
  const orders = await M.Order.find({ partnerId: userId, rework: { $ne: true } }, 'status committedDate deliveredAt events').lean();
  const done = orders.filter((o) => o.deliveredAt);
  const timed = done.filter((o) => o.committedDate);
  const onTime = timed.filter((o) => { const ready = o.events.find((e) => e.to === 'READY'); return ready && new Date(ready.ts) <= new Date(o.committedDate); }).length; // hub-controlled SLA: READY tak
  const ids = orders.map((o) => o._id);
  const reworks = await M.Job.countDocuments({ orderId: { $in: ids }, rework: true });
  const claims = await M.Claim.countDocuments({ orderId: { $in: ids } });
  const rv = await M.Review.find({ partnerId: userId }).lean();
  const avg = (k) => (rv.length ? +(rv.reduce((s, x) => s + x[k], 0) / rv.length).toFixed(2) : null);
  return {
    jobs: orders.length, delivered: done.length, onTimePct: timed.length ? Math.round((onTime * 100) / timed.length) : null,
    reworkRatePct: done.length ? Math.round((reworks * 100) / done.length) : null, claims, ratingQuality: avg('quality'), ratingComms: avg('communication'), reviews: rv.length,
  };
}
R.get('/partner/scorecard', auth('partner'), ah(async (q, r) => r.json(await scorecard(q.user.id))));
R.get('/admin/partners/:id/scorecard', admin('partners'), ah(async (q, r) => { const p = await M.Partner.findById(ID(q.params.id)); r.json(await scorecard(p.userId)); }));

// ---------------- partner panel
const JOB_STATUSES = ['AT_HUB', 'CONDITION_CONFIRMED', 'QUOTE_SENT', 'QUOTE_APPROVED', 'IN_REPAIR', 'QC', 'READY', 'QUOTE_REJECTED', 'NOT_REPAIRABLE', 'RETURN_READY'];
R.get('/partner/jobs', auth('partner', 'admin'), ah(async (q, r) => {
  let f;
  if (q.user.role === 'admin') f = { status: { $in: JOB_STATUSES } };
  else {
    const me = await M.Partner.findOne({ userId: q.user.id, status: 'APPROVED' }).lean();
    f = { $or: [{ partnerId: q.user.id, status: { $in: JOB_STATUSES } }, { partnerId: null, status: { $in: ['PICKED_UP', 'AT_HUB'] }, ...(me?.pincodes?.length ? { pincode: { $in: me.pincodes } } : {}) }] };
  }
  const list = await M.Order.find(f).sort('-createdAt').limit(100);
  const ids = list.map((o) => o._id);
  const conds = await M.Cond.find({ orderId: { $in: ids } }, 'orderId grade lockedAt disputedReason customerPhotos preExisting').lean();
  r.json(list.map((o) => ({ ...pub(o, q), condition: conds.find((c) => String(c.orderId) === String(o._id)) })));
}));
R.post('/partner/jobs/:id/accept', auth('partner'), ah(async (q, r) => {
  const me = await M.Partner.findOne({ userId: q.user.id, status: 'APPROVED' }).lean();
  if (me?.capacity) {
    const active = await M.Order.countDocuments({ partnerId: q.user.id, status: { $in: ['AT_HUB', 'CONDITION_CONFIRMED', 'QUOTE_SENT', 'QUOTE_APPROVED', 'IN_REPAIR', 'QC'] } });
    if (active >= me.capacity) throw bad(`Aapki capacity (${me.capacity}) full hai`);
  }
  const o = await M.Order.findOneAndUpdate({ _id: ID(q.params.id), partnerId: null, status: { $in: ['PICKED_UP', 'AT_HUB'] } }, { partnerId: q.user.id }, { new: true });
  if (!o) throw bad('Job pehle hi assign ho chuka hai');
  await M.Job.updateOne({ orderId: o._id }, { $setOnInsert: { orderId: o._id, partnerId: q.user.id } }, { upsert: true });
  r.json(pub(o, q));
}));
R.post('/partner/jobs/:id/milestone', auth('partner', 'admin'), ah(async (q, r) => {
  const o = await M.Order.findById(ID(q.params.id));
  if (!o) throw bad('Nahi mila', 404);
  if (q.user.role === 'partner' && String(o.partnerId) !== q.user.id) throw bad('Job aapka nahi hai', 403);
  const t = String(q.body.type);
  if (!['INTAKE', 'QUOTE_BASIS', 'FINAL_QC'].includes(t)) throw bad('Milestone type galat (INTAKE / QUOTE_BASIS / FINAL_QC)');
  const photos = await saveImages(q.body.photos, 'milestone', { min: 1, max: 4 });
  const j = await M.Job.findOneAndUpdate({ orderId: o._id }, { $setOnInsert: { partnerId: o.partnerId }, $push: { milestones: { type: t, photos, note: str(q.body.note, 200) } } }, { upsert: true, new: true });
  r.json({ milestones: j.milestones.length });
}));
R.get('/partner/earnings', auth('partner'), ah(async (q, r) => {
  const me = await M.Partner.findOne({ userId: q.user.id }).lean();
  const l = me ? await M.Payout.find({ payeeType: 'PARTNER', userId: q.user.id }).sort('-createdAt').lean() : [];
  const sum = (s) => l.filter((x) => x.status === s).reduce((a, x) => a + x.amount + (x.adjustments || []).reduce((t, y) => t + y.amount, 0), 0);
  r.json({ pending: sum('PENDING'), onHold: sum('HOLD'), paid: sum('PAID'), payouts: l });
}));

// ---------------- agent
R.get('/agent/tasks', auth('agent', 'admin'), ah(async (q, r) => {
  const mine = q.user.role === 'agent' ? { $or: [{ agentId: q.user.id }, { agentId: null }] } : {};
  const list = await M.Order.find({ ...mine, status: { $in: ['BOOKED', 'PICKED_UP', 'READY', 'RETURN_READY', 'OUT_FOR_DELIVERY'] } }).sort('pincode createdAt').limit(200);
  const ap = new Set((await M.Custody.find({ orderId: { $in: list.map((o) => o._id) }, type: 'AGENT_PICKUP' }, 'orderId').lean()).map((c) => String(c.orderId)));
  const tasks = [];
  for (const o of list) {
    let task;
    if (o.status === 'BOOKED') task = o.pickupMode === 'PICKUP' ? 'PICKUP' : null; // drop-point order mein customer khud drop-point par jaata hai
    else if (o.status === 'PICKED_UP') task = o.pickupMode === 'DROPPOINT' && !ap.has(String(o._id)) ? 'COLLECT_FROM_DROPPOINT' : 'HUB_DROP';
    else if (['READY', 'RETURN_READY'].includes(o.status)) task = 'START_DELIVERY';
    else task = o.pickupMode === 'DROPPOINT' ? 'AT_DROPPOINT_AWAIT_CUSTOMER' : 'DELIVERY';
    if (task) tasks.push({ ...pub(o, q), task, batchKey: `${o.pincode}|${o.slot || 'any'}` });
  }
  r.json(tasks);
}));

// ---------------- drop-point
R.get('/droppoint/orders', auth('droppoint'), ah(async (q, r) => {
  const dp = await M.Partner.findOne({ userId: q.user.id, type: 'DROP_POINT', status: 'APPROVED' }).lean();
  if (!dp) throw bad('Drop-point approved nahi hai', 403);
  const list = await M.Order.find({ dropPointId: dp._id, status: { $in: ['BOOKED', 'PICKED_UP', 'OUT_FOR_DELIVERY'] } }).sort('-createdAt').limit(100);
  const users = await M.User.find({ _id: { $in: list.map((o) => o.userId) } }, 'name').lean();
  r.json(list.map((o) => ({ ...pub(o, q), customer: (users.find((u) => String(u._id) === String(o.userId))?.name || '').split(' ')[0], expect: o.status === 'BOOKED' ? 'CUSTOMER_DROPS_SHOES' : o.status === 'PICKED_UP' ? 'AGENT_COLLECTS' : 'CUSTOMER_COLLECTS' })));
}));
R.get('/serviceability/:pin', auth(), ah(async (q, r) => {
  const pin = String(q.params.pin);
  if (!/^\d{6}$/.test(pin)) throw bad('6-digit pincode do');
  const list = await S.get('pincodes');
  const dps = await M.Partner.find({ type: 'DROP_POINT', status: 'APPROVED', pincodes: pin }, 'businessName address city').lean();
  r.json({ pickup: !list.length || list.includes(pin), dropPoints: dps.map((d) => ({ id: d._id, name: d.businessName, address: d.address, city: d.city })) });
}));

// ---------------- brand (B2B) panel
const brandOf = async (q) => { const u = await M.User.findById(q.user.id, 'brandId').lean(); if (!u?.brandId) throw bad('Brand account link nahi hai', 403); return M.Brand.findById(u.brandId).lean(); };
R.get('/brand/summary', auth('brand'), ah(async (q, r) => {
  const b = await brandOf(q), orders = await M.Order.find({ brandId: b._id }, 'status total paidAmount deliveredAt').lean();
  const pay = await M.Payout.find({ payeeType: 'BRAND', payeeId: b._id }).lean();
  r.json({ brand: { name: b.name, code: b.code, commissionPct: b.commissionPct }, orders: orders.length, delivered: orders.filter((o) => o.deliveredAt).length, revenue: orders.reduce((s, o) => s + (o.paidAmount || 0), 0), commissionPending: pay.filter((p) => p.status !== 'PAID').reduce((s, p) => s + p.amount, 0), commissionPaid: pay.filter((p) => p.status === 'PAID').reduce((s, p) => s + p.amount, 0) });
}));
R.get('/brand/orders', auth('brand'), ah(async (q, r) => {
  const b = await brandOf(q), l = await M.Order.find({ brandId: b._id }, 'orderNo status total shoe createdAt deliveredAt').sort('-createdAt').limit(200).lean();
  r.json(l);
}));

// ---------------- batches (agent route planning)
R.get('/admin/batches', admin('batches'), ah(async (q, r) => r.json(await M.Batch.find().sort('-createdAt').limit(100).lean())));
R.post('/admin/batches', admin('batches'), ah(async (q, r) => {
  const agent = await M.User.findOne({ _id: ID(q.body.agentId), role: 'agent', status: 'active' });
  if (!agent) throw bad('Agent nahi mila');
  const ids = (q.body.orderIds || []).map(ID);
  if (!ids.length) throw bad('Orders chuno');
  const b = await M.Batch.create({ agentId: agent._id, orderIds: ids, slot: str(q.body.slot, 60), note: str(q.body.note, 200) });
  await M.Order.updateMany({ _id: { $in: ids }, status: { $in: ['BOOKED', 'PICKED_UP', 'READY', 'RETURN_READY', 'OUT_FOR_DELIVERY'] } }, { agentId: agent._id, batchId: b._id });
  audit(q, 'BATCH_CREATE', 'Batch', b._id, null, { orders: ids.length });
  r.json(b);
}));
R.delete('/admin/batches/:id', admin('batches'), ah(async (q, r) => {
  await M.Order.updateMany({ batchId: ID(q.params.id) }, { $unset: { agentId: 1, batchId: 1 } });
  await M.Batch.updateOne({ _id: q.params.id }, { status: 'CANCELLED' });
  r.json({ ok: true });
}));

// ---------------- payouts (finance)
R.get('/admin/payouts', admin('payouts'), ah(async (q, r) => {
  const f = {}; if (q.query.status) f.status = String(q.query.status); if (q.query.payeeType) f.payeeType = String(q.query.payeeType);
  const { limit, skip } = page(q.query);
  const list = await M.Payout.find(f).sort('-createdAt').skip(skip).limit(limit).lean();
  const orders = await M.Order.find({ _id: { $in: list.map((p) => p.orderId) } }, 'orderNo').lean();
  const rows = list.map((p) => ({ ...p, orderNo: orders.find((o) => String(o._id) === String(p.orderId))?.orderNo, net: p.amount + (p.adjustments || []).reduce((s, a) => s + a.amount, 0) }));
  if (q.query.format === 'csv') return r.type('text/csv').send(csv(rows.map((p) => ({ id: p._id, orderNo: p.orderNo, payeeType: p.payeeType, gross: p.gross, pct: p.pct, net: p.net, status: p.status, reference: p.reference || '' }))));
  r.json(rows);
}));
// NOTE: asli bank transfer platform ke bahar hota hai (RazorpayX/NEFT). Yahan reference record hota hai.
R.post('/admin/payouts/:id/release', admin('payouts'), ah(async (q, r) => {
  const p = await M.Payout.findOneAndUpdate({ _id: ID(q.params.id), status: 'PENDING' }, { status: 'PAID', reference: str(q.body.reference, 80) || 'manual', releasedAt: new Date() }, { new: true });
  if (!p) throw bad('Payout PENDING nahi hai (HOLD par ho to claim resolve karo)');
  audit(q, 'PAYOUT_RELEASE', 'Payout', p._id, null, { amount: p.amount, reference: p.reference });
  const o = await M.Order.findById(p.orderId, 'orderNo').lean();
  if (p.userId) await notify(p.userId, 'PAYOUT_PAID', { orderNo: o?.orderNo, amount: p.amount, reference: p.reference });
  r.json(p);
}));
R.post('/admin/payouts/:id/chargeback', admin('payouts'), ah(async (q, r) => {
  const amt = num(q.body.amount);
  if (!(amt > 0) || !str(q.body.reason)) throw bad('Amount aur reason do');
  const p = await M.Payout.findById(ID(q.params.id));
  if (!p || p.status === 'PAID') throw bad('Paid payout par chargeback nahi (adjustment next payout mein karo)');
  p.adjustments.push({ amount: -amt, reason: str(q.body.reason, 200) }); await p.save();
  audit(q, 'PAYOUT_CHARGEBACK', 'Payout', p._id, null, { amount: -amt });
  r.json(p);
}));
module.exports = { router: R, scorecard };
