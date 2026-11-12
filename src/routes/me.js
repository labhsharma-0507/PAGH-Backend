const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const M = require('../models');
const { auth } = require('../middleware/auth');
const { bad, ah, clean, normPhone, str, num, token, limiter } = require('../lib/util');
const wallet = require('../lib/wallet');
const { saveImages } = require('../lib/storage');
const { FLOW } = require('../lib/orders');

const R = express.Router();
const ID = (v) => { if (!M.mongoose.isValidObjectId(v)) throw bad('Bad id'); return v; };

R.get('/me', auth(), ah(async (q, r) => {
  const u = await M.User.findById(q.user.id, '-hash -twoFA.secret -emailVerifyHash').lean();
  r.json({ ...u, id: u._id, twoFA: !!u.twoFA?.enabled, balance: await wallet.balance(u._id) });
}));
R.patch('/me', auth(), ah(async (q, r) => {
  const b = clean(q.body), set = {};
  if (['en', 'hi', 'hg'].includes(b.lang)) set.lang = b.lang;
  if (typeof b.name === 'string' && b.name.trim().length >= 2) set.name = str(b.name, 80);
  if (b.phone !== undefined) {
    const p = normPhone(b.phone);
    if (!p) throw bad('Valid 10-digit mobile number do');
    if (await M.User.findOne({ phone: p, _id: { $ne: q.user.id } })) throw bad('Ye number kisi aur account par hai', 409);
    set.phone = p; set.phoneVerified = false;
  }
  if (b.prefs) set.prefs = { email: !!b.prefs.email, sms: !!b.prefs.sms, whatsapp: !!b.prefs.whatsapp };
  await M.User.updateOne({ _id: q.user.id }, set);
  r.json({ ok: true });
}));
R.get('/me/sessions', auth(), ah(async (q, r) => r.json(await M.Session.find({ userId: q.user.id, revoked: { $ne: true }, expiresAt: { $gt: new Date() } }, 'ua ip createdAt').sort('-createdAt').lean())));
R.delete('/me/sessions/:id', auth(), ah(async (q, r) => { await M.Session.updateOne({ _id: ID(q.params.id), userId: q.user.id }, { revoked: true }); r.json({ ok: true }); }));
R.get('/me/export', auth(), ah(async (q, r) => {
  const id = q.user.id;
  r.json({
    user: await M.User.findById(id, '-hash -twoFA -emailVerifyHash').lean(), addresses: await M.Address.find({ userId: id }).lean(), shoes: await M.Shoe.find({ userId: id }).lean(),
    orders: await M.Order.find({ userId: id }, '-pickupOtp -deliveryOtp').lean(), claims: await M.Claim.find({ userId: id }).lean(), wallet: await M.Ledger.find({ userId: id }).lean(),
    shopOrders: await M.ShopOrder.find({ userId: id }).lean(), reviews: await M.Review.find({ userId: id }).lean(),
  });
}));
// Account deletion: personal data hata dete hain, order/payment records legal reasons se anonymised rehte hain
R.delete('/me', auth('customer'), ah(async (q, r) => {
  const active = await M.Order.exists({ userId: q.user.id, status: { $nin: ['CLOSED', 'CANCELLED', 'DELIVERED'] } });
  if (active) throw bad('Active order hain. Delivery/close ke baad account delete kar sakte ho.');
  if ((await wallet.balance(q.user.id)) > 0 && !q.body.confirmLoseWallet) throw bad('Wallet mein balance hai. Delete karne par wo jaata rahega: confirmLoseWallet:true bhejo.', 409);
  await M.User.updateOne({ _id: q.user.id }, { status: 'deleted', deletedAt: new Date(), name: 'Deleted user', email: `deleted_${q.user.id}@deleted.invalid`, $unset: { phone: 1, hash: 1, twoFA: 1 } });
  await M.Session.updateMany({ userId: q.user.id }, { revoked: true });
  await M.Address.deleteMany({ userId: q.user.id }); await M.Shoe.deleteMany({ userId: q.user.id });
  r.json({ ok: true });
}));

// ---- addresses
const Addr = z.object({ label: z.string().max(30).optional(), name: z.string().max(80).optional(), phone: z.string().optional(), line1: z.string().trim().min(5).max(200), line2: z.string().max(200).optional(), city: z.string().trim().min(2).max(60), state: z.string().max(60).optional(), pincode: z.string().regex(/^\d{6}$/, 'Pincode 6 digit ka hona chahiye'), isDefault: z.boolean().optional() });
const saveAddr = async (q, id) => {
  const p = Addr.safeParse(clean(q.body));
  if (!p.success) throw bad(p.error.issues[0].message);
  if (p.data.isDefault) await M.Address.updateMany({ userId: q.user.id }, { isDefault: false });
  const doc = { ...p.data, userId: q.user.id };
  return id ? M.Address.findOneAndUpdate({ _id: ID(id), userId: q.user.id }, doc, { new: true }) : M.Address.create(doc);
};
R.get('/me/addresses', auth(), ah(async (q, r) => r.json(await M.Address.find({ userId: q.user.id }).sort('-isDefault -createdAt').lean())));
R.post('/me/addresses', auth(), ah(async (q, r) => r.json(await saveAddr(q))));
R.patch('/me/addresses/:id', auth(), ah(async (q, r) => r.json((await saveAddr(q, q.params.id)) || bad('Nahi mila', 404))));
R.delete('/me/addresses/:id', auth(), ah(async (q, r) => { await M.Address.deleteOne({ _id: ID(q.params.id), userId: q.user.id }); r.json({ ok: true }); }));

// ---- Shoe wardrobe
const ShoeIn = z.object({ brand: z.string().max(60).optional(), model: z.string().max(80).optional(), type: z.string().max(30).optional(), material: z.string().max(30).optional(), purchaseDate: z.string().optional(), declaredValue: z.coerce.number().min(0).max(1000000).optional(), notes: z.string().max(300).optional(), photos: z.array(z.string()).max(4).optional() });
R.get('/me/shoes', auth(), ah(async (q, r) => r.json(await M.Shoe.find({ userId: q.user.id, archived: { $ne: true } }).sort('-createdAt').lean())));
R.post('/me/shoes', auth(), ah(async (q, r) => {
  const p = ShoeIn.safeParse(clean(q.body));
  if (!p.success) throw bad(p.error.issues[0].message);
  const d = { ...p.data, userId: q.user.id };
  if (d.photos?.length) d.photos = await saveImages(d.photos, 'shoe', { min: 1, max: 4 });
  r.json(await M.Shoe.create(d));
}));
R.patch('/me/shoes/:id', auth(), ah(async (q, r) => {
  const p = ShoeIn.partial().safeParse(clean(q.body));
  if (!p.success) throw bad(p.error.issues[0].message);
  const d = p.data;
  if (d.photos) d.photos = await saveImages(d.photos, 'shoe', { min: 0, max: 4 });
  r.json((await M.Shoe.findOneAndUpdate({ _id: ID(q.params.id), userId: q.user.id }, d, { new: true })) || bad('Nahi mila', 404));
}));
R.delete('/me/shoes/:id', auth(), ah(async (q, r) => { await M.Shoe.updateOne({ _id: ID(q.params.id), userId: q.user.id }, { archived: true }); r.json({ ok: true }); }));
R.get('/me/shoes/:id/history', auth(), ah(async (q, r) => r.json(await M.Order.find({ userId: q.user.id, shoeId: ID(q.params.id) }, 'orderNo status total createdAt').sort('-createdAt').lean())));

// ---- notifications (in-app)
R.get('/notifications', auth(), ah(async (q, r) => {
  const items = await M.Notif.find({ userId: q.user.id, channel: 'inapp' }).sort('-createdAt').limit(50).lean();
  r.json({ items, unread: await M.Notif.countDocuments({ userId: q.user.id, channel: 'inapp', read: false }) });
}));
R.post('/notifications/read-all', auth(), ah(async (q, r) => { await M.Notif.updateMany({ userId: q.user.id, channel: 'inapp' }, { read: true }); r.json({ ok: true }); }));

// ---- wallet
R.get('/wallet', auth('customer'), ah(async (q, r) => r.json({ balance: await wallet.balance(q.user.id), ledger: await M.Ledger.find({ userId: q.user.id }).sort('-createdAt').limit(100).lean() })));
module.exports = R;
