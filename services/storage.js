// ── Shared file storage: Cloudflare R2 with local-filesystem fallback ─────────
// Used by both talent uploads (routes/uploads.js) and employer verification docs
// (routes/employer-verification.js) so every uploaded file lands in the same
// persistent object store. Local disk is only a dev/last-resort fallback — on an
// ephemeral host (e.g. Railway without a mounted volume) local files are lost on
// redeploy, which is exactly why verification docs used to 404 → SPA landing page.
const path = require('path');
const fs   = require('fs');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const LOCAL_UPLOAD_ROOT = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'public', 'uploads');
if (!fs.existsSync(LOCAL_UPLOAD_ROOT)) fs.mkdirSync(LOCAL_UPLOAD_ROOT, { recursive: true });

const R2_CONFIGURED = !!(
  process.env.CLOUDFLARE_ACCOUNT_ID &&
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY &&
  process.env.R2_BUCKET_NAME &&
  process.env.R2_PUBLIC_URL
);
console.log('[storage] R2 configured:', R2_CONFIGURED);

const r2 = R2_CONFIGURED ? new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
}) : null;

const R2_BUCKET     = process.env.R2_BUCKET_NAME;
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;

// uploadFile: tries R2, falls back to local filesystem. Returns a URL string —
// an absolute R2 URL when configured, otherwise a `/uploads/<key>` path.
async function uploadFile(buffer, key, contentType) {
  if (R2_CONFIGURED) {
    try {
      await r2.send(new PutObjectCommand({
        Bucket:      R2_BUCKET,
        Key:         key,
        Body:        buffer,
        ContentType: contentType,
      }));
      const url = `${R2_PUBLIC_URL}/${key}`;
      console.log('[R2] Upload success:', url);
      return url;
    } catch (err) {
      console.warn('[R2] Upload failed, falling back to local storage:', err.message);
    }
  }

  const localPath = path.join(LOCAL_UPLOAD_ROOT, key);
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.writeFileSync(localPath, buffer);
  const url = `/uploads/${key}`;
  console.log('[local] Saved file:', url);
  return url;
}

module.exports = { uploadFile, R2_CONFIGURED };
