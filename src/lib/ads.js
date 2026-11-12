// Ads engine: placement guard, targeting, budget, frequency cap, bot filter, reports.
const { Campaign, AdEvent } = require('../models');
const SLOTS = ['guide_sidebar', 'shop_banner', 'shop_sponsored', 'post_delivery_email'];
// PRD FR-ADS-7: in pages par ad kabhi serve nahi hota (server-side hard block)
const BLOCK_PAGES = ['verdict', 'quote', 'claim', 'checkout', 'condition', 'order', 'payment'];
const isBot = (ua) => !ua || /bot|spider|crawl|headless|curl|wget|python|axios/i.test(ua);
const dayStart = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const matches = (c, ctx) => {
  const t = c.targeting || {};
  const ok = (list, v) => !list || !list.length || (v && list.map((x) => x.toLowerCase()).includes(String(v).toLowerCase()));
  return ok(t.materials, ctx.material) && ok(t.brands, ctx.brand) && ok(t.categories, ctx.category);
};
async function pick(placement, ctx = {}) {
  if (!SLOTS.includes(placement) || BLOCK_PAGES.includes(String(ctx.page))) return null;
  const now = new Date();
  const list = await Campaign.find({ placement, status: 'APPROVED', startAt: { $lte: now }, endAt: { $gte: now } }).lean();
  const ok = [];
  for (const c of list) {
    if (c.pricingModel !== 'FLAT' && c.budget && c.spent >= c.budget) continue; // budget khatam
    if (!matches(c, ctx)) continue;
    if (ctx.anon && c.freqCapPerDay) {
      const n = await AdEvent.countDocuments({ campaignId: c._id, anon: ctx.anon, type: 'IMPRESSION', createdAt: { $gte: dayStart() } });
      if (n >= c.freqCapPerDay) continue;
    }
    ok.push(c);
  }
  return ok.length ? ok[Math.floor(Math.random() * ok.length)] : null;
}
async function track(c, type, ctx = {}) {
  if (isBot(ctx.ua)) return false;
  if (type === 'CLICK' && ctx.anon) {
    const dup = await AdEvent.findOne({ campaignId: c._id, anon: ctx.anon, type: 'CLICK', createdAt: { $gte: new Date(Date.now() - 30000) } });
    if (dup) return false;
  }
  await AdEvent.create({ campaignId: c._id, type, placement: c.placement, anon: ctx.anon, page: ctx.page });
  const inc = type === 'IMPRESSION' ? { impressions: 1 } : { clicks: 1 };
  if (type === 'IMPRESSION' && c.pricingModel === 'CPM') inc.spent = (c.rate || 0) / 1000;
  if (type === 'CLICK' && c.pricingModel === 'CPC') inc.spent = c.rate || 0;
  await Campaign.updateOne({ _id: c._id }, { $inc: inc });
  return true;
}
// Campaign se kitna revenue bana (FLAT = budget ko din ke hisaab se prorate)
function revenue(c) {
  if (c.pricingModel !== 'FLAT') return +(c.spent || 0).toFixed(2);
  const s = +new Date(c.startAt), e = +new Date(c.endAt);
  if (!s || !e || e <= s) return 0;
  return +((c.budget || 0) * Math.min(1, Math.max(0, (Date.now() - s) / (e - s)))).toFixed(2);
}
module.exports = { pick, track, revenue, SLOTS, BLOCK_PAGES, isBot };
