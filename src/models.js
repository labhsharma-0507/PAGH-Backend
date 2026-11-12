// Saare MongoDB collections yahin hain. Naya collection add karna ho to yahin M(...) se banao.
const mongoose = require('mongoose');
const { Schema } = mongoose;
const OID = Schema.Types.ObjectId;
const M = (name, def, indexes = []) => {
  const s = new Schema(def, { timestamps: true });
  indexes.forEach((i) => s.index(...(Array.isArray(i) ? i : [i])));
  return mongoose.model(name, s);
};
const Photos = [String];

const User = M('User', {
  name: String,
  email: { type: String, unique: true, lowercase: true, trim: true },
  phone: { type: String, unique: true, sparse: true },
  hash: String,
  role: { type: String, default: 'customer', enum: ['customer', 'partner', 'agent', 'droppoint', 'brand', 'admin'] },
  adminRole: { type: String, enum: ['super', 'ops', 'support', 'finance', 'content'] },
  lang: { type: String, default: 'hg' },
  emailVerified: Boolean, phoneVerified: Boolean,
  status: { type: String, default: 'active', enum: ['active', 'blocked', 'deleted'] },
  twoFA: { enabled: Boolean, secret: String },
  failedLogins: { type: Number, default: 0 }, lockUntil: Date,
  prefs: { email: { type: Boolean, default: true }, sms: { type: Boolean, default: true }, whatsapp: { type: Boolean, default: false } },
  googleId: { type: String, unique: true, sparse: true }, mustChangePassword: Boolean,
  brandId: OID, emailVerifyHash: String, emailVerifyExp: Date, lastLoginAt: Date, deletedAt: Date,
});
const Session = M('Session', { userId: OID, family: String, hash: { type: String, index: true }, revoked: Boolean, ua: String, ip: String, expiresAt: Date });
const Otp = M('Otp', { target: String, purpose: String, codeHash: String, attempts: { type: Number, default: 0 }, expiresAt: Date }, [{ target: 1, purpose: 1 }]);
const Address = M('Address', { userId: { type: OID, index: true }, label: String, name: String, phone: String, line1: String, line2: String, city: String, state: String, pincode: String, isDefault: Boolean });
const Shoe = M('Shoe', { userId: { type: OID, index: true }, brand: String, model: String, type: String, material: String, purchaseDate: Date, declaredValue: Number, photos: Photos, notes: String, archived: Boolean });
const VerdictRule = M('VerdictRule', { version: { type: Number, unique: true }, rules: Object, status: { type: String, default: 'ACTIVE' }, note: String, createdBy: OID });
const VerdictRequest = M('VerdictRequest', {
  userId: OID, shoeId: OID, photos: Photos, inputs: Object, ai: Object, output: Object, rulesVersion: Number,
  reviewStatus: { type: String, default: 'NONE', enum: ['NONE', 'PENDING', 'DONE'] }, reviewedBy: OID, reviewNote: String, final: Object,
}, [{ reviewStatus: 1, createdAt: -1 }]);
const Setting = M('Setting', { key: { type: String, unique: true }, value: Schema.Types.Mixed });
const RateItem = M('RateItem', {
  code: { type: String, unique: true }, name: String, category: String, description: String, price: Number, cap: Number,
  tatDays: Number, warrantyDays: Number, materials: [String], active: { type: Boolean, default: true }, sort: { type: Number, default: 100 },
});
const Order = M('Order', {
  orderNo: { type: String, unique: true }, userId: { type: OID, index: true }, shoeId: OID, shoe: Object, verdict: Object, verdictId: OID,
  serviceType: { type: String, default: 'REPAIR' }, declaredValue: Number, plan: String,
  address: String, addressId: OID, pincode: String, slot: String,
  pickupMode: { type: String, default: 'PICKUP', enum: ['PICKUP', 'DROPPOINT'] }, dropPointId: OID, brandId: OID, brandCode: String,
  agentId: OID, batchId: OID, partnerId: OID, express: Boolean,
  status: { type: String, default: 'BOOKED', index: true },
  pickupOtp: String, deliveryOtp: String, qrId: { type: String, index: true },
  committedDate: Date, hold: { active: Boolean, reason: String, since: Date, note: String },
  slaCreditedDays: { type: Number, default: 0 }, slaCreditTotal: { type: Number, default: 0 }, atRiskNotified: Boolean, quoteReminded: Boolean,
  total: { type: Number, default: 0 }, cap: Number, fees: { delivery: Number, express: Number, protection: Number, returnFee: Number },
  paid: Boolean, paidAmount: { type: Number, default: 0 }, dueExtra: { type: Number, default: 0 }, pendingExtraQuoteId: OID,
  rework: Boolean, parentOrderId: OID, returnReason: String, cancelReason: String, deliveredAt: Date, closedAt: Date,
  events: [{ from: String, to: String, by: String, byId: OID, note: String, ts: { type: Date, default: Date.now } }],
}, [{ partnerId: 1, status: 1 }, { dropPointId: 1, status: 1 }, { brandId: 1 }, { createdAt: -1 }]);
const Quote = M('Quote', {
  orderId: { type: OID, index: true }, version: Number, items: [{ code: String, name: String, price: Number }], total: Number, cap: Number,
  tatDays: Number, warrantyDays: Number, extraWorkOf: OID, note: String, queryText: String,
  status: { type: String, default: 'SENT', enum: ['SENT', 'APPROVED', 'REJECTED', 'QUERY', 'SUPERSEDED', 'EXPIRED'] },
});
const Cond = M('Cond', {
  orderId: { type: OID, unique: true }, version: { type: Number, default: 1 }, customerPhotos: Photos, hubPhotos: Photos, preExisting: [String],
  checklist: Object, grade: String, customerAcceptedAt: Date, lockedAt: Date, disputedReason: String, disputedAt: Date,
  history: [{ version: Number, grade: String, hubPhotos: Photos, ts: { type: Date, default: Date.now } }],
});
const Custody = M('Custody', { orderId: { type: OID, index: true }, type: String, actorId: OID, role: String, qrId: String, otpVerified: Boolean, geo: Object, note: String });
const Payment = M('Payment', {
  userId: OID, orderId: OID, shopOrderId: OID, kind: { type: String, default: 'ORDER' }, amount: Number, credit: { type: Number, default: 0 },
  providerOrderId: { type: String, index: true }, providerPaymentId: String, status: { type: String, default: 'CREATED' }, mock: Boolean,
  refunds: [{ amount: Number, reason: String, toWallet: Boolean, providerId: String, ts: { type: Date, default: Date.now } }],
});
const Ledger = M('Ledger', { userId: { type: OID, index: true }, type: { type: String, enum: ['CREDIT', 'DEBIT'] }, reason: String, amount: Number, orderId: OID, claimId: OID, note: String, createdBy: OID, key: { type: String, unique: true, sparse: true } });
const Plan = M('Plan', { code: { type: String, unique: true }, name: String, description: String, feePct: Number, limit: Number, fullDeclared: Boolean, active: { type: Boolean, default: true } });
const Warranty = M('Warranty', { orderId: { type: OID, unique: true }, startDate: Date, endDate: Date, days: Number, scope: String, exclusions: String });
const Claim = M('Claim', {
  claimNo: { type: String, unique: true }, orderId: OID, userId: OID, type: { type: String, enum: ['damage', 'loss', 'delay', 'warranty', 'other'] },
  text: String, evidence: Photos,
  status: { type: String, default: 'SUBMITTED', enum: ['SUBMITTED', 'UNDER_REVIEW', 'INFO_NEEDED', 'APPROVED', 'PARTIALLY_APPROVED', 'REJECTED', 'SETTLED'] },
  settlement: { type: String, enum: ['REDO', 'REFUND', 'CREDIT', 'COMPENSATION'] }, amount: Number, notes: String, reviewerId: OID, redoOrderId: OID, settledAt: Date,
}, [{ status: 1, createdAt: -1 }]);
const Review = M('Review', { orderId: { type: OID, unique: true }, userId: OID, partnerId: OID, quality: Number, communication: Number, delivery: Number, text: String });
const Notif = M('Notif', {
  userId: { type: OID, index: true }, event: String, channel: { type: String, default: 'inapp' }, title: String, body: String, data: Object,
  status: { type: String, default: 'PENDING', enum: ['PENDING', 'SENT', 'FAILED'] }, attempts: { type: Number, default: 0 }, nextAt: Date, error: String, read: Boolean,
}, [{ status: 1, nextAt: 1 }]);
const Partner = M('Partner', {
  userId: OID, businessName: String, type: { type: String, enum: ['COBBLER', 'HUB', 'DROP_POINT', 'AGENT'] }, address: String, city: String,
  pincodes: [String], docs: [String], capacity: Number, commissionPct: Number,
  status: { type: String, default: 'PENDING', enum: ['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED'] },
}, [{ type: 1, status: 1 }]);
const Job = M('Job', { orderId: { type: OID, unique: true }, partnerId: OID, milestones: [{ type: { type: String }, photos: Photos, note: String, ts: { type: Date, default: Date.now } }], rework: Boolean, qcResult: String, qcNote: String });
const Payout = M('Payout', {
  orderId: OID, payeeType: { type: String, enum: ['PARTNER', 'DROPPOINT', 'BRAND'] }, payeeId: OID, userId: OID, gross: Number, pct: Number, amount: Number, adjustments: [{ amount: Number, reason: String, ts: { type: Date, default: Date.now } }],
  status: { type: String, default: 'PENDING', enum: ['HOLD', 'PENDING', 'PAID'] }, reference: String, releasedAt: Date,
}, [{ payeeId: 1, status: 1 }, { orderId: 1, payeeType: 1 }]);
const Brand = M('Brand', { name: String, code: { type: String, unique: true, uppercase: true }, contactEmail: String, commissionPct: { type: Number, default: 0 }, notes: String, active: { type: Boolean, default: true } });
const Batch = M('Batch', { agentId: OID, orderIds: [OID], slot: String, note: String, status: { type: String, default: 'OPEN' } });
const Product = M('Product', {
  sku: { type: String, unique: true }, title: String, brand: String, category: { type: String, index: true }, group: String, description: String,
  mrp: Number, price: Number, stock: { type: Number, default: 0 }, lowStockAt: { type: Number, default: 5 }, images: [String],
  materialsSuitable: [String], damageTags: [String], tags: [String], isOwn: { type: Boolean, default: true },
  affiliateUrl: String, affiliateCommissionPct: Number, sponsored: Boolean, advertiserId: OID, sponsoredUntil: Date,
  attrs: Schema.Types.Mixed, // add-on fields: size, colour, ingredients, kuch bhi
  active: { type: Boolean, default: true }, clicks: { type: Number, default: 0 }, sold: { type: Number, default: 0 },
});
const ShopOrder = M('ShopOrder', {
  orderNo: String, userId: { type: OID, index: true }, items: [{ sku: String, title: String, price: Number, qty: Number }],
  address: Object, subtotal: Number, shipping: Number, tax: Number, total: Number, paymentId: OID, reservedUntil: Date,
  status: { type: String, default: 'PENDING', enum: ['PENDING', 'PAID', 'PACKED', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED'] },
  tracking: { courier: String, awb: String, url: String }, note: String,
});
const Advertiser = M('Advertiser', { name: String, contactName: String, email: String, phone: String, notes: String, active: { type: Boolean, default: true } });
const Campaign = M('Campaign', {
  advertiserId: OID, name: String, title: String, image: String, link: String, placement: String,
  startAt: Date, endAt: Date, budget: Number, pricingModel: { type: String, enum: ['FLAT', 'CPM', 'CPC'], default: 'FLAT' }, rate: Number, spent: { type: Number, default: 0 },
  status: { type: String, default: 'PENDING', enum: ['PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'ENDED'] },
  targeting: { materials: [String], brands: [String], categories: [String] }, freqCapPerDay: { type: Number, default: 5 },
  impressions: { type: Number, default: 0 }, clicks: { type: Number, default: 0 }, reviewNote: String,
}, [{ placement: 1, status: 1 }]);
const AdEvent = M('AdEvent', { campaignId: OID, productId: OID, type: String, placement: String, anon: String, page: String }, [{ anon: 1, campaignId: 1, createdAt: -1 }]);
const Guide = M('Guide', { slug: { type: String, unique: true }, title: Object, body: Object, material: String, tags: [String], seo: Object, status: { type: String, default: 'PUBLISHED' } });
const Page = M('Page', { slug: { type: String, unique: true }, title: Object, body: Object, status: { type: String, default: 'PUBLISHED' }, needsLegalReview: Boolean });
const Audit = M('Audit', { actorId: OID, role: String, action: String, entity: String, entityId: String, before: Object, after: Object, ip: String, ua: String }, [{ createdAt: -1 }, { actorId: 1 }]);

module.exports = {
  mongoose, User, Session, Otp, Address, Shoe, VerdictRule, VerdictRequest, Setting, RateItem, Order, Quote, Cond, Custody, Payment, Ledger,
  Plan, Warranty, Claim, Review, Notif, Partner, Job, Payout, Brand, Batch, Product, ShopOrder, Advertiser, Campaign, AdEvent, Guide, Page, Audit,
};
