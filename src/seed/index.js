const bcrypt = require('bcryptjs');
const cfg = require('../config');
const M = require('../models');
const { PRODUCTS, RATES, PLANS, GUIDES, PAGES } = require('./data');
const verdict = require('../lib/verdict');

const upsertMany = async (Model, key, list) => {
  let n = 0;
  for (const d of list) {
    const r = await Model.updateOne({ [key]: d[key] }, { $setOnInsert: d }, { upsert: true });
    if (r.upsertedCount) n++;
  }
  return n;
};
// Idempotent: baar-baar chalane par duplicate nahi banta aur aapke admin-edits overwrite nahi hote
async function seed() {
  const out = {};
  out.products = await upsertMany(M.Product, 'sku', PRODUCTS);
  out.rates = await upsertMany(M.RateItem, 'code', RATES);
  out.plans = await upsertMany(M.Plan, 'code', PLANS);
  out.guides = await upsertMany(M.Guide, 'slug', GUIDES);
  out.pages = await upsertMany(M.Page, 'slug', PAGES);
  await verdict.activeRules();
  if (!(await M.User.exists({ role: 'admin' }))) {
    await M.User.create({ name: 'Super Admin', email: cfg.admin.email, role: 'admin', adminRole: 'super', emailVerified: true, hash: await bcrypt.hash(cfg.admin.password, 12) });
    out.admin = cfg.admin.email;
  }
  return out;
}
module.exports = { seed };
