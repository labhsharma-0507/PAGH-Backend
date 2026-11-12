const express = require('express');
const M = require('../models');
const S = require('../lib/settings');
const wallet = require('../lib/wallet');
const P = require('../lib/payments');
const O = require('../lib/orders');
const { auth, admin, can } = require('../middleware/auth');
const { bad, ah, clean, str, num, orderNo, otp4, token, limiter, page } = require('../lib/util');
const { saveImages } = require('../lib/storage');
const { notify, notifyAdmins } = require('../lib/notify');
const { audit } = require('../lib/audit');
const R = express.Router();
const TYPES = ['damage', 'loss', 'delay', 'warranty', 'other'];
const CF = { SUBMITTED: ['UNDER_REVIEW'], UNDER_REVIEW: ['INFO_NEEDED', 'APPROVED', 'PARTIALLY_APPROVED', 'REJECTED'], INFO_NEEDED: ['UNDER_REVIEW'], APPROVED: ['SETTLED'], PARTIALLY_APPROVED: ['SETTLED'] };

async function cover(o) {
  const plan = o.plan ? await M.Plan.findOne({ code: o.plan }).lean() : null;
  const dep = +(await S.get('depreciation')), depreciated = Math.round((o.declaredValue || 0) * (1 - dep));
  return { plan: plan?.code || null, declared: o.declaredValue || 0, depreciated, maxCompensation: plan ? (plan.fullDeclared ? depreciated : Math.min(depreciated, plan.limit || 0)) : 0 };
}

R.post('/claims', auth('customer'), limiter(60e3, 10), ah(async (q, r) => {
  if (!M.mongoose.isValidObjectId(q.body.orderId)) throw bad('Bad id');
  const o = await M.Order.findOne({ _id: q.body.orderId, userId: q.user.id });
  if (!o) throw bad('Order nahi mila', 404);
  const type = String(q.body.type);
  if (!TYPES.includes(type)) throw bad('Claim type invalid');
  if (['BOOKED', 'CANCELLED'].includes(o.status)) throw bad('Jootein abhi humare paas nahi aaye, claim nahi ho sakta');
  if (type === 'warranty') {
    const w = await M.Warranty.findOne({ orderId: o._id });
    if (!w || w.endDate < Date.now()) throw bad('Warranty active nahi hai');
  }
  if (type === 'delay' && !(o.committedDate && o.committedDate < Date.now())) throw bad('Abhi deadline nikli nahi hai (delay claim nahi ban sakta)');
  if (await M.Claim.exists({ orderId: o._id, type, status: { $in: O.OPEN_CLAIM } })) throw bad('Is order par ye claim pehle se open hai', 409);
  const text = str(q.body.text, 1000);
  if (text.length < 5) throw bad('Problem likho (kam se kam 5 characters)');
  const evidence = q.body.evidence?.length ? await saveImages(q.body.evidence, 'claim', { min: 1, max: 6 }) : [];
  const c = await M.Claim.create({ claimNo: orderNo('CL'), orderId: o._id, userId: q.user.id, type, text, evidence });
  await M.Payout.updateMany({ orderId: o._id, status: 'PENDING' }, { status: 'HOLD' }); // claim ke dauran payout hold
  await notifyAdmins('CLAIM_UPDATE', { claimNo: c.claimNo, status: 'SUBMITTED', notes: type }, 'claims:review');
  r.json(c);
}));
R.get('/claims', auth('customer'), ah(async (q, r) => r.json(await M.Claim.find({ userId: q.user.id }).sort('-createdAt').lean())));
R.post('/claims/:id/info', auth('customer'), ah(async (q, r) => {
  const c = await M.Claim.findOne({ _id: q.params.id, userId: q.user.id });
  if (!c || c.status !== 'INFO_NEEDED') throw bad('Claim mein abhi info nahi maangi gayi');
  if (q.body.evidence?.length) c.evidence = [...c.evidence, ...(await saveImages(q.body.evidence, 'claim', { min: 1, max: 6 }))].slice(0, 12);
  c.text = (c.text + '\n[Customer]: ' + str(q.body.text, 500)).slice(0, 2000); c.status = 'UNDER_REVIEW';
  await c.save();
  r.json(c);
}));

// ---------------- admin
R.get('/admin/claims', admin('claims:review'), ah(async (q, r) => {
  const f = {}; if (q.query.status) f.status = String(q.query.status);
  const { limit, skip } = page(q.query);
  r.json(await M.Claim.find(f).sort('-createdAt').skip(skip).limit(limit).lean());
}));
R.get('/admin/claims/reserve', admin('claims:review'), ah(async (q, r) => {
  const paid = (await M.Claim.find({ status: 'SETTLED' }).lean()).filter((c) => c.settlement !== 'REDO').reduce((s, c) => s + (c.amount || 0), 0);
  const sla = (await M.Ledger.find({ reason: 'SLA' }).lean()).reduce((s, x) => s + x.amount, 0);
  const revenue = (await M.Order.find({}, 'paidAmount').lean()).reduce((s, o) => s + (o.paidAmount || 0), 0);
  const pct = +(await S.get('reservePct')), reserve = Math.round((revenue * pct) / 100), used = paid + sla;
  r.json({ revenue, reservePct: pct, reserve, claimsPaid: paid, slaCredits: sla, used, remaining: reserve - used, healthy: used <= reserve });
}));
R.get('/admin/claims/:id/detail', admin('claims:review'), ah(async (q, r) => {
  const c = await M.Claim.findById(q.params.id).lean();
  if (!c) throw bad('Nahi mila', 404);
  const o = await M.Order.findById(c.orderId, '-pickupOtp -deliveryOtp').lean();
  const [cond, custody, job, quotes, payments, warranty] = await Promise.all([
    M.Cond.findOne({ orderId: o._id }).lean(), M.Custody.find({ orderId: o._id }).sort('createdAt').lean(), M.Job.findOne({ orderId: o._id }).lean(),
    M.Quote.find({ orderId: o._id }).lean(), M.Payment.find({ orderId: o._id }).lean(), M.Warranty.findOne({ orderId: o._id }).lean(),
  ]);
  r.json({ claim: c, order: o, condition: cond, custody, milestones: job?.milestones || [], quotes, payments, warranty, cover: await cover(o), user: await M.User.findById(c.userId, 'name email phone').lean() });
}));
R.patch('/admin/claims/:id', admin('claims:review'), ah(async (q, r) => {
  const c = await M.Claim.findById(q.params.id);
  if (!c) throw bad('Nahi mila', 404);
  const to = String(q.body.status);
  if (!(CF[c.status] || []).includes(to)) throw bad(`${c.status} se ${to} allowed nahi`);
  if (to === 'SETTLED' && !can(q.user, 'claims:settle')) throw bad('Settlement sirf Finance/Super admin kar sakta hai', 403);
  const o = await M.Order.findById(c.orderId);
  const before = c.toObject();
  if (['APPROVED', 'PARTIALLY_APPROVED'].includes(to)) {
    const s = String(q.body.settlement);
    if (!['REDO', 'REFUND', 'CREDIT', 'COMPENSATION'].includes(s)) throw bad('Settlement type chuno: REDO / REFUND / CREDIT / COMPENSATION');
    if (s === 'REDO' && c.type !== 'warranty') throw bad('REDO sirf warranty claim ke liye hai');
    c.settlement = s;
    if (s !== 'REDO') {
      const amt = num(q.body.amount);
      if (!(amt > 0)) throw bad('Amount do');
      const cv = await cover(o);
      if (['damage', 'loss'].includes(c.type) && ['COMPENSATION', 'CREDIT'].includes(s) && amt > cv.maxCompensation) throw bad(`Cover limit Rs ${cv.maxCompensation} hai (plan: ${cv.plan || 'koi nahi'}). Isse upar ke liye Super admin override.`);
      if (s === 'REFUND' && amt > o.paidAmount) throw bad(`Refund paid amount (Rs ${o.paidAmount}) se zyada nahi ho sakta`);
      c.amount = amt;
    }
  }
  if (q.body.notes !== undefined) c.notes = str(q.body.notes, 500);
  c.status = to; c.reviewerId = q.user.id;
  if (to === 'SETTLED') await settle(c, o, q);
  await c.save();
  if (['REJECTED', 'SETTLED'].includes(to)) await O.releaseHeldPayouts(c.orderId);
  await notify(c.userId, 'CLAIM_UPDATE', { claimNo: c.claimNo, status: to, notes: c.notes || '' });
  audit(q, 'CLAIM_' + to, 'Claim', c._id, before, c.toObject());
  r.json(c);
}));

async function settle(c, o, q) {
  c.settledAt = new Date();
  if (c.settlement === 'CREDIT' || c.settlement === 'COMPENSATION') await wallet.credit(c.userId, c.amount, 'CLAIM', { orderId: o._id, claimId: c._id, key: 'claim:' + c._id, createdBy: q.user.id });
  else if (c.settlement === 'REFUND') {
    const p = await M.Payment.findOne({ orderId: o._id, kind: 'ORDER', status: 'PAID' });
    const done = p ? p.refunds.reduce((s, x) => s + x.amount, 0) : 0;
    if (!p || c.amount + done > p.amount) await wallet.credit(c.userId, c.amount, 'REFUND', { orderId: o._id, claimId: c._id, key: 'claim:' + c._id, note: 'Refund wallet mein (original payment se possible nahi)' });
    else {
      const pid = P.live() && !p.mock ? (await P.rz(`/payments/${p.providerPaymentId}/refund`, { amount: Math.round(c.amount * 100) })).id : 'mock';
      p.refunds.push({ amount: c.amount, reason: 'Claim ' + c.claimNo, providerId: pid }); await p.save();
    }
  } else if (c.settlement === 'REDO') {
    const n = await M.Order.create({
      orderNo: orderNo('RW'), userId: o.userId, shoeId: o.shoeId, shoe: o.shoe, declaredValue: o.declaredValue, plan: o.plan, address: o.address, addressId: o.addressId, pincode: o.pincode,
      pickupMode: o.pickupMode, dropPointId: o.dropPointId, partnerId: o.partnerId, rework: true, parentOrderId: o._id, paid: true, total: 0, fees: { delivery: 0, express: 0, protection: 0 },
      qrId: 'QR' + token(5).toUpperCase(), pickupOtp: otp4(), deliveryOtp: otp4(), events: [{ to: 'BOOKED', by: 'system', note: 'Warranty redo for ' + o.orderNo }],
    });
    c.redoOrderId = n._id;
    await M.Job.updateOne({ orderId: o._id }, { rework: true });
    await notify(c.userId, 'WARRANTY_REDO', { orderNo: n.orderNo });
  }
}
module.exports = { router: R, cover };
