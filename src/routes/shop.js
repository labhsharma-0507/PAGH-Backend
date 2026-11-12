// Shop: catalog, recommendations, cart checkout (stock reserve), orders, admin CRUD + CSV import, affiliate tracking
const express = require('express');
const M = require('../models');
const S = require('../lib/settings');
const P = require('../lib/payments');
const ads = require('../lib/ads');
const { auth, admin, optionalAuth } = require('../middleware/auth');
const { crud } = require('../lib/crud');
const { bad, ah, clean, str, num, orderNo, page, rx, csv, limiter } = require('../lib/util');
const { notify } = require('../lib/notify');
const { audit } = require('../lib/audit');
const R = express.Router();

const liveFilter = () => ({ active: true, $or: [{ affiliateUrl: { $exists: true, $ne: '' } }, { stock: { $gt: 0 } }] });
const publicProduct = (p, withStock = false) => {
  const sp = p.sponsored && (!p.sponsoredUntil || new Date(p.sponsoredUntil) > new Date());
  const x = { id: p._id, sku: p.sku, title: p.title, brand: p.brand, category: p.category, group: p.group, description: p.description, mrp: p.mrp, price: p.price, images: p.images, materialsSuitable: p.materialsSuitable, damageTags: p.damageTags, tags: p.tags, attrs: p.attrs, isOwn: p.isOwn, affiliate: !!p.affiliateUrl, sponsored: !!sp, label: sp ? 'Sponsored' : undefined, inStock: !!p.affiliateUrl || p.stock > 0 };
  if (withStock) x.stock = p.stock;
  return x;
};

R.get('/products', auth(), ah(async (q, r) => {
  const f = liveFilter();
  if (q.query.category) f.category = String(q.query.category);
  if (q.query.material) f.materialsSuitable = String(q.query.material);
  if (q.query.q) f.title = rx(String(q.query.q).slice(0, 60));
  const { limit, skip } = page(q.query, 100);
  const sort = q.query.sort === 'price_asc' ? { price: 1 } : q.query.sort === 'price_desc' ? { price: -1 } : q.query.sort === 'popular' ? { sold: -1 } : { createdAt: -1 };
  const [items, total, cats] = await Promise.all([M.Product.find(f).sort(sort).skip(skip).limit(limit).lean(), M.Product.countDocuments(f), M.Product.distinct('category', { active: true })]);
  r.json({ items: items.map((p) => publicProduct(p)), total, categories: cats.sort() });
}));
// DIY recommendations: hamesha kam se kam ek NON-sponsored. context=verdict par sponsored kabhi nahi (PRD FR-VERD-8)
R.get('/products/recommend', auth(), ah(async (q, r) => {
  const f = { ...liveFilter() }, mat = String(q.query.material || ''), dmg = String(q.query.damage || '');
  const or = [];
  if (mat) or.push({ materialsSuitable: mat });
  if (dmg) or.push({ damageTags: dmg });
  const base = { ...f, ...(or.length ? { $and: [{ $or: or }, { $or: f.$or }] } : {}) };
  if (or.length) delete base.$or;
  let list = await M.Product.find(base).sort({ sold: -1 }).limit(12).lean();
  const now = new Date(), isSp = (p) => p.sponsored && (!p.sponsoredUntil || new Date(p.sponsoredUntil) > now);
  if (q.query.context === 'verdict') list = list.filter((p) => !isSp(p));
  const organic = list.filter((p) => !isSp(p)).slice(0, 3), sponsored = list.filter(isSp).slice(0, 1);
  if (!organic.length) { const any = await M.Product.find({ ...liveFilter(), sponsored: { $ne: true } }).sort({ sold: -1 }).limit(3).lean(); organic.push(...any); }
  r.json([...organic, ...sponsored].map((p) => publicProduct(p)));
}));
R.get('/products/:sku', auth(), ah(async (q, r) => {
  const p = await M.Product.findOne({ sku: String(q.params.sku), active: true }).lean();
  if (!p) throw bad('Product nahi mila', 404);
  r.json(publicProduct(p));
}));
R.post('/products/:sku/click', auth(), limiter(60e3, 60), ah(async (q, r) => {
  const p = await M.Product.findOne({ sku: String(q.params.sku), active: true });
  if (!p) throw bad('Nahi mila', 404);
  if (!ads.isBot(q.headers['user-agent'])) { await M.Product.updateOne({ _id: p._id }, { $inc: { clicks: 1 } }); await M.AdEvent.create({ productId: p._id, type: 'PRODUCT_CLICK', placement: 'shop', anon: String(q.body.anon || '').slice(0, 40) }); }
  r.json({ url: p.affiliateUrl || null });
}));

// ---------------- checkout (stock reserve -> payment -> paid). Stock atomic decrement; payment na hua to scheduler wapas karta hai.
R.post('/shop/checkout', auth('customer'), limiter(60e3, 10), ah(async (q, r) => {
  const items = Array.isArray(q.body.items) ? q.body.items.slice(0, 30) : [];
  if (!items.length) throw bad('Cart khaali hai');
  const a = clean(q.body.address || {});
  if (!str(a.line1) || !/^\d{6}$/.test(String(a.pincode)) || !str(a.city) || !str(a.name)) throw bad('Naam, address, city aur 6-digit pincode do');
  const reserved = [], lines = [];
  try {
    for (const it of items) {
      const qty = Math.min(20, Math.max(1, Math.round(num(it.qty, 1))));
      const p = await M.Product.findOne({ sku: String(it.sku), active: true }).lean();
      if (!p || p.affiliateUrl) throw bad(`${it.sku}: product available nahi / external link wala hai`);
      const ok = await M.Product.findOneAndUpdate({ sku: p.sku, stock: { $gte: qty } }, { $inc: { stock: -qty } });
      if (!ok) throw bad(`${p.title}: stock kam hai`);
      reserved.push({ sku: p.sku, qty });
      lines.push({ sku: p.sku, title: p.title, price: p.price, qty });
    }
  } catch (e) { for (const x of reserved) await M.Product.updateOne({ sku: x.sku }, { $inc: { stock: x.qty } }); throw e; }
  const subtotal = lines.reduce((s, l) => s + l.price * l.qty, 0);
  const shipping = subtotal >= (await S.get('shopFreeAbove')) ? 0 : await S.get('shopShipping');
  const gst = +(await S.get('shopGstPct')), total = subtotal + shipping, tax = +((total * gst) / (100 + gst)).toFixed(2);
  const mins = +(await S.get('stockReserveMinutes'));
  const so = await M.ShopOrder.create({ orderNo: orderNo('SH'), userId: q.user.id, items: lines, address: a, subtotal, shipping, tax, total, reservedUntil: new Date(Date.now() + mins * 60000) });
  const pay = await P.create({ userId: q.user.id, shopOrderId: so._id, kind: 'SHOP', amount: total, receipt: so.orderNo });
  await M.ShopOrder.updateOne({ _id: so._id }, { paymentId: pay.paymentId });
  r.json({ shopOrder: so, payment: pay });
}));
R.get('/shop-orders', auth('customer'), ah(async (q, r) => r.json(await M.ShopOrder.find({ userId: q.user.id, status: { $ne: 'CANCELLED' } }).sort('-createdAt').limit(50).lean())));
R.post('/shop-orders/:id/cancel', auth('customer'), ah(async (q, r) => {
  const so = await M.ShopOrder.findOneAndUpdate({ _id: q.params.id, userId: q.user.id, status: 'PENDING' }, { status: 'CANCELLED', note: 'Customer ne cancel kiya' });
  if (!so) throw bad('Sirf unpaid order cancel ho sakta hai');
  for (const i of so.items) await M.Product.updateOne({ sku: i.sku }, { $inc: { stock: i.qty } });
  r.json({ ok: true });
}));

// ---------------- admin: products (add-on friendly: attrs, categories free text, CSV import)
const PF = ['sku', 'title', 'brand', 'category', 'group', 'description', 'mrp', 'price', 'stock', 'lowStockAt', 'images', 'materialsSuitable', 'damageTags', 'tags', 'isOwn', 'affiliateUrl', 'affiliateCommissionPct', 'sponsored', 'advertiserId', 'sponsoredUntil', 'attrs', 'active'];
crud(R, '/admin/products', M.Product, {
  perm: 'shop', fields: PF, search: ['title', 'sku', 'brand'], filters: ['category', 'active'], del: false, sort: '-createdAt', name: 'Product',
  before: async (d, q, old) => {
    if (d.price !== undefined && !(+d.price >= 0)) throw bad('Price galat');
    if (d.mrp !== undefined && d.price !== undefined && +d.mrp < +d.price) throw bad('MRP price se kam nahi ho sakta');
    if (d.sponsored && !d.advertiserId && !old?.advertiserId) throw bad('Sponsored product ke liye advertiser chuno');
    if (d.affiliateUrl && !/^https?:\/\//.test(d.affiliateUrl)) throw bad('Affiliate URL http(s) se shuru ho');
    if (!old && (!d.sku || !d.title || d.price === undefined)) throw bad('sku, title, price zaroori');
  },
});
R.get('/admin/products/low-stock', admin('shop'), ah(async (q, r) => {
  const l = await M.Product.find({ active: true, stock: { $lte: 100 } }).lean(); // lowStockAt har product ka alag hai, isliye JS mein filter
  r.json(l.filter((p) => !p.affiliateUrl && p.stock <= (p.lowStockAt ?? 5)));
}));
R.get('/admin/products/export', admin('shop'), ah(async (q, r) => {
  const l = await M.Product.find().sort('sku').lean();
  r.type('text/csv').send(csv(l.map((p) => ({ sku: p.sku, title: p.title, brand: p.brand, category: p.category, price: p.price, mrp: p.mrp, stock: p.stock, materialsSuitable: (p.materialsSuitable || []).join('|'), damageTags: (p.damageTags || []).join('|'), description: p.description, image: (p.images || [])[0] || '', active: p.active }))));
}));
// CSV import: header = sku,title,brand,category,price,mrp,stock,materialsSuitable,damageTags,description,image,active  (list fields "|" se alag)
R.post('/admin/products/import', admin('shop'), express.text({ type: '*/*', limit: '2mb' }), ah(async (q, r) => {
  const text = typeof q.body === 'string' ? q.body : q.body?.csv;
  if (!text) throw bad('CSV text bhejo');
  const rows = parseCsv(String(text));
  if (rows.length < 2) throw bad('Header + kam se kam ek row chahiye');
  const head = rows[0].map((h) => h.trim()), out = { created: 0, updated: 0, errors: [] };
  for (let i = 1; i < rows.length; i++) {
    const o = Object.fromEntries(head.map((h, j) => [h, (rows[i][j] || '').trim()]));
    try {
      if (!o.sku || !o.title || !(+o.price >= 0)) throw new Error('sku/title/price zaroori');
      const d = { title: o.title, brand: o.brand, category: o.category, price: +o.price, mrp: +o.mrp || +o.price, stock: +o.stock || 0, description: o.description, active: o.active ? o.active !== 'false' : true };
      if (o.materialsSuitable) d.materialsSuitable = o.materialsSuitable.split('|').filter(Boolean);
      if (o.damageTags) d.damageTags = o.damageTags.split('|').filter(Boolean);
      if (o.image) d.images = [o.image];
      const ex = await M.Product.findOne({ sku: o.sku });
      if (ex) { ex.set(d); await ex.save(); out.updated++; } else { await M.Product.create({ sku: o.sku, isOwn: true, ...d }); out.created++; }
    } catch (e) { out.errors.push(`Row ${i + 1}: ${e.message}`); }
  }
  audit(q, 'PRODUCT_IMPORT', 'Product', 'csv', null, out);
  r.json(out);
}));
function parseCsv(t) {
  const rows = []; let row = [], cur = '', inQ = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inQ) { if (c === '"' && t[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') inQ = false; else cur += c; }
    else if (c === '"') inQ = true; else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; row.push(cur); if (row.some((x) => x.trim())) rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  row.push(cur); if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

// ---------------- admin: shop orders
R.get('/admin/shop-orders', admin('shop'), ah(async (q, r) => {
  const f = {}; if (q.query.status) f.status = String(q.query.status);
  const { limit, skip } = page(q.query);
  r.json(await M.ShopOrder.find(f).sort('-createdAt').skip(skip).limit(limit).lean());
}));
const SO_FLOW = { PAID: ['PACKED', 'CANCELLED'], PACKED: ['SHIPPED'], SHIPPED: ['DELIVERED'], DELIVERED: ['REFUNDED'] };
R.patch('/admin/shop-orders/:id', admin('shop'), ah(async (q, r) => {
  const so = await M.ShopOrder.findById(q.params.id);
  if (!so) throw bad('Nahi mila', 404);
  const to = String(q.body.status);
  if (!(SO_FLOW[so.status] || []).includes(to)) throw bad(`${so.status} se ${to} allowed nahi`);
  if (to === 'SHIPPED') { so.tracking = { courier: str(q.body.courier, 40), awb: str(q.body.awb, 40), url: str(q.body.url, 200) }; if (!so.tracking.awb) throw bad('AWB/tracking number do'); }
  if (to === 'CANCELLED') for (const i of so.items) await M.Product.updateOne({ sku: i.sku }, { $inc: { stock: i.qty, sold: -i.qty } });
  so.status = to; await so.save();
  audit(q, 'SHOP_ORDER_' + to, 'ShopOrder', so._id);
  await notify(so.userId, 'SHOP_ORDER_UPDATE', { orderNo: so.orderNo, status: to, tracking: so.tracking?.awb ? `AWB ${so.tracking.awb}` : '' });
  r.json(so);
}));
// affiliate / product-click report
R.get('/admin/shop/report', admin('shop'), ah(async (q, r) => {
  const paid = await M.ShopOrder.find({ status: { $nin: ['PENDING', 'CANCELLED'] } }).lean();
  const aff = await M.Product.find({ affiliateUrl: { $exists: true, $ne: '' } }).lean();
  r.json({
    orders: paid.length, revenue: paid.reduce((s, o) => s + o.total, 0),
    top: (await M.Product.find().sort('-sold').limit(5).lean()).map((p) => ({ sku: p.sku, title: p.title, sold: p.sold })),
    affiliate: aff.map((p) => ({ sku: p.sku, title: p.title, clicks: p.clicks, commissionPct: p.affiliateCommissionPct, estimatedCommission: +((p.clicks * (p.price || 0) * (p.affiliateCommissionPct || 0)) / 100 * 0.02).toFixed(2), note: 'Estimate (2% conversion maana); asli commission affiliate network se milegi' })),
  });
}));
module.exports = R;
