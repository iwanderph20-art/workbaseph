const express = require('express');
const router = express.Router();
const db = require('../database');
const { authenticateToken } = require('../middleware/auth');

// ─── SUBSCRIPTION GATE HELPER ────────────────────────────────────────────────
// Returns true if the employer has an active Tier 1 subscription
function hasActiveSubscription(userId) {
  const user = db.prepare('SELECT subscription_tier, subscription_expires_at FROM users WHERE id = ?').get(userId);
  if (!user) return false;
  if (user.subscription_tier === 'tier_1' && user.subscription_expires_at) {
    return new Date(user.subscription_expires_at) > new Date();
  }
  return false;
}

// ─── VISIBILITY FIREWALL HELPER ───────────────────────────────────────────────
// Tier 1 ($100/mo): sees only standard_marketplace
// Tier 2 (20% fee) / Admin: sees elite_candidate (via admin dossier, not here)
// Unauth / free employer / talent: blocked or sees nothing
function getAllowedStatuses(req) {
  if (!req.user) return null; // not authenticated
  const user = db.prepare('SELECT admin_role, role FROM users WHERE id = ?').get(req.user.id);
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
// Requires active Tier 1 subscription (or admin). Returns Standard Marketplace only.
router.get('/', optionalAuth, (req, res) => {
  // Must be logged in as employer with active subscription (or admin)
  if (!req.user) {
    return res.status(401).json({ error: 'Login required', code: 'LOGIN_REQUIRED' });
  }
  const dbUser = db.prepare('SELECT role, admin_role FROM users WHERE id = ?').get(req.user.id);
  if (!dbUser.admin_role && dbUser.role === 'employer' && !hasActiveSubscription(req.user.id)) {
    return res.status(402).json({
      error: 'Active subscription required to search talent',
      code: 'SUBSCRIPTION_REQUIRED',
      upgrade_url: '/pricing.html',
    });
  }

  const { search, skills, location, page = 1, limit = 12 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const allowedStatuses = getAllowedStatuses(req);
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
    query += ' AND (full_name LIKE ? OR bio LIKE ? OR skills LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (skills) {
    query += ' AND skills LIKE ?';
    params.push(`%${skills}%`);
  }
  if (location) {
    query += ' AND location LIKE ?';
    params.push(`%${location}%`);
  }

  const countQuery = query.replace(/SELECT[\s\S]+?FROM/, 'SELECT COUNT(*) as c FROM');
  const total = db.prepare(countQuery).get(...params).c;

  query += ` ORDER BY is_verified DESC, created_at DESC LIMIT ${parseInt(limit)} OFFSET ${offset}`;
  const talent = db.prepare(query).all(...params);

  res.json({ talent, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
});

// ─── GET /api/talent/:id ─────────────────────────────────────────────────────
router.get('/:id', optionalAuth, (req, res) => {
  const allowedStatuses = getAllowedStatuses(req);
  const placeholders = allowedStatuses.map(() => '?').join(',');

  const talent = db.prepare(`
    SELECT id, full_name, bio, skills, location, profile_pic, is_verified, talent_status,
           hardware_specs, speedtest_url, video_loom_link, resume_file,
           detected_ram, detected_cpu, detected_speed_down, detected_speed_up,
           created_at
    FROM users
    WHERE id = ? AND role = 'freelancer' AND talent_status IN (${placeholders})
  `).get(req.params.id, ...allowedStatuses);

  if (!talent) return res.status(404).json({ error: 'Talent not found' });
  res.json(talent);
});

// ─── PUT /api/talent/profile ──────────────────────────────────────────────────
// Freelancer updates their own hardware specs, speedtest, video link
router.put('/profile', authenticateToken, (req, res) => {
  if (req.user.role !== 'freelancer') return res.status(403).json({ error: 'Freelancers only' });

  const { full_name, bio, skills, location, hardware_specs, speedtest_url, video_loom_link } = req.body;

  // Calculate if they qualify for elite review trigger
  const current = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const newSpecs = hardware_specs || current.hardware_specs;
  const newSpeedtest = speedtest_url || current.speedtest_url;
  const newVideo = video_loom_link || current.video_loom_link;

  // Auto-flag for admin review if all 3 elite requirements are met
  let newStatus = current.talent_status;
  if (newSpecs && newSpeedtest && newVideo && current.talent_status === 'standard_marketplace') {
    newStatus = 'standard_marketplace'; // stays standard, but visible in vetting queue
  }

  // Profile completion check: move pending → standard if ≥50% complete
  const fields = [full_name || current.full_name, bio || current.bio, skills || current.skills, location || current.location];
  const filled = fields.filter(f => f && f.trim()).length;
  const completion = Math.round((filled / fields.length) * 100);
  if (current.talent_status === 'pending' && completion >= 50) {
    newStatus = 'standard_marketplace';
  }

  db.prepare(`
    UPDATE users SET
      full_name = ?, bio = ?, skills = ?, location = ?,
      hardware_specs = ?, speedtest_url = ?, video_loom_link = ?,
      talent_status = ?, updated_at = CURRENT_TIMESTAMP
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

  const updated = db.prepare('SELECT id, email, full_name, role, bio, skills, location, hardware_specs, speedtest_url, video_loom_link, talent_status, is_verified FROM users WHERE id = ?').get(req.user.id);
  res.json({ ...updated, profile_completion: completion, elite_review_ready: !!(newSpecs && newSpeedtest && newVideo) });
});

module.exports = router;
