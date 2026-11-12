// Verdict RULES ENGINE. AI sirf photo se fields suggest karta hai; final decision hamesha ye rules leti hain.
const { VerdictRule } = require('../models');
const DEFAULT_RULES = {
  riskyMaterials: ['suede', 'knit', 'luxury', 'unknown'],
  notWorthBelow: 500, repairWorthFrom: 1000, luxuryFrom: 3000,
  bands: { sole: [300, 1200], stitch: [200, 600], clean: [300, 700], upper: [500, 2500], insole: [200, 600], default: [300, 1500] },
  tatDays: [3, 7], baseConfidence: 0.7, unknownMaterialConfidence: 0.4, lowConfidence: 0.5,
};
const MATERIALS = ['leather', 'canvas', 'suede', 'knit', 'luxury', 'unknown'];
const DAMAGES = ['sole', 'stitch', 'upper', 'clean', 'insole'];
const TYPES = ['sneaker', 'casual', 'formal', 'sandal', 'boot', 'luxury', 'other'];

let cache = null, at = 0;
async function activeRules() {
  if (cache && Date.now() - at < 15000) return cache;
  let r = await VerdictRule.findOne({ status: 'ACTIVE' }).sort('-version').lean();
  if (!r) r = (await VerdictRule.create({ version: 1, rules: DEFAULT_RULES, note: 'default' })).toObject();
  cache = r; at = Date.now();
  return r;
}
const invalidate = () => { cache = null; };

function validateRules(x) {
  const n = (v, name) => { if (!(Number(v) >= 0)) throw Object.assign(new Error(`${name} number hona chahiye`), { status: 400 }); return Number(v); };
  if (!x || typeof x !== 'object') throw Object.assign(new Error('Rules object do'), { status: 400 });
  const out = {
    riskyMaterials: (x.riskyMaterials || []).map(String),
    notWorthBelow: n(x.notWorthBelow, 'notWorthBelow'), repairWorthFrom: n(x.repairWorthFrom, 'repairWorthFrom'), luxuryFrom: n(x.luxuryFrom, 'luxuryFrom'),
    bands: {}, tatDays: (x.tatDays || [3, 7]).map(Number), baseConfidence: n(x.baseConfidence, 'baseConfidence'),
    unknownMaterialConfidence: n(x.unknownMaterialConfidence, 'unknownMaterialConfidence'), lowConfidence: n(x.lowConfidence, 'lowConfidence'),
  };
  for (const [k, v] of Object.entries(x.bands || {})) {
    if (!Array.isArray(v) || v.length !== 2 || !(+v[0] >= 0) || !(+v[1] >= +v[0])) throw Object.assign(new Error(`bands.${k} [min,max] hona chahiye`), { status: 400 });
    out.bands[k] = [+v[0], +v[1]];
  }
  if (!out.bands.default) throw Object.assign(new Error('bands.default zaroori hai'), { status: 400 });
  return out;
}

function evaluate(input, R, version) {
  const material = MATERIALS.includes(input.material) ? input.material : 'unknown';
  const damage = DAMAGES.includes(input.damage) ? input.damage : 'sole';
  const type = TYPES.includes(input.type) ? input.type : 'casual';
  const value = Math.max(0, Number(input.value) || 0);
  const risky = R.riskyMaterials.includes(material);
  const reasons = [];
  let v, diyBlocked = false;
  if (damage === 'clean' && !risky) { v = 'DIY_SAFE'; reasons.push('Sirf safai chahiye aur material low-risk hai'); }
  else if (damage === 'clean' && risky) {
    v = value >= R.notWorthBelow ? 'REPAIR_WORTH_IT' : 'BORDERLINE'; diyBlocked = true;
    reasons.push(`${material} material par DIY safai risky hai; professional safai behtar`);
  } else if (value < R.notWorthBelow) { v = 'NOT_WORTH_OR_NOT_REPAIRABLE'; reasons.push('Shoe ki value repair cost se kam lag rahi hai'); }
  else if (value >= R.luxuryFrom || type === 'luxury' || material === 'luxury') { v = 'REPAIR_WORTH_IT'; reasons.push('Premium/luxury shoe: repair usually worth it'); }
  else if (value >= R.repairWorthFrom) { v = 'REPAIR_WORTH_IT'; reasons.push('Value repair cost se kaafi upar hai'); }
  else { v = 'BORDERLINE'; reasons.push('Value aur repair cost lagbhag barabar; aapki attachment par depend'); }
  let conf = R.baseConfidence;
  if (material === 'unknown') { conf = R.unknownMaterialConfidence; reasons.push('Material pata nahi, isliye confidence kam'); }
  const band = R.bands[damage] || R.bands.default;
  return {
    verdict: v, priceBand: { min: band[0], max: band[1] }, tatDays: R.tatDays, confidence: conf,
    needsReview: conf < R.lowConfidence, diyAllowed: v === 'DIY_SAFE', diyWarning: diyBlocked,
    reasons, hubWillVerify: ['Material aur construction (cemented/stitched)', 'Damage ki gehrai', 'Final price intake ke baad'],
    inputs: { material, damage, type, value }, rulesVersion: version,
    disclaimer: 'Ye sirf estimate hai. Final quote hub par intake ke baad milega; AI/rules guarantee nahi dete.',
  };
}
async function run(input) {
  const r = await activeRules();
  return evaluate(input, r.rules, r.version);
}
module.exports = { run, evaluate, activeRules, invalidate, validateRules, DEFAULT_RULES, MATERIALS, DAMAGES, TYPES };
