// Order ka poora lifecycle: status machine, fees, hold/resume, payouts, SLA engine, background lifecycle jobs.
const M = require('../models');
const S = require('./settings');
const wallet = require('./wallet');
const { notify, notifyAdmins } = require('./notify');
const { bad, DAY, HOUR } = require('./util');

const FLOW = {
  BOOKED: ['PICKED_UP', 'CANCELLED'],
  PICKED_UP: ['AT_HUB'],
  AT_HUB: ['CONDITION_CONFIRMED', 'NOT_REPAIRABLE'],
  CONDITION_CONFIRMED: ['QUOTE_SENT', 'NOT_REPAIRABLE', 'IN_REPAIR'], // IN_REPAIR sirf rework (warranty redo) order ke liye
  QUOTE_SENT: ['QUOTE_APPROVED', 'QUOTE_REJECTED'],
  QUOTE_APPROVED: ['IN_REPAIR'],
  IN_REPAIR: ['QC'],
  QC: ['READY', 'IN_REPAIR'],
  READY: ['OUT_FOR_DELIVERY'],
  OUT_FOR_DELIVERY: ['DELIVERED'],
  DELIVERED: ['CLOSED'],
  QUOTE_REJECTED: ['RETURN_READY'],
  NOT_REPAIRABLE: ['RETURN_READY'],
  RETURN_READY: ['OUT_FOR_DELIVERY'],
};
const SLA_ACTIVE = ['QUOTE_APPROVED', 'IN_REPAIR', 'QC', 'READY']; // OUT_FOR_DELIVERY (courier) SLA mein nahi ginte
const HOLD_REASONS = ['PARTS_DELAY', 'FORCE_MAJEURE', 'CUSTOMER_REQUEST', 'EXTRA_WORK_APPROVAL'];
const OPEN_CLAIM = ['SUBMITTED', 'UNDER_REVIEW', 'INFO_NEEDED', 'APPROVED', 'PARTIALLY_APPROVED'];

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '');

async function afterMove(o, to, meta) {
  const data = {
    orderNo: o.orderNo, status: to, reason: meta.note || '', hours: await S.get('conditionDisputeHours'), committed: fmtDate(o.committedDate),
    deliveryOtp: to === 'OUT_FOR_DELIVERY' ? o.deliveryOtp : undefined, warrantyDays: await S.get('warrantyDays'),
  };
  await notify(o.userId, 'STATUS_' + to, data).catch((e) => console.error('notify', e.message));
  if (to === 'DELIVERED') {
    const days = o.rework ? +(await S.get('warrantyDays')) : (await M.Quote.findOne({ orderId: o._id, status: 'APPROVED' }).sort('-createdAt'))?.warrantyDays || (await S.get('warrantyDays'));
    await M.Warranty.updateOne(
      { orderId: o._id },
      { $setOnInsert: { orderId: o._id, startDate: new Date(), endDate: new Date(Date.now() + days * DAY), days, scope: 'Workmanship: glue/stitch dobara fail hona', exclusions: 'Naya damage, normal wear, aur condition report mein pehle se note ki gayi cheezein' } },
      { upsert: true },
    );
    await createPayouts(o);
  }
}

// Atomic status change: do agents ek saath scan karein to bhi sirf ek jeetega (status filter ke saath update)
async function move(o, to, { by = 'system', byId, note, extra = {} } = {}, force = false) {
  if (!force && !(FLOW[o.status] || []).includes(to)) throw bad(`${o.status} se ${to} allowed nahi`);
  const set = { status: to, ...extra };
  if (to === 'DELIVERED') set.deliveredAt = new Date();
  if (to === 'CLOSED') set.closedAt = new Date();
  const r = await M.Order.findOneAndUpdate(
    { _id: o._id, status: o.status },
    { $set: set, $push: { events: { from: o.status, to, by, byId, note, ts: new Date() } } },
    { new: true },
  );
  if (!r) throw bad('Order ka status abhi badal chuka hai, refresh karo', 409);
  await afterMove(r, to, { note });
  return r;
}

// ---- fees (quote approve hone par lock hote hain)
async function computeFees(o) {
  if (o.rework) return { delivery: 0, express: 0, protection: 0 };
  const plan = o.plan ? await M.Plan.findOne({ code: o.plan, active: true }).lean() : null;
  const freeAbove = await S.get('freeDeliveryAbove');
  return {
    delivery: o.pickupMode === 'PICKUP' && o.total < freeAbove ? await S.get('deliveryFee') : 0,
    express: o.express ? await S.get('expressFee') : 0,
    protection: plan ? Math.round(((o.declaredValue || 0) * (plan.feePct || 0)) / 100) : 0,
  };
}
const payable = (o) => o.total + (o.fees?.delivery || 0) + (o.fees?.express || 0) + (o.fees?.protection || 0);

// ---- hold / resume (SLA pause)
async function hold(o, reason, note, by) {
  if (!HOLD_REASONS.includes(reason)) throw bad('Hold reason invalid');
  if (o.hold?.active) throw bad('Order pehle se hold par hai');
  if (!SLA_ACTIVE.includes(o.status)) throw bad('Is stage par hold ka matlab nahi');
  const r = await M.Order.findOneAndUpdate({ _id: o._id, 'hold.active': { $ne: true } }, { $set: { hold: { active: true, reason, note, since: new Date() } }, $push: { events: { from: o.status, to: o.status, by, note: 'HOLD: ' + reason + (note ? ' - ' + note : '') } } }, { new: true });
  if (!r) throw bad('Order pehle se hold par hai', 409);
  await notify(o.userId, 'ORDER_ON_HOLD', { orderNo: o.orderNo, reason: `${reason}${note ? ': ' + note : ''}` });
  return r;
}
async function resume(o, by) {
  if (!o.hold?.active) throw bad('Order hold par nahi hai');
  const paused = Date.now() - +new Date(o.hold.since);
  const set = { 'hold.active': false };
  if (o.committedDate) set.committedDate = new Date(+new Date(o.committedDate) + paused); // deadline pause ke barabar aage
  return M.Order.findOneAndUpdate({ _id: o._id }, { $set: set, $push: { events: { from: o.status, to: o.status, by, note: `RESUME (${Math.round(paused / HOUR)}h pause)` } } }, { new: true });
}

// ---- payouts (delivery OTP ke baad). Open claim ho to HOLD.
async function createPayouts(o) {
  if (o.rework) return;
  const hasClaim = await M.Claim.exists({ orderId: o._id, status: { $in: OPEN_CLAIM } });
  const status = hasClaim ? 'HOLD' : 'PENDING';
  const total = o.total || 0;
  const mk = async (payeeType, payeeId, userId, pct) => {
    if (!payeeId || !(pct >= 0)) return;
    const amount = Math.round((total * pct) / 100);
    if (!amount) return;
    await M.Payout.updateOne({ orderId: o._id, payeeType }, { $setOnInsert: { orderId: o._id, payeeType, payeeId, userId, gross: total, pct, amount, status } }, { upsert: true });
  };
  if (o.partnerId) {
    const p = await M.Partner.findOne({ userId: o.partnerId }).lean();
    const commission = p?.commissionPct ?? (await S.get('platformCommissionPct'));
    await mk('PARTNER', p?._id || o.partnerId, o.partnerId, 100 - commission);
  }
  if (o.dropPointId) {
    const dp = await M.Partner.findById(o.dropPointId).lean();
    await mk('DROPPOINT', dp?._id, dp?.userId, await S.get('dropPointPct'));
  }
  if (o.brandId) {
    const b = await M.Brand.findById(o.brandId).lean();
    if (b?.active) await mk('BRAND', b._id, undefined, b.commissionPct || 0);
  }
}
async function releaseHeldPayouts(orderId) {
  if (await M.Claim.exists({ orderId, status: { $in: OPEN_CLAIM } })) return;
  await M.Payout.updateMany({ orderId, status: 'HOLD' }, { status: 'PENDING' });
}

// ---- SLA engine: hub-controlled delay par per-day auto credit (idempotent: ledger key unique)
async function runSla() {
  const perDay = +(await S.get('slaCreditPerDay')), capPct = +(await S.get('slaCapPct'));
  const list = await M.Order.find({ status: { $in: SLA_ACTIVE }, committedDate: { $lt: new Date() }, 'hold.active': { $ne: true } });
  let credited = 0;
  for (const o of list) {
    const days = Math.floor((Date.now() - +o.committedDate) / DAY);
    if (days <= o.slaCreditedDays) continue;
    const cap = Math.round(((o.total || 0) * capPct) / 100);
    let total = o.slaCreditTotal, d = o.slaCreditedDays, added = 0;
    while (d < days) {
      d++;
      const amt = Math.min(perDay, cap - total);
      if (amt > 0) {
        const e = await wallet.credit(o.userId, amt, 'SLA', { orderId: o._id, key: `sla:${o._id}:${d}`, note: `Delay day ${d}` });
        if (e) { total += amt; added += amt; }
      }
    }
    await M.Order.updateOne({ _id: o._id }, { $set: { slaCreditedDays: d, slaCreditTotal: total } });
    if (added) { credited += added; await notify(o.userId, 'SLA_CREDIT', { orderNo: o.orderNo, amount: added }); }
  }
  return { orders: list.length, credited };
}

// ---- lifecycle: reminders, auto-expire, at-risk alerts, auto-close, stock-reservation release
async function runLifecycle() {
  const out = { reminded: 0, expired: 0, atRisk: 0, closed: 0, released: 0 };
  const remindH = +(await S.get('quoteReminderHours')), expireD = +(await S.get('quoteExpireDays'));
  for (const o of await M.Order.find({ status: 'QUOTE_SENT' })) {
    const since = +new Date(o.events.filter((e) => e.to === 'QUOTE_SENT').pop()?.ts || o.updatedAt);
    if (Date.now() - since > expireD * DAY) {
      await M.Quote.updateMany({ orderId: o._id, status: 'SENT' }, { status: 'EXPIRED' });
      await move(o, 'QUOTE_REJECTED', { note: 'Quote expire ho gaya (jawab nahi aaya)' }).catch(() => {});
      out.expired++;
    } else if (!o.quoteReminded && Date.now() - since > remindH * HOUR) {
      await notify(o.userId, 'QUOTE_REMINDER', { orderNo: o.orderNo, days: expireD });
      await M.Order.updateOne({ _id: o._id }, { quoteReminded: true });
      out.reminded++;
    }
  }
  const atRiskH = +(await S.get('atRiskHours'));
  const risky = await M.Order.find({ status: { $in: ['QUOTE_APPROVED', 'IN_REPAIR', 'QC'] }, atRiskNotified: { $ne: true }, 'hold.active': { $ne: true }, committedDate: { $gt: new Date(), $lt: new Date(Date.now() + atRiskH * HOUR) } });
  for (const o of risky) {
    await notify(o.userId, 'DELAY_AT_RISK', { orderNo: o.orderNo, committed: fmtDate(o.committedDate) });
    await M.Order.updateOne({ _id: o._id }, { atRiskNotified: true });
    out.atRisk++;
  }
  if (risky.length) await notifyAdmins('SLA_ALERT_ADMIN', { count: risky.length }, 'orders');
  const closeD = +(await S.get('closeAfterDays'));
  for (const o of await M.Order.find({ status: 'DELIVERED', deliveredAt: { $lt: new Date(Date.now() - closeD * DAY) } })) {
    if (await M.Claim.exists({ orderId: o._id, status: { $in: OPEN_CLAIM } })) continue;
    await move(o, 'CLOSED', { note: 'Auto-close' }).catch(() => {});
    out.closed++;
  }
  // shop: payment na hua to stock wapas
  for (const so of await M.ShopOrder.find({ status: 'PENDING', reservedUntil: { $lt: new Date() } })) {
    const r = await M.ShopOrder.findOneAndUpdate({ _id: so._id, status: 'PENDING' }, { status: 'CANCELLED', note: 'Payment time out' });
    if (r) { for (const i of so.items) await M.Product.updateOne({ sku: i.sku }, { $inc: { stock: i.qty } }); out.released++; }
  }
  return out;
}
module.exports = { FLOW, SLA_ACTIVE, HOLD_REASONS, OPEN_CLAIM, move, computeFees, payable, hold, resume, createPayouts, releaseHeldPayouts, runSla, runLifecycle, fmtDate };
