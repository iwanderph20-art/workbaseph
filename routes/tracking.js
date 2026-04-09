const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'workbaseph_secret_2026';

function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(h.replace('Bearer ', ''), JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

// PUT /api/tracking/talent — set or update status for a talent
router.put('/talent', auth, async (req, res) => {
  if (req.user.role !== 'employer') return res.status(403).json({ error: 'Employers only' });
  const { talent_id, status } = req.body;
  const valid = ['shortlisted','pending','interviewing','rejected'];
  if (!talent_id || !valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  try {
    await pool.query(
      `INSERT INTO employer_talent_tracking (employer_id, talent_id, status, updated_at)
       VALUES ($1,$2,$3,NOW())
       ON CONFLICT (employer_id, talent_id) DO UPDATE SET status=$3, updated_at=NOW()`,
      [req.user.id, talent_id, status]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/tracking/talent/:id — get employer's status for one talent
router.get('/talent/:id', auth, async (req, res) => {
  if (req.user.role !== 'employer') return res.status(403).json({ error: 'Employers only' });
  try {
    const { rows } = await pool.query(
      `SELECT status FROM employer_talent_tracking WHERE employer_id=$1 AND talent_id=$2`,
      [req.user.id, req.params.id]
    );
    res.json({ status: rows[0]?.status || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/tracking/all — get all tracked talents for this employer (with user details)
router.get('/all', auth, async (req, res) => {
  if (req.user.role !== 'employer') return res.status(403).json({ error: 'Employers only' });
  try {
    const { rows } = await pool.query(
      `SELECT t.status, t.updated_at, u.id, u.full_name, u.skills, u.location, u.profile_pic
       FROM employer_talent_tracking t
       JOIN users u ON u.id = t.talent_id
       WHERE t.employer_id=$1
       ORDER BY t.updated_at DESC`,
      [req.user.id]
    );
    res.json({ tracking: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
