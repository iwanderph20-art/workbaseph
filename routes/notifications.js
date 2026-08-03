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

// GET /api/notifications — get current user's notifications.
// Default hides archived items; ?archived=1 returns only the archived ones.
router.get('/', auth, async (req, res) => {
  try {
    const onlyArchived = req.query.archived === '1' || req.query.archived === 'true';
    const archiveFilter = onlyArchived ? 'archived_at IS NOT NULL' : 'archived_at IS NULL';
    const { rows } = await pool.query(
      `SELECT * FROM notifications WHERE user_id=$1 AND ${archiveFilter} ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json({ notifications: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/notifications/unread-count — archived items never count toward the badge.
router.get('/unread-count', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*) AS count FROM notifications WHERE user_id=$1 AND is_read=0 AND archived_at IS NULL`,
      [req.user.id]
    );
    res.json({ count: parseInt(rows[0].count, 10) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/notifications/mark-read/:id
router.post('/mark-read/:id', auth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE notifications SET is_read=1 WHERE id=$1 AND user_id=$2`,
      [req.params.id, req.user.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/notifications/mark-all-read
router.post('/mark-all-read', auth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE notifications SET is_read=1 WHERE user_id=$1`,
      [req.user.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/notifications/archive/:id — talent archives (or unarchives) an inbox item so
// it drops off their Inbox. Pass { unarchive: true } to restore it.
router.post('/archive/:id', auth, async (req, res) => {
  try {
    const unarchive = req.body && req.body.unarchive;
    const { rowCount } = await pool.query(
      `UPDATE notifications SET archived_at = ${unarchive ? 'NULL' : 'NOW()'} WHERE id=$1 AND user_id=$2`,
      [req.params.id, req.user.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Notification not found' });
    res.json({ ok: true, archived: !unarchive });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
