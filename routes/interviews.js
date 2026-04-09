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

// POST /api/interviews/request — employer proposes 2 slots + timezone + message
router.post('/request', auth, async (req, res) => {
  if (req.user.role !== 'employer') return res.status(403).json({ error: 'Employers only' });
  const { talent_id, slot1, slot2, timezone, message } = req.body;
  if (!talent_id || !slot1 || !slot2) return res.status(400).json({ error: 'talent_id, slot1, slot2 required' });
  try {
    const tz = timezone || 'UTC';
    const msg = message || '';

    const { rows } = await pool.query(
      `INSERT INTO interview_requests (employer_id, talent_id, slot1, slot2, employer_timezone, employer_message)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [req.user.id, talent_id, new Date(slot1), new Date(slot2), tz, msg]
    );
    const requestId = rows[0].id;

    // Get employer name
    const { rows: empRows } = await pool.query('SELECT full_name FROM users WHERE id=$1', [req.user.id]);
    const employerName = empRows[0]?.full_name || 'An employer';

    // Create notification for specialist
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, body, data) VALUES ($1,$2,$3,$4,$5)`,
      [
        talent_id,
        'interview_request',
        `Interview invite from ${employerName}`,
        `${employerName} wants to interview you. Choose a time slot.`,
        JSON.stringify({
          request_id: requestId,
          employer_id: req.user.id,
          employer_name: employerName,
          slot1: new Date(slot1).toISOString(),
          slot2: new Date(slot2).toISOString(),
          timezone: tz,
          message: msg
        })
      ]
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

    const invite = rows[0];
    const jitsiLink = `https://meet.jit.si/WorkBasePH-${invite.employer_id}-${req.user.id}-${Date.now()}`;
    const confirmedTime = new Date(invite[slot]).toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZone: invite.employer_timezone || 'UTC', timeZoneName: 'short'
    });

    await pool.query(
      `UPDATE interview_requests SET selected_slot=$1, jitsi_link=$2, status='accepted' WHERE id=$3`,
      [slot, jitsiLink, req.params.id]
    );

    // Get specialist name
    const { rows: talentRows } = await pool.query('SELECT full_name FROM users WHERE id=$1', [req.user.id]);
    const talentName = talentRows[0]?.full_name || 'The specialist';

    // Create notification for employer
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, body, data) VALUES ($1,$2,$3,$4,$5)`,
      [
        invite.employer_id,
        'interview_accepted',
        `${talentName} confirmed your interview`,
        `${talentName} chose ${confirmedTime}. Meeting link is ready.`,
        JSON.stringify({
          talent_id: req.user.id,
          talent_name: talentName,
          confirmed_time: confirmedTime,
          jitsi_link: jitsiLink
        })
      ]
    );

    res.json({ ok: true, jitsi_link: jitsiLink, confirmed_slot: invite[slot], confirmed_time: confirmedTime });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
