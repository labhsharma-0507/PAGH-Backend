const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const cfg = require('./config');
const S = require('./lib/settings');
const { limiter } = require('./lib/util');

const app = express();
// Enable trust proxy by default for Vercel/proxies so express-rate-limit detects client IPs safely
app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: (o, cb) => cb(null, cfg.isAllowedOrigin(o)), credentials: true }));
// raw body webhook signature verify ke liye chahiye
app.use(express.json({ limit: '4mb', verify: (q, r, buf) => { if (q.originalUrl.includes('/payments/webhook')) q.raw = buf.toString('utf8'); } }));
// Local photo storage (S3 na ho to). nosniff: browser file ko HTML ki tarah execute na kare
app.use('/uploads', express.static(cfg.uploadsDir, { maxAge: '365d', immutable: true, setHeaders: (r) => { r.setHeader('X-Content-Type-Options', 'nosniff'); r.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'"); } }));

const V = '/api/v1';
app.get(V + '/health', (q, r) => r.json({ ok: true }));
app.get(V + '/config', async (q, r) => r.json({
  googleClientId: cfg.googleClientId, razorpayKeyId: cfg.razorpay.keyId || null, razorpay: !!cfg.razorpay.keyId,
  directUpload: !!(cfg.s3.bucket && cfg.s3.key), support: { phone: await S.get('supportPhone'), email: await S.get('supportEmail') },
  fees: { delivery: await S.get('deliveryFee'), freeDeliveryAbove: await S.get('freeDeliveryAbove'), express: await S.get('expressFee'), returnFee: await S.get('returnFee'), slaCreditPerDay: await S.get('slaCreditPerDay'), warrantyDays: await S.get('warrantyDays'), conditionDisputeHours: await S.get('conditionDisputeHours') },
}));
app.use(V + '/auth', require('./routes/auth').router);
for (const m of ['me', 'uploads', 'verdict', 'orders', 'payments', 'claims', 'ops', 'shop', 'ads', 'content', 'admin']) {
  const x = require('./routes/' + m);
  app.use(V, x.router || x);
}
app.use(V, (q, r) => r.status(404).json({ error: 'Not found' }));
app.use((e, q, r, n) => {
  if (e.type === 'entity.too.large') return r.status(413).json({ error: 'Request bahut badi hai' });
  if (e.name === 'JsonWebTokenError' || e.name === 'TokenExpiredError') return r.status(401).json({ error: 'Login required' });
  if (e.code === 11000) return r.status(409).json({ error: 'Ye pehle se maujood hai (duplicate)' });
  if (e.name === 'ValidationError' || e.name === 'CastError') return r.status(400).json({ error: e.message });
  const status = e.status || 500;
  if (status >= 500 && status !== 501) console.error('[error]', q.method, q.originalUrl, e);
  r.status(status).json({ error: status >= 500 && cfg.prod ? 'Server error' : e.message, code: e.code && typeof e.code === 'string' ? e.code : undefined });
});
module.exports = app;
