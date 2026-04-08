const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const db       = require('../database');
const { authenticateToken } = require('../middleware/auth');
const { analyzeApplication }  = require('../services/ai');

// Upload root: /data/uploads on Railway (persisted volume), public/uploads locally
const UPLOAD_ROOT = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'public', 'uploads');

// ── Multer config ─────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = path.join(UPLOAD_ROOT, String(req.user.id));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    // Deterministic names so re-uploads overwrite the old file
    const ext = path.extname(file.originalname).toLowerCase() || '.bin';
    cb(null, file.fieldname + ext);
  },
});

const ALLOWED_IMAGE = /^image\/(jpeg|jpg|png|webp|gif)$/i;
const ALLOWED_DOC   = /^(application\/pdf|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document)$/i;

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB per file
  fileFilter(req, file, cb) {
    if (file.fieldname === 'resume') {
      return cb(null, ALLOWED_DOC.test(file.mimetype) || file.originalname.match(/\.(pdf|docx)$/i) !== null);
    }
    cb(null, ALLOWED_IMAGE.test(file.mimetype));
  },
});

// ── POST /api/uploads/profile-pic ─────────────────────────────────────────────
// Accepts a single profile photo. Requires authenticated user (any role).
router.post('/profile-pic', authenticateToken, upload.single('profile_pic'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  const ext = path.extname(req.file.originalname).toLowerCase() || '.jpg';
  const picPath = `/uploads/${req.user.id}/profile_pic${ext}`;
  db.prepare('UPDATE users SET profile_pic = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(picPath, req.user.id);
  res.json({ ok: true, profile_pic: picPath });
});

// ── POST /api/uploads/talent-files ────────────────────────────────────────────
// Accepts up to three files: resume, specs_image, speedtest_image.
// Requires authenticated freelancer. Triggers AI analysis after save.
router.post('/talent-files', authenticateToken, upload.fields([
  { name: 'resume',          maxCount: 1 },
  { name: 'specs_image',     maxCount: 1 },
  { name: 'speedtest_image', maxCount: 1 },
]), async (req, res) => {
  if (req.user.role !== 'freelancer') {
    return res.status(403).json({ error: 'Only talent accounts can upload files' });
  }
  if (!req.files || Object.keys(req.files).length === 0) {
    return res.status(400).json({ error: 'No files were uploaded' });
  }

  const uid = req.user.id;
  const updates = {};

  if (req.files.resume) {
    const f = req.files.resume[0];
    updates.resume_file = `/uploads/${uid}/resume${path.extname(f.originalname).toLowerCase() || '.pdf'}`;
  }
  if (req.files.specs_image) {
    const f = req.files.specs_image[0];
    updates.specs_image = `/uploads/${uid}/specs_image${path.extname(f.originalname).toLowerCase() || '.png'}`;
  }
  if (req.files.speedtest_image) {
    const f = req.files.speedtest_image[0];
    updates.speedtest_image = `/uploads/${uid}/speedtest_image${path.extname(f.originalname).toLowerCase() || '.png'}`;
  }

  // Persist paths + set pre_screen_status = processing
  const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE users SET ${setClauses}, pre_screen_status = 'processing', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(...Object.values(updates), uid);

  // Kick off AI analysis in background (non-blocking)
  analyzeApplication(uid).catch(err => console.error('[uploads] AI error:', err.message));

  res.json({ ok: true, uploaded: Object.keys(updates), message: 'Files saved. AI analysis running in background.' });
});

// ── GET /api/uploads/my-files ─────────────────────────────────────────────────
// Returns current file paths + AI results for the logged-in talent
router.get('/my-files', authenticateToken, (req, res) => {
  const user = db.prepare(`
    SELECT profile_pic, resume_file, specs_image, speedtest_image,
           detected_ram, detected_cpu, detected_speed_down, detected_speed_up,
           ai_tier_recommendation, ai_summary, pre_screen_status
    FROM users WHERE id = ?
  `).get(req.user.id);
  res.json(user || {});
});

module.exports = router;
