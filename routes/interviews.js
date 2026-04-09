const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const jwt = require('jsonwebtoken');

function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(h.replace('Bearer ', ''), process.env.JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

// POST /api/interviews/request — employer proposes 2 slots
router.post('/request', auth, async (req, res) => {
  if (req.user.role !== 'employer') return res.status(403).json({ error: 'Employers only' });
  const { talent_id, slot1, slot2 } = req.body;
  if (!talent_id || !slot1 || !slot2) return res.status(400).json({ error: 'talent_id, slot1, slot2 required' });
  try {
    await pool.query(
      `INSERT INTO interview_requests (employer_id, talent_id, slot1, slot2) VALUES ($1,$2,$3,$4)`,
      [req.user.id, talent_id, new Date(slot1), new Date(slot2)]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/interviews/my-invites — specialist sees their pending invites
router.get('/my-invites', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ir.*, u.full_name AS employer_name
       FROM interview_requests ir
       JOIN users u ON u.id = ir.employer_id
       WHERE ir.talent_id = $1
       ORDER BY ir.created_at DESC`,
      [req.user.id]
    );
    res.json({ invites: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/interviews/accept/:id — specialist picks a slot
router.post('/accept/:id', auth, async (req, res) => {
  const { slot } = req.body; // 'slot1' or 'slot2'
  if (!['slot1','slot2'].includes(slot)) return res.status(400).json({ error: 'slot must be slot1 or slot2' });
  try {
    const { rows } = await pool.query(
      `SELECT * FROM interview_requests WHERE id=$1 AND talent_id=$2`,
      [req.params.id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Invite not found' });
    // Generate a Jitsi room (free, no API key needed)
    const roomId = `WorkBasePH-${rows[0].employer_id}-${req.user.id}-${Date.now()}`;
    const jitsiLink = `https://meet.jit.si/${roomId}`;
    await pool.query(
      `UPDATE interview_requests SET selected_slot=$1, jitsi_link=$2, status='accepted' WHERE id=$3`,
      [slot, jitsiLink, req.params.id]
    );
    res.json({ ok: true, jitsi_link: jitsiLink, confirmed_slot: rows[0][slot] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
