const express = require('express');
const router = express.Router();
const db = require('../database');
const { authenticateToken } = require('../middleware/auth');

// ── POST /api/reviews ─────────────────────────────────────────────────────────
router.post('/', authenticateToken, async (req, res) => {
  const { reviewee_id, rating, comment, job_id } = req.body;
  if (!reviewee_id || !rating) return res.status(400).json({ error: 'reviewee_id and rating required' });
  if (rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating must be 1–5' });
  try {
    const existing = await db.prepare(
      'SELECT id FROM reviews WHERE reviewer_id = ? AND reviewee_id = ? AND job_id = ?'
    ).get(req.user.id, reviewee_id, job_id || null);
    if (existing) return res.status(409).json({ error: 'Already reviewed' });
    await db.prepare(
      'INSERT INTO reviews (reviewer_id, reviewee_id, job_id, rating, comment) VALUES (?, ?, ?, ?, ?)'
    ).run(req.user.id, reviewee_id, job_id || null, rating, comment || '');
    // Notify reviewee
    const reviewer = await db.prepare('SELECT full_name, role FROM users WHERE id = ?').get(req.user.id);
    await db.prepare(
      "INSERT INTO notifications (user_id, type, title, body, data) VALUES (?, 'new_review', ?, ?, ?)"
    ).run(reviewee_id, 'New Review', `${reviewer.full_name} left you a ${rating}-star review.`, JSON.stringify({ reviewer_id: req.user.id, rating }));
    res.json({ ok: true });
  } catch (err) {
    console.error('[reviews post]', err.message);
    res.status(500).json({ error: 'Failed to submit review' });
  }
});

// ── GET /api/reviews/talent/:id ───────────────────────────────────────────────
router.get('/talent/:id', async (req, res) => {
  try {
    const rows = await db.prepare(`
      SELECT r.id, r.rating, r.comment, r.created_at,
             u.full_name as reviewer_name, u.profile_pic as reviewer_pic, u.role as reviewer_role
      FROM reviews r
      JOIN users u ON u.id = r.reviewer_id
      WHERE r.reviewee_id = ? AND r.is_public = 1
      ORDER BY r.created_at DESC
      LIMIT 20
    `).all(parseInt(req.params.id));
    const avg = rows.length ? (rows.reduce((s,r)=>s+r.rating,0)/rows.length).toFixed(1) : null;
    res.json({ reviews: rows, average: avg, total: rows.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch reviews' });
  }
});

// ── GET /api/reviews/pending-mine ─────────────────────────────────────────────
// For employers: hires that haven't been reviewed yet
router.get('/pending-mine', authenticateToken, async (req, res) => {
  try {
    const rows = await db.prepare(`
      SELECT p.talent_id, p.hired_at, u.full_name, u.profile_pic, u.job_title
      FROM employer_pipeline p
      JOIN users u ON u.id = p.talent_id
      WHERE p.employer_id = ? AND p.stage = 'hired'
        AND NOT EXISTS (
          SELECT 1 FROM reviews r
          WHERE r.reviewer_id = ? AND r.reviewee_id = p.talent_id
        )
      ORDER BY p.hired_at DESC
    `).all(req.user.id, req.user.id);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

module.exports = router;
