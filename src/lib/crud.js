// Generic admin CRUD: naya resource add karna ho to bas ek crud(...) line. Audit, permission, search, pagination built-in.
const { admin } = require('../middleware/auth');
const { bad, ah, clean, page, rx } = require('./util');
const { audit } = require('./audit');
const mongoose = require('mongoose');

function crud(router, path, Model, o) {
  const { perm, fields, search = [], sort = '-createdAt', filters = [], del = false, before, after, name = Model.modelName } = o;
  const pick = (b) => Object.fromEntries(Object.entries(clean(b)).filter(([k]) => fields.includes(k)));
  const id = (v) => { if (!mongoose.isValidObjectId(v)) throw bad('Bad id'); return v; };
  router.get(path, admin(perm), ah(async (q, r) => {
    const f = {};
    for (const k of filters) if (q.query[k] !== undefined && q.query[k] !== '') f[k] = String(q.query[k]);
    if (q.query.q && search.length) f.$or = search.map((k) => ({ [k]: rx(String(q.query.q).slice(0, 60)) }));
    const { limit, skip } = page(q.query, 200);
    const [items, total] = await Promise.all([Model.find(f).sort(sort).skip(skip).limit(limit).lean(), Model.countDocuments(f)]);
    r.json({ items, total });
  }));
  router.post(path, admin(perm), ah(async (q, r) => {
    let d = pick(q.body);
    if (before) d = (await before(d, q, null)) || d;
    const doc = await Model.create(d);
    audit(q, `${name}_CREATE`, name, doc._id, null, doc.toObject());
    if (after) await after(doc, q);
    r.json(doc);
  }));
  router.patch(`${path}/:id`, admin(perm), ah(async (q, r) => {
    const old = await Model.findById(id(q.params.id));
    if (!old) throw bad('Nahi mila', 404);
    let d = pick(q.body);
    if (before) d = (await before(d, q, old)) || d;
    old.set(d);
    await old.save();
    audit(q, `${name}_UPDATE`, name, old._id, null, d);
    if (after) await after(old, q);
    r.json(old);
  }));
  if (del) router.delete(`${path}/:id`, admin(perm), ah(async (q, r) => {
    const old = await Model.findByIdAndDelete(id(q.params.id));
    audit(q, `${name}_DELETE`, name, q.params.id, old?.toObject(), null);
    r.json({ ok: true });
  }));
}
module.exports = { crud };
