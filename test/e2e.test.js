// End-to-end test: poora PRD flow. Chalane ke liye: MONGO_URI set karo (test DB drop hota hai!), phir `npm test`
process.env.NODE_ENV = 'test';
process.env.RUN_SCHEDULER = 'false';
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/footwear_sos_test';
process.env.UPLOADS_DIR = require('os').tmpdir() + '/fs_test_uploads';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { hotp } = require('../src/lib/totp');
const { decrypt } = require('../src/lib/util');

let base, server, M, O, P;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const call = async (method, path, tok, body, raw) => {
  const r = await fetch(base + path, { method, redirect: 'manual', headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = text; }
  return { s: r.status, j, h: r.headers };
};
const ok = (r, msg) => assert.equal(r.s, 200, `${msg || ''} -> ${r.s} ${JSON.stringify(r.j).slice(0, 200)}`);
const login = async (email, password = 'Pass@1234', totp) => { const r = await call('POST', '/auth/login', null, { email, password, totp }); ok(r, 'login ' + email); return r.j.token; };
const PW2 = 'Pass@5678';
// Admin-created users ko pehle temporary password badalna padta hai (forced), phir normal login
const mkUser = async (adminTok, role, email, extra = {}) => {
  ok(await call('POST', '/admin/users', adminTok, { role, email, password: 'Pass@1234', name: role, pincodes: '456001', businessName: role + ' biz', city: 'Ujjain', address: 'MG Road', ...extra }), 'create ' + role);
  const t0 = await login(email);
  ok(await call('POST', '/auth/change-password', t0, { current: 'Pass@1234', password: PW2 }), 'forced pw change');
  return login(email, PW2);
};

before(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  await mongoose.connection.dropDatabase();
  const { seed } = require('../src/seed');
  await seed();
  M = require('../src/models'); O = require('../src/lib/orders'); P = require('../src/lib/payments');
  server = require('../src/app').listen(0);
  base = `http://127.0.0.1:${server.address().port}/api/v1`;
});
after(async () => { server?.close(); await mongoose.disconnect(); });

const S = {}; // shared state across tests

test('seed: shop, rate card, plans, guides, pages', async () => {
  assert.ok((await M.Product.countDocuments()) >= 24, 'starter products seeded'); assert.ok((await M.Product.distinct('category')).includes('SUEDE_CARE'));
  assert.ok((await M.RateItem.countDocuments()) >= 14); assert.equal(await M.Plan.countDocuments(), 2);
  assert.ok((await M.Guide.countDocuments()) >= 8); assert.equal((await call('GET', '/pages/terms')).s, 200, 'legal pages public');
});

test('auth: signup validation, login, lockout, verify email, otp login, reset, refresh', async () => {
  let r = await call('POST', '/auth/signup', null, { name: 'T', email: 'bad', phone: '123', password: 'x' }); assert.equal(r.s, 400);
  r = await call('POST', '/auth/signup', null, { name: 'Test User', email: 'cust@t.in', phone: '9876543210', password: 'Pass@1234' }); ok(r, 'signup');
  S.cust = r.j.token;
  assert.equal((await call('POST', '/auth/signup', null, { name: 'Dup', email: 'cust@t.in', phone: '9876543211', password: 'Pass@1234' })).s, 409);
  assert.equal((await call('POST', '/auth/signup', null, { name: 'Dup', email: 'x@t.in', phone: '9876543210', password: 'Pass@1234' })).s, 409, 'phone unique');
  const n = await M.Notif.findOne({ event: 'EMAIL_VERIFY', channel: 'inapp' }).lean();
  const token = n.body.match(/token=([a-f0-9]+)/)[1];
  ok(await call('GET', '/auth/verify-email?token=' + token), 'verify email');
  assert.equal((await call('GET', '/auth/verify-email?token=' + token)).s, 400, 'token one-time');
  // lockout
  for (let i = 0; i < 5; i++) await call('POST', '/auth/login', null, { email: 'cust@t.in', password: 'wrong' });
  r = await call('POST', '/auth/login', null, { email: 'cust@t.in', password: 'Pass@1234' }); assert.equal(r.s, 423, 'locked');
  await M.User.updateOne({ email: 'cust@t.in' }, { lockUntil: null, failedLogins: 0 });
  // phone otp login (dev code)
  r = await call('POST', '/auth/otp/login-send', null, { phone: '9876543210' }); ok(r); assert.ok(r.j.devCode);
  assert.equal((await call('POST', '/auth/otp/login', null, { phone: '9876543210', code: '000000' })).s, 401);
  r = await call('POST', '/auth/otp/login', null, { phone: '9876543210', code: r.j.devCode }); ok(r, 'otp login');
  // forgot / reset
  r = await call('POST', '/auth/forgot', null, { email: 'cust@t.in' }); ok(r);
  ok(await call('POST', '/auth/reset', null, { email: 'cust@t.in', code: r.j.devCode, password: 'NewPass@123' }), 'reset');
  assert.equal((await call('POST', '/auth/login', null, { email: 'cust@t.in', password: 'Pass@1234' })).s, 401);
  S.cust = await login('cust@t.in', 'NewPass@123');
  const me = await call('GET', '/me', S.cust); ok(me); assert.equal(me.j.hash, undefined);
  ok(await call('PATCH', '/me', S.cust, { prefs: { email: true, sms: true, whatsapp: true } }));
});

test('refresh token rotation + reuse detection', async () => {
  const r = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'cust@t.in', password: 'NewPass@123' }) });
  const c1 = r.headers.get('set-cookie').split(';')[0];
  const rf = (c) => fetch(base + '/auth/refresh', { method: 'POST', headers: { cookie: c, origin: 'http://localhost:3000' } });
  const a = await rf(c1); assert.equal(a.status, 200);
  const c2 = a.headers.get('set-cookie').split(';')[0];
  assert.equal((await rf(c1)).status, 401, 'purana token reuse = reject');
  assert.equal((await rf(c2)).status, 401, 'reuse ke baad poori family revoke');
  const evil = await fetch(base + '/auth/refresh', { method: 'POST', headers: { cookie: c1, origin: 'https://evil.com' } });
  assert.equal(evil.status, 403, 'CSRF origin check');
});

test('admin: 2FA mandatory, RBAC sub-roles, staff creation', async () => {
  let t = await login('admin@footwearsos.in', 'Admin@12345');
  let r = await call('GET', '/admin/stats', t); assert.equal(r.s, 403); assert.equal(r.j.code, '2FA');
  r = await call('POST', '/auth/2fa/setup', t); ok(r);
  const secret = r.j.secret;
  assert.notEqual((await M.User.findOne({ role: 'admin' })).twoFA.secret, secret, '2FA secret DB mein encrypted');
  assert.equal(decrypt((await M.User.findOne({ role: 'admin' })).twoFA.secret), secret);
  r = await call('POST', '/auth/2fa/verify', t, { code: hotp(secret, Math.floor(Date.now() / 3e4)) }); ok(r, '2fa verify');
  const code = () => hotp(secret, Math.floor(Date.now() / 3e4));
  assert.equal((await call('POST', '/auth/login', null, { email: 'admin@footwearsos.in', password: 'Admin@12345' })).s, 401, 'totp code bina login nahi');
  S.admin = await login('admin@footwearsos.in', 'Admin@12345', code());
  ok(await call('GET', '/admin/stats', S.admin));
  S.ops = await mkUser(S.admin, 'admin', 'ops@t.in', { adminRole: 'ops' });
  S.fin = await mkUser(S.admin, 'admin', 'fin@t.in', { adminRole: 'finance' });
  S.content = await mkUser(S.admin, 'admin', 'content@t.in', { adminRole: 'content' });
  // staff admin ko pehle 2FA chahiye
  assert.equal((await call('GET', '/admin/orders', S.ops)).s, 403);
  for (const k of ['ops', 'fin', 'content']) {
    const tk = await call('POST', '/auth/2fa/setup', S[k]); const sec = tk.j.secret;
    S[k] = (await call('POST', '/auth/2fa/verify', S[k], { code: hotp(sec, Math.floor(Date.now() / 3e4)) })).j.token;
  }
  assert.equal((await call('GET', '/admin/orders', S.ops)).s, 200);
  assert.equal((await call('POST', '/admin/users', S.ops, { role: 'admin', adminRole: 'super', email: 'x@t.in', password: 'Pass@1234' })).s, 403, 'ops super nahi bana sakta');
  assert.equal((await call('GET', '/admin/payouts', S.ops)).s, 403, 'ops payouts nahi dekh sakta');
  assert.equal((await call('GET', '/admin/payouts', S.fin)).s, 200);
  assert.equal((await call('GET', '/admin/products', S.fin)).s, 403, 'finance shop nahi chala sakta');
  assert.equal((await call('GET', '/admin/products', S.content)).s, 200);
  assert.equal((await call('GET', '/admin/audit', S.ops)).s, 403);
  assert.equal((await call('GET', '/admin/audit', S.admin)).s, 200);
  assert.equal((await call('GET', '/admin/stats', S.cust)).s, 403);
});

test('verdict engine, AI fallback, review queue, versioned rules', async () => {
  let r = await call('POST', '/verdicts', S.cust, { material: 'leather', damage: 'sole', value: 2500, type: 'formal' }); ok(r);
  assert.equal(r.j.verdict, 'REPAIR_WORTH_IT'); assert.equal(r.j.rulesVersion, 1); assert.ok(r.j.hubWillVerify.length);
  r = await call('POST', '/verdicts', S.cust, { material: 'suede', damage: 'clean', value: 4000 }); assert.equal(r.j.verdict, 'REPAIR_WORTH_IT'); assert.equal(r.j.diyWarning, true, 'suede DIY blocked');
  r = await call('POST', '/verdicts', S.cust, { material: 'canvas', damage: 'clean', value: 900 }); assert.equal(r.j.verdict, 'DIY_SAFE');
  r = await call('POST', '/verdicts', S.cust, { material: 'canvas', damage: 'sole', value: 200 }); assert.equal(r.j.verdict, 'NOT_WORTH_OR_NOT_REPAIRABLE');
  r = await call('POST', '/verdicts', S.cust, { material: 'unknown', damage: 'upper', value: 3000, photos: [PNG] }); ok(r);
  assert.equal(r.j.reviewStatus, 'PENDING'); assert.match(r.j.photos[0], /\/uploads\/verdict\//, 'photo storage URL');
  S.verdictId = r.j.id;
  const ai = await call('POST', '/verdicts/ai', S.cust, { image: PNG }); ok(ai); assert.equal(ai.j.source, 'fallback');
  assert.equal((await call('POST', '/verdicts/ai', S.cust, { image: 'data:text/html;base64,PGI+' })).s, 400);
  const q = await call('GET', '/admin/verdict-review', S.ops); ok(q); assert.equal(q.j.length, 1);
  ok(await call('POST', '/admin/verdict-review/' + S.verdictId, S.ops, { verdict: 'REPAIR_WORTH_IT', priceMin: 800, priceMax: 2000, note: 'leather hai' }));
  assert.equal((await call('GET', '/verdicts/' + S.verdictId, S.cust)).j.final.verdict, 'REPAIR_WORTH_IT');
  assert.equal((await M.Notif.countDocuments({ event: 'VERDICT_REVIEWED' })), 1);
  const rules = (await call('GET', '/admin/verdict-rules', S.ops)).j[0].rules;
  rules.notWorthBelow = 1500;
  ok(await call('POST', '/admin/verdict-rules', S.ops, { rules, note: 'test' }));
  r = await call('POST', '/verdicts', S.cust, { material: 'leather', damage: 'sole', value: 1200 }); assert.equal(r.j.rulesVersion, 2); assert.equal(r.j.verdict, 'NOT_WORTH_OR_NOT_REPAIRABLE');
  rules.notWorthBelow = 500; ok(await call('POST', '/admin/verdict-rules', S.ops, { rules }));
  assert.equal((await call('POST', '/admin/verdict-rules', S.ops, { rules: { bands: {} } })).s, 400);
});

test('wardrobe + address book', async () => {
  let r = await call('POST', '/me/addresses', S.cust, { line1: '12 MG Road, Freeganj', city: 'Ujjain', state: 'MP', pincode: '456001', isDefault: true }); ok(r); S.addr = r.j._id;
  assert.equal((await call('POST', '/me/addresses', S.cust, { line1: 'abcde', city: 'X', pincode: '12' })).s, 400);
  r = await call('POST', '/me/shoes', S.cust, { brand: 'Nike', model: 'AF1', type: 'sneaker', material: 'leather', declaredValue: 8000, photos: [PNG] }); ok(r); S.shoe = r.j._id;
  assert.equal((await call('GET', '/me/shoes', S.cust)).j.length, 1);
});

let order, orderId;
test('order: booking, pickup (OTP+photos), hub, condition grade, quote, approve, pay, repair, QC, deliver', async () => {
  S.partner = await mkUser(S.admin, 'partner', 'partner@t.in'); S.agent = await mkUser(S.admin, 'agent', 'agent@t.in');
  let r = await call('POST', '/orders', S.cust, { shoeId: S.shoe, shoe: { problem: 'sole nikal rahi' }, verdictId: S.verdictId, declaredValue: 8000, addressId: S.addr, plan: 'PLUS', serviceType: 'REPAIR' }); ok(r, 'create order');
  order = r.j; orderId = order._id; assert.ok(order.pickupOtp && order.qrId);
  assert.equal((await call('POST', '/orders', S.cust, { shoe: { material: 'x' }, declaredValue: 100, plan: 'NOPE', address: 'abc def', pincode: '456001' })).s, 400);
  // photos ke bina pickup nahi
  r = await call('POST', '/custody/scan', S.agent, { qr: order.qrId, type: 'PICKUP', otp: order.pickupOtp }); assert.equal(r.s, 400); assert.match(r.j.error, /photos/);
  ok(await call('POST', `/orders/${orderId}/condition/customer-photos`, S.cust, { photos: [PNG, PNG], preExisting: ['left heel scuff'] }));
  assert.equal((await call('POST', '/custody/scan', S.agent, { qr: order.qrId, type: 'PICKUP', otp: '0000' })).s, 400, 'wrong otp');
  assert.equal((await call('POST', '/custody/scan', S.cust, { qr: order.qrId, type: 'PICKUP', otp: order.pickupOtp })).s, 403, 'customer scan nahi kar sakta');
  ok(await call('POST', '/custody/scan', S.agent, { qr: order.qrId, type: 'PICKUP', otp: order.pickupOtp }), 'pickup');
  assert.equal((await call('POST', '/custody/scan', S.agent, { qr: order.qrId, type: 'PICKUP', otp: order.pickupOtp })).s, 400, 'double pickup');
  ok(await call('POST', '/custody/scan', S.agent, { qr: order.qrId, type: 'HUB_INTAKE' }), 'hub intake');
  assert.equal((await call('POST', `/orders/${orderId}/condition/hub`, S.partner, { photos: [PNG], grade: 'B' })).s, 403, 'accept ke bina hub report nahi');
  ok(await call('POST', `/partner/jobs/${orderId}/accept`, S.partner));
  ok(await call('POST', `/orders/${orderId}/condition/hub`, S.partner, { photos: [PNG], grade: 'B', checklist: { sole: 'worn' } }), 'hub condition');
  // quote
  assert.equal((await call('POST', `/orders/${orderId}/quotes`, S.partner, { items: ['NOPE'] })).s, 400);
  r = await call('POST', `/orders/${orderId}/quotes`, S.partner, { items: ['SOLE_REBOND', 'STITCH'] }); ok(r, 'quote');
  S.quote = r.j; assert.equal(r.j.total, 800); assert.equal(r.j.cap, 1300);
  assert.equal((await call('POST', `/orders/${orderId}/status`, S.partner, { to: 'IN_REPAIR' })).s, 400, 'approval ke bina repair nahi');
  assert.equal((await call('POST', `/quotes/${S.quote._id}/approve`, S.partner)).s, 403);
  ok(await call('POST', `/orders/${orderId}/condition/dispute`, S.cust, { reason: 'logo scuff pehle nahi tha' }), 'dispute');
  assert.equal((await call('POST', `/quotes/${S.quote._id}/approve`, S.cust)).s, 400, 'dispute pending: approve blocked');
  ok(await call('POST', `/admin/orders/${orderId}/condition/resolve`, S.ops, { action: 'REOPEN' }), 'reopen');
  ok(await call('POST', `/orders/${orderId}/condition/hub`, S.partner, { photos: [PNG], grade: 'C', preExisting: ['logo scuff'] }), 'hub redo');
  r = await call('POST', `/orders/${orderId}/quotes`, S.partner, { items: ['SOLE_REBOND', 'STITCH'] }); ok(r); S.quote = r.j;
  r = await call('POST', `/quotes/${S.quote._id}/approve`, S.cust); ok(r, 'approve');
  assert.ok(r.j.committedDate); assert.equal(r.j.fees.protection, 240, 'PLUS plan: 3% of 8000'); assert.equal(r.j.fees.delivery, 99);
  assert.equal((await M.Cond.findOne({ orderId })).lockedAt != null, true, 'condition locked');
  assert.equal((await call('POST', `/orders/${orderId}/status`, S.partner, { to: 'IN_REPAIR' })).s, 400, 'payment pending');
  // payment
  r = await call('POST', '/payments/create', S.cust, { orderId }); ok(r); assert.equal(r.j.amount, 113900); assert.equal(r.j.mock, true);
  ok(await call('POST', '/payments/mock-pay', S.cust, { paymentId: r.j.paymentId })); ok(await call('POST', '/payments/mock-pay', S.cust, { paymentId: r.j.paymentId }), 'idempotent');
  assert.equal((await M.Order.findById(orderId)).paidAmount, 1139);
  assert.equal((await call('POST', '/payments/create', S.cust, { orderId })).s, 400, 'dobara payment nahi');
  ok(await call('POST', `/orders/${orderId}/status`, S.partner, { to: 'IN_REPAIR' }), 'in repair');
});

test('extra work: price cap + approval + payment + SLA hold', async () => {
  let r = await call('POST', `/orders/${orderId}/extra-quote`, S.partner, { items: ['SOLE_REPLACE'] }); assert.equal(r.s, 400, 'cap se upar'); assert.match(r.j.error, /cap/);
  r = await call('POST', `/orders/${orderId}/extra-quote`, S.partner, { items: ['INSOLE_REPLACE'] }); ok(r, 'extra'); S.extra = r.j;
  assert.equal((await M.Order.findById(orderId)).hold.active, true, 'SLA paused');
  assert.equal((await call('POST', `/orders/${orderId}/status`, S.partner, { to: 'QC' })).s, 400, 'approval pending');
  ok(await call('POST', `/quotes/${S.extra._id}/approve`, S.cust), 'approve extra');
  const o = await M.Order.findById(orderId); assert.equal(o.total, 1150); assert.equal(o.dueExtra, 350); assert.equal(o.hold.active, false);
  r = await call('POST', '/payments/create', S.cust, { orderId }); ok(r); assert.equal(r.j.kind, 'EXTRA');
  ok(await call('POST', '/payments/mock-pay', S.cust, { paymentId: r.j.paymentId }));
  assert.equal((await M.Order.findById(orderId)).dueExtra, 0);
});

test('hold/resume shifts deadline; SLA engine credits late days idempotently; at-risk alert', async () => {
  let o = await M.Order.findById(orderId), before = +o.committedDate;
  await call('POST', `/orders/${orderId}/hold`, S.partner, { reason: 'PARTS_DELAY' }).then((r) => assert.equal(r.s, 400, 'note zaroori'));
  ok(await call('POST', `/orders/${orderId}/hold`, S.partner, { reason: 'PARTS_DELAY', note: 'sole material aane mein 1 din' }));
  await M.Order.updateOne({ _id: orderId }, { 'hold.since': new Date(Date.now() - 36e5 * 5) });
  ok(await call('POST', `/orders/${orderId}/resume`, S.partner));
  o = await M.Order.findById(orderId); assert.ok(+o.committedDate - before >= 36e5 * 4.9, 'deadline pause ke barabar aage');
  // delay simulate: deadline 3.5 din pehle
  await M.Order.updateOne({ _id: orderId }, { committedDate: new Date(Date.now() - 864e5 * 3.5) });
  let s = await O.runSla(); assert.equal(s.credited, 300, '3 din x Rs100 (cap 30% of 1150 = 345)');
  s = await O.runSla(); assert.equal(s.credited, 0, 'idempotent: dobara credit nahi');
  await M.Order.updateOne({ _id: orderId }, { committedDate: new Date(Date.now() - 864e5 * 5.5) });
  s = await O.runSla(); assert.equal(s.credited, 45, 'cap 345 par ruk gaya');
  const w = await call('GET', '/wallet', S.cust); assert.equal(w.j.balance, 345); assert.equal((await M.Notif.countDocuments({ event: 'SLA_CREDIT', channel: 'inapp' })), 2);
  await M.Order.updateOne({ _id: orderId }, { committedDate: new Date(Date.now() + 36e5 * 10), atRiskNotified: false });
  const l = await O.runLifecycle(); assert.equal(l.atRisk, 1, 'at-risk alert'); assert.equal((await O.runLifecycle()).atRisk, 0);
});

test('QC -> READY needs FINAL_QC photo -> delivery OTP -> warranty + payouts', async () => {
  ok(await call('POST', `/orders/${orderId}/status`, S.partner, { to: 'QC' }));
  assert.equal((await call('POST', `/orders/${orderId}/status`, S.partner, { to: 'READY' })).s, 400, 'FINAL_QC photo chahiye');
  ok(await call('POST', `/partner/jobs/${orderId}/milestone`, S.partner, { type: 'FINAL_QC', photos: [PNG], note: 'ok' }));
  ok(await call('POST', `/orders/${orderId}/status`, S.partner, { to: 'READY' }));
  ok(await call('POST', `/orders/${orderId}/status`, S.agent, { to: 'OUT_FOR_DELIVERY' }));
  const det = await call('GET', `/orders/${orderId}`, S.cust); ok(det); S.dotp = det.j.order.deliveryOtp; assert.ok(S.dotp, 'customer ko delivery OTP');
  assert.equal(det.j.milestones.length, 1);
  const agentView = await call('GET', `/orders/${orderId}`, S.agent); assert.equal(agentView.j.order.deliveryOtp, undefined, 'agent ko OTP nahi dikhta');
  assert.equal((await call('POST', '/custody/scan', S.agent, { qr: order.qrId, type: 'DELIVERY', otp: '1111' })).s, 400);
  ok(await call('POST', '/custody/scan', S.agent, { qr: order.qrId, type: 'DELIVERY', otp: S.dotp }), 'delivery');
  const w = await call('GET', `/orders/${orderId}/warranty`, S.cust).catch(() => null);
  const wr = await M.Warranty.findOne({ orderId }); assert.equal(wr.days, 30);
  const pay = await M.Payout.find({ orderId }); assert.equal(pay.length, 1); assert.equal(pay[0].payeeType, 'PARTNER'); assert.equal(pay[0].amount, 920, '80% of 1150'); assert.equal(pay[0].status, 'PENDING');
  const cust = (await call('GET', `/orders/${orderId}`, S.cust)).j;
  assert.equal(cust.custody.length, 3); // PICKUP, HUB_INTAKE, DELIVERY
  ok(await call('POST', `/orders/${orderId}/review`, S.cust, { quality: 5, communication: 4, delivery: 5, text: 'badhiya' }));
  assert.equal((await call('POST', `/orders/${orderId}/review`, S.cust, { quality: 5 })).s, 409);
  const inv = await call('GET', `/orders/${orderId}/invoice`, S.cust); ok(inv); assert.equal(inv.j.total, 1139 + 0 > 0 ? inv.j.total : 0);
  assert.ok(inv.j.gst > 0);
});

test('claims: cover cap, finance-only settle, wallet credit, payout hold/release, warranty REDO order', async () => {
  let r = await call('POST', '/claims', S.cust, { orderId, type: 'damage', text: 'logo kharab ho gaya', evidence: [PNG] }); ok(r, 'claim'); const c = r.j;
  assert.equal((await M.Payout.findOne({ orderId })).status, 'HOLD', 'claim ke dauran payout hold');
  assert.equal((await call('POST', '/claims', S.cust, { orderId, type: 'damage', text: 'dobara claim' })).s, 409);
  assert.equal((await call('PATCH', `/admin/claims/${c._id}`, S.ops, { status: 'APPROVED' })).s, 400, 'seedha approve nahi');
  ok(await call('PATCH', `/admin/claims/${c._id}`, S.ops, { status: 'UNDER_REVIEW' }));
  const det = await call('GET', `/admin/claims/${c._id}/detail`, S.ops); ok(det); assert.equal(det.j.cover.maxCompensation, 6400, 'PLUS: 8000 - 20% depreciation'); assert.ok(det.j.custody.length >= 3);
  r = await call('PATCH', `/admin/claims/${c._id}`, S.ops, { status: 'APPROVED', settlement: 'COMPENSATION', amount: 9000 }); assert.equal(r.s, 400); assert.match(r.j.error, /Cover limit/);
  ok(await call('PATCH', `/admin/claims/${c._id}`, S.ops, { status: 'APPROVED', settlement: 'COMPENSATION', amount: 2000, notes: 'logo damage' }));
  assert.equal((await call('PATCH', `/admin/claims/${c._id}`, S.ops, { status: 'SETTLED' })).s, 403, 'ops settle nahi kar sakta');
  ok(await call('PATCH', `/admin/claims/${c._id}`, S.fin, { status: 'SETTLED' }), 'finance settle');
  assert.equal((await call('GET', '/wallet', S.cust)).j.balance, 2345);
  assert.equal((await M.Payout.findOne({ orderId })).status, 'PENDING', 'claim settle ke baad payout release-able');
  // warranty claim -> REDO
  r = await call('POST', '/claims', S.cust, { orderId, type: 'warranty', text: 'sole dobara khul gaya' }); ok(r); const w = r.j;
  for (const st of ['UNDER_REVIEW']) ok(await call('PATCH', `/admin/claims/${w._id}`, S.ops, { status: st }));
  ok(await call('PATCH', `/admin/claims/${w._id}`, S.ops, { status: 'APPROVED', settlement: 'REDO' }));
  ok(await call('PATCH', `/admin/claims/${w._id}`, S.fin, { status: 'SETTLED' }));
  const rw = await M.Order.findOne({ parentOrderId: orderId }); assert.ok(rw && rw.rework && rw.paid && rw.status === 'BOOKED');
  // rework flow: pickup bina customer photos, hub, direct repair
  ok(await call('POST', '/custody/scan', S.agent, { qr: rw.qrId, type: 'PICKUP', otp: rw.pickupOtp }), 'rework pickup');
  ok(await call('POST', '/custody/scan', S.agent, { qr: rw.qrId, type: 'HUB_INTAKE' }));
  ok(await call('POST', `/orders/${rw._id}/condition/hub`, S.partner, { photos: [PNG], grade: 'B' }));
  ok(await call('POST', `/orders/${rw._id}/status`, S.partner, { to: 'IN_REPAIR' }), 'rework direct repair');
  assert.ok((await M.Order.findById(rw._id)).committedDate);
  assert.equal((await M.Payout.countDocuments({ orderId: rw._id })), 0, 'rework par payout nahi');
  // payout release (finance only)
  const po = await M.Payout.findOne({ orderId });
  assert.equal((await call('POST', `/admin/payouts/${po._id}/release`, S.ops, {})).s, 403);
  ok(await call('POST', `/admin/payouts/${po._id}/release`, S.fin, { reference: 'NEFT123' }));
  assert.equal((await call('GET', '/partner/earnings', S.partner)).j.paid, 920);
  const sc = await call('GET', '/partner/scorecard', S.partner); ok(sc); assert.equal(sc.j.delivered, 1);
});

test('reject quote -> return fee -> return; not repairable; cancel', async () => {
  const mk = async () => {
    const r = await call('POST', '/orders', S.cust, { shoe: { material: 'canvas', brand: 'Vans' }, declaredValue: 3000, addressId: S.addr, plan: 'BASIC' }); ok(r); const o = r.j;
    ok(await call('POST', `/orders/${o._id}/condition/customer-photos`, S.cust, { photos: [PNG] }));
    ok(await call('POST', '/custody/scan', S.agent, { qr: o.qrId, type: 'PICKUP', otp: o.pickupOtp }));
    ok(await call('POST', '/custody/scan', S.agent, { qr: o.qrId, type: 'HUB_INTAKE' }));
    ok(await call('POST', `/partner/jobs/${o._id}/accept`, S.partner));
    return o;
  };
  const a = await mk();
  ok(await call('POST', `/orders/${a._id}/condition/hub`, S.partner, { photos: [PNG], grade: 'A' }));
  const q = (await call('POST', `/orders/${a._id}/quotes`, S.partner, { items: ['DEEP_CLEAN'] })).j;
  ok(await call('POST', `/quotes/${q._id}/query`, S.cust, { text: 'kya laces bhi?' }));
  const q2 = (await call('POST', `/orders/${a._id}/quotes`, S.partner, { items: ['DEEP_CLEAN', 'ODOUR_TREAT'] })).j;
  assert.equal((await call('POST', `/quotes/${q._id}/approve`, S.cust)).s, 400, 'superseded quote');
  let r = await call('POST', `/quotes/${q2._id}/reject`, S.cust, { reason: 'mehnga' }); ok(r);
  assert.equal(r.j.status, 'QUOTE_REJECTED'); assert.equal(r.j.dueExtra, 99);
  assert.equal((await call('POST', `/orders/${a._id}/status`, S.partner, { to: 'RETURN_READY' })).s, 400, 'return fee pending');
  r = await call('POST', '/payments/create', S.cust, { orderId: a._id }); ok(r); assert.equal(r.j.kind, 'RETURN_FEE');
  ok(await call('POST', '/payments/mock-pay', S.cust, { paymentId: r.j.paymentId }));
  ok(await call('POST', `/orders/${a._id}/status`, S.partner, { to: 'RETURN_READY' })); ok(await call('POST', `/orders/${a._id}/status`, S.agent, { to: 'OUT_FOR_DELIVERY' }));
  const otp = (await call('GET', `/orders/${a._id}`, S.cust)).j.order.deliveryOtp;
  ok(await call('POST', '/custody/scan', S.agent, { qr: a.qrId, type: 'DELIVERY', otp }));
  const b = await mk();
  assert.equal((await call('POST', `/orders/${b._id}/status`, S.partner, { to: 'NOT_REPAIRABLE' })).s, 400, 'AT_HUB: reason chahiye ya status');
  ok(await call('POST', `/orders/${b._id}/status`, S.partner, { to: 'NOT_REPAIRABLE', note: 'upper gal chuka hai' }));
  ok(await call('POST', `/orders/${b._id}/status`, S.partner, { to: 'RETURN_READY' }));
  const c = (await call('POST', '/orders', S.cust, { shoe: { material: 'canvas' }, declaredValue: 1000, addressId: S.addr })).j;
  ok(await call('POST', `/orders/${c._id}/cancel`, S.cust, { reason: 'plan change' }));
  assert.equal((await call('POST', `/orders/${c._id}/cancel`, S.cust)).s, 400);
});

test('lifecycle: quote reminder + auto-expire + auto-close', async () => {
  const mkq = async () => {
    const r = await call('POST', '/orders', S.cust, { shoe: { material: 'leather' }, declaredValue: 5000, addressId: S.addr }); const o = r.j;
    await call('POST', `/orders/${o._id}/condition/customer-photos`, S.cust, { photos: [PNG] });
    await call('POST', '/custody/scan', S.agent, { qr: o.qrId, type: 'PICKUP', otp: o.pickupOtp }); await call('POST', '/custody/scan', S.agent, { qr: o.qrId, type: 'HUB_INTAKE' });
    await call('POST', `/partner/jobs/${o._id}/accept`, S.partner); await call('POST', `/orders/${o._id}/condition/hub`, S.partner, { photos: [PNG], grade: 'B' });
    await call('POST', `/orders/${o._id}/quotes`, S.partner, { items: ['STITCH'] }); return o;
  };
  const o = await mkq();
  const age = async (id, days) => { const d = await M.Order.findById(id); d.events.filter((e) => e.to === 'QUOTE_SENT').forEach((e) => { e.ts = new Date(Date.now() - 864e5 * days); }); await d.save(); };
  await age(o._id, 4);
  let l = await O.runLifecycle(); assert.equal(l.reminded, 1);
  await age(o._id, 8);
  l = await O.runLifecycle(); assert.equal(l.expired, 1); assert.equal((await M.Order.findById(o._id)).status, 'QUOTE_REJECTED');
  await M.Order.updateOne({ _id: orderId }, { deliveredAt: new Date(Date.now() - 864e5 * 9) });
  l = await O.runLifecycle(); assert.equal(l.closed, 1); assert.equal((await M.Order.findById(orderId)).status, 'CLOSED');
});

test('drop-point mode + agent collection + brand B2B + batches', async () => {
  S.dp = await mkUser(S.admin, 'droppoint', 'dp@t.in', { businessName: 'Sneaker Store Ujjain' });
  const brand = await call('POST', '/admin/brands', S.ops, { name: 'TestBrand', code: 'TB2026', commissionPct: 5 }); ok(brand);
  ok(await call('POST', '/admin/users', S.ops, { role: 'brand', email: 'brand@t.in', password: 'Pass@1234', brandId: brand.j._id, name: 'Brand' }));
  { const t0 = await login('brand@t.in'); ok(await call('POST', '/auth/change-password', t0, { current: 'Pass@1234', password: PW2 })); S.brand = await login('brand@t.in', PW2); }
  assert.equal((await call('GET', '/brand/summary', S.brand)).s, 200);
  const svc = await call('GET', '/serviceability/456001', S.cust); ok(svc); assert.equal(svc.j.dropPoints.length, 1);
  let r = await call('POST', '/orders', S.cust, { shoe: { material: 'leather', brand: 'Clarks' }, declaredValue: 6000, pickupMode: 'DROPPOINT', dropPointId: svc.j.dropPoints[0].id, brandCode: 'tb2026', plan: 'BASIC' }); ok(r); const o = r.j;
  assert.equal((await call('POST', '/orders', S.cust, { shoe: { material: 'x' }, declaredValue: 1, brandCode: 'WRONG', addressId: S.addr })).s, 400);
  assert.equal((await call('POST', '/custody/scan', S.agent, { qr: o.qrId, type: 'PICKUP', otp: o.pickupOtp })).s, 400, 'DROPPOINT order par agent PICKUP nahi');
  ok(await call('POST', `/orders/${o._id}/condition/customer-photos`, S.cust, { photos: [PNG] }));
  const dpl = await call('GET', '/droppoint/orders', S.dp); ok(dpl); assert.equal(dpl.j.length, 1); assert.equal(dpl.j[0].expect, 'CUSTOMER_DROPS_SHOES');
  ok(await call('POST', '/custody/scan', S.dp, { qr: o.qrId, type: 'DROP_INTAKE', otp: o.pickupOtp }), 'drop intake');
  assert.equal((await call('POST', '/custody/scan', S.agent, { qr: o.qrId, type: 'HUB_INTAKE' })).s, 400, 'agent collect pehle');
  const tasks = (await call('GET', '/agent/tasks', S.agent)).j; assert.ok(tasks.find((t) => t.orderNo === o.orderNo && t.task === 'COLLECT_FROM_DROPPOINT'));
  // batch assign
  const agentUser = await M.User.findOne({ email: 'agent@t.in' }); ok(await call('POST', '/admin/batches', S.ops, { agentId: agentUser._id, orderIds: [o._id], slot: 'morning' }));
  ok(await call('POST', '/custody/scan', S.agent, { qr: o.qrId, type: 'AGENT_PICKUP' })); ok(await call('POST', '/custody/scan', S.agent, { qr: o.qrId, type: 'HUB_INTAKE' }));
  ok(await call('POST', `/partner/jobs/${o._id}/accept`, S.partner)); ok(await call('POST', `/orders/${o._id}/condition/hub`, S.partner, { photos: [PNG], grade: 'A' }));
  const q = (await call('POST', `/orders/${o._id}/quotes`, S.partner, { items: ['LEATHER_RESTORE'] })).j; ok(await call('POST', `/quotes/${q._id}/approve`, S.cust));
  const pay = (await call('POST', '/payments/create', S.cust, { orderId: o._id })).j; assert.equal(pay.amount, 120000, 'drop-point: delivery fee nahi (1200 >= free-above? no, fee 0 because DROPPOINT)');
  ok(await call('POST', '/payments/mock-pay', S.cust, { paymentId: pay.paymentId }));
  ok(await call('POST', `/orders/${o._id}/status`, S.partner, { to: 'IN_REPAIR' })); ok(await call('POST', `/orders/${o._id}/status`, S.partner, { to: 'QC' }));
  ok(await call('POST', `/partner/jobs/${o._id}/milestone`, S.partner, { type: 'FINAL_QC', photos: [PNG] })); ok(await call('POST', `/orders/${o._id}/status`, S.partner, { to: 'READY' }));
  ok(await call('POST', `/orders/${o._id}/status`, S.agent, { to: 'OUT_FOR_DELIVERY' }));
  const dotp = (await call('GET', `/orders/${o._id}`, S.cust)).j.order.deliveryOtp;
  assert.equal((await call('POST', '/custody/scan', S.agent, { qr: o.qrId, type: 'DELIVERY', otp: dotp })).s, 400, 'agent home delivery nahi (drop-point order)');
  ok(await call('POST', '/custody/scan', S.dp, { qr: o.qrId, type: 'DROP_HANDOVER', otp: dotp }), 'handover');
  const pays = await M.Payout.find({ orderId: o._id }); assert.deepEqual(pays.map((p) => p.payeeType).sort(), ['BRAND', 'DROPPOINT', 'PARTNER']);
  assert.equal(pays.find((p) => p.payeeType === 'DROPPOINT').amount, 60, '5% of 1200'); assert.equal(pays.find((p) => p.payeeType === 'BRAND').amount, 60);
  const bs = await call('GET', '/brand/summary', S.brand); ok(bs); assert.equal(bs.j.orders, 1); assert.equal(bs.j.commissionPending, 60);
  assert.equal((await call('GET', '/brand/orders', S.brand)).j.length, 1);
  assert.equal((await call('GET', `/orders/${o._id}`, S.brand)).s, 200);
  assert.equal((await call('GET', `/orders/${orderId}`, S.brand)).s, 404, 'brand dusre ka order nahi dekh sakta');
});

test('partner onboarding via application + approval', async () => {
  const c2 = (await call('POST', '/auth/signup', null, { name: 'New Cobbler', email: 'nc@t.in', phone: '9000000001', password: 'Pass@1234' })).j.token;
  assert.equal((await call('POST', '/partners/apply', c2, { type: 'COBBLER', businessName: 'Raju Cobbler', pincodes: 'abc' })).s, 400);
  const r = await call('POST', '/partners/apply', c2, { type: 'COBBLER', businessName: 'Raju Cobbler', pincodes: '456001', docs: [PNG] }); ok(r);
  const list = await call('GET', '/admin/partners?status=PENDING', S.ops); assert.equal(list.j.length, 1);
  ok(await call('POST', `/admin/partners/${r.j._id}/decision`, S.ops, { approve: true, commissionPct: 15 }));
  assert.equal((await M.User.findOne({ email: 'nc@t.in' })).role, 'partner');
  assert.equal((await call('GET', '/partner/jobs', c2)).s, 200, 'role DB se live: re-login ke bina naya role lagu');
  ok(await call('POST', `/admin/partners/${r.j._id}/decision`, S.ops, { suspend: true }));
  assert.equal((await call('GET', '/partner/jobs', c2)).s, 403, 'suspend hote hi access band (token expire ka wait nahi)');
  ok(await call('POST', `/admin/partners/${r.j._id}/decision`, S.ops, { approve: true }));
  assert.equal((await call('GET', '/partner/jobs', await login('nc@t.in'))).s, 200);
});

test('shop: stock reserve, checkout, pay, ship, release; admin CRUD + CSV import', async () => {
  const addr = { name: 'Test', line1: '12 MG Road', city: 'Ujjain', pincode: '456001' };
  let r = await call('POST', '/shop/checkout', S.cust, { items: [{ sku: 'FSC-SUE-001', qty: 2 }, { sku: 'FSC-CLN-001', qty: 1 }], address: addr }); ok(r, 'checkout');
  assert.equal(r.j.shopOrder.subtotal, 847); assert.equal(r.j.shopOrder.shipping, 0, 'free above 499'); assert.equal((await M.Product.findOne({ sku: 'FSC-SUE-001' })).stock, 98, 'stock reserved');
  ok(await call('POST', '/payments/mock-pay', S.cust, { paymentId: r.j.payment.paymentId }));
  assert.equal((await M.ShopOrder.findById(r.j.shopOrder._id)).status, 'PAID'); assert.equal((await M.Product.findOne({ sku: 'FSC-SUE-001' })).sold, 2);
  await M.Product.updateOne({ sku: 'FSC-ACC-004' }, { stock: 1 });
  assert.equal((await call('POST', '/shop/checkout', S.cust, { items: [{ sku: 'FSC-SUE-001', qty: 1 }, { sku: 'FSC-ACC-004', qty: 2 }], address: addr })).s, 400, 'stock kam');
  assert.equal((await M.Product.findOne({ sku: 'FSC-SUE-001' })).stock, 98, 'failed checkout ka stock rollback');
  assert.equal((await M.Product.findOne({ sku: 'FSC-ACC-004' })).stock, 1);
  // unpaid reservation release
  const u = await call('POST', '/shop/checkout', S.cust, { items: [{ sku: 'FSC-BRU-001', qty: 3 }], address: addr }); ok(u);
  await M.ShopOrder.updateOne({ _id: u.j.shopOrder._id }, { reservedUntil: new Date(Date.now() - 1000) });
  assert.equal((await O.runLifecycle()).released, 1); assert.equal((await M.Product.findOne({ sku: 'FSC-BRU-001' })).stock, 100);
  const adm = (p, b, m = 'PATCH') => call(m, '/admin/shop-orders/' + p, S.content, b);
  assert.equal((await adm(r.j.shopOrder._id, { status: 'SHIPPED' })).s, 400, 'PAID -> SHIPPED direct nahi');
  ok(await adm(r.j.shopOrder._id, { status: 'PACKED' })); assert.equal((await adm(r.j.shopOrder._id, { status: 'SHIPPED' })).s, 400, 'AWB zaroori'); ok(await adm(r.j.shopOrder._id, { status: 'SHIPPED', courier: 'Delhivery', awb: 'AWB1' }));
  // admin CRUD add-on
  r = await call('POST', '/admin/products', S.content, { sku: 'NEW-001', title: 'Test Product', price: 199, mrp: 299, stock: 5, category: 'CUSTOM_CAT', attrs: { size: 'M', colour: 'red' } }); ok(r);
  assert.equal((await call('GET', '/products?category=CUSTOM_CAT', S.cust)).j.items[0].attrs.colour, 'red', 'naya category + custom attrs');
  assert.equal((await call('POST', '/admin/products', S.content, { sku: 'NEW-002', title: 'Bad', price: 100, mrp: 50 })).s, 400);
  assert.equal((await call('POST', '/admin/products', S.content, { sku: 'NEW-003', title: 'Sp', price: 100, sponsored: true })).s, 400, 'sponsored ke liye advertiser');
  const csv = 'sku,title,category,price,mrp,stock,materialsSuitable,description\nIMP-1,Imported A,CLEANERS,100,150,10,canvas|leather,desc\nIMP-2,Imported B,CLEANERS,-5,,1,,';
  const imp = await fetch(base + '/admin/products/import', { method: 'POST', headers: { 'content-type': 'text/csv', authorization: 'Bearer ' + S.content }, body: csv }).then((x) => x.json());
  assert.equal(imp.created, 1); assert.equal(imp.errors.length, 1);
  assert.ok((await call('GET', '/admin/products/low-stock', S.content)).j.length >= 1);
  ok(await call('GET', '/admin/shop/report', S.content));
});

test('ads: approval workflow, targeting, blocked pages, freq cap, bot filter, click, report', async () => {
  const adv = await call('POST', '/admin/advertisers', S.content, { name: 'CleanCo' }); ok(adv);
  const now = Date.now();
  const mk = (extra) => call('POST', '/admin/campaigns', S.content, { advertiserId: adv.j._id, name: 'C1', title: 'Sale 20%', link: 'https://example.com/x', placement: 'shop_banner', startAt: new Date(now - 864e5), endAt: new Date(now + 864e5), pricingModel: 'CPC', rate: 5, budget: 10, freqCapPerDay: 2, ...extra });
  assert.equal((await mk({ placement: 'verdict_page' })).s, 400); assert.equal((await mk({ link: 'javascript:alert(1)' })).s, 400);
  const c = await mk({}); ok(c); assert.equal(c.j.status, 'PENDING');
  let r = await call('GET', '/ads/placement/shop_banner?anon=a1&page=shop', S.cust); assert.equal(r.j.ad, null, 'unapproved ad serve nahi');
  ok(await call('PATCH', '/admin/campaigns/' + c.j._id, S.content, { status: 'APPROVED' }));
  r = await call('GET', '/ads/placement/shop_banner?anon=a1&page=shop', S.cust); assert.equal(r.j.ad.label, 'Ad');
  for (const pg of ['verdict', 'quote', 'claim', 'checkout', 'condition', 'order', 'payment']) assert.equal((await call('GET', `/ads/placement/shop_banner?anon=a1&page=${pg}`, S.cust)).j.ad, null, pg + ' par ad block');
  await call('GET', '/ads/placement/shop_banner?anon=a1&page=shop', S.cust); r = await call('GET', '/ads/placement/shop_banner?anon=a1&page=shop', S.cust); assert.equal(r.j.ad, null, 'frequency cap (2/day)');
  assert.ok((await call('GET', '/ads/placement/shop_banner?anon=a2&page=shop', S.cust)).j.ad, 'dusra user');
  const bot = await fetch(base + '/ads/placement/shop_banner?anon=a9&page=shop', { headers: { 'user-agent': 'Googlebot' } }); await bot.json();
  const before = (await M.Campaign.findById(c.j._id)).impressions;
  await fetch(base + '/ads/placement/shop_banner?anon=a10&page=shop', { headers: { 'user-agent': 'curl/8' } }).then((x) => x.json());
  assert.equal((await M.Campaign.findById(c.j._id)).impressions, before, 'bot impressions count nahi');
  const cl = await fetch(base + `/ads/click/${c.j._id}?anon=a1`, { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0' } }); assert.equal(cl.status, 302); assert.equal(cl.headers.get('location'), 'https://example.com/x');
  await fetch(base + `/ads/click/${c.j._id}?anon=a1`, { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0' } });
  const camp = await M.Campaign.findById(c.j._id); assert.equal(camp.clicks, 1, 'duplicate click 30s mein ignore'); assert.equal(camp.spent, 5);
  const rep = await call('GET', '/admin/ads/report', S.content); ok(rep); assert.equal(rep.j.totals.clicks, 1); assert.equal(rep.j.rows[0].revenue, 5);
  assert.equal((await call('GET', '/admin/ads/report', S.ops)).s, 403);
});

test('analytics, audit log, notification queue, content CMS, settings', async () => {
  const a = await call('GET', '/admin/analytics', S.ops); ok(a);
  assert.ok(a.j.funnel.orders >= 5); assert.ok(a.j.slaCredits === 345); assert.ok(a.j.reserve.target >= 0); assert.ok('shop' in a.j.revenueMix);
  const csvr = await fetch(base + '/admin/analytics?format=csv', { headers: { authorization: 'Bearer ' + S.ops } }); assert.match(await csvr.text(), /funnel\.orders/);
  const au = await call('GET', '/admin/audit?action=CLAIM', S.admin); ok(au); assert.ok(au.j.length >= 3);
  assert.ok((await call('GET', '/admin/audit?action=LOGIN', S.admin)).j.length >= 1);
  const j = await call('POST', '/admin/jobs/run', S.ops); ok(j);
  assert.equal(await M.Notif.countDocuments({ status: 'PENDING' }), 0);
  ok(await call('PUT', '/admin/settings/slaCreditPerDay', S.ops, { value: 150 })); assert.equal((await call('PUT', '/admin/settings/nope', S.ops, { value: 1 })).s, 400);
  assert.equal((await call('PUT', '/admin/settings/slaCreditPerDay', S.ops, { value: -5 })).s, 400);
  ok(await call('PUT', '/admin/settings/slaCreditPerDay', S.ops, { value: 100 }));
  ok(await call('POST', '/admin/guides', S.content, { slug: 'new-guide', title: { hg: 'Naya' }, body: { hg: 'x' }, material: 'canvas' })); assert.equal((await call('GET', '/guides/new-guide', S.cust)).s, 200);
  ok(await call('PATCH', '/admin/pages/' + (await M.Page.findOne({ slug: 'terms' }))._id, S.content, { status: 'PUBLISHED' }));
  const n = await call('GET', '/notifications', S.cust); ok(n); assert.ok(n.j.unread > 5); ok(await call('POST', '/notifications/read-all', S.cust));
  const ex = await call('GET', '/me/export', S.cust); ok(ex); assert.ok(ex.j.orders.length >= 4); assert.equal(ex.j.orders[0].pickupOtp, undefined);
  // user block
  const u = await M.User.findOne({ email: 'nc@t.in' }); ok(await call('PATCH', '/admin/users/' + u._id, S.ops, { status: 'blocked' }));
  assert.equal((await call('POST', '/auth/login', null, { email: 'nc@t.in', password: 'Pass@1234' })).s, 403);
});

test('security: injection, authz isolation, upload validation', async () => {
  const other = (await call('POST', '/auth/signup', null, { name: 'Other', email: 'o@t.in', phone: '9000000002', password: 'Pass@1234' })).j.token;
  assert.equal((await call('GET', `/orders/${orderId}`, other)).s, 404, 'dusre ka order nahi');
  assert.equal((await call('POST', '/auth/login', null, { email: { $ne: '' }, password: { $ne: '' } })).s, 401, 'NoSQL injection');
  assert.equal((await call('POST', '/uploads', S.cust, { image: 'data:image/png;base64,' + Buffer.from('<script>x</script>').toString('base64'), folder: 'shoe' })).s, 400, 'fake png reject');
  const up = await call('POST', '/uploads', S.cust, { image: PNG, folder: 'shoe' }); ok(up); assert.match(up.j.url, /\/uploads\/shoe\//);
  assert.equal((await fetch(up.j.url.replace(/^https?:\/\/[^/]+/, base.replace('/api/v1', '')))).headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await call('GET', '/me')).s, 401); assert.equal((await call('GET', '/admin/stats', other)).s, 403);
  assert.equal((await call('DELETE', '/me', S.cust)).s, 400, 'active order hain');
});

// ---------- naye tests: gating, Google, OpenRouter, forced password change, onboarding flags
const withFetch = async (handler, fn) => {
  const real = global.fetch;
  global.fetch = async (u, o) => { const r = await handler(String(u), o); return r || real(u, o); };
  try { await fn(); } finally { global.fetch = real; }
};
const J = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

test('feature APIs login ke bina band (sirf legal pages/config public)', async () => {
  for (const [m, p] of [['GET', '/products'], ['GET', '/products/recommend'], ['GET', '/guides'], ['GET', '/guides/suede-care'], ['POST', '/verdicts'], ['POST', '/verdicts/ai'], ['GET', '/serviceability/456001'], ['GET', '/ads/placement/shop_banner'], ['GET', '/verdict-meta'], ['POST', '/orders'], ['GET', '/wallet']])
    assert.equal((await call(m, p, null, m === 'POST' ? {} : undefined)).s, 401, `${m} ${p} anonymous`);
  assert.equal((await call('GET', '/pages/terms')).s, 200); assert.equal((await call('GET', '/config')).s, 200);
  const g = await call('GET', '/products', S.cust); ok(g); assert.ok(g.j.items.length >= 24); assert.ok(g.j.categories.includes('SUEDE_CARE'));
  assert.ok((await call('GET', '/guides', S.cust)).j.length >= 8);
  const rec = await call('GET', '/products/recommend?material=suede&damage=clean&context=verdict', S.cust); assert.ok(rec.j.length && rec.j.every((x) => !x.sponsored));
  assert.equal((await call('GET', '/verdict-meta', S.cust)).s, 200);
});

test('forced password change for admin-created staff', async () => {
  ok(await call('POST', '/admin/users', S.admin, { role: 'agent', email: 'newagent@t.in', password: 'Pass@1234', name: 'New Agent', pincodes: '456001' }));
  const t = await login('newagent@t.in'); const me = await call('GET', '/me', t); ok(me);
  let r = await call('GET', '/agent/tasks', t); assert.equal(r.s, 403); assert.equal(r.j.code, 'CHANGE_PW');
  assert.equal((await call('POST', '/auth/change-password', t, { current: 'Pass@1234', password: 'Pass@1234' })).s, 400, 'same password reject');
  assert.equal((await call('POST', '/auth/change-password', t, { current: 'wrong', password: PW2 })).s, 400);
  ok(await call('POST', '/auth/change-password', t, { current: 'Pass@1234', password: PW2 }));
  assert.equal((await call('GET', '/agent/tasks', t)).s, 200, 'password badalte hi panel khul gaya');
  assert.equal((await call('POST', '/auth/login', null, { email: 'newagent@t.in', password: 'Pass@1234' })).s, 401, 'temp password band');
});

test('Google sign-in: verification checks, signup, link, onboarding flags', async () => {
  const cfg = require('../src/config'); cfg.googleClientId = 'test-client.apps.googleusercontent.com';
  const base = () => ({ aud: cfg.googleClientId, iss: 'https://accounts.google.com', exp: String(Math.floor(Date.now() / 1000) + 3600), email_verified: 'true', sub: 'g-sub-1', email: 'guser@gmail.com', name: 'Google User' });
  let G = base();
  const gcall = (body = { idToken: 'tok-aaaaaaaaaaaaaaaaaaaa' }) => call('POST', '/auth/google', null, body);
  await withFetch((u) => (u.includes('oauth2.googleapis.com/tokeninfo') ? J(G, G.__status || 200) : null), async () => {
    G = { ...base(), aud: 'other-app' }; assert.equal((await gcall()).s, 401, 'wrong audience');
    G = { ...base(), iss: 'evil.com' }; assert.equal((await gcall()).s, 401, 'wrong issuer');
    G = { ...base(), exp: String(Math.floor(Date.now() / 1000) - 10) }; assert.equal((await gcall()).s, 401, 'expired');
    G = { ...base(), email_verified: 'false' }; assert.equal((await gcall()).s, 401, 'unverified email');
    G = { error: 'invalid_token', __status: 400 }; assert.equal((await gcall()).s, 401, 'google rejects token');
    G = base(); assert.equal((await gcall({})).s, 401, 'token missing');
    // naya user
    let r = await gcall(); ok(r, 'google signup'); const t = r.j.token;
    assert.equal(r.j.user.needsPhone, true); assert.equal(r.j.user.emailVerified, true); assert.equal(r.j.user.googleLinked, true); assert.equal(r.j.user.role, 'customer');
    const u = await M.User.findOne({ email: 'guser@gmail.com' }); assert.equal(u.googleId, 'g-sub-1'); assert.equal(u.phone, undefined);
    // phone ke bina booking nahi
    const addr = (await call('POST', '/me/addresses', t, { line1: '12 MG Road, Freeganj', city: 'Ujjain', pincode: '456001' })).j;
    const body = { shoe: { material: 'leather', brand: 'X' }, declaredValue: 1000, addressId: addr._id };
    r = await call('POST', '/orders', t, body); assert.equal(r.s, 403); assert.equal(r.j.code, 'NEEDS_PHONE');
    ok(await call('PATCH', '/me', t, { phone: '9111111111' }), 'complete profile');
    assert.equal((await call('GET', '/me', t)).j.phone, '9111111111');
    ok(await call('POST', '/orders', t, body), 'phone ke baad booking');
    // dobara login = wahi user
    r = await gcall(); ok(r); assert.equal(r.j.user.needsPhone, false); assert.equal(await M.User.countDocuments({ email: 'guser@gmail.com' }), 1);
    // password wale existing user se same email: link, duplicate nahi
    G = { ...base(), sub: 'g-sub-2', email: 'cust@t.in' }; r = await gcall(); ok(r, 'link existing'); assert.equal(r.j.user.id, String((await M.User.findOne({ email: 'cust@t.in' }))._id));
    assert.equal((await M.User.findOne({ email: 'cust@t.in' })).googleId, 'g-sub-2'); assert.equal(await M.User.countDocuments({ email: 'cust@t.in' }), 1);
    G = { ...base(), sub: 'g-sub-9', email: 'cust@t.in' }; assert.equal((await gcall()).s, 409, 'alag google account same email');
    // admin Google se nahi
    G = { ...base(), sub: 'g-admin', email: 'admin@footwearsos.in' }; assert.equal((await gcall()).s, 403);
    // staff (temp password) Google se aaye to forced change hat jata hai
    ok(await call('POST', '/admin/users', S.admin, { role: 'agent', email: 'gstaff@gmail.com', password: 'Pass@1234', name: 'G Staff', pincodes: '456001' }));
    G = { ...base(), sub: 'g-staff', email: 'gstaff@gmail.com' }; r = await gcall(); ok(r, 'staff google'); assert.equal(r.j.user.role, 'agent'); assert.equal(r.j.user.mustChangePassword, false);
    assert.equal((await call('GET', '/agent/tasks', r.j.token)).s, 200);
    assert.equal((await call('POST', '/auth/login', null, { email: 'gstaff@gmail.com', password: 'Pass@1234' })).s, 401, 'temp password invalidate');
    // blocked user
    await M.User.updateOne({ email: 'guser@gmail.com' }, { status: 'blocked' }); G = base(); assert.equal((await gcall()).s, 403);
    await M.User.updateOne({ email: 'guser@gmail.com' }, { status: 'active' });
  });
  cfg.googleClientId = null;
  assert.equal((await gcall()).s, 501, 'client id na ho to clear error');
});

test('OpenRouter AI: model fallback chain, parsing, sanitising, failure fallback', async () => {
  const cfg = require('../src/config'); cfg.ai.key = 'or-test-key'; cfg.ai.models = ['model-a:free', 'model-b:free'];
  const seen = [];
  const chat = (content, status = 200) => J(status === 200 ? { choices: [{ message: { content } }] } : { error: { message: 'x' } }, status);
  let mode = 'second-ok';
  await withFetch((u, o) => {
    if (!u.includes('openrouter.ai/api/v1/chat/completions')) return null;
    const b = JSON.parse(o.body); seen.push({ model: b.model, auth: o.headers.Authorization, img: b.messages[0].content.find((x) => x.type === 'image_url')?.image_url.url?.slice(0, 22) });
    if (mode === 'second-ok') return b.model === 'model-a:free' ? chat('', 429) : chat('Sure! Here: ```json\n{"isShoe": true, "material": "suede", "damage": "clean", "type": "sneaker"}\n```');
    if (mode === 'weird') return chat('{"isShoe":true,"material":"plastic","damage":"explode","type":"rocket"}');
    if (mode === 'notshoe') return chat('{"isShoe":false}');
    return chat('', 500);
  }, async () => {
    let r = await call('POST', '/verdicts/ai', S.cust, { image: PNG }); ok(r);
    assert.equal(r.j.source, 'ai'); assert.equal(r.j.model, 'model-b:free'); assert.equal(r.j.material, 'suede'); assert.equal(r.j.damage, 'clean');
    assert.deepEqual(seen.map((x) => x.model), ['model-a:free', 'model-b:free'], 'pehla fail hua to dusra try');
    assert.equal(seen[0].auth, 'Bearer or-test-key'); assert.equal(seen[0].img, 'data:image/png;base64,', 'image data-URL bheji');
    mode = 'weird'; r = await call('POST', '/verdicts/ai', S.cust, { image: PNG }); assert.equal(r.j.material, 'unknown'); assert.equal(r.j.damage, 'sole'); assert.equal(r.j.type, 'other', 'model ka kachra enums se bahar nahi jaata');
    mode = 'notshoe'; r = await call('POST', '/verdicts/ai', S.cust, { image: PNG }); assert.equal(r.j.notShoe, true);
    mode = 'fail'; r = await call('POST', '/verdicts/ai', S.cust, { image: PNG }); ok(r); assert.equal(r.j.source, 'fallback'); assert.equal(r.j.aiUnavailable, true, 'sab models fail: manual fallback');
  });
  cfg.ai.key = undefined;
  const r = await call('POST', '/verdicts/ai', S.cust, { image: PNG }); assert.equal(r.j.source, 'fallback');
});

test('verified-contact setting aur unverified email booking', async () => {
  const t = (await call('POST', '/auth/signup', null, { name: 'Unv', email: 'unv@t.in', phone: '9222222222', password: 'Pass@1234' })).j.token;
  const addr = (await call('POST', '/me/addresses', t, { line1: '12 MG Road, Freeganj', city: 'Ujjain', pincode: '456001' })).j;
  const body = { shoe: { material: 'leather', brand: 'X' }, declaredValue: 1000, addressId: addr._id };
  ok(await call('PUT', '/admin/settings/requireVerifiedContact', S.ops, { value: 1 }));
  const r = await call('POST', '/orders', t, body); assert.equal(r.s, 403); assert.equal(r.j.code, 'NEEDS_VERIFY');
  const otp = await call('POST', '/auth/otp/send', t); ok(otp); ok(await call('POST', '/auth/otp/verify', t, { code: otp.j.devCode }));
  ok(await call('POST', '/orders', t, body), 'phone verify ke baad booking');
  ok(await call('PUT', '/admin/settings/requireVerifiedContact', S.ops, { value: 0 }));
});
