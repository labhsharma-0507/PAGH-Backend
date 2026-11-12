// Admin panel se badalne wale saare business-rule numbers. Defaults yahin hain; DB mein override hota hai.
const { Setting } = require('../models');
const REGISTRY = {
  pincodes: { def: [], desc: 'Serviceable pincodes (khali = sab jagah)' },
  warrantyDays: { def: 30, desc: 'Workmanship warranty (din)' },
  depreciation: { def: 0.2, desc: 'Cover claim mein depreciation (0.2 = 20%)' },
  slaCreditPerDay: { def: 100, desc: 'Hub-delay par credit per din (Rs)' },
  slaCapPct: { def: 30, desc: 'SLA credit ka maximum (bill ka %)' },
  atRiskHours: { def: 24, desc: 'Deadline se itne ghante pehle delay-alert' },
  deliveryFee: { def: 99, desc: 'Pickup+delivery fee (Rs), PICKUP mode' },
  freeDeliveryAbove: { def: 1500, desc: 'Is bill se upar delivery free (Rs)' },
  expressFee: { def: 150, desc: 'Express (priority) fee (Rs)' },
  returnFee: { def: 99, desc: 'Quote reject karne par return fee (Rs)' },
  minPickupBill: { def: 800, desc: 'Isse kam expected bill par pickup ki jagah drop-point suggest (Rs)' },
  platformCommissionPct: { def: 20, desc: 'Platform commission % (partner payout = baaki)' },
  dropPointPct: { def: 5, desc: 'Drop-point commission (bill ka %)' },
  reservePct: { def: 6, desc: 'Claims/credits reserve target (bill ka %)' },
  gstPct: { def: 18, desc: 'Service invoice GST % (accountant se confirm karo)' },
  shopGstPct: { def: 18, desc: 'Shop invoice GST % (product ke hisaab se accountant set kare)' },
  shopShipping: { def: 49, desc: 'Shop shipping charge (Rs)' },
  shopFreeAbove: { def: 499, desc: 'Is se upar shop shipping free (Rs)' },
  stockReserveMinutes: { def: 30, desc: 'Checkout ke baad stock reserve (minutes)' },
  quoteReminderHours: { def: 72, desc: 'Quote ka jawab na aaye to reminder (ghante)' },
  quoteExpireDays: { def: 7, desc: 'Quote ka jawab na aaye to auto-reject (din)' },
  closeAfterDays: { def: 7, desc: 'Delivery ke itne din baad order auto-close (open claim na ho)' },
  reworkTatDays: { def: 3, desc: 'Warranty redo ka TAT (din)' },
  conditionDisputeHours: { def: 48, desc: 'Condition report dispute window (ghante)' },
  aiDailyLimit: { def: 20, desc: 'Per user/IP roz AI verdict limit' },
  requireVerifiedContact: { def: 0, desc: 'Booking se pehle email ya phone verified zaroori (1=haan, 0=nahi)' },
  requireCustomerPhotos: { def: 1, desc: 'Pickup/drop se pehle customer ki condition photos zaroori (1=haan, 0=nahi)' },
  sellerName: { def: '', desc: 'Invoice par seller ka naam' },
  sellerGstin: { def: '', desc: 'Invoice par seller GSTIN' },
  supportPhone: { def: '', desc: 'Support phone (customers ko dikhega)' },
  supportEmail: { def: '', desc: 'Support email' },
};
let cache = null, at = 0;
const load = async () => {
  if (cache && Date.now() - at < 15000) return cache;
  const rows = await Setting.find().lean();
  cache = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  at = Date.now();
  return cache;
};
const get = async (k) => {
  const c = await load();
  return k in c ? c[k] : REGISTRY[k]?.def;
};
const all = async () => {
  const c = await load();
  return Object.entries(REGISTRY).map(([key, r]) => ({ key, value: key in c ? c[key] : r.def, default: r.def, desc: r.desc }));
};
const set = async (k, v) => {
  if (!REGISTRY[k]) throw Object.assign(new Error('Unknown setting'), { status: 400 });
  const d = REGISTRY[k].def;
  if (typeof d === 'number') { v = Number(v); if (!Number.isFinite(v) || v < 0) throw Object.assign(new Error('Number do (>= 0)'), { status: 400 }); }
  if (Array.isArray(d)) v = (Array.isArray(v) ? v : String(v).split(',')).map((x) => String(x).trim()).filter(Boolean);
  if (typeof d === 'string') v = String(v).slice(0, 200);
  await Setting.updateOne({ key: k }, { value: v }, { upsert: true });
  cache = null;
  return v;
};
module.exports = { get, all, set, REGISTRY };
