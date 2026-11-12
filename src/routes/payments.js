const express = require('express');
const cfg = require('../config');
const M = require('../models');
const wallet = require('../lib/wallet');
const P = require('../lib/payments');
const O = require('../lib/orders');
const { auth, admin } = require('../middleware/auth');
const { bad, ah, num, str, page } = require('../lib/util');
const { audit } = require('../lib/audit');
const R = express.Router();

R.post('/payments/create', auth('customer'), ah(async (q, r) => {
  if (!M.mongoose.isValidObjectId(q.body.orderId)) throw bad('Bad id');
  const o = await M.Order.findOne({ _id: q.body.orderId, userId: q.user.id });
  if (!o) throw bad('Order nahi mila', 404);
  let kind, amount;
  if (o.status === 'QUOTE_APPROVED' && !o.paid) { kind = 'ORDER'; amount = O.payable(o); }
  else if (o.status === 'IN_REPAIR' && o.dueExtra > 0) { kind = 'EXTRA'; amount = o.dueExtra; }
  else if (o.status === 'QUOTE_REJECTED' && o.dueExtra > 0) { kind = 'RETURN_FEE'; amount = o.dueExtra; }
  else throw bad('Payment abhi possible nahi hai');
  let credit = 0;
  if (q.body.useCredits) credit = Math.max(0, Math.min(await wallet.balance(q.user.id), amount - 1));
  r.json(await P.create({ userId: q.user.id, orderId: o._id, kind, amount: amount - credit, credit, receipt: o.orderNo }));
}));
// Dev-only: keys ke bina payment simulate karo (production/live mein band)
R.post('/payments/mock-pay', auth(), ah(async (q, r) => {
  if (P.live() || cfg.prod) throw bad('Mock payment band hai', 403);
  const p = await M.Payment.findById(q.body.paymentId);
  if (!p || String(p.userId) !== q.user.id) throw bad('Nahi mila', 404);
  await P.markPaid(p, 'mock_pay_' + Date.now());
  r.json({ ok: true });
}));
R.post('/payments/verify', auth(), ah(async (q, r) => {
  const p = await M.Payment.findById(q.body.paymentId);
  if (!p || String(p.userId) !== q.user.id) throw bad('Nahi mila', 404);
  if (!P.verifySignature(p.providerOrderId, String(q.body.razorpay_payment_id), q.body.razorpay_signature)) throw bad('Signature mismatch');
  await P.markPaid(p, q.body.razorpay_payment_id);
  r.json({ ok: true });
}));
R.post('/payments/webhook', ah(async (q, r) => {
  if (!P.verifyWebhook(q.raw, q.headers['x-razorpay-signature'])) return r.status(400).json({ error: 'bad signature' });
  const pay = q.body.payload?.payment?.entity;
  if (['payment.captured', 'order.paid'].includes(q.body.event) && pay) {
    const p = await M.Payment.findOne({ providerOrderId: pay.order_id });
    if (p) await P.markPaid(p, pay.id);
  }
  r.json({ ok: true });
}));

// ---- admin
R.get('/admin/payments', admin('payments'), ah(async (q, r) => {
  const f = {}; if (q.query.status) f.status = String(q.query.status); if (q.query.kind) f.kind = String(q.query.kind);
  const { limit, skip } = page(q.query);
  r.json(await M.Payment.find(f).sort('-createdAt').skip(skip).limit(limit).lean());
}));
R.post('/admin/payments/:id/refund', admin('payments'), ah(async (q, r) => {
  const p = await M.Payment.findById(q.params.id);
  if (!p || p.status !== 'PAID') throw bad('Paid payment nahi mila');
  const done = p.refunds.reduce((s, x) => s + x.amount, 0), amt = num(q.body.amount);
  if (!(amt > 0) || amt + done > p.amount) throw bad(`Amount invalid (max Rs ${p.amount - done})`);
  let pid = 'wallet';
  if (!q.body.toWallet) pid = P.live() && !p.mock ? (await P.rz(`/payments/${p.providerPaymentId}/refund`, { amount: Math.round(amt * 100) })).id : 'mock';
  else await wallet.credit(p.userId, amt, 'REFUND', { orderId: p.orderId, note: str(q.body.reason, 100), createdBy: q.user.id });
  p.refunds.push({ amount: amt, reason: str(q.body.reason, 200), toWallet: !!q.body.toWallet, providerId: pid });
  await p.save();
  audit(q, 'REFUND', 'Payment', p._id, null, { amount: amt, toWallet: !!q.body.toWallet });
  r.json(p);
}));
// Reconciliation: paid payments vs order/shop records mismatch
R.get('/admin/payments/reconcile', admin('payments'), ah(async (q, r) => {
  const paid = await M.Payment.find({ status: 'PAID' }).lean();
  const issues = [];
  for (const p of paid) {
    if (p.kind === 'ORDER') { const o = await M.Order.findById(p.orderId, 'paid orderNo').lean(); if (!o?.paid) issues.push({ payment: p._id, issue: 'Payment PAID par order.paid false', order: o?.orderNo }); }
    if (p.kind === 'SHOP') { const s = await M.ShopOrder.findById(p.shopOrderId, 'status orderNo').lean(); if (s?.status === 'CANCELLED') issues.push({ payment: p._id, issue: 'Shop order cancelled par payment aaya: refund karo', order: s.orderNo }); }
  }
  const stale = await M.Payment.countDocuments({ status: 'CREATED', createdAt: { $lt: new Date(Date.now() - 864e5) } });
  r.json({ paidCount: paid.length, staleCreated: stale, issues });
}));
module.exports = R;
