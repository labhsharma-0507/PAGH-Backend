// STARTER DATA. Sab kuch admin panel se edit/add ho sakta hai. Seed sirf tab insert karta hai jab sku/code/slug pehle se na ho
// (isliye aapke edit kabhi overwrite nahi hote). Prices Rs mein hain aur ASSUMPTIONS hain: launch se pehle apne cost ke hisaab se badlo.
const P = (sku, title, category, price, mrp, materials, damage, description, extra = {}) => ({ sku, title, brand: 'Footwear SOS Care', category, price, mrp, stock: 100, lowStockAt: 10, materialsSuitable: materials, damageTags: damage, description, isOwn: true, active: true, ...extra });
const ALL = ['canvas', 'leather', 'suede', 'knit'];
const PRODUCTS = [
  P('FSC-CLN-001', 'Sneaker Cleaning Solution 250ml', 'CLEANERS', 349, 449, ['canvas', 'leather', 'knit'], ['clean'], 'Canvas, leather aur knit sneakers ki roz ki safai ke liye. Pehle chhote hisse par patch-test karo. Suede par mat use karo.'),
  P('FSC-CLN-002', 'Sneaker Cleaning Kit (solution + brush + cloth)', 'CLEANERS', 599, 799, ['canvas', 'leather', 'knit'], ['clean'], 'Beginners ke liye complete kit: cleaning solution, soft brush aur microfibre cloth.'),
  P('FSC-CLN-003', 'Foam Shoe Cleaner 200ml', 'CLEANERS', 299, 399, ['canvas', 'knit'], ['clean'], 'Foam formula, kam paani mein safai. Knit/mesh par halke haath se use karo.'),
  P('FSC-CLN-004', 'Sneaker Cleaning Wipes (12 pcs)', 'CLEANERS', 249, 299, ['canvas', 'leather'], ['clean'], 'Travel ya quick touch-up ke liye. Gehre daag ke liye nahi.'),
  P('FSC-CLN-005', 'Midsole & Sole Whitening Paste', 'CLEANERS', 399, 499, ['canvas', 'leather'], ['clean', 'sole'], 'Sole aur midsole ke halke peelepan/daag ke liye. Gehre oxidation ke liye professional deoxidation behtar hai.'),
  P('FSC-BRU-001', 'Soft Cleaning Brush', 'TOOLS', 149, 199, ALL, ['clean'], 'Nylon soft bristles, upper aur sole dono ke liye.'),
  P('FSC-BRU-002', 'Horsehair Polish Brush', 'TOOLS', 299, 399, ['leather'], ['clean'], 'Leather polish lagane aur chamak laane ke liye.'),
  P('FSC-CLO-001', 'Microfibre Cloth (pack of 3)', 'TOOLS', 149, 199, ALL, ['clean'], 'Lint-free cloths: safai, polish aur sukhane ke liye.'),
  P('FSC-SUE-001', 'Suede & Nubuck Eraser', 'SUEDE_CARE', 249, 299, ['suede'], ['clean'], 'Suede par sukhe daag aur chamak ke nishaan hatane ke liye. Geele suede par mat use karo.'),
  P('FSC-SUE-002', 'Suede Brush (brass + nylon)', 'SUEDE_CARE', 299, 399, ['suede'], ['clean'], 'Suede ki nap (rongta) seedha karne ke liye. Halke haath se brush karo.'),
  P('FSC-SUE-003', 'Suede Care Kit (eraser + brush + protector spray)', 'SUEDE_CARE', 649, 849, ['suede'], ['clean'], 'Suede ki basic care ka poora kit.'),
  P('FSC-LEA-001', 'Leather Conditioner 100ml', 'LEATHER_CARE', 449, 549, ['leather', 'luxury'], ['clean'], 'Leather ko naram rakhta hai aur sukhne se bachata hai. Pehle chhote hisse par test karo.'),
  P('FSC-LEA-002', 'Leather Cleaner 150ml', 'LEATHER_CARE', 399, 499, ['leather'], ['clean'], 'Smooth leather shoes ki safai ke liye.'),
  P('FSC-LEA-003', 'Neutral Shoe Cream Polish', 'LEATHER_CARE', 249, 299, ['leather'], ['clean'], 'Colour-neutral cream; chamak aur halki nami deta hai. Dark leather par colour match karke dekho.'),
  P('FSC-LEA-004', 'Leather Scuff Touch-up Cream (Black)', 'LEATHER_CARE', 299, 399, ['leather'], ['clean'], 'Chhote scuff aur kharonch par touch-up. Gehre kat ke liye professional repair.'),
  P('FSC-PRO-001', 'Water & Stain Protector Spray 200ml', 'PROTECTION', 499, 649, ALL, ['clean'], 'Baarish aur daag se bachav ke liye. Saaf, sukhe jooton par 20 cm door se spray karo, hawadaar jagah mein.'),
  P('FSC-REP-001', 'Flexible Shoe Sole Adhesive 30g', 'REPAIR_KITS', 199, 249, ['canvas', 'leather'], ['sole'], 'Chhote sole-separation ke liye temporary/halka fix. Poora sole khula ho ya shoe mehnga ho to professional repair karwao.'),
  P('FSC-REP-002', 'Heel Tips Replacement (pair)', 'REPAIR_KITS', 149, 199, ['leather'], ['sole'], 'Ghise hue heel tips badalne ke liye.'),
  P('FSC-REP-003', 'Sole Edge Paint (Black)', 'REPAIR_KITS', 249, 299, ['canvas', 'leather'], ['sole'], 'Sole edge ke colour touch-up ke liye.'),
  P('FSC-ACC-001', 'Cushion Replacement Insoles', 'INSOLES_ACCESSORIES', 299, 399, ALL, ['insole'], 'Ghise hue insoles badalne ke liye; size trim karke fit karo.'),
  P('FSC-ACC-002', 'Shoe Odour Control Spray 100ml', 'INSOLES_ACCESSORIES', 249, 299, ALL, ['clean'], 'Badboo kam karne ke liye. Shoes ko hawa mein bhi sukhao.'),
  P('FSC-ACC-003', 'Cedar Shoe Tree (pair)', 'INSOLES_ACCESSORIES', 599, 799, ['leather'], ['clean'], 'Formal leather shoes ka shape banaye rakhta hai aur nami absorb karta hai.'),
  P('FSC-ACC-004', 'Flat Cotton Laces (2 pairs)', 'INSOLES_ACCESSORIES', 149, 199, ['canvas', 'leather'], ['clean'], 'Sneakers ke liye replacement laces.'),
  P('FSC-ACC-005', 'Silica Gel Moisture Absorber (pack of 4)', 'INSOLES_ACCESSORIES', 149, 199, ALL, ['clean'], 'Baarish mein shoes ke andar nami aur fungus kam karne ke liye.'),
];

const R = (code, name, category, price, cap, tatDays, warrantyDays, materials, description) => ({ code, name, category, price, cap, tatDays, warrantyDays, materials, description, active: true });
const RATES = [
  R('DEEP_CLEAN', 'Sneaker deep clean', 'CLEANING', 450, 700, 3, 7, ['canvas', 'leather', 'knit'], 'Poori safai: upper, sole, laces.'),
  R('SUEDE_CLEAN', 'Suede/nubuck specialist clean', 'CLEANING', 650, 950, 4, 7, ['suede'], 'Suede ke liye alag process.'),
  R('ODOUR_TREAT', 'Odour treatment', 'CLEANING', 250, 400, 2, 7, ALL, 'Anti-odour treatment.'),
  R('LEATHER_RESTORE', 'Leather clean + condition + colour touch-up', 'RESTORATION', 1200, 1800, 5, 15, ['leather', 'luxury'], 'Leather ki restoration.'),
  R('DEOXIDIZE', 'Sole deoxidation / whitening', 'RESTORATION', 900, 1400, 4, 15, ['canvas', 'leather'], 'Peele sole ki restoration.'),
  R('COLOUR_RESTORE', 'Colour restoration (dye/repaint)', 'RESTORATION', 1500, 2200, 6, 15, ['leather', 'suede', 'luxury'], 'Faded colour wapas.'),
  R('SOLE_REBOND', 'Sole re-bonding', 'REPAIR', 500, 800, 3, 30, ['canvas', 'leather'], 'Khule sole ko dobara chipkana.'),
  R('SOLE_REPLACE', 'Full sole replacement', 'REPAIR', 1500, 2200, 6, 45, ['leather'], 'Poora sole badalna.'),
  R('HEEL_CAP', 'Heel cap/tip replacement', 'REPAIR', 250, 400, 2, 30, ['leather'], 'Heel tip badalna.'),
  R('HEEL_REPLACE', 'Heel replacement', 'REPAIR', 600, 900, 4, 30, ['leather'], 'Poori heel badalna.'),
  R('STITCH', 'Stitching repair', 'REPAIR', 300, 500, 3, 30, ALL, 'Khuli silai ki repair.'),
  R('INSOLE_REPLACE', 'Insole replacement', 'REPAIR', 350, 600, 2, 30, ALL, 'Naye insoles.'),
  R('ZIP_REPAIR', 'Zip repair', 'REPAIR', 350, 600, 3, 30, ['leather', 'canvas'], 'Zip badalna/theek karna.'),
  R('MIDSOLE_REPAIR', 'Midsole crumbling repair', 'REPAIR', 1800, 2800, 7, 30, ['canvas', 'leather'], 'Bhurbhura hota midsole.'),
];
const PLANS = [
  { code: 'BASIC', name: 'Basic cover', description: 'Included: loss/damage par Rs 2,000 tak (depreciated).', feePct: 0, limit: 2000, fullDeclared: false, active: true },
  { code: 'PLUS', name: 'Plus cover', description: 'Declared value tak (depreciation ke baad) cover. Fee: declared value ka 3%.', feePct: 3, limit: 0, fullDeclared: true, active: true },
];
const G = (slug, material, tags, th, te, bh, be) => ({ slug, material, tags, title: { hg: th, en: te }, body: { hg: bh, en: be }, status: 'PUBLISHED' });
const GUIDES = [
  G('canvas-sneaker-cleaning', 'canvas', ['clean'], 'Canvas sneakers ki safai', 'Cleaning canvas sneakers',
    '1. Laces aur insoles nikalo.\n2. Sukhe brush se dhool hatao.\n3. Halke saabun ke paani mein soft brush se ragdo.\n4. Geele cloth se pocho, chhaon mein sukhao (dhoop/heater nahi).\nDhyan: washing machine aur tez bleach se bacho.',
    '1. Remove laces and insoles.\n2. Dry-brush off dust.\n3. Scrub with a soft brush and mild soapy water.\n4. Wipe, then air-dry in shade (no sun/heater).\nAvoid washing machines and strong bleach.'),
  G('leather-shoe-care', 'leather', ['clean'], 'Leather shoes ki care', 'Leather shoe care',
    '1. Dhool ko brush/cloth se hatao.\n2. Leather cleaner se halke haath se saaf karo.\n3. Sukhne ke baad conditioner lagao.\n4. Polish aur brush se chamkao.\nDhyan: pehle chhote hisse par test karo; geele jooton ko heater ke paas mat rakho.',
    '1. Wipe off dust.\n2. Clean gently with leather cleaner.\n3. Apply conditioner once dry.\n4. Polish and buff.\nTest on a small spot first; never dry wet shoes near a heater.'),
  G('suede-care', 'suede', ['clean'], 'Suede ki care', 'Suede care',
    '1. Suede hamesha SUKHA saaf karo.\n2. Eraser se daag rub karo, phir suede brush se nap seedha karo.\n3. Protector spray lagao.\nDhyan: paani ya liquid cleaner suede ko kharab kar sakte hain. Gehre daag par DIY mat karo; professional safai karwao.',
    '1. Clean suede DRY only.\n2. Rub marks with an eraser, then brush the nap.\n3. Apply protector spray.\nWater or liquid cleaners can ruin suede. For deep stains, use professional cleaning.'),
  G('knit-mesh-care', 'knit', ['clean'], 'Knit/mesh sneakers ki care', 'Knit/mesh sneaker care',
    '1. Soft brush aur halke foam cleaner se safai.\n2. Zor se mat ragdo (fabric kheench sakta hai).\n3. Chhaon mein sukhao.\nDhyan: tez chemical se colour ya coating kharab ho sakti hai; pehle test karo.',
    '1. Use a soft brush and mild foam cleaner.\n2. Do not scrub hard (fabric can snag).\n3. Air-dry in shade.\nStrong chemicals can damage colour or coating; test first.'),
  G('yellow-sole-whitening', 'canvas', ['sole', 'clean'], 'Peele sole ko safed karna', 'Whitening yellowed soles',
    'Halka peelapan: whitening paste aur brush. Gehra oxidation ya crumbling ho to DIY risky hai; professional deoxidation behtar hai.',
    'Light yellowing: whitening paste and a brush. Deep oxidation or crumbling soles are risky for DIY; choose professional deoxidation.'),
  G('shoe-odour', 'canvas', ['clean'], 'Jooton ki badboo hatana', 'Removing shoe odour',
    'Insoles nikalke hawa mein sukhao, odour spray/silica gel use karo, aur ek hi jode ko roz mat pehno.',
    'Remove insoles and air them, use an odour spray/silica gel, and rotate pairs instead of wearing one daily.'),
  G('sole-separation', 'leather', ['sole'], 'Sole khulne par kya karein', 'When a sole starts to separate',
    'Chhota separation: flexible adhesive se temporary fix. Poora sole khula ho, shoe mehnga ho, ya midsole bhurbhura ho to repair karwana safe hai. Verdict tool se estimate lo.',
    'Small gap: temporary fix with flexible adhesive. If the sole is fully open, the shoe is expensive, or the midsole is crumbling, get it professionally repaired. Use our verdict tool for an estimate.'),
  G('monsoon-shoe-care', 'canvas', ['clean'], 'Baarish mein jooton ki care', 'Monsoon shoe care',
    'Protector spray lagao, geele jooton ko akhbaar se bharo aur chhaon mein sukhao, silica gel rakho. Heater/dhoop se bacho.',
    'Apply protector spray, stuff wet shoes with paper and dry in shade, keep silica gel inside. Avoid heaters and direct sun.'),
];
const PG = (slug, th, te, bh, be) => ({ slug, title: { hg: th, en: te }, body: { hg: bh, en: be }, status: 'PUBLISHED', needsLegalReview: true });
const NOTE = '[DRAFT: lawyer se review karwana zaroori hai, phir ye note hata do.]\n\n';
const PAGES = [
  PG('terms', 'Terms of Service', 'Terms of Service', NOTE + 'Footwear SOS ek service platform hai. Estimates (verdict) sirf anuman hain; final price quote approve karne par tay hota hai. Aapki jootein humare paas hone par hum documented condition aur declared value ke hisaab se zimmedaar hain (cover plan ke terms ke saath).', NOTE + 'Footwear SOS is a service platform. Verdict estimates are indicative; the final price is fixed when you approve the quote. While your shoes are in our custody we are responsible according to the documented condition and your declared value (subject to the cover plan terms).'),
  PG('privacy', 'Privacy Policy', 'Privacy Policy', NOTE + 'Hum aapka naam, contact, address, photos aur order data sirf service dene ke liye rakhte hain. Aap profile se data export ya account delete kar sakte ho.', NOTE + 'We store your name, contact, address, photos and order data only to deliver the service. You can export your data or delete your account from your profile.'),
  PG('refund-policy', 'Refund & Cancellation', 'Refund & Cancellation', NOTE + 'Pickup se pehle cancel free hai. Quote reject karne par return fee lag sakti hai (quote screen par pehle dikhegi). Payment sirf quote approve karne ke baad liya jaata hai.', NOTE + 'Cancellation before pickup is free. Rejecting a quote may attract a return fee (shown beforehand). Payment is taken only after you approve the quote.'),
  PG('warranty-policy', 'Workmanship Warranty', 'Workmanship Warranty', NOTE + 'Repair ke kaam par workmanship warranty quote mein likhe din tak. Warranty mein glue/stitch dobara fail hona aata hai; naya damage, normal wear aur condition report mein pehle se note ki gayi cheezein shamil nahi.', NOTE + 'Repairs carry a workmanship warranty for the days stated on the quote. It covers re-failure of glue/stitching; it excludes new damage, normal wear and issues already noted in the condition report.'),
  PG('protection-policy', 'Protection Cover', 'Protection Cover', NOTE + 'Loss/damage par declared value (depreciation ke baad) tak, aapke plan ki limit ke andar. Claim ke liye condition report aur custody records dekhe jaate hain. Ye insurance hai ya service guarantee, iska legal structure confirm karna baaki hai.', NOTE + 'For loss/damage while in our custody, compensation is up to the declared value (after depreciation) within your plan limit, reviewed against the condition report and custody records. Legal structure (insurance vs service guarantee) is pending confirmation.'),
  PG('faq', 'Aksar puche jaane wale sawal', 'FAQ', 'Verdict kitna sahi hai? Ye anuman hai; hub par intake ke baad final quote milta hai.\nPayment kab? Quote approve karne ke baad.\nDeadline miss hui? Hub ki taraf se late hone par wallet mein automatic credit milta hai.', 'How accurate is the verdict? It is an estimate; the final quote comes after hub intake.\nWhen do I pay? After you approve the quote.\nWhat if a deadline is missed? If the delay is on our side you get an automatic wallet credit.'),
];
module.exports = { PRODUCTS, RATES, PLANS, GUIDES, PAGES };
