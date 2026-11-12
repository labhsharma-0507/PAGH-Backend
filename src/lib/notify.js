// Notifications: in-app (hamesha) + email (Resend) + SMS/WhatsApp (Twilio) + generic webhook (MSG91/Gupshup/n8n).
// Queue DB mein hai (Notif collection): fail hone par backoff ke saath 5 baar retry. Redis zaroori nahi.
const cfg = require('../config');
const { User, Notif } = require('../models');
const ads = require('./ads');

const MSG = {
  ORDER_BOOKED: { hg: ['Booking ho gayi', 'Order {orderNo} book ho gaya. Pickup OTP: {pickupOtp} (sirf agent ko dena, pickup ke time).'], en: ['Booking confirmed', 'Order {orderNo} booked. Pickup OTP: {pickupOtp} (share only with the agent at pickup).'], hi: ['बुकिंग हो गई', 'ऑर्डर {orderNo} बुक हो गया। पिकअप OTP: {pickupOtp} (सिर्फ़ एजेंट को पिकअप पर बताएँ)।'] },
  STATUS_PICKED_UP: { hg: ['Jootein pick ho gaye', 'Order {orderNo}: jootein humare paas aa gaye.'], en: ['Shoes picked up', 'Order {orderNo}: we have your shoes.'] },
  STATUS_AT_HUB: { hg: ['Hub par pahunche', 'Order {orderNo}: hub par intake chal raha hai.'], en: ['At hub', 'Order {orderNo}: intake in progress.'] },
  STATUS_CONDITION_CONFIRMED: { hg: ['Condition report ready', 'Order {orderNo}: report dekho aur {hours} ghante mein accept ya dispute karo.'], en: ['Condition report ready', 'Order {orderNo}: review it and accept or dispute within {hours} hours.'], hi: ['कंडीशन रिपोर्ट तैयार', 'ऑर्डर {orderNo}: रिपोर्ट देखें और {hours} घंटे में स्वीकार या विवाद करें।'] },
  STATUS_QUOTE_SENT: { hg: ['Quote aaya', 'Order {orderNo}: quote approve karo. Approve ke baad hi payment aur kaam shuru hoga.'], en: ['Quote ready', 'Order {orderNo}: approve the quote. Work and payment start only after approval.'], hi: ['कोट आ गया', 'ऑर्डर {orderNo}: कोट अप्रूव करें। अप्रूवल के बाद ही पेमेंट और काम शुरू होगा।'] },
  STATUS_QUOTE_APPROVED: { hg: ['Quote approve', 'Order {orderNo}: ab payment kar do. Committed date: {committed}.'], en: ['Quote approved', 'Order {orderNo}: please pay now. Committed date: {committed}.'] },
  STATUS_QUOTE_REJECTED: { hg: ['Quote reject', 'Order {orderNo}: jootein wapas bheje jaayenge.'], en: ['Quote rejected', 'Order {orderNo}: your shoes will be returned.'] },
  STATUS_NOT_REPAIRABLE: { hg: ['Repair possible nahi', 'Order {orderNo}: hub ke mutabiq repair possible nahi ({reason}). Jootein wapas bheje jaayenge.'], en: ['Not repairable', 'Order {orderNo}: not repairable ({reason}). Shoes will be returned.'] },
  STATUS_IN_REPAIR: { hg: ['Repair shuru', 'Order {orderNo}: kaam shuru ho gaya.'], en: ['Repair started', 'Order {orderNo}: work has started.'] },
  STATUS_QC: { hg: ['Quality check', 'Order {orderNo}: quality check chal raha hai.'], en: ['Quality check', 'Order {orderNo}: quality check in progress.'] },
  STATUS_READY: { hg: ['Jootein ready', 'Order {orderNo}: ready hain, jaldi delivery hogi.'], en: ['Shoes ready', 'Order {orderNo}: ready, delivery soon.'] },
  STATUS_RETURN_READY: { hg: ['Wapsi ke liye ready', 'Order {orderNo}: jootein wapsi ke liye ready hain.'], en: ['Ready for return', 'Order {orderNo}: ready to be returned.'] },
  STATUS_OUT_FOR_DELIVERY: { hg: ['Delivery ke liye nikle', 'Order {orderNo}: delivery OTP {deliveryOtp} (sirf delivery par agent ko dena).'], en: ['Out for delivery', 'Order {orderNo}: delivery OTP {deliveryOtp} (share only at delivery).'], hi: ['डिलीवरी के लिए निकले', 'ऑर्डर {orderNo}: डिलीवरी OTP {deliveryOtp} (सिर्फ़ डिलीवरी पर बताएँ)।'] },
  STATUS_DELIVERED: { hg: ['Delivered', 'Order {orderNo}: deliver ho gaya. Warranty {warrantyDays} din ki hai. Review zaroor do.'], en: ['Delivered', 'Order {orderNo}: delivered. {warrantyDays}-day warranty active. Please leave a review.'] },
  STATUS_CANCELLED: { hg: ['Order cancel', 'Order {orderNo} cancel ho gaya.'], en: ['Order cancelled', 'Order {orderNo} was cancelled.'] },
  PAYMENT_OK: { hg: ['Payment mil gaya', 'Order {orderNo}: payment successful. Ab repair shuru hoga.'], en: ['Payment received', 'Order {orderNo}: payment successful.'] },
  QUOTE_REMINDER: { hg: ['Quote ka jawab do', 'Order {orderNo}: quote approve/reject karo, warna {days} din mein auto-reject ho jayega.'], en: ['Quote reminder', 'Order {orderNo}: please respond or it auto-rejects in {days} days.'] },
  EXTRA_QUOTE: { hg: ['Extra kaam ka approval', 'Order {orderNo}: extra kaam ke liye naya quote (Rs {amount}). Approve karo.'], en: ['Extra work approval', 'Order {orderNo}: extra work quote (Rs {amount}) needs approval.'] },
  DELAY_AT_RISK: { hg: ['Delay ka risk', 'Order {orderNo}: committed date {committed} tak mushkil lag raha hai. Late hua to credit milega.'], en: ['Possible delay', 'Order {orderNo}: may miss {committed}. Late = automatic credit.'] },
  SLA_CREDIT: { hg: ['Delay credit mila', 'Order {orderNo}: late hone par Rs {amount} wallet mein add hue.'], en: ['Delay credit added', 'Order {orderNo}: Rs {amount} added to your wallet for the delay.'], hi: ['देरी का क्रेडिट मिला', 'ऑर्डर {orderNo}: देरी के लिए Rs {amount} वॉलेट में जोड़े गए।'] },
  ORDER_ON_HOLD: { hg: ['Order hold par', 'Order {orderNo}: {reason}. Deadline iske hisaab se aage badhegi.'], en: ['Order on hold', 'Order {orderNo}: {reason}. Deadline extends accordingly.'] },
  CLAIM_UPDATE: { hg: ['Claim update', 'Claim {claimNo}: status {status}. {notes}'], en: ['Claim update', 'Claim {claimNo}: {status}. {notes}'] },
  CONDITION_DISPUTE: { hg: ['Condition dispute', 'Order {orderNo} ki condition report par dispute aaya.'], en: ['Condition dispute', 'Dispute on condition report for {orderNo}.'] },
  VERDICT_REVIEWED: { hg: ['Expert review ho gaya', 'Aapke verdict ka expert review ready hai: {verdict}.'], en: ['Expert review done', 'Your verdict review is ready: {verdict}.'] },
  EMAIL_VERIFY: { hg: ['Email verify karo', 'Is link se email verify karo: {link}'], en: ['Verify your email', 'Verify your email: {link}'] },
  SHOP_ORDER_UPDATE: { hg: ['Shop order update', 'Shop order {orderNo}: {status}. {tracking}'], en: ['Shop order update', 'Shop order {orderNo}: {status}. {tracking}'] },
  PAYOUT_PAID: { hg: ['Payout ho gaya', 'Order {orderNo} ka payout Rs {amount} release hua (ref {reference}).'], en: ['Payout released', 'Payout Rs {amount} released for {orderNo} (ref {reference}).'] },
  WARRANTY_REDO: { hg: ['Redo order', 'Warranty claim approve: redo order {orderNo} ban gaya.'], en: ['Redo order created', 'Warranty approved: redo order {orderNo} created.'] },
  SLA_ALERT_ADMIN: { hg: ['SLA risk', '{count} orders deadline ke risk mein hain.'], en: ['SLA risk', '{count} orders at risk.'] },
  QUOTE_QUERY: { hg: ['Customer ka sawal', 'Order {orderNo}: customer ne quote par sawal poocha: {text}'], en: ['Customer query', 'Order {orderNo}: customer asked about the quote: {text}'] },
  JOB_ASSIGNED: { hg: ['Naya job', 'Order {orderNo} aapko assign hua.'], en: ['New job', 'Order {orderNo} assigned to you.'] },
  PARTNER_DECISION: { hg: ['Application update', 'Aapki partner application: {status}. {next}'], en: ['Application update', 'Your partner application is {status}. {next}'] },
  OTP: { hg: ['Aapka OTP', 'Footwear SOS OTP: {code} (10 minute valid). Kisi ko mat batana.'], en: ['Your OTP', 'Footwear SOS OTP: {code} (valid 10 min). Do not share.'], hi: ['आपका OTP', 'Footwear SOS OTP: {code} (10 मिनट)। किसी को न बताएँ।'] },
};
const render = (event, data, lang) => {
  const t = MSG[event];
  const pair = t ? t[lang] || t.hg || t.en : [event, JSON.stringify(data)];
  const fill = (s) => s.replace(/\{(\w+)\}/g, (_, k) => (data[k] ?? ''));
  return [fill(pair[0]), fill(pair[1])];
};
const URGENT = new Set(['OTP', 'ORDER_BOOKED', 'STATUS_QUOTE_SENT', 'STATUS_OUT_FOR_DELIVERY', 'DELAY_AT_RISK', 'SLA_CREDIT', 'CLAIM_UPDATE', 'STATUS_READY']);
const providers = () => ({
  email: !!cfg.mail.resendKey, sms: !!(cfg.twilio.sid && cfg.twilio.token && cfg.twilio.smsFrom),
  whatsapp: !!(cfg.twilio.sid && cfg.twilio.token && cfg.twilio.waFrom), webhook: !!cfg.notifyWebhook,
});
const isDev = () => !cfg.prod && !Object.values(providers()).some(Boolean);
const quiet = () => cfg.env === 'test';
const post = (url, opts) => fetch(url, { ...opts, signal: AbortSignal.timeout(8000) }).then(async (r) => { if (!r.ok) throw new Error(`${url.split('/')[2]} ${r.status}: ${(await r.text()).slice(0, 120)}`); return r; });

const send = {
  email: (u, n) => post('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + cfg.mail.resendKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: cfg.mail.from, to: u.email, subject: n.title, text: n.body }) }),
  sms: (u, n) => twilio('+91' + u.phone, cfg.twilio.smsFrom, `${n.title}: ${n.body}`),
  whatsapp: (u, n) => twilio('whatsapp:+91' + u.phone, 'whatsapp:' + cfg.twilio.waFrom, `${n.title}\n${n.body}`),
  webhook: (u, n) => post(cfg.notifyWebhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: n.event, to: u.phone, email: u.email, title: n.title, body: n.body, data: n.data, lang: u.lang }) }),
};
const twilio = (to, from, body) =>
  post(`https://api.twilio.com/2010-04-01/Accounts/${cfg.twilio.sid}/Messages.json`, {
    method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${cfg.twilio.sid}:${cfg.twilio.token}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: to, From: from, Body: body }),
  });

function channelsFor(u, event) {
  const p = providers(), out = [], prefs = u.prefs || {};
  if (p.email && u.email && prefs.email !== false) out.push('email');
  if (p.sms && u.phone && prefs.sms !== false && URGENT.has(event)) out.push('sms');
  if (p.whatsapp && u.phone && prefs.whatsapp && URGENT.has(event)) out.push('whatsapp');
  if (p.webhook) out.push('webhook');
  return out;
}
async function notify(userId, event, data = {}) {
  const u = await User.findById(userId).lean();
  if (!u || u.status === 'deleted') return;
  const [title, body] = render(event, data, u.lang);
  await Notif.create({ userId, event, channel: 'inapp', title, body, data: { ...data, pickupOtp: undefined, deliveryOtp: undefined }, status: 'SENT', read: false });
  for (const channel of channelsFor(u, event))
    await Notif.create({ userId, event, channel, title, body, data, status: 'PENDING', nextAt: new Date() });
  if (isDev() && !quiet()) console.log(`[notify:dev] ${u.email} ${event} -> ${title}: ${body}`.slice(0, 220));
}
// perm do to sirf wahi admin sub-roles ko jaata hai jinke paas wo permission hai (super ko hamesha)
const notifyAdmins = async (event, data, perm) => {
  const { PERMS } = require('../middleware/auth');
  for (const a of await User.find({ role: 'admin', status: 'active' }, '_id adminRole').lean()) {
    const p = PERMS[a.adminRole];
    if (!perm || p === '*' || (Array.isArray(p) && p.includes(perm))) await notify(a._id, event, data);
  }
};

// OTP turant (queue nahi) bhejte hain. Dev mein provider na ho to code API response mein aata hai.
async function sendOtp(u, code) {
  const [title, body] = render('OTP', { code }, u.lang);
  const n = { event: 'OTP', title, body, data: {} };
  const p = providers();
  const jobs = [];
  if (p.email && u.email) jobs.push(send.email(u, n));
  if (p.sms && u.phone) jobs.push(send.sms(u, n));
  if (p.webhook) jobs.push(send.webhook(u, n));
  await Promise.allSettled(jobs);
  if (isDev() && !quiet()) console.log(`[otp:dev] ${u.email} code=${code}`);
  return isDev() ? code : undefined;
}
async function processQueue() {
  const due = await Notif.find({ status: 'PENDING', nextAt: { $lte: new Date() } }).limit(25);
  for (const n of due) {
    const u = await User.findById(n.userId).lean();
    try {
      let out = n.toObject();
      if (n.channel === 'email' && n.event === 'STATUS_DELIVERED') {
        const ad = await ads.pick('post_delivery_email', { page: 'email' });
        if (ad) { out.body += `\n\n[Sponsored] ${ad.title}: ${ad.link}`; await ads.track(ad, 'IMPRESSION', { ua: 'mailer-ok-human' }); }
      }
      await send[n.channel](u, out);
      n.status = 'SENT';
    } catch (e) {
      n.attempts++; n.error = e.message.slice(0, 200);
      if (n.attempts >= 5) n.status = 'FAILED'; else n.nextAt = new Date(Date.now() + 2 ** n.attempts * 60000);
    }
    await n.save();
  }
  return due.length;
}
module.exports = { notify, notifyAdmins, sendOtp, processQueue, isDev, providers, render };
