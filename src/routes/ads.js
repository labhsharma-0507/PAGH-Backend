const express = require('express');
const M = require('../models');
const ads = require('../lib/ads');
const { admin, auth } = require('../middleware/auth');
const { crud } = require('../lib/crud');
const { bad, ah, str, csv, limiter } = require('../lib/util');
const { audit } = require('../lib/audit');
const R = express.Router();
const ID = (v) => { if (!M.mongoose.isValidObjectId(v)) throw bad('Bad id'); return v; };
const ctxOf = (q) => ({ page: String(q.query.page || ''), material: q.query.material, brand: q.query.brand, category: q.query.category, anon: String(q.query.anon || '').slice(0, 40), ua: q.headers['user-agent'] });

// Public: ad serve. Blocked pages (verdict/quote/claim/checkout...) par hamesha null.
R.get('/ads/placement/:slot', auth(), limiter(60e3, 120), ah(async (q, r) => {
  const ctx = ctxOf(q), c = await ads.pick(q.params.slot, ctx);
  if (!c) return r.json({ ad: null });
  await ads.track(c, 'IMPRESSION', ctx);
  r.json({ ad: { id: c._id, title: c.title, image: c.image, label: 'Ad', url: `/api/v1/ads/click/${c._id}` } });
}));
R.get('/ads/click/:id', limiter(60e3, 120), ah(async (q, r) => {
  const c = await M.Campaign.findById(ID(q.params.id)).lean();
  if (!c || c.status !== 'APPROVED') throw bad('Nahi mila', 404);
  await ads.track(c, 'CLICK', ctxOf(q));
  r.redirect(302, c.link);
}));

// ---------------- admin
crud(R, '/admin/advertisers', M.Advertiser, { perm: 'ads', fields: ['name', 'contactName', 'email', 'phone', 'notes', 'active'], search: ['name', 'email'], name: 'Advertiser', del: false,
  before: (d) => { if (d.name !== undefined && str(d.name).length < 2) throw bad('Naam do'); } });
crud(R, '/admin/campaigns', M.Campaign, {
  perm: 'ads', name: 'Campaign', search: ['name', 'title'], filters: ['status', 'placement', 'advertiserId'],
  fields: ['advertiserId', 'name', 'title', 'image', 'link', 'placement', 'startAt', 'endAt', 'budget', 'pricingModel', 'rate', 'targeting', 'freqCapPerDay', 'status', 'reviewNote'],
  before: async (d, q, old) => {
    const x = { ...(old ? old.toObject() : {}), ...d };
    if (!old) { if (!M.mongoose.isValidObjectId(d.advertiserId) || !(await M.Advertiser.exists({ _id: d.advertiserId }))) throw bad('Advertiser chuno'); d.status = 'PENDING'; }
    if (d.placement !== undefined && !ads.SLOTS.includes(d.placement)) throw bad('Placement: ' + ads.SLOTS.join(', '));
    if (d.link !== undefined && !/^https?:\/\//.test(d.link)) throw bad('Link http(s):// se shuru ho');
    if (!old && (!x.title || !x.link || !x.placement || !x.startAt || !x.endAt)) throw bad('title, link, placement, startAt, endAt zaroori');
    if (x.startAt && x.endAt && new Date(x.endAt) <= new Date(x.startAt)) throw bad('endAt startAt ke baad ho');
    if (['CPM', 'CPC'].includes(x.pricingModel) && !(+x.rate > 0)) throw bad('CPM/CPC ke liye rate do');
    if (old && d.status && ['APPROVED', 'REJECTED'].includes(d.status) && !(await M.Advertiser.exists({ _id: x.advertiserId, active: true }))) throw bad('Advertiser active nahi');
  },
});
// campaign report (JSON/CSV): impressions, clicks, CTR, spend, revenue
R.get('/admin/ads/report', admin('ads'), ah(async (q, r) => {
  const f = q.query.advertiserId ? { advertiserId: q.query.advertiserId } : {};
  const list = await M.Campaign.find(f).lean(), advs = await M.Advertiser.find().lean();
  const rows = list.map((c) => ({ campaign: c.name, advertiser: advs.find((a) => String(a._id) === String(c.advertiserId))?.name, placement: c.placement, status: c.status, model: c.pricingModel, impressions: c.impressions, clicks: c.clicks, ctrPct: c.impressions ? +((c.clicks * 100) / c.impressions).toFixed(2) : 0, spent: c.spent, revenue: ads.revenue(c) }));
  if (q.query.format === 'csv') return r.type('text/csv').send(csv(rows));
  r.json({ rows, totals: { impressions: rows.reduce((s, x) => s + x.impressions, 0), clicks: rows.reduce((s, x) => s + x.clicks, 0), revenue: +rows.reduce((s, x) => s + x.revenue, 0).toFixed(2) } });
}));
module.exports = R;
