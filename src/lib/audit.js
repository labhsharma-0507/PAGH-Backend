const { Audit } = require('../models');
const redact = (o) => {
  if (!o) return o;
  const x = JSON.parse(JSON.stringify(o));
  for (const k of ['password', 'hash', 'secret', 'twoFA', 'codeHash', 'payoutDetails']) delete x[k];
  return x;
};
// Fire-and-forget: audit fail ho to bhi request nahi rukti
const audit = (req, action, entity, entityId, before, after) =>
  Audit.create({
    actorId: req?.user?.id, role: req?.user?.role === 'admin' ? 'admin:' + (req.user.ar || '') : req?.user?.role, action, entity,
    entityId: entityId ? String(entityId) : undefined, before: redact(before), after: redact(after), ip: req?.ip, ua: req?.headers?.['user-agent'],
  }).catch((e) => console.error('audit', e.message));
module.exports = { audit };
