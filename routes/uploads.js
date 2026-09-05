const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const path     = require('path');
const db       = require('../database');
const { authenticateToken } = require('../middleware/auth');
const { uploadFile } = require('../services/storage');

// ── Multer — memory storage (no disk write) ───────────────────────────────────
// Accept the common phone/desktop screenshot formats. Filipino talents upload
// from phones, where photos and screenshots frequently arrive as HEIC/HEIF (or
// with an empty / octet-stream mimetype), so we also fall back to the filename
// extension rather than trusting the browser-reported mimetype alone.
const ALLOWED_IMAGE     = /^image\/(jpeg|jpg|png|webp|gif|heic|heif)$/i;
const ALLOWED_IMAGE_EXT = /\.(jpe?g|png|webp|gif|heic|heif)$/i;
const ALLOWED_DOC       = /^(application\/pdf|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document)$/i;
const ALLOWED_AUDIO     = /^audio\/(mpeg|mp3|wav|x-wav|m4a|x-m4a|aac|ogg|webm)$/i;
const ALLOWED_AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|webm)$/i;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    let ok;
    if (['resume', 'certifications', 'reference_letter'].includes(file.fieldname)) {
      ok = ALLOWED_DOC.test(file.mimetype) || /\.(pdf|docx)$/i.test(file.originalname);
    } else if (file.fieldname === 'audio_intro') {
      ok = ALLOWED_AUDIO.test(file.mimetype) || ALLOWED_AUDIO_EXT.test(file.originalname);
    } else {
      ok = ALLOWED_IMAGE.test(file.mimetype) || ALLOWED_IMAGE_EXT.test(file.originalname);
    }
    // Record rejections so the route can return a clear message instead of the
    // file being silently dropped (which reads to the talent as "nothing happened").
    if (!ok) {
      req.rejectedFiles = req.rejectedFiles || [];
      req.rejectedFiles.push(file.originalname || file.fieldname);
    }
    cb(null, ok);
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
  { name: 'audio_intro',       maxCount: 1 },
]), async (req, res) => {
  if (req.user.role !== 'freelancer') {
    return res.status(403).json({ error: 'Only talent accounts can upload files' });
  }
  if (!req.files || Object.keys(req.files).length === 0) {
    if (req.rejectedFiles && req.rejectedFiles.length) {
      return res.status(400).json({
        error: "That file type isn't supported. Please upload a JPG, PNG, or HEIC image (a screenshot works best).",
      });
    }
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
    if (req.files.audio_intro) {
      const f = req.files.audio_intro[0];
      const ext = path.extname(f.originalname).toLowerCase() || '.mp3';
      updates.audio_intro_url = await uploadFile(f.buffer, `users/${uid}/audio_intro${ext}`, f.mimetype);
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
             certifications_url, reference_letter_url, audio_intro_url,
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
