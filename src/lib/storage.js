// Photo storage: S3-compatible (AWS S3 / Cloudflare R2 / MinIO) agar keys diye ho, warna local disk (dev).
// Photos hamesha random naam se likhi jaati hain (kabhi overwrite nahi) -> condition evidence write-once rehta hai.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('../config');
const { bad } = require('./util');

const MAX_BYTES = 1500000;
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const useS3 = () => !!(cfg.s3.bucket && cfg.s3.key && cfg.s3.secret);
let client = null;
const s3 = () => {
  if (!client) {
    const { S3Client } = require('@aws-sdk/client-s3');
    client = new S3Client({
      region: cfg.s3.region, endpoint: cfg.s3.endpoint || undefined, forcePathStyle: !!cfg.s3.endpoint,
      credentials: { accessKeyId: cfg.s3.key, secretAccessKey: cfg.s3.secret },
    });
  }
  return client;
};
const base = () =>
  useS3() ? cfg.s3.publicBase || `https://${cfg.s3.bucket}.s3.${cfg.s3.region}.amazonaws.com` : `${cfg.apiPublicUrl}/uploads`;
const urlFor = (key) => `${base()}/${key}`;
const isOurs = (u) => typeof u === 'string' && u.startsWith(base() + '/');
const sniff = (b) => {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
};
const newKey = (folder, ext) => `${folder}/${new Date().toISOString().slice(0, 7)}/${crypto.randomBytes(16).toString('hex')}.${ext}`;

async function saveImage(input, folder = 'misc') {
  if (typeof input !== 'string') throw bad('Photo invalid');
  if (isOurs(input)) return input; // pehle se hamare storage ka URL
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(input);
  if (!m) throw bad('Photo sirf jpeg/png/webp hoti hai');
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > MAX_BYTES) throw bad('Photo 1.5MB se badi hai (app compress karta hai, dobara try karo)');
  if (sniff(buf) !== m[1]) throw bad('Photo ka content type match nahi karta');
  const key = newKey(folder, EXT[m[1]]);
  if (useS3()) {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await s3().send(new PutObjectCommand({ Bucket: cfg.s3.bucket, Key: key, Body: buf, ContentType: m[1], CacheControl: 'public, max-age=31536000, immutable' }));
  } else {
    const p = path.join(cfg.uploadsDir, key);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, buf, { flag: 'wx' });
  }
  return urlFor(key);
}
async function saveImages(arr, folder, { min = 1, max = 8 } = {}) {
  if (!Array.isArray(arr) || arr.length < min || arr.length > max) throw bad(`${min}-${max} photos do`);
  return Promise.all(arr.map((x) => saveImage(x, folder)));
}
// Direct browser -> S3 upload ke liye presigned PUT (PRD: signed upload URLs). S3 na ho to {mode:'server'}.
async function presign(folder, contentType) {
  if (!useS3()) return { mode: 'server' };
  if (!EXT[contentType]) throw bad('Sirf jpeg/png/webp');
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  const key = newKey(folder, EXT[contentType]);
  const url = await getSignedUrl(s3(), new PutObjectCommand({ Bucket: cfg.s3.bucket, Key: key, ContentType: contentType }), { expiresIn: 300 });
  return { mode: 'direct', url, publicUrl: urlFor(key), headers: { 'Content-Type': contentType } };
}
module.exports = { saveImage, saveImages, presign, useS3, isOurs };
