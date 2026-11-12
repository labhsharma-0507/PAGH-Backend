const express = require('express');
const { auth } = require('../middleware/auth');
const { bad, ah, limiter } = require('../lib/util');
const { saveImage, presign } = require('../lib/storage');
const FOLDERS = ['verdict', 'condition', 'claim', 'shoe', 'milestone', 'product', 'ad', 'partner'];
const R = express.Router();
// Server-side upload (S3 na ho ya direct upload na chale to). Body: { image: "data:image/jpeg;base64,...", folder }
R.post('/uploads', auth(), limiter(60e3, 40), express.json({ limit: '3mb' }), ah(async (q, r) => {
  const folder = FOLDERS.includes(q.body.folder) ? q.body.folder : 'misc';
  r.json({ url: await saveImage(q.body.image, folder) });
}));
// Signed upload URL (S3/R2 configured ho to browser seedha bucket mein upload karta hai)
R.post('/uploads/sign', auth(), limiter(60e3, 40), ah(async (q, r) => {
  const folder = FOLDERS.includes(q.body.folder) ? q.body.folder : 'misc';
  r.json(await presign(folder, String(q.body.contentType || '')));
}));
module.exports = R;
