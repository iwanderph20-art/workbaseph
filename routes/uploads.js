const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const db       = require('../database');
const { authenticateToken } = require('../middleware/auth');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

// ── Local fallback storage ────────────────────────────────────────────────────
// Used when R2 is not configured or upload fails
const LOCAL_UPLOAD_ROOT = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'public', 'uploads');
if (!fs.existsSync(LOCAL_UPLOAD_ROOT)) fs.mkdirSync(LOCAL_UPLOAD_ROOT, { recursive: true });

// ── R2 client ────────────────────────────────────────────────────────────────
const R2_CONFIGURED = !!(
  process.env.CLOUDFLARE_ACCOUNT_ID &&
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY &&
  process.env.R2_BUCKET_NAME &&
  process.env.R2_PUBLIC_URL
);
console.log('[uploads] R2 configured:', R2_CONFIGURED);

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

// ── uploadFile: tries R2, falls back to local filesystem ─────────────────────
async function uploadFile(buffer, key, contentType) {
  // Try R2 first
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

  // Fallback: save to local filesystem
  const localPath = path.join(LOCAL_UPLOAD_ROOT, key);
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.writeFileSync(localPath, buffer);
  const url = `/uploads/${key}`;
  console.log('[local] Saved file:', url);
  return url;
}

// ── Multer — memory storage (no disk write) ───────────────────────────────────
const ALLOWED_IMAGE = /^image\/(jpeg|jpg|png|webp|gif)$/i;
const ALLOWED_DOC   = /^(application\/pdf|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document)$/i;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (['resume', 'certifications', 'reference_letter'].includes(file.fieldname)) {
      return cb(null, ALLOWED_DOC.test(file.mimetype) || /\.(pdf|docx)$/i.test(file.originalname));
    }
    cb(null, ALLOWED_IMAGE.test(file.mimetype));
  },
});

// ── POST /api/uploads/profile-pic ────────────────────────────────────────────
router.post('/profile-pic', authenticateToken, upload.single('profile_pic'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  const ext = path.extname(req.file.originalname).toLowerCase() || '.jpg';
  const key = `users/${req.user.id}/profile_pic${ext}`;
  try {
    const url = await uploadFile(req.file.buffer, key, req.file.mimetype);
    await db.prepare('UPDATE users SET profile_pic = ?, updated_at = NOW() WHERE id = ?')
      .run(url, req.user.id);
    res.json({ ok: true, profile_pic: url });
  } catch (err) {
    console.error('[profile-pic] error:', err.message);
    res.status(500).json({ error: 'Failed to save profile picture' });
  }
});

// ── POST /api/uploads/talent-files ───────────────────────────────────────────
router.post('/talent-files', authenticateToken, upload.fields([
  { name: 'profile_pic',       maxCount: 1 },
  { name: 'resume',            maxCount: 1 },
  { name: 'specs_image',       maxCount: 1 },
  { name: 'speedtest_image',   maxCount: 1 },
  { name: 'certifications',    maxCount: 1 },
  { name: 'reference_letter',  maxCount: 1 },
]), async (req, res) => {
  if (req.user.role !== 'freelancer') {
    return res.status(403).json({ error: 'Only talent accounts can upload files' });
  }
  if (!req.files || Object.keys(req.files).length === 0) {
    return res.status(400).json({ error: 'No files were uploaded' });
  }

  const uid = req.user.id;
  const updates = {};

  try {
    if (req.files.profile_pic) {
      const f = req.files.profile_pic[0];
      const ext = path.extname(f.originalname).toLowerCase() || '.jpg';
      updates.profile_pic = await uploadFile(f.buffer, `users/${uid}/profile_pic${ext}`, f.mimetype);
    }
    if (req.files.resume) {
      const f = req.files.resume[0];
      const ext = path.extname(f.originalname).toLowerCase() || '.pdf';
      updates.resume_file = await uploadFile(f.buffer, `users/${uid}/resume${ext}`, f.mimetype);
    }
    if (req.files.specs_image) {
      const f = req.files.specs_image[0];
      const ext = path.extname(f.originalname).toLowerCase() || '.png';
      updates.specs_image = await uploadFile(f.buffer, `users/${uid}/specs_image${ext}`, f.mimetype);
    }
    if (req.files.speedtest_image) {
      const f = req.files.speedtest_image[0];
      const ext = path.extname(f.originalname).toLowerCase() || '.png';
      updates.speedtest_image = await uploadFile(f.buffer, `users/${uid}/speedtest_image${ext}`, f.mimetype);
    }
    if (req.files.certifications) {
      const f = req.files.certifications[0];
      const ext = path.extname(f.originalname).toLowerCase() || '.pdf';
      updates.certifications_url = await uploadFile(f.buffer, `users/${uid}/certifications${ext}`, f.mimetype);
    }
    if (req.files.reference_letter) {
      const f = req.files.reference_letter[0];
      const ext = path.extname(f.originalname).toLowerCase() || '.pdf';
      updates.reference_letter_url = await uploadFile(f.buffer, `users/${uid}/reference_letter${ext}`, f.mimetype);
    }

    const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    await db.prepare(
      `UPDATE users SET ${setClauses}, pre_screen_status = 'ready_for_approval', updated_at = NOW() WHERE id = ?`
    ).run(...Object.values(updates), uid);

    res.json({ ok: true, uploaded: Object.keys(updates) });
  } catch (err) {
    console.error('[talent-files] error:', err.message);
    res.status(500).json({ error: 'Failed to upload files' });
  }
});

// ── GET /api/uploads/my-files ─────────────────────────────────────────────────
router.get('/my-files', authenticateToken, async (req, res) => {
  try {
    const user = await db.prepare(`
      SELECT profile_pic, resume_file, specs_image, speedtest_image,
             certifications_url, reference_letter_url,
             detected_ram, detected_cpu, detected_speed_down, detected_speed_up,
             pre_screen_status
      FROM users WHERE id = ?
    `).get(req.user.id);
    res.json(user || {});
  } catch (err) {
    console.error('[my-files] error:', err.message);
    res.status(500).json({ error: 'Failed to fetch files' });
  }
});

module.exports = router;
