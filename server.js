const mongoose = require('mongoose');
const cfg = require('./src/config');
const app = require('./src/app');
const { seed } = require('./src/seed');
const O = require('./src/lib/orders');
const { processQueue } = require('./src/lib/notify');

async function connect() {
  try {
    await mongoose.connect(cfg.mongoUri, { serverSelectionTimeoutMS: 4000 });
  } catch (e) {
    if (cfg.prod) throw e;
    console.log(`\n[!] MongoDB nahi mila (${cfg.mongoUri}). Temporary in-memory database start kar raha hoon (restart par data ud jayega)...`);
    const { MongoMemoryServer } = require('mongodb-memory-server');
    await mongoose.connect((await MongoMemoryServer.create()).getUri('footwear_sos'));
  }
}
const every = (ms, fn, name) => setInterval(() => fn().catch((e) => console.error(`[${name}]`, e.message)), ms).unref();

async function main() {
  await connect();
  const s = await seed();
  if (Object.values(s).some(Boolean)) console.log('[seed]', s);
  if (cfg.runScheduler) {
    every(20000, processQueue, 'notify-queue');
    every(5 * 60000, async () => { await O.runSla(); await O.runLifecycle(); }, 'sla-lifecycle');
  }
  app.listen(cfg.port, () => {
    console.log(`\nAPI ready: ${cfg.apiPublicUrl}/api/v1/config`);
    if (!cfg.prod) console.log(`Admin: ${cfg.admin.email} / ${cfg.admin.password}  (pehle login par 2FA setup karna hoga)`);
  });
}
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { main, connect };
