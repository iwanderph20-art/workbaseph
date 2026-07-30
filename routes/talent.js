const express = require('express');
const router = express.Router();
const db = require('../database');
const { authenticateToken } = require('../middleware/auth');

// ─── SUBSCRIPTION GATE HELPER ────────────────────────────────────────────────
async function hasActiveSubscription(userId) {
  const user = await db.prepare('SELECT subscription_tier, subscription_expires_at FROM users WHERE id = ?').get(userId);
  if (!user) return false;
  if (user.subscription_tier === 'tier_1' && user.subscription_expires_at) {
    return new Date(user.subscription_expires_at) > new Date();
  }
  return false;
}

// ─── VISIBILITY FIREWALL ──────────────────────────────────────────────────────
// Every freelancer is live in the marketplace by default. Visibility is controlled
// by the talent themselves (account_paused) — there is no admin approval gate.
// Hidden only when: the talent paused their account, or they were hired/denied.
const TALENT_VISIBLE_CLAUSE = `
  COALESCE(account_paused, FALSE) = FALSE
  AND (talent_status IS NULL OR talent_status NOT IN ('hired','denied'))
`;

// Optional auth middleware — doesn't block if no token
function optionalAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return next();
  const jwt = require('jsonwebtoken');
  const { JWT_SECRET } = require('../middleware/auth');
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (!err) req.user = user;
    next();
  });
}

// ─── GET /api/talent ─────────────────────────────────────────────────────────
router.get('/', optionalAuth, async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Login required', code: 'LOGIN_REQUIRED' });
  }

  try {
    const dbUser = await db.prepare('SELECT role, admin_role FROM users WHERE id = ?').get(req.user.id);
    // Subscription gate temporarily disabled for testing
    // if (!dbUser.admin_role && dbUser.role === 'employer' && !(await hasActiveSubscription(req.user.id))) {
    //   return res.status(402).json({
    //     error: 'Active subscription required to search talent',
    //     code: 'SUBSCRIPTION_REQUIRED',
    //     upgrade_url: '/pricing.html',
    //   });
    // }

    const { search, skills, location, page = 1, limit = 12 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = `
      SELECT id, full_name, bio, skills, location, profile_pic, is_verified, talent_status,
             video_loom_link, detected_ram, detected_cpu, detected_speed_down, detected_speed_up,
             talent_code, created_at
      FROM users
      WHERE role = 'freelancer'
        AND ${TALENT_VISIBLE_CLAUSE}
    `;
    const params = [];

    if (search) {
      query += ' AND (full_name ILIKE ? OR bio ILIKE ? OR skills ILIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (skills) {
      query += ' AND skills ILIKE ?';
      params.push(`%${skills}%`);
    }
    if (location) {
      query += ' AND location ILIKE ?';
      params.push(`%${location}%`);
    }

    const countQuery = query.replace(/SELECT[\s\S]+?FROM/, 'SELECT COUNT(*) as c FROM');
    const countRow = await db.prepare(countQuery).get(...params);
    const total = parseInt(countRow.c);

    query += ` ORDER BY is_verified DESC, created_at DESC LIMIT ${parseInt(limit)} OFFSET ${offset}`;
    const talent = await db.prepare(query).all(...params);

    res.json({ talent, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
  } catch (err) {
    console.error('[talent GET /] error:', err.message);
    res.status(500).json({ error: 'Failed to fetch talent' });
  }
});

// ─── GET /api/talent/:id ─────────────────────────────────────────────────────
router.get('/:id', optionalAuth, async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Login required', code: 'LOGIN_REQUIRED' });
  }
  if (!/^\d+$/.test(req.params.id)) {
    return res.status(404).json({ error: 'Talent not found' });
  }
  try {
    // Check if viewer is an admin — admins can see any talent regardless of status
    let isAdmin = false;
    if (req.user) {
      const viewer = await db.prepare('SELECT admin_role FROM users WHERE id = ?').get(req.user.id);
      isAdmin = !!(viewer && viewer.admin_role);
    }

    const talentFields = `id, full_name, bio, skills, location, profile_pic, is_verified, talent_status,
               hardware_specs, speedtest_url, video_loom_link, resume_file,
               specs_image, speedtest_image,
               detected_ram, detected_cpu, detected_speed_down, detected_speed_up,
               personality_type, personality_badge, personality_scores,
               professional_level, education_level, hourly_rate_range, weekly_availability,
               start_availability, work_schedule, equipment, internet_speed, connection_type,
               job_title, certifications_url, is_top_tier, talent_code, created_at`;

    // Email is contact info — only surfaced to viewers with a real relationship to this talent
    // (admins, or employers who have them as an applicant/pipeline/interview). Starter employers
    // rely on it to reach candidates by email; it is never exposed on the general public view.
    const relFields = `${talentFields}, email`;

    let talent;
    if (isAdmin) {
      talent = await db.prepare(`SELECT ${relFields} FROM users WHERE id = ? AND role = 'freelancer'`).get(parseInt(req.params.id));
    } else {
      // Employers who have an existing relationship (applications, pipeline, or interview) with this
      // talent can view their profile regardless of talent_status (e.g. pending/vetting/elite).
      const isEmployer = req.user && (await db.prepare('SELECT role FROM users WHERE id = ?').get(req.user.id))?.role === 'employer';
      let hasRelationship = false;
      if (isEmployer) {
        const rel = await db.prepare(`
          SELECT 1 FROM applications a
          JOIN jobs j ON j.id = a.job_id
          WHERE a.freelancer_id = ? AND j.employer_id = ?
          UNION ALL
          SELECT 1 FROM employer_pipeline WHERE talent_id = ? AND employer_id = ?
          UNION ALL
          SELECT 1 FROM interview_requests WHERE talent_id = ? AND employer_id = ?
          LIMIT 1
        `).get(parseInt(req.params.id), req.user.id, parseInt(req.params.id), req.user.id, parseInt(req.params.id), req.user.id);
        hasRelationship = !!rel;
      }

      if (hasRelationship) {
        // Employer can see any talent they have a relationship with — incl. email for contact
        talent = await db.prepare(`SELECT ${relFields} FROM users WHERE id = ? AND role = 'freelancer'`).get(parseInt(req.params.id));
      } else {
        talent = await db.prepare(`SELECT ${talentFields} FROM users WHERE id = ? AND role = 'freelancer' AND ${TALENT_VISIBLE_CLAUSE}`).get(parseInt(req.params.id));
      }
    }

    if (!talent) return res.status(404).json({ error: 'Talent not found' });
    res.json(talent);
  } catch (err) {
    console.error('[talent GET /:id] error:', err.message);
    res.status(500).json({ error: 'Failed to fetch talent profile' });
  }
});

// ─── PUT /api/talent/profile ──────────────────────────────────────────────────
router.put('/profile', authenticateToken, async (req, res) => {
  if (req.user.role !== 'freelancer') return res.status(403).json({ error: 'Freelancers only' });

  const { full_name, bio, skills, location, hardware_specs, speedtest_url, video_loom_link } = req.body;

  try {
    const current = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const newSpecs = hardware_specs || current.hardware_specs;
    const newSpeedtest = speedtest_url || current.speedtest_url;
    const newVideo = video_loom_link || current.video_loom_link;

    let newStatus = current.talent_status;

    // Profile completion check: move pending → standard if ≥50% complete
    const fields = [full_name || current.full_name, bio || current.bio, skills || current.skills, location || current.location];
    const filled = fields.filter(f => f && f.trim()).length;
    const completion = Math.round((filled / fields.length) * 100);
    if (current.talent_status === 'pending' && completion >= 50) {
      newStatus = 'standard_marketplace';
    }

    await db.prepare(`
      UPDATE users SET
        full_name = ?, bio = ?, skills = ?, location = ?,
        hardware_specs = ?, speedtest_url = ?, video_loom_link = ?,
        talent_status = ?, updated_at = NOW()
      WHERE id = ?
    `).run(
      full_name || current.full_name,
      bio || current.bio,
      skills || current.skills,
      location || current.location,
      newSpecs,
      newSpeedtest,
      newVideo,
      newStatus,
      req.user.id
    );

    const updated = await db.prepare(
      'SELECT id, email, full_name, role, bio, skills, location, hardware_specs, speedtest_url, video_loom_link, talent_status, is_verified FROM users WHERE id = ?'
    ).get(req.user.id);

    res.json({ ...updated, profile_completion: completion, elite_review_ready: !!(newSpecs && newSpeedtest && newVideo) });
  } catch (err) {
    console.error('[talent PUT /profile] error:', err.message);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// ─── POST /api/talent/assessment ─────────────────────────────────────────────
router.post('/assessment', authenticateToken, async (req, res) => {
  if (req.user.role !== 'freelancer') return res.status(403).json({ error: 'Freelancers only' });

  const { personality_type, personality_badge, personality_scores } = req.body;
  if (!personality_type || !personality_badge) {
    return res.status(400).json({ error: 'Missing assessment results' });
  }

  try {
    // Only save if not already completed
    const current = await db.prepare('SELECT personality_type FROM users WHERE id = ?').get(req.user.id);
    if (current.personality_type) {
      return res.status(409).json({ error: 'Assessment already completed and cannot be retaken' });
    }

    await db.prepare(`
      UPDATE users SET personality_type = ?, personality_badge = ?, personality_scores = ?, updated_at = NOW()
      WHERE id = ?
    `).run(personality_type, personality_badge, JSON.stringify(personality_scores || {}), req.user.id);

    res.json({ ok: true });
  } catch (err) {
    console.error('[talent POST /assessment] error:', err.message);
    res.status(500).json({ error: 'Failed to save assessment' });
  }
});

// ─── POST /api/talent/account/pause — set or toggle account paused state ───────
// Body { paused:true|false } sets an explicit state (used by the hire email's
// "Pause my account" / "Keep my profile open" CTAs); with no body it toggles
// (the dashboard button).
router.post('/account/pause', authenticateToken, async (req, res) => {
  if (req.user.role !== 'freelancer') return res.status(403).json({ error: 'Freelancers only' });
  try {
    const user = await db.prepare('SELECT account_paused FROM users WHERE id = ?').get(req.user.id);
    const nowPaused = (typeof req.body?.paused === 'boolean') ? req.body.paused : !user.account_paused;
    await db.prepare(
      'UPDATE users SET account_paused = ?, account_paused_at = ?, updated_at = NOW() WHERE id = ?'
    ).run(nowPaused ? 1 : 0, nowPaused ? new Date().toISOString() : null, req.user.id);
    res.json({ ok: true, account_paused: nowPaused });
  } catch (err) {
    console.error('[talent POST /account/pause]', err.message);
    res.status(500).json({ error: 'Failed to update pause state' });
  }
});

// ─── DELETE /api/talent/account — request account deletion with feedback ──────
router.delete('/account', authenticateToken, async (req, res) => {
  if (req.user.role !== 'freelancer') return res.status(403).json({ error: 'Freelancers only' });
  const { reason } = req.body;
  try {
    await db.prepare(
      'UPDATE users SET account_delete_requested_at = NOW(), account_delete_reason = ?, talent_status = \'self_deleted\', updated_at = NOW() WHERE id = ?'
    ).run(reason || '', req.user.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[talent DELETE /account]', err.message);
    res.status(500).json({ error: 'Failed to request deletion' });
  }
});

module.exports = router;
