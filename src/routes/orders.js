const express = require('express');
const { z } = require('zod');
const M = require('../models');
const S = require('../lib/settings');
const wallet = require('../lib/wallet');
const O = require('../lib/orders');
const { auth, admin } = require('../middleware/auth');
const { bad, ah, clean, str, num, orderNo, otp4, token, limiter, DAY } = require('../lib/util');
const { saveImages } = require('../lib/storage');
const { notify, notifyAdmins } = require('../lib/notify');
const { audit } = require('../lib/audit');

const R = express.Router();
const ID = (v) => { if (!M.mongoose.isValidObjectId(v)) throw bad('Bad id'); return v; };
const STAFF = ['partner', 'agent', 'droppoint', 'admin'];

async function getOrder(q, id) {
  const o = await M.Order.findById(ID(id));
  if (!o) throw bad('Order nahi mila', 404);
  const u = q.user;
  if (u.role === 'customer' && String(o.userId) !== u.id) throw bad('Order nahi mila', 404);
  if (u.role === 'partner' && o.partnerId && String(o.partnerId) !== u.id) throw bad('Ye job aapka nahi hai', 403);
  if (u.role === 'droppoint') {
    const dp = await M.Partner.findOne({ userId: u.id, type: 'DROP_POINT', status: 'APPROVED' });
    if (!dp || String(o.dropPointId) !== String(dp._id)) throw bad('Ye order aapke drop-point ka nahi hai', 403);
  }
  if (u.role === 'brand') {
    const me = await M.User.findById(u.id, 'brandId').lean();
    if (!me?.brandId || String(o.brandId) !== String(me.brandId)) throw bad('Order nahi mila', 404);
  }
  return o;
}
// OTP sirf customer ko aur sirf zaroorat ke stage par dikhta hai
const pub = (o, q) => {
  const x = o.toObject ? o.toObject() : o;
  if (q.user.role !== 'customer') { delete x.pickupOtp; delete x.deliveryOtp; if (q.user.role !== 'admin') delete x.qrId; }
  else {
    if (x.status !== 'BOOKED') delete x.pickupOtp;
    if (x.status !== 'OUT_FOR_DELIVERY') delete x.deliveryOtp;
  }
  return x;
};
const ownPartner = (o, q) => { if (q.user.role === 'partner' && String(o.partnerId) !== q.user.id) throw bad('Pehle job accept karo', 403); };

// ---------------- create
const Create = z.object({
  shoeId: z.string().optional(), shoe: z.object({ brand: z.string().max(60).optional(), model: z.string().max(80).optional(), type: z.string().max(30).optional(), material: z.string().max(30).optional(), problem: z.string().max(300).optional() }).passthrough().optional(),
  verdictId: z.string().optional(), declaredValue: z.coerce.number().min(0).max(1000000), serviceType: z.enum(['REPAIR', 'CLEANING', 'RESTORATION']).optional(),
  addressId: z.string().optional(), address: z.string().max(300).optional(), pincode: z.string().regex(/^\d{6}$/).optional(), slot: z.string().max(60).optional(),
  pickupMode: z.enum(['PICKUP', 'DROPPOINT']).optional(), dropPointId: z.string().optional(), plan: z.string().max(20).optional(), express: z.boolean().optional(), brandCode: z.string().max(30).optional(),
});
R.post('/orders', auth('customer'), limiter(60e3, 20), ah(async (q, r) => {
  const p = Create.safeParse(clean(q.body));
  if (!p.success) throw bad(p.error.issues[0].message);
  const me = await M.User.findById(q.user.id, 'phone emailVerified phoneVerified').lean();
  if (!me?.phone) throw bad('Booking se pehle profile mein phone number add karo (pickup coordination ke liye)', 403, 'NEEDS_PHONE');
  if ((await S.get('requireVerifiedContact')) && !(me.emailVerified || me.phoneVerified)) throw bad('Booking se pehle email ya phone verify karo', 403, 'NEEDS_VERIFY');
  const b = p.data, mode = b.pickupMode || 'PICKUP';
  let shoe = b.shoe || {}, shoeId;
  if (b.shoeId) {
    const sh = await M.Shoe.findOne({ _id: ID(b.shoeId), userId: q.user.id }).lean();
    if (!sh) throw bad('Wardrobe mein ye shoe nahi mila', 404);
    shoe = { brand: sh.brand, model: sh.model, type: sh.type, material: sh.material, photos: sh.photos, ...shoe }; shoeId = sh._id;
  }
  if (!shoe.material && !shoe.brand && !shoe.model && !shoe.problem) throw bad('Shoe ki details do');
  let address, pincode, dropPointId, addressId;
  if (mode === 'DROPPOINT') {
    const dp = await M.Partner.findOne({ _id: ID(b.dropPointId || ''), type: 'DROP_POINT', status: 'APPROVED' }).lean();
    if (!dp) throw bad('Drop-point available nahi hai');
    dropPointId = dp._id; address = `${dp.businessName}, ${dp.address || ''}, ${dp.city || ''}`; pincode = dp.pincodes?.[0] || '';
  } else {
    if (b.addressId) {
      const a = await M.Address.findOne({ _id: ID(b.addressId), userId: q.user.id }).lean();
      if (!a) throw bad('Address nahi mila', 404);
      address = [a.line1, a.line2, a.city, a.state, a.pincode].filter(Boolean).join(', '); pincode = a.pincode; addressId = a._id;
    } else { address = b.address; pincode = b.pincode; }
    if (!address || !pincode) throw bad('Address aur 6-digit pincode do');
    const list = await S.get('pincodes');
    if (list.length && !list.includes(pincode)) throw bad('Is pincode par abhi pickup service available nahi hai. Drop-point try karo.');
  }
  let brand;
  if (b.brandCode) { brand = await M.Brand.findOne({ code: b.brandCode.toUpperCase(), active: true }).lean(); if (!brand) throw bad('Brand code galat hai'); }
  const plan = await M.Plan.findOne({ code: b.plan || 'BASIC', active: true }).lean();
  if (!plan) throw bad('Protection plan invalid');
  let verdict; if (b.verdictId && M.mongoose.isValidObjectId(b.verdictId)) verdict = (await M.VerdictRequest.findById(b.verdictId).lean())?.output;
  const o = await M.Order.create({
    orderNo: orderNo(), userId: q.user.id, shoeId, shoe, verdict, verdictId: b.verdictId && M.mongoose.isValidObjectId(b.verdictId) ? b.verdictId : undefined,
    serviceType: b.serviceType || 'REPAIR', declaredValue: b.declaredValue, plan: plan.code, address, addressId, pincode, slot: b.slot, pickupMode: mode, dropPointId, brandId: brand?._id, brandCode: brand?.code, express: !!b.express,
    qrId: 'QR' + token(5).toUpperCase(), pickupOtp: otp4(), deliveryOtp: otp4(), events: [{ to: 'BOOKED', by: 'customer', byId: q.user.id }],
  });
  await notify(q.user.id, 'ORDER_BOOKED', { orderNo: o.orderNo, pickupOtp: o.pickupOtp });
  const warnings = [];
  const minBill = await S.get('minPickupBill');
  if (mode === 'PICKUP' && verdict?.priceBand?.max < minBill) warnings.push(`Expected bill chhota hai (max Rs ${verdict.priceBand.max}). Pickup fee zyada lag sakti hai; drop-point sasta padega.`);
  r.json({ ...pub(o, q), warnings });
}));

R.get('/orders', auth('customer'), ah(async (q, r) => r.json((await M.Order.find({ userId: q.user.id }).sort('-createdAt').limit(100)).map((o) => pub(o, q)))));

R.get('/orders/:id', auth(), ah(async (q, r) => {
  const o = await getOrder(q, q.params.id);
  const [cond, quotes, warranty, review, custody, job, payments] = await Promise.all([
    M.Cond.findOne({ orderId: o._id }).lean(), M.Quote.find({ orderId: o._id }).sort('createdAt').lean(), M.Warranty.findOne({ orderId: o._id }).lean(),
    M.Review.findOne({ orderId: o._id }).lean(), M.Custody.find({ orderId: o._id }).sort('createdAt').lean(), M.Job.findOne({ orderId: o._id }).lean(),
    q.user.role === 'customer' || q.user.role === 'admin' ? M.Payment.find({ orderId: o._id }, 'kind amount credit status createdAt refunds').lean() : [],
  ]);
  const plan = o.plan ? await M.Plan.findOne({ code: o.plan }).lean() : null;
  const dep = +(await S.get('depreciation')), val = Math.round((o.declaredValue || 0) * (1 - dep));
  r.json({
    order: pub(o, q), condition: cond, quotes, warranty, review, payments, payable: O.payable(o), dueExtra: o.dueExtra,
    custody: custody.map((x) => ({ type: x.type, ts: x.createdAt, role: x.role, otpVerified: x.otpVerified })),
    milestones: (job?.milestones || []).map((m) => ({ type: m.type, photos: m.photos, ts: m.ts, note: m.note })),
    cover: { plan: plan?.code, name: plan?.name, declared: o.declaredValue, depreciated: val, max: plan ? (plan.fullDeclared ? val : Math.min(val, plan.limit || 0)) : 0 },
  });
}));

R.post('/orders/:id/cancel', auth('customer'), ah(async (q, r) => {
  const o = await getOrder(q, q.params.id);
  r.json(pub(await O.move(o, 'CANCELLED', { by: 'customer', byId: q.user.id, note: str(q.body.reason, 200) }), q));
}));

R.post('/orders/:id/protection', auth('customer'), ah(async (q, r) => {
  const o = await getOrder(q, q.params.id);
  if (o.paid || ['CANCELLED', 'CLOSED', 'DELIVERED'].includes(o.status)) throw bad('Ab plan badal nahi sakte');
  const plan = await M.Plan.findOne({ code: String(q.body.plan), active: true }).lean();
  if (!plan) throw bad('Plan invalid');
  o.plan = plan.code;
  if (o.status === 'QUOTE_APPROVED') o.fees = await O.computeFees(o);
  await o.save();
  r.json(pub(o, q));
}));
R.get('/protection/plans', ah(async (q, r) => r.json(await M.Plan.find({ active: true }).lean())));

// ---------------- staff status transitions (strict role matrix)
const STATUS_RULES = {
  NOT_REPAIRABLE: { roles: ['partner', 'admin'], needNote: true },
  IN_REPAIR: { roles: ['partner', 'admin'] },
  QC: { roles: ['partner', 'admin'] },
  READY: { roles: ['partner', 'admin'] },
  RETURN_READY: { roles: ['partner', 'admin'] },
  OUT_FOR_DELIVERY: { roles: ['partner', 'agent', 'admin'] },
};
R.post('/orders/:id/status', auth(...STAFF), ah(async (q, r) => {
  const o = await getOrder(q, q.params.id), to = String(q.body.to), rule = STATUS_RULES[to];
  if (!rule) throw bad('Is status par direct jaana allowed nahi (custody scan/quote flow use karo)');
  if (!rule.roles.includes(q.user.role)) throw bad('Aapko ye action allowed nahi', 403);
  if (rule.needNote && !str(q.body.note)) throw bad('Reason (note) likho');
  if (q.user.role === 'partner' && to !== 'OUT_FOR_DELIVERY') ownPartner(o, q);
  const extra = {};
  if (to === 'IN_REPAIR' && o.status === 'CONDITION_CONFIRMED') {
    if (!o.rework) throw bad('Quote approval ke bina repair nahi');
    extra.committedDate = new Date(Date.now() + (await S.get('reworkTatDays')) * DAY); extra.paid = true;
  } else if (to === 'IN_REPAIR' && o.status === 'QUOTE_APPROVED' && !o.paid) throw bad('Payment pending hai');
  if (to === 'QC' && (o.hold?.active || o.pendingExtraQuoteId || o.dueExtra > 0)) throw bad('Extra-work approval/payment pending hai');
  if (to === 'IN_REPAIR' && o.status === 'QC') { await M.Job.updateOne({ orderId: o._id }, { qcResult: 'FAIL', qcNote: str(q.body.note, 300) }); }
  if (to === 'READY') {
    const job = await M.Job.findOne({ orderId: o._id }).lean();
    if (!job?.milestones?.some((m) => m.type === 'FINAL_QC')) throw bad('Pehle FINAL_QC milestone photo upload karo');
    await M.Job.updateOne({ orderId: o._id }, { qcResult: 'PASS' });
  }
  if (to === 'RETURN_READY' && o.dueExtra > 0) throw bad('Return fee payment pending hai');
  if (to === 'OUT_FOR_DELIVERY' && o.pickupMode === 'DROPPOINT') { /* agent shoe ko drop-point tak le jaata hai */ }
  const n = await O.move(o, to, { by: q.user.role, byId: q.user.id, note: str(q.body.note, 300), extra });
  if (to === 'IN_REPAIR' && extra.committedDate) await M.Order.updateOne({ _id: o._id }, { slaCreditedDays: 0 });
  r.json(pub(n, q));
}));

// ---------------- hold / resume (SLA pause) - sirf declared reasons
R.post('/orders/:id/hold', auth('partner', 'admin'), ah(async (q, r) => {
  const o = await getOrder(q, q.params.id); ownPartner(o, q);
  if (q.user.role === 'admin' && !(await require('../middleware/auth').can(q.user, 'orders'))) throw bad('Permission nahi', 403);
  if (!str(q.body.note)) throw bad('Reason ka note likho (customer ko dikhega)');
  const n = await O.hold(o, String(q.body.reason), str(q.body.note, 200), q.user.role);
  audit(q, 'ORDER_HOLD', 'Order', o._id, null, { reason: q.body.reason });
  r.json(pub(n, q));
}));
R.post('/orders/:id/resume', auth('partner', 'admin'), ah(async (q, r) => {
  const o = await getOrder(q, q.params.id); ownPartner(o, q);
  if (o.pendingExtraQuoteId) throw bad('Extra-work quote ka jawab pending hai');
  r.json(pub(await O.resume(o, q.user.role), q));
}));

// ---------------- condition report
const lockedOrNot = (c) => { if (c?.lockedAt) throw bad('Report locked hai (customer accept kar chuka)'); };
R.post('/orders/:id/condition/customer-photos', auth('customer'), limiter(60e3, 20), ah(async (q, r) => {
  const o = await getOrder(q, q.params.id);
  if (!['BOOKED', 'PICKED_UP'].includes(o.status)) throw bad('Ab photos add nahi ho sakte');
  const photos = await saveImages(q.body.photos, 'condition', { min: 1, max: 8 });
  const pre = (Array.isArray(q.body.preExisting) ? q.body.preExisting : []).map((x) => str(x, 200)).slice(0, 10);
  const c = await M.Cond.findOneAndUpdate({ orderId: o._id }, { customerPhotos: photos, preExisting: pre }, { upsert: true, new: true, setDefaultsOnInsert: true });
  r.json(c);
}));
R.post('/orders/:id/condition/hub', auth('partner', 'admin'), ah(async (q, r) => {
  const o = await getOrder(q, q.params.id);
  if (o.status !== 'AT_HUB') throw bad('Order hub par intake hona chahiye');
  if (q.user.role === 'partner' && String(o.partnerId) !== q.user.id) throw bad('Pehle job accept karo', 403);
  const g = String(q.body.grade);
  if (!/^[A-D]$/.test(g)) throw bad('Grade A-D chahiye');
  let c = (await M.Cond.findOne({ orderId: o._id })) || new M.Cond({ orderId: o._id });
  lockedOrNot(c);
  if (c.grade) c.history.push({ version: c.version, grade: c.grade, hubPhotos: c.hubPhotos });
  c.hubPhotos = await saveImages(q.body.photos, 'condition', { min: 1, max: 8 });
  c.checklist = clean(q.body.checklist || {}); c.grade = g; c.disputedReason = undefined; c.disputedAt = undefined;
  if (Array.isArray(q.body.preExisting)) c.preExisting = q.body.preExisting.map((x) => str(x, 200)).slice(0, 10);
  c.version = (c.version || 0) + 1;
  await c.save();
  await O.move(o, 'CONDITION_CONFIRMED', { by: q.user.role, byId: q.user.id });
  r.json(c);
}));
const condBase = async (q) => {
  const o = await getOrder(q, q.params.id), c = await M.Cond.findOne({ orderId: o._id });
  if (!c?.grade) throw bad('Report abhi ready nahi');
  lockedOrNot(c);
  return [o, c];
};
R.post('/orders/:id/condition/accept', auth('customer'), ah(async (q, r) => {
  const [, c] = await condBase(q);
  c.customerAcceptedAt = c.lockedAt = new Date(); c.disputedReason = undefined;
  await c.save();
  r.json(c);
}));
R.post('/orders/:id/condition/dispute', auth('customer'), ah(async (q, r) => {
  const [o, c] = await condBase(q);
  const hours = await S.get('conditionDisputeHours');
  if (Date.now() - +new Date(c.updatedAt) > hours * 36e5) throw bad(`${hours} ghante ka window khatam ho gaya`);
  if (!str(q.body.reason)) throw bad('Dispute ka reason likho');
  c.disputedReason = str(q.body.reason, 500); c.disputedAt = new Date();
  await c.save();
  await notifyAdmins('CONDITION_DISPUTE', { orderNo: o.orderNo }, 'orders');
  r.json(c);
}));
// Admin dispute resolve: reopen (hub dobara report banaye) ya report ko final lock kar do
R.post('/admin/orders/:id/condition/resolve', admin('orders'), ah(async (q, r) => {
  const o = await M.Order.findById(ID(q.params.id)), c = await M.Cond.findOne({ orderId: o?._id });
  if (!o || !c) throw bad('Nahi mila', 404);
  if (q.body.action === 'REOPEN') {
    if (!['CONDITION_CONFIRMED', 'QUOTE_SENT'].includes(o.status)) throw bad('Reopen sirf quote approve hone se pehle ho sakta hai');
    await M.Quote.updateMany({ orderId: o._id, status: { $in: ['SENT', 'QUERY'] } }, { status: 'SUPERSEDED' }); // purana quote naye report par valid nahi
    c.lockedAt = undefined; c.disputedReason = undefined; await c.save();
    await O.move(o, 'AT_HUB', { by: 'admin', byId: q.user.id, note: 'Condition report reopen' }, true);
  } else { c.lockedAt = new Date(); c.disputedReason = undefined; await c.save(); }
  audit(q, 'CONDITION_RESOLVE', 'Order', o._id, null, { action: q.body.action });
  r.json(c);
}));

// ---------------- quotes
const quoteItems = async (codes, isAdmin, custom) => {
  const rate = await M.RateItem.find({ code: { $in: (codes || []).map(String) }, active: true }).lean();
  const items = rate.map((x) => ({ code: x.code, name: x.name, price: x.price, cap: x.cap || x.price, tat: x.tatDays, war: x.warrantyDays }));
  if (isAdmin) for (const c of custom || []) if (c.name && num(c.price) > 0) items.push({ code: 'CUSTOM', name: str(c.name, 80), price: num(c.price), cap: num(c.price), tat: num(c.tat, 3), war: undefined });
  if (!items.length) throw bad('Rate card se items chuno');
  return items;
};
R.post('/orders/:id/quotes', auth('partner', 'admin'), ah(async (q, r) => {
  const o = await getOrder(q, q.params.id); ownPartner(o, q);
  if (!['CONDITION_CONFIRMED', 'QUOTE_SENT'].includes(o.status)) throw bad('Condition confirm ke baad hi quote bana sakte ho');
  const items = await quoteItems(q.body.items, q.user.role === 'admin', q.body.custom);
  const total = items.reduce((s, i) => s + i.price, 0);
  await M.Quote.updateMany({ orderId: o._id, status: { $in: ['SENT', 'QUERY'] } }, { status: 'SUPERSEDED' });
  const count = await M.Quote.countDocuments({ orderId: o._id, extraWorkOf: null });
  const wd = items.map((i) => i.war).filter(Boolean);
  const qt = await M.Quote.create({
    orderId: o._id, version: count + 1, items: items.map(({ code, name, price }) => ({ code, name, price })), total, cap: items.reduce((s, i) => s + i.cap, 0),
    tatDays: Math.max(...items.map((i) => i.tat || 3)), warrantyDays: wd.length ? Math.min(...wd) : await S.get('warrantyDays'), note: str(q.body.note, 300),
  });
  const set = { total, cap: qt.cap };
  if (o.status === 'CONDITION_CONFIRMED') await O.move(o, 'QUOTE_SENT', { by: q.user.role, byId: q.user.id, extra: { ...set, quoteReminded: false } });
  else { await M.Order.updateOne({ _id: o._id }, { ...set, quoteReminded: false }); await notify(o.userId, 'STATUS_QUOTE_SENT', { orderNo: o.orderNo }); }
  r.json(qt);
}));
// Extra kaam: price cap ke andar hi, aur customer ki nayi approval ke baad
R.post('/orders/:id/extra-quote', auth('partner', 'admin'), ah(async (q, r) => {
  const o = await getOrder(q, q.params.id); ownPartner(o, q);
  if (o.status !== 'IN_REPAIR' || o.pendingExtraQuoteId) throw bad('Extra quote abhi possible nahi');
  const items = await quoteItems(q.body.items, false);
  const extra = items.reduce((s, i) => s + i.price, 0);
  if (o.total + extra > (o.cap || o.total)) throw bad(`Price cap (Rs ${o.cap}) se upar nahi ja sakte. Total Rs ${o.total + extra} hota.`);
  const qt = await M.Quote.create({ orderId: o._id, version: 0, items: items.map(({ code, name, price }) => ({ code, name, price })), total: extra, cap: extra, tatDays: 0, extraWorkOf: o._id, note: str(q.body.note, 300) });
  await M.Order.updateOne({ _id: o._id }, { pendingExtraQuoteId: qt._id });
  await O.hold(o, 'EXTRA_WORK_APPROVAL', 'Extra kaam ke liye customer approval chahiye', q.user.role);
  await notify(o.userId, 'EXTRA_QUOTE', { orderNo: o.orderNo, amount: extra });
  r.json(qt);
}));
R.get('/orders/:id/quotes', auth(), ah(async (q, r) => { const o = await getOrder(q, q.params.id); r.json(await M.Quote.find({ orderId: o._id }).sort('createdAt').lean()); }));

const decide = (ok) => ah(async (q, r) => {
  const qt = await M.Quote.findById(ID(q.params.id));
  const o = qt && (await M.Order.findById(qt.orderId));
  if (!o || String(o.userId) !== q.user.id) throw bad('Quote nahi mila', 404);
  if (!['SENT', 'QUERY'].includes(qt.status)) throw bad('Ye quote ab valid nahi hai');
  // --- extra-work quote (repair ke dauran)
  if (qt.extraWorkOf) {
    if (o.status !== 'IN_REPAIR' || String(o.pendingExtraQuoteId) !== String(qt._id)) throw bad('Quote valid nahi');
    qt.status = ok ? 'APPROVED' : 'REJECTED'; await qt.save();
    await M.Order.updateOne({ _id: o._id }, { $unset: { pendingExtraQuoteId: 1 }, ...(ok ? { $inc: { total: qt.total, dueExtra: qt.total } } : {}) });
    await O.resume(await M.Order.findById(o._id), 'customer');
    return r.json(pub(await M.Order.findById(o._id), q));
  }
  if (o.status !== 'QUOTE_SENT') throw bad('Is order par quote approve nahi ho sakta');
  if (qt.status === 'SUPERSEDED') throw bad('Naya quote aa gaya hai');
  const c = await M.Cond.findOne({ orderId: o._id });
  if (ok) {
    if (c?.disputedReason && !c.lockedAt) throw bad('Condition report par dispute pending hai. Support resolve karega, tab quote approve karo.');
    if (c && !c.lockedAt) { c.lockedAt = c.customerAcceptedAt = new Date(); await c.save(); } // approval = condition accept
    const express = o.express ? Math.max(1, Math.ceil(qt.tatDays / 2)) : qt.tatDays;
    const fees = await O.computeFees(o);
    qt.status = 'APPROVED'; await qt.save();
    return r.json(pub(await O.move(o, 'QUOTE_APPROVED', { by: 'customer', byId: q.user.id, extra: { fees, committedDate: new Date(Date.now() + express * DAY), slaCreditedDays: 0, slaCreditTotal: 0, atRiskNotified: false } }), q));
  }
  qt.status = 'REJECTED'; await qt.save();
  const fee = o.pickupMode === 'PICKUP' ? await S.get('returnFee') : 0;
  r.json(pub(await O.move(o, 'QUOTE_REJECTED', { by: 'customer', byId: q.user.id, note: str(q.body.reason, 200), extra: { dueExtra: fee, 'fees.returnFee': fee, returnReason: str(q.body.reason, 200) } }), q));
});
R.post('/quotes/:id/approve', auth('customer'), decide(true));
R.post('/quotes/:id/reject', auth('customer'), decide(false));
R.post('/quotes/:id/query', auth('customer'), ah(async (q, r) => {
  const qt = await M.Quote.findById(ID(q.params.id)), o = qt && (await M.Order.findById(qt.orderId));
  if (!o || String(o.userId) !== q.user.id || qt.status !== 'SENT') throw bad('Quote nahi mila', 404);
  qt.queryText = str(q.body.text, 300); qt.status = 'QUERY'; await qt.save();
  if (o.partnerId) await notify(o.partnerId, 'QUOTE_QUERY', { orderNo: o.orderNo, text: qt.queryText });
  r.json(qt);
}));

// ---------------- custody scans (OTP + QR) - append-only custody log
const SCAN = {
  PICKUP: { from: 'BOOKED', to: 'PICKED_UP', roles: ['agent', 'admin'], mode: 'PICKUP', otp: 'pickupOtp', photos: true },
  DROP_INTAKE: { from: 'BOOKED', to: 'PICKED_UP', roles: ['droppoint'], mode: 'DROPPOINT', otp: 'pickupOtp', photos: true },
  AGENT_PICKUP: { from: 'PICKED_UP', to: null, roles: ['agent', 'admin'], mode: 'DROPPOINT' },
  HUB_INTAKE: { from: 'PICKED_UP', to: 'AT_HUB', roles: ['agent', 'partner', 'admin'] },
  DELIVERY: { from: 'OUT_FOR_DELIVERY', to: 'DELIVERED', roles: ['agent', 'admin'], mode: 'PICKUP', otp: 'deliveryOtp' },
  DROP_HANDOVER: { from: 'OUT_FOR_DELIVERY', to: 'DELIVERED', roles: ['droppoint'], mode: 'DROPPOINT', otp: 'deliveryOtp' },
};
R.post('/custody/scan', auth(...STAFF), limiter(60e3, 60), ah(async (q, r) => {
  const type = String(q.body.type), rule = SCAN[type];
  if (!rule) throw bad('Scan type galat');
  if (!rule.roles.includes(q.user.role)) throw bad('Aapko ye scan allowed nahi', 403);
  const o = await M.Order.findOne({ qrId: String(q.body.qr || '') });
  if (!o) throw bad('QR galat', 404);
  if (q.user.role === 'droppoint') await getOrder(q, o._id);
  if (rule.mode && o.pickupMode !== rule.mode) throw bad(`Ye order ${o.pickupMode} mode ka hai, ${type} nahi ho sakta`);
  if (o.status !== rule.from) throw bad(`Order ${o.status} hai, ${type} abhi nahi ho sakta`);
  if (rule.otp && String(q.body.otp) !== o[rule.otp]) { audit(q, 'OTP_MISMATCH', 'Order', o._id); throw bad('OTP galat'); }
  if (rule.photos && !o.rework && (await S.get('requireCustomerPhotos'))) {
    const c = await M.Cond.findOne({ orderId: o._id }).lean();
    if (!c?.customerPhotos?.length) throw bad('Customer ne condition photos nahi daali. Pehle photos upload karwao.');
  }
  if (type === 'HUB_INTAKE' && o.pickupMode === 'DROPPOINT' && !(await M.Custody.exists({ orderId: o._id, type: 'AGENT_PICKUP' }))) throw bad('Pehle drop-point se AGENT_PICKUP scan karo');
  if (type === 'AGENT_PICKUP' && (await M.Custody.exists({ orderId: o._id, type }))) throw bad('Ye scan pehle ho chuka hai');
  let n = o;
  if (rule.to) n = await O.move(o, rule.to, { by: q.user.role, byId: q.user.id, note: 'custody ' + type });
  else await M.Order.updateOne({ _id: o._id }, { $push: { events: { from: o.status, to: o.status, by: q.user.role, byId: q.user.id, note: 'custody ' + type } } });
  await M.Custody.create({ orderId: o._id, type, actorId: q.user.id, role: q.user.role, qrId: o.qrId, otpVerified: !!rule.otp, geo: q.body.geo && typeof q.body.geo === 'object' ? { lat: num(q.body.geo.lat), lng: num(q.body.geo.lng) } : undefined });
  r.json({ orderNo: o.orderNo, status: n.status, type });
}));

// ---------------- review + invoice
R.post('/orders/:id/review', auth('customer'), ah(async (q, r) => {
  const o = await getOrder(q, q.params.id);
  if (!['DELIVERED', 'CLOSED'].includes(o.status)) throw bad('Delivery ke baad review do');
  const n = (k) => Math.min(5, Math.max(1, Math.round(num(q.body[k], 5))));
  try { r.json(await M.Review.create({ orderId: o._id, userId: o.userId, partnerId: o.partnerId, quality: n('quality'), communication: n('communication'), delivery: n('delivery'), text: str(q.body.text, 500) })); }
  catch (e) { if (e.code === 11000) throw bad('Review pehle hi diya hai', 409); throw e; }
}));
R.get('/orders/:id/invoice', auth('customer', 'admin'), ah(async (q, r) => {
  const o = await getOrder(q, q.params.id);
  if (!o.paid) throw bad('Payment ke baad invoice milega');
  const qt = await M.Quote.find({ orderId: o._id, status: 'APPROVED' }).lean();
  const u = await M.User.findById(o.userId, 'name email phone').lean(), gst = +(await S.get('gstPct'));
  const lines = qt.flatMap((x) => x.items.map((i) => ({ description: i.name, amount: i.price })));
  for (const [k, label] of [['delivery', 'Pickup + delivery'], ['express', 'Express service'], ['protection', 'Protection plan']]) if (o.fees?.[k]) lines.push({ description: label, amount: o.fees[k] });
  if (o.fees?.returnFee && o.status !== 'BOOKED' && o.returnReason) lines.push({ description: 'Return fee', amount: o.fees.returnFee });
  const total = lines.reduce((s, l) => s + l.amount, 0), tax = +((total * gst) / (100 + gst)).toFixed(2);
  r.json({ invoiceNo: 'INV-' + o.orderNo, date: o.updatedAt, seller: { name: await S.get('sellerName'), gstin: await S.get('sellerGstin') }, buyer: { name: u.name, email: u.email, phone: u.phone, address: o.address }, lines, gstPct: gst, taxableValue: +(total - tax).toFixed(2), gst: tax, total, note: 'GST rate/HSN ke liye accountant se confirm karo. Rates inclusive maane gaye hain.' });
}));
module.exports = { router: R, getOrder, pub };
