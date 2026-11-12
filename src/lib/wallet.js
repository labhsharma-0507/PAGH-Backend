const { Ledger } = require('../models');
const mongoose = require('mongoose');
// Wallet = append-only ledger. Balance hamesha ledger se nikalta hai. `key` unique hota hai -> same credit do baar nahi ban sakta.
async function balance(userId) {
  const r = await Ledger.aggregate([
    { $match: { userId: new mongoose.Types.ObjectId(String(userId)) } },
    { $group: { _id: '$type', t: { $sum: '$amount' } } },
  ]);
  const g = (t) => r.find((x) => x._id === t)?.t || 0;
  return g('CREDIT') - g('DEBIT');
}
async function entry(userId, type, amount, reason, o = {}) {
  if (!(amount > 0)) return null;
  try {
    return await Ledger.create({ userId, type, amount, reason, orderId: o.orderId, claimId: o.claimId, note: o.note, createdBy: o.createdBy, key: o.key });
  } catch (e) {
    if (e.code === 11000 && o.key) return null; // idempotent: pehle se ban chuka
    throw e;
  }
}
module.exports = { balance, credit: (u, a, r, o) => entry(u, 'CREDIT', a, r, o), debit: (u, a, r, o) => entry(u, 'DEBIT', a, r, o) };
