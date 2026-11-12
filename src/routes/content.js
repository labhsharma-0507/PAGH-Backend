const express = require('express');
const M = require('../models');
const { crud } = require('../lib/crud');
const { auth } = require('../middleware/auth');
const { bad, ah } = require('../lib/util');
const R = express.Router();
const pickLang = (o, lang) => (o && (o[lang] || o.hg || o.en || Object.values(o)[0])) || '';

R.get('/guides', auth(), ah(async (q, r) => {
  const f = { status: 'PUBLISHED' }; if (q.query.material) f.material = String(q.query.material);
  const l = await M.Guide.find(f).sort('createdAt').lean();
  r.json(l.map((g) => ({ slug: g.slug, material: g.material, tags: g.tags, title: g.title, body: g.body })));
}));
R.get('/guides/:slug', auth(), ah(async (q, r) => {
  const g = await M.Guide.findOne({ slug: String(q.params.slug), status: 'PUBLISHED' }).lean();
  if (!g) throw bad('Guide nahi mila', 404);
  r.json(g);
}));
R.get('/pages/:slug', ah(async (q, r) => {
  const p = await M.Page.findOne({ slug: String(q.params.slug), status: 'PUBLISHED' }).lean();
  if (!p) throw bad('Page nahi mila', 404);
  r.json(p);
}));
R.get('/pages', ah(async (q, r) => r.json((await M.Page.find({ status: 'PUBLISHED' }, 'slug title').lean()))));
crud(R, '/admin/guides', M.Guide, { perm: 'content', fields: ['slug', 'title', 'body', 'material', 'tags', 'seo', 'status'], search: ['slug'], filters: ['status', 'material'], del: true, name: 'Guide',
  before: (d, q, old) => { if (!old && (!d.slug || !/^[a-z0-9-]+$/.test(d.slug) || !d.title)) throw bad('slug (a-z0-9-) aur title zaroori'); } });
crud(R, '/admin/pages', M.Page, { perm: 'content', fields: ['slug', 'title', 'body', 'status', 'needsLegalReview'], search: ['slug'], del: true, name: 'Page',
  before: (d, q, old) => { if (!old && (!d.slug || !/^[a-z0-9-]+$/.test(d.slug))) throw bad('slug (a-z0-9-) zaroori'); } });
module.exports = R;
