require('dotenv').config();
const E = process.env;
const prod = E.NODE_ENV === 'production';

if (prod) {
  if (!E.JWT_SECRET || E.JWT_SECRET.length < 32) throw new Error('JWT_SECRET (kam se kam 32 characters) production mein zaroori hai');
  if (!E.ADMIN_PASSWORD || E.ADMIN_PASSWORD === 'Admin@12345') throw new Error('Production mein ADMIN_PASSWORD badalna zaroori hai');
  if (!E.WEB_ORIGIN) throw new Error('WEB_ORIGIN production mein zaroori hai');
}

// Dev mein localhost + LAN (phone se test) origins allowed; production mein sirf WEB_ORIGIN
const isAllowedOrigin = (o) => !o || o === (E.WEB_ORIGIN || 'http://localhost:3000') || (!prod && /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[\w-]+\.local)(:\d+)?$/.test(o));

module.exports = {
  isAllowedOrigin,
  env: E.NODE_ENV || 'development',
  prod,
  port: +E.PORT || 4000,
  mongoUri: E.MONGO_URI || 'mongodb://127.0.0.1:27017/footwear_sos',
  webOrigin: E.WEB_ORIGIN || 'http://localhost:3000',
  apiPublicUrl: E.API_PUBLIC_URL || `http://localhost:${+E.PORT || 4000}`,
  jwtSecret: E.JWT_SECRET || 'dev-secret-change-me',
  cookie: {
    sameSite: E.COOKIE_SAMESITE || 'lax', // cross-site production (alag domains) mein 'none' + HTTPS
    secure: prod || E.COOKIE_SECURE === 'true',
    domain: E.COOKIE_DOMAIN || undefined,
  },
  admin: { email: E.ADMIN_EMAIL || 'admin@footwearsos.in', password: E.ADMIN_PASSWORD || 'Admin@12345' },
  razorpay: { keyId: E.RAZORPAY_KEY_ID, keySecret: E.RAZORPAY_KEY_SECRET, webhookSecret: E.RAZORPAY_WEBHOOK_SECRET },
  googleClientId: E.GOOGLE_CLIENT_ID || null,
  // AI: OpenRouter (free models chalte hain). OPENROUTER_MODELS comma-separated fallback list.
  ai: { key: E.OPENROUTER_API_KEY, models: (E.OPENROUTER_MODELS || 'openrouter/free,google/gemma-3-27b-it:free').split(',').map((s) => s.trim()).filter(Boolean) },
  mail: { resendKey: E.RESEND_KEY, from: E.MAIL_FROM || 'Footwear SOS <onboarding@resend.dev>' },
  twilio: { sid: E.TWILIO_SID, token: E.TWILIO_TOKEN, smsFrom: E.TWILIO_SMS_FROM, waFrom: E.TWILIO_WA_FROM },
  notifyWebhook: E.NOTIFY_WEBHOOK,
  s3: {
    bucket: E.S3_BUCKET, region: E.S3_REGION || 'auto', endpoint: E.S3_ENDPOINT,
    key: E.S3_ACCESS_KEY, secret: E.S3_SECRET_KEY, publicBase: E.S3_PUBLIC_BASE,
  },
  uploadsDir: E.UPLOADS_DIR || require('path').join(__dirname, '..', 'uploads'),
  runScheduler: E.RUN_SCHEDULER !== 'false',
};
