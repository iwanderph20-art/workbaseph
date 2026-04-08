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

// ─── VISIBILITY FIREWALL HELPER ───────────────────────────────────────────────
async function getAllowedStatuses(req) {
  if (!req.user) return null;
  const user = await db.prepare('SELECT admin_role, role FROM users WHERE id = ?').get(req.user.id);
  if (user && user.admin_role) return ['standard_marketplace', 'elite_candidate'];
  return ['standard_marketplace'];
}

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
    const allowedStatuses = await getAllowedStatuses(req);
    const placeholders = allowedStatuses.map(() => '?').join(',');

    let query = `
      SELECT id, full_name, bio, skills, location, profile_pic, is_verified, talent_status,
             video_loom_link, detected_ram, detected_cpu, detected_speed_down, detected_speed_up, created_at
      FROM users
      WHERE role = 'freelancer'
        AND talent_status IN (${placeholders})
    `;
    const params = [...allowedStatuses];

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
  try {
    const allowedStatuses = await getAllowedStatuses(req);
    const placeholders = allowedStatuses.map(() => '?').join(',');

    const talent = await db.prepare(`
      SELECT id, full_name, bio, skills, location, profile_pic, is_verified, talent_status,
             hardware_specs, speedtest_url, video_loom_link, resume_file,
             detected_ram, detected_cpu, detected_speed_down, detected_speed_up,
             sleek_profile, created_at
      FROM users
      WHERE id = ? AND role = 'freelancer' AND talent_status IN (${placeholders})
    `).get(parseInt(req.params.id), ...allowedStatuses);

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

module.exports = router;
