// Razorpay (live) ya mock (dev). Keys na ho to mock mode chalta hai; keys daalte hi live ho jaata hai.
const crypto = require('crypto');
const cfg = require('../config');
const M = require('../models');
const wallet = require('./wallet');
const { notify } = require('./notify');
const { bad, eq } = require('./util');

const live = () => !!(cfg.razorpay.keyId && cfg.razorpay.keySecret);
const rz = async (path, body) => {
  const r = await fetch('https://api.razorpay.com/v1' + path, {
    method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(`${cfg.razorpay.keyId}:${cfg.razorpay.keySecret}`).toString('base64') },
    body: JSON.stringify(body),
  });
  const d = await r.json();
  if (!r.ok) throw bad(d.error?.description || 'Razorpay error', 502);
  return d;
};
async function create({ userId, orderId, shopOrderId, kind, amount, credit = 0, receipt }) {
  const paise = Math.round(amount * 100);
  if (paise < 100) throw bad('Amount bahut kam hai');
  const prov = live() ? (await rz('/orders', { amount: paise, currency: 'INR', receipt })).id : 'mock_' + crypto.randomBytes(6).toString('hex');
  const p = await M.Payment.create({ userId, orderId, shopOrderId, kind, amount, credit, providerOrderId: prov, mock: !live() });
  return { paymentId: p._id, providerOrderId: prov, amount: paise, keyId: cfg.razorpay.keyId || null, mock: !live(), kind };
}
// Idempotent: webhook + verify dono aaye to bhi sirf ek baar apply hota hai
async function markPaid(p, providerPaymentId) {
  const x = await M.Payment.findOneAndUpdate({ _id: p._id, status: { $ne: 'PAID' } }, { status: 'PAID', providerPaymentId }, { new: true });
  if (!x) return false;
  if (x.credit) await wallet.debit(x.userId, x.credit, 'USE', { orderId: x.orderId, key: 'use:' + x._id });
  const gross = x.amount + (x.credit || 0);
  if (x.kind === 'ORDER') {
    const o = await M.Order.findByIdAndUpdate(x.orderId, { paid: true, $inc: { paidAmount: gross } }, { new: true });
    await notify(o.userId, 'PAYMENT_OK', { orderNo: o.orderNo });
  } else if (x.kind === 'EXTRA' || x.kind === 'RETURN_FEE') {
    await M.Order.updateOne({ _id: x.orderId }, { dueExtra: 0, $inc: { paidAmount: gross } });
  } else if (x.kind === 'SHOP') {
    const so = await M.ShopOrder.findOneAndUpdate({ _id: x.shopOrderId, status: 'PENDING' }, { status: 'PAID', $unset: { reservedUntil: 1 } }, { new: true });
    if (so) {
      for (const i of so.items) await M.Product.updateOne({ sku: i.sku }, { $inc: { sold: i.qty } });
      await notify(so.userId, 'SHOP_ORDER_UPDATE', { orderNo: so.orderNo, status: 'PAID', tracking: '' });
    } else await M.ShopOrder.updateOne({ _id: x.shopOrderId, status: 'CANCELLED' }, { note: 'Late payment aaya: refund karna hai' });
  }
  return true;
}
const verifySignature = (providerOrderId, paymentId, sig) =>
  live() && eq(crypto.createHmac('sha256', cfg.razorpay.keySecret).update(providerOrderId + '|' + paymentId).digest('hex'), String(sig || ''));
const verifyWebhook = (raw, sig) =>
  !!(cfg.razorpay.webhookSecret && raw && eq(crypto.createHmac('sha256', cfg.razorpay.webhookSecret).update(raw).digest('hex'), String(sig || '')));
module.exports = { live, rz, create, markPaid, verifySignature, verifyWebhook };
