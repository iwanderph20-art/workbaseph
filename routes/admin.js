const express = require('express');
const router = express.Router();
const db = require('../database');
const { requireAdmin, requireSuperAdmin } = require('../middleware/auth');
const { sendEmail, eliteWelcomeEmail, standardRetentionEmail, standardApprovalEmail, requestReuploadEmail } = require('../services/email');
const { analyzeApplication } = require('../services/ai');

// ─── GET /api/admin/stats ────────────────────────────────────────────────────
router.get('/stats', requireAdmin, (req, res) => {
  const stats = {
    pending:            db.prepare("SELECT COUNT(*) as c FROM users WHERE role='freelancer' AND talent_status='pending'").get().c,
    standard:           db.prepare("SELECT COUNT(*) as c FROM users WHERE role='freelancer' AND talent_status='standard_marketplace'").get().c,
    elite:              db.prepare("SELECT COUNT(*) as c FROM users WHERE role='freelancer' AND talent_status='elite_candidate'").get().c,
    elite_review_queue: db.prepare("SELECT COUNT(*) as c FROM users WHERE role='freelancer' AND video_loom_link != '' AND talent_status != 'elite_candidate'").get().c,
    employers:          db.prepare("SELECT COUNT(*) as c FROM users WHERE role='employer'").get().c,
    total_jobs:         db.prepare("SELECT COUNT(*) as c FROM jobs").get().c,
  };
  res.json(stats);
});

// ─── GET /api/admin/vetting-queue ─────────────────────────────────────────────
// Returns ALL new freelancer sign-ups pending admin review
router.get('/vetting-queue', requireAdmin, (req, res) => {
  const candidates = db.prepare(`
    SELECT id, full_name, email, bio, skills, location, hardware_specs, speedtest_url,
           video_loom_link, admin_notes, talent_status, pre_screen_status, profile_pic, created_at
    FROM users
    WHERE role = 'freelancer'
      AND talent_status IN ('pending', 'standard_marketplace')
    ORDER BY created_at ASC
    LIMIT 100
  `).all();
  res.json(candidates);
});

// ─── GET /api/admin/elite-pool ─────────────────────────────────────────────
router.get('/elite-pool', requireAdmin, (req, res) => {
  const elite = db.prepare(`
    SELECT id, full_name, email, bio, skills, location, hardware_specs, speedtest_url,
           video_loom_link, admin_notes, talent_status, pre_screen_status, profile_pic, created_at
    FROM users
    WHERE role = 'freelancer' AND talent_status = 'elite_candidate'
    ORDER BY created_at DESC
  `).all();
  res.json(elite);
});

// ─── POST /api/admin/approve/:id ─────────────────────────────────────────────
router.post('/approve/:id', requireAdmin, (req, res) => {
  const candidate = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'freelancer'").get(req.params.id);
  if (!candidate) return res.status(404).json({ error: 'Candidate not found' });

  db.prepare("UPDATE users SET talent_status = 'elite_candidate', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(req.params.id);

  // Send Elite Welcome Email (non-blocking)
  const emailTemplate = eliteWelcomeEmail(candidate.full_name);
  sendEmail({ to: candidate.email, ...emailTemplate })
    .catch(err => console.error('Elite welcome email failed:', err.message));

  res.json({ message: `${candidate.full_name} promoted to Elite Candidate`, status: 'elite_candidate' });
});

// ─── POST /api/admin/approve-standard/:id ────────────────────────────────────
// Approve candidate to Standard Marketplace
router.post('/approve-standard/:id', requireAdmin, (req, res) => {
  const candidate = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'freelancer'").get(req.params.id);
  if (!candidate) return res.status(404).json({ error: 'Candidate not found' });

  db.prepare("UPDATE users SET talent_status = 'standard_marketplace', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(req.params.id);

  sendEmail({ to: candidate.email, ...standardApprovalEmail(candidate.full_name) })
    .catch(err => console.error('Standard approval email failed:', err.message));

  res.json({ message: `${candidate.full_name} approved to Standard Marketplace`, status: 'standard_marketplace' });
});

// ─── POST /api/admin/deny/:id ─────────────────────────────────────────────────
// Deny / reject a candidate entirely
router.post('/deny/:id', requireAdmin, (req, res) => {
  const { feedback } = req.body;
  const candidate = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'freelancer'").get(req.params.id);
  if (!candidate) return res.status(404).json({ error: 'Candidate not found' });

  db.prepare("UPDATE users SET talent_status = 'denied', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(req.params.id);

  const emailTemplate = standardRetentionEmail(candidate.full_name, feedback || '');
  sendEmail({ to: candidate.email, ...emailTemplate })
    .catch(err => console.error('Denial email failed:', err.message));

  res.json({ message: `${candidate.full_name} application denied`, status: 'denied' });
});

// ─── POST /api/admin/reject/:id ──────────────────────────────────────────────
router.post('/reject/:id', requireAdmin, (req, res) => {
  const { feedback } = req.body;
  const candidate = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'freelancer'").get(req.params.id);
  if (!candidate) return res.status(404).json({ error: 'Candidate not found' });

  // Keep as standard_marketplace
  db.prepare("UPDATE users SET talent_status = 'standard_marketplace', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(req.params.id);

  // Send Standard Retention Email with feedback
  const emailTemplate = standardRetentionEmail(candidate.full_name, feedback || '');
  sendEmail({ to: candidate.email, ...emailTemplate })
    .catch(err => console.error('Standard retention email failed:', err.message));

  res.json({ message: `${candidate.full_name} kept in Standard Marketplace`, status: 'standard_marketplace' });
});

// ─── PUT /api/admin/notes/:id ─────────────────────────────────────────────────
// Admin-only private notes on a profile
router.put('/notes/:id', requireAdmin, (req, res) => {
  const { notes } = req.body;
  db.prepare("UPDATE users SET admin_notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(notes || '', req.params.id);
  res.json({ message: 'Notes saved' });
});

// ─── GET /api/admin/users ─────────────────────────────────────────────────────
// Super Admin only: full user list
router.get('/users', requireSuperAdmin, (req, res) => {
  const { role, status, search, page = 1, limit = 50 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  let query = `SELECT id, email, full_name, role, talent_status, admin_role, is_verified, created_at FROM users WHERE 1=1`;
  const params = [];

  if (role && role !== 'all') { query += ' AND role = ?'; params.push(role); }
  if (status && status !== 'all') { query += ' AND talent_status = ?'; params.push(status); }
  if (search) { query += ' AND (full_name LIKE ? OR email LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }

  const total = db.prepare(query.replace('SELECT id, email, full_name, role, talent_status, admin_role, is_verified, created_at', 'SELECT COUNT(*) as c')).get(...params).c;
  query += ` ORDER BY created_at DESC LIMIT ${parseInt(limit)} OFFSET ${offset}`;

  const users = db.prepare(query).all(...params);
  res.json({ users, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
});

// ─── DELETE /api/admin/users/:id ─────────────────────────────────────────────
router.delete('/users/:id', requireSuperAdmin, (req, res) => {
  const user = db.prepare('SELECT id, full_name, admin_role FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.admin_role === 'super_admin') return res.status(403).json({ error: 'Cannot delete a super admin' });

  db.prepare('DELETE FROM applications WHERE freelancer_id = ? OR job_id IN (SELECT id FROM jobs WHERE employer_id = ?)').run(req.params.id, req.params.id);
  db.prepare('DELETE FROM jobs WHERE employer_id = ?').run(req.params.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);

  res.json({ message: `User ${user.full_name} deleted` });
});

// ─── GET /api/admin/full-profile/:id ─────────────────────────────────────────
// Returns full application data for the profile review modal
router.get('/full-profile/:id', requireAdmin, (req, res) => {
  const user = db.prepare(`
    SELECT id, full_name, email, bio, skills, location,
           profile_pic, hardware_specs, speedtest_url, video_loom_link,
           resume_file, specs_image, speedtest_image,
           detected_ram, detected_cpu, detected_speed_down, detected_speed_up,
           ai_tier_recommendation, ai_summary,
           pre_screen_status, talent_status, admin_notes, created_at
    FROM users WHERE id = ? AND role = 'freelancer'
  `).get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Candidate not found' });
  res.json(user);
});

// ─── POST /api/admin/reanalyze/:id ────────────────────────────────────────────
// Manually re-trigger AI analysis for a candidate
router.post('/reanalyze/:id', requireAdmin, async (req, res) => {
  const user = db.prepare("SELECT id, full_name FROM users WHERE id = ? AND role = 'freelancer'").get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Candidate not found' });
  db.prepare("UPDATE users SET pre_screen_status = 'processing' WHERE id = ?").run(req.params.id);
  analyzeApplication(req.params.id).catch(err => console.error('[reanalyze] AI error:', err.message));
  res.json({ message: `AI re-analysis started for ${user.full_name}` });
});

// ─── POST /api/admin/request-reupload/:id ─────────────────────────────────────
// Ask candidate to re-upload specific files
router.post('/request-reupload/:id', requireAdmin, (req, res) => {
  const { items, message } = req.body; // items: array of ['resume','specs_image','speedtest_image']
  const candidate = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'freelancer'").get(req.params.id);
  if (!candidate) return res.status(404).json({ error: 'Candidate not found' });

  db.prepare("UPDATE users SET pre_screen_status = 'pending_correction', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(req.params.id);

  const template = requestReuploadEmail(candidate.full_name, items || [], message || '');
  sendEmail({ to: candidate.email, ...template })
    .catch(err => console.error('Re-upload email failed:', err.message));

  res.json({ message: `Re-upload request sent to ${candidate.full_name}` });
});

// ─── POST /api/admin/create-reviewer ─────────────────────────────────────────
// Super Admin only: create a reviewer_admin account
router.post('/create-reviewer', requireSuperAdmin, (req, res) => {
  const { email, full_name, password } = req.body;
  if (!email || !full_name || !password) return res.status(400).json({ error: 'email, full_name, and password required' });

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return res.status(409).json({ error: 'Email already in use' });

  const bcrypt = require('bcryptjs');
  const result = db.prepare(
    "INSERT INTO users (email, password, full_name, role, admin_role) VALUES (?, ?, ?, 'employer', 'reviewer_admin')"
  ).run(email, bcrypt.hashSync(password, 10), full_name);

  res.status(201).json({ id: result.lastInsertRowid, email, full_name, admin_role: 'reviewer_admin' });
});

module.exports = router;
