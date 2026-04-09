const express = require('express');
const router = express.Router();
const db = require('../database');
const { requireAdmin, requireSuperAdmin } = require('../middleware/auth');
const { sendEmail, eliteWelcomeEmail, standardRetentionEmail, standardApprovalEmail, requestReuploadEmail } = require('../services/email');
const { analyzeApplication, generateSleekProfile } = require('../services/ai');

// ─── GET /api/admin/stats ────────────────────────────────────────────────────
router.get('/stats', requireAdmin, async (req, res) => {
  try {
    const [pending, standard, elite, eliteQueue, employers, totalJobs] = await Promise.all([
      db.prepare("SELECT COUNT(*) as c FROM users WHERE role='freelancer' AND talent_status='pending'").get(),
      db.prepare("SELECT COUNT(*) as c FROM users WHERE role='freelancer' AND talent_status='standard_marketplace'").get(),
      db.prepare("SELECT COUNT(*) as c FROM users WHERE role='freelancer' AND talent_status='elite_candidate'").get(),
      db.prepare("SELECT COUNT(*) as c FROM users WHERE role='freelancer' AND video_loom_link != '' AND talent_status != 'elite_candidate'").get(),
      db.prepare("SELECT COUNT(*) as c FROM users WHERE role='employer' AND (admin_role IS NULL OR admin_role = '')").get(),
      db.prepare("SELECT COUNT(*) as c FROM jobs").get(),
    ]);

    res.json({
      pending:            parseInt(pending.c),
      standard:           parseInt(standard.c),
      elite:              parseInt(elite.c),
      elite_review_queue: parseInt(eliteQueue.c),
      employers:          parseInt(employers.c),
      total_jobs:         parseInt(totalJobs.c),
    });
  } catch (err) {
    console.error('[admin stats] error:', err.message);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ─── GET /api/admin/vetting-queue ─────────────────────────────────────────────
router.get('/vetting-queue', requireAdmin, async (req, res) => {
  try {
    const candidates = await db.prepare(`
      SELECT id, full_name, email, bio, skills, location, hardware_specs, speedtest_url,
             video_loom_link, admin_notes, talent_status, pre_screen_status, profile_pic, created_at
      FROM users
      WHERE role = 'freelancer'
        AND talent_status IN ('pending', 'standard_marketplace')
      ORDER BY created_at ASC
      LIMIT 100
    `).all();
    res.json(candidates);
  } catch (err) {
    console.error('[vetting-queue] error:', err.message);
    res.status(500).json({ error: 'Failed to fetch queue' });
  }
});

// ─── GET /api/admin/elite-pool ─────────────────────────────────────────────
router.get('/elite-pool', requireAdmin, async (req, res) => {
  try {
    const elite = await db.prepare(`
      SELECT id, full_name, email, bio, skills, location, hardware_specs, speedtest_url,
             video_loom_link, admin_notes, talent_status, pre_screen_status, profile_pic, created_at
      FROM users
      WHERE role = 'freelancer' AND talent_status = 'elite_candidate'
      ORDER BY created_at DESC
    `).all();
    res.json(elite);
  } catch (err) {
    console.error('[elite-pool] error:', err.message);
    res.status(500).json({ error: 'Failed to fetch elite pool' });
  }
});

// ─── POST /api/admin/approve/:id ─────────────────────────────────────────────
router.post('/approve/:id', requireAdmin, async (req, res) => {
  try {
    const candidate = await db.prepare("SELECT * FROM users WHERE id = ? AND role = 'freelancer'").get(parseInt(req.params.id));
    if (!candidate) return res.status(404).json({ error: 'Candidate not found' });

    await db.prepare("UPDATE users SET talent_status = 'elite_candidate', updated_at = NOW() WHERE id = ?")
      .run(parseInt(req.params.id));

    let emailError = null;
    try {
      await sendEmail({ to: candidate.email, ...eliteWelcomeEmail(candidate.full_name) });
    } catch (err) {
      emailError = err.message;
      console.error('Elite welcome email failed:', err.message);
    }

    res.json({ message: `${candidate.full_name} promoted to Elite Candidate`, status: 'elite_candidate', email_error: emailError });
  } catch (err) {
    console.error('[approve] error:', err.message);
    res.status(500).json({ error: 'Failed to approve candidate' });
  }
});

// ─── POST /api/admin/approve-standard/:id ────────────────────────────────────
router.post('/approve-standard/:id', requireAdmin, async (req, res) => {
  try {
    const candidate = await db.prepare("SELECT * FROM users WHERE id = ? AND role = 'freelancer'").get(parseInt(req.params.id));
    if (!candidate) return res.status(404).json({ error: 'Candidate not found' });

    await db.prepare("UPDATE users SET talent_status = 'standard_marketplace', updated_at = NOW() WHERE id = ?")
      .run(parseInt(req.params.id));

    let emailError = null;
    try {
      await sendEmail({ to: candidate.email, ...standardApprovalEmail(candidate.full_name) });
    } catch (err) {
      emailError = err.message;
      console.error('Standard approval email failed:', err.message);
    }

    res.json({ message: `${candidate.full_name} approved to Standard Marketplace`, status: 'standard_marketplace', email_error: emailError });
  } catch (err) {
    console.error('[approve-standard] error:', err.message);
    res.status(500).json({ error: 'Failed to approve candidate' });
  }
});

// ─── POST /api/admin/deny/:id ─────────────────────────────────────────────────
router.post('/deny/:id', requireAdmin, async (req, res) => {
  const { feedback } = req.body;
  try {
    const candidate = await db.prepare("SELECT * FROM users WHERE id = ? AND role = 'freelancer'").get(parseInt(req.params.id));
    if (!candidate) return res.status(404).json({ error: 'Candidate not found' });

    await db.prepare("UPDATE users SET talent_status = 'denied', updated_at = NOW() WHERE id = ?")
      .run(parseInt(req.params.id));

    sendEmail({ to: candidate.email, ...standardRetentionEmail(candidate.full_name, feedback || '') })
      .catch(err => console.error('Denial email failed:', err.message));

    res.json({ message: `${candidate.full_name} application denied`, status: 'denied' });
  } catch (err) {
    console.error('[deny] error:', err.message);
    res.status(500).json({ error: 'Failed to deny candidate' });
  }
});

// ─── POST /api/admin/reject/:id ──────────────────────────────────────────────
router.post('/reject/:id', requireAdmin, async (req, res) => {
  const { feedback } = req.body;
  try {
    const candidate = await db.prepare("SELECT * FROM users WHERE id = ? AND role = 'freelancer'").get(parseInt(req.params.id));
    if (!candidate) return res.status(404).json({ error: 'Candidate not found' });

    await db.prepare("UPDATE users SET talent_status = 'standard_marketplace', updated_at = NOW() WHERE id = ?")
      .run(parseInt(req.params.id));

    sendEmail({ to: candidate.email, ...standardRetentionEmail(candidate.full_name, feedback || '') })
      .catch(err => console.error('Standard retention email failed:', err.message));

    res.json({ message: `${candidate.full_name} kept in Standard Marketplace`, status: 'standard_marketplace' });
  } catch (err) {
    console.error('[reject] error:', err.message);
    res.status(500).json({ error: 'Failed to reject candidate' });
  }
});

// ─── PUT /api/admin/notes/:id ─────────────────────────────────────────────────
router.put('/notes/:id', requireAdmin, async (req, res) => {
  const { notes } = req.body;
  try {
    await db.prepare("UPDATE users SET admin_notes = ?, updated_at = NOW() WHERE id = ?")
      .run(notes || '', parseInt(req.params.id));
    res.json({ message: 'Notes saved' });
  } catch (err) {
    console.error('[notes] error:', err.message);
    res.status(500).json({ error: 'Failed to save notes' });
  }
});

// ─── GET /api/admin/users ─────────────────────────────────────────────────────
router.get('/users', requireSuperAdmin, async (req, res) => {
  const { role, status, search, page = 1, limit = 50 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  let whereClause = 'WHERE 1=1';
  const params = [];

  if (role && role !== 'all') { whereClause += ' AND role = ?'; params.push(role); }
  if (status && status !== 'all') { whereClause += ' AND talent_status = ?'; params.push(status); }
  if (search) { whereClause += ' AND (full_name ILIKE ? OR email ILIKE ?)'; params.push(`%${search}%`, `%${search}%`); }

  try {
    const countRow = await db.prepare(`SELECT COUNT(*) as c FROM users ${whereClause}`).get(...params);
    const total = parseInt(countRow.c);

    const users = await db.prepare(
      `SELECT id, email, full_name, role, talent_status, admin_role, is_verified, created_at FROM users ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).all(...params, parseInt(limit), offset);

    res.json({ users, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
  } catch (err) {
    console.error('[admin users] error:', err.message);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// ─── DELETE /api/admin/users/:id ─────────────────────────────────────────────
router.delete('/users/:id', requireSuperAdmin, async (req, res) => {
  try {
    const user = await db.prepare('SELECT id, full_name, admin_role FROM users WHERE id = ?').get(parseInt(req.params.id));
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.admin_role === 'super_admin') return res.status(403).json({ error: 'Cannot delete a super admin' });

    await db.prepare('DELETE FROM applications WHERE freelancer_id = ? OR job_id IN (SELECT id FROM jobs WHERE employer_id = ?)').run(parseInt(req.params.id), parseInt(req.params.id));
    await db.prepare('DELETE FROM jobs WHERE employer_id = ?').run(parseInt(req.params.id));
    await db.prepare('DELETE FROM users WHERE id = ?').run(parseInt(req.params.id));

    res.json({ message: `User ${user.full_name} deleted` });
  } catch (err) {
    console.error('[delete user] error:', err.message);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// ─── GET /api/admin/full-profile/:id ─────────────────────────────────────────
router.get('/full-profile/:id', requireAdmin, async (req, res) => {
  try {
    const user = await db.prepare(`
      SELECT id, full_name, email, bio, skills, location,
             profile_pic, hardware_specs, speedtest_url, video_loom_link,
             resume_file, specs_image, speedtest_image,
             detected_ram, detected_cpu, detected_speed_down, detected_speed_up,
             ai_tier_recommendation, ai_summary,
             pre_screen_status, talent_status, admin_notes, sleek_profile,
             is_top_tier, personality_type, personality_badge, created_at
      FROM users WHERE id = ? AND role = 'freelancer'
    `).get(parseInt(req.params.id));
    if (!user) return res.status(404).json({ error: 'Candidate not found' });
    res.json(user);
  } catch (err) {
    console.error('[full-profile] error:', err.message);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// ─── POST /api/admin/reanalyze/:id ────────────────────────────────────────────
router.post('/reanalyze/:id', requireAdmin, async (req, res) => {
  try {
    const user = await db.prepare("SELECT id, full_name FROM users WHERE id = ? AND role = 'freelancer'").get(parseInt(req.params.id));
    if (!user) return res.status(404).json({ error: 'Candidate not found' });
    await db.prepare("UPDATE users SET pre_screen_status = 'processing' WHERE id = ?").run(parseInt(req.params.id));
    analyzeApplication(req.params.id).catch(err => console.error('[reanalyze] AI error:', err.message));
    res.json({ message: `AI re-analysis started for ${user.full_name}` });
  } catch (err) {
    console.error('[reanalyze] error:', err.message);
    res.status(500).json({ error: 'Failed to start re-analysis' });
  }
});

// ─── POST /api/admin/request-reupload/:id ─────────────────────────────────────
router.post('/request-reupload/:id', requireAdmin, async (req, res) => {
  const { items, message } = req.body;
  try {
    const candidate = await db.prepare("SELECT * FROM users WHERE id = ? AND role = 'freelancer'").get(parseInt(req.params.id));
    if (!candidate) return res.status(404).json({ error: 'Candidate not found' });

    await db.prepare("UPDATE users SET pre_screen_status = 'pending_correction', updated_at = NOW() WHERE id = ?")
      .run(parseInt(req.params.id));

    sendEmail({ to: candidate.email, ...requestReuploadEmail(candidate.full_name, items || [], message || '') })
      .catch(err => console.error('Re-upload email failed:', err.message));

    res.json({ message: `Re-upload request sent to ${candidate.full_name}` });
  } catch (err) {
    console.error('[request-reupload] error:', err.message);
    res.status(500).json({ error: 'Failed to send re-upload request' });
  }
});

// ─── GET /api/admin/employer-profile/:id ─────────────────────────────────────
router.get('/employer-profile/:id', requireAdmin, async (req, res) => {
  try {
    const employer = await db.prepare(`
      SELECT id, full_name, email, role, subscription_tier, subscription_expires_at,
             client_brief, employer_plan, created_at
      FROM users WHERE id = ? AND role = 'employer'
    `).get(parseInt(req.params.id));
    if (!employer) return res.status(404).json({ error: 'Employer not found' });
    res.json(employer);
  } catch (err) {
    console.error('[employer-profile] error:', err.message);
    res.status(500).json({ error: 'Failed to fetch employer profile' });
  }
});

// ─── PUT /api/admin/employer-brief/:id ───────────────────────────────────────
router.put('/employer-brief/:id', requireAdmin, async (req, res) => {
  const { client_brief } = req.body;
  try {
    await db.prepare('UPDATE users SET client_brief = ?, updated_at = NOW() WHERE id = ?')
      .run(client_brief || '', parseInt(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    console.error('[employer-brief] error:', err.message);
    res.status(500).json({ error: 'Failed to save client brief' });
  }
});

// ─── GET /api/admin/employers-list ───────────────────────────────────────────
router.get('/employers-list', requireAdmin, async (req, res) => {
  try {
    const employers = await db.prepare(`
      SELECT id, full_name, email, role, subscription_tier, subscription_expires_at, client_brief, created_at
      FROM users
      WHERE role = 'employer' AND (admin_role IS NULL OR admin_role = '')
      ORDER BY created_at DESC
    `).all();
    res.json(employers);
  } catch (err) {
    console.error('[employers-list] error:', err.message);
    res.status(500).json({ error: 'Failed to fetch employers' });
  }
});

// ─── GET /api/admin/talent-list ───────────────────────────────────────────────
router.get('/talent-list', requireAdmin, async (req, res) => {
  try {
    const talent = await db.prepare(`
      SELECT id, full_name, email, role, talent_status, profile_pic, pre_screen_status, created_at
      FROM users
      WHERE role = 'freelancer'
      ORDER BY created_at DESC
    `).all();
    res.json(talent);
  } catch (err) {
    console.error('[talent-list] error:', err.message);
    res.status(500).json({ error: 'Failed to fetch talent list' });
  }
});

// ─── POST /api/admin/test-email ──────────────────────────────────────────────
// Send a test email to the logged-in admin to verify Resend is working
router.post('/test-email', requireAdmin, async (req, res) => {
  const db2 = require('../database');
  const user = await db2.prepare('SELECT email, full_name FROM users WHERE id = ?').get(req.user.id);
  try {
    await sendEmail({
      to: user.email,
      subject: 'WorkBase PH — Email Test',
      html: `<div style="font-family:sans-serif;padding:32px;max-width:500px">
        <h2 style="color:#0d2240">Email is working!</h2>
        <p>This is a test email from WorkBase PH sent to <strong>${user.email}</strong>.</p>
        <p style="color:#6b7280;font-size:13px">If you received this, your Resend integration is correctly configured.</p>
      </div>`,
    });
    res.json({ ok: true, message: `Test email sent to ${user.email}` });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── PUT /api/admin/sleek/:id ────────────────────────────────────────────────
// Manually save a sleek profile written by admin
router.put('/sleek/:id', requireAdmin, async (req, res) => {
  const { sleek_profile } = req.body;
  try {
    await db.prepare('UPDATE users SET sleek_profile = ?, updated_at = NOW() WHERE id = ?')
      .run(sleek_profile || '', parseInt(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    console.error('[sleek PUT] error:', err.message);
    res.status(500).json({ error: 'Failed to save sleek profile' });
  }
});

// ─── POST /api/admin/generate-sleek/:id ──────────────────────────────────────
// Generate (or regenerate) a Sleek View profile for a talent from raw data
router.post('/generate-sleek/:id', requireAdmin, async (req, res) => {
  try {
    const user = await db.prepare("SELECT id, full_name FROM users WHERE id = ? AND role = 'freelancer'").get(parseInt(req.params.id));
    if (!user) return res.status(404).json({ error: 'Candidate not found' });
    const sleek = await generateSleekProfile(parseInt(req.params.id), 'generate');
    res.json({ ok: true, sleek_profile: sleek, message: `Sleek profile generated for ${user.full_name}` });
  } catch (err) {
    console.error('[generate-sleek] error:', err.message);
    res.status(500).json({ error: 'Failed to generate sleek profile: ' + err.message });
  }
});

// ─── POST /api/admin/edit-sleek/:id ──────────────────────────────────────────
// Editorial mode: polish/reformat existing admin notes or bio text
router.post('/edit-sleek/:id', requireAdmin, async (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'text field required' });
  try {
    const user = await db.prepare("SELECT id, full_name FROM users WHERE id = ? AND role = 'freelancer'").get(parseInt(req.params.id));
    if (!user) return res.status(404).json({ error: 'Candidate not found' });
    const sleek = await generateSleekProfile(parseInt(req.params.id), 'edit', text);
    res.json({ ok: true, sleek_profile: sleek, message: `Sleek profile edited for ${user.full_name}` });
  } catch (err) {
    console.error('[edit-sleek] error:', err.message);
    res.status(500).json({ error: 'Failed to edit sleek profile: ' + err.message });
  }
});

// ─── POST /api/admin/create-reviewer ─────────────────────────────────────────
router.post('/create-reviewer', requireSuperAdmin, async (req, res) => {
  const { email, full_name, password } = req.body;
  if (!email || !full_name || !password) return res.status(400).json({ error: 'email, full_name, and password required' });

  try {
    const existing = await db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) return res.status(409).json({ error: 'Email already in use' });

    const bcrypt = require('bcryptjs');
    const result = await db.prepare(
      "INSERT INTO users (email, password, full_name, role, admin_role) VALUES (?, ?, ?, 'employer', 'reviewer_admin')"
    ).run(email, bcrypt.hashSync(password, 10), full_name);

    res.status(201).json({ id: result.lastInsertRowid, email, full_name, admin_role: 'reviewer_admin' });
  } catch (err) {
    console.error('[create-reviewer] error:', err.message);
    res.status(500).json({ error: 'Failed to create reviewer' });
  }
});

// ─── PUT /api/admin/set-elite-employer/:id ───────────────────────────────────
router.put('/set-elite-employer/:id', requireAdmin, async (req, res) => {
  const { employer_plan } = req.body;
  try {
    await db.prepare("UPDATE users SET employer_plan = ?, updated_at = NOW() WHERE id = ? AND role = 'employer'")
      .run(employer_plan || 'elite', parseInt(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    console.error('[set-elite-employer] error:', err.message);
    res.status(500).json({ error: 'Failed to update employer plan' });
  }
});

// ─── PUT /api/admin/top-tier/:id ─────────────────────────────────────────────
router.put('/top-tier/:id', requireAdmin, async (req, res) => {
  const { is_top_tier } = req.body;
  try {
    await db.prepare('UPDATE users SET is_top_tier = ?, updated_at = NOW() WHERE id = ?')
      .run(is_top_tier ? 1 : 0, parseInt(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    console.error('[top-tier] error:', err.message);
    res.status(500).json({ error: 'Failed to update badge' });
  }
});

module.exports = router;
