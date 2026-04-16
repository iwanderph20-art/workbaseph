const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const jwt = require('jsonwebtoken');
const { sendEmail, interviewInviteEmail } = require('../services/email');

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

    // Send congratulations email to talent
    const { rows: talentRows } = await pool.query('SELECT full_name, email FROM users WHERE id=$1', [talent_id]);
    const talentEmail = talentRows[0]?.email;
    const talentName  = talentRows[0]?.full_name || 'there';
    if (talentEmail) {
      sendEmail({ to: talentEmail, ...interviewInviteEmail(talentName, employerName, slot1, slot2, tz, msg) })
        .catch(err => console.error('[interview invite email]', err.message));
    }

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

// GET /api/interviews/employer-list — employer sees all their sent interview requests
router.get('/employer-list', auth, async (req, res) => {
  if (req.user.role !== 'employer') return res.status(403).json({ error: 'Employers only' });
  try {
    const { rows } = await pool.query(
      `SELECT ir.*, u.full_name AS talent_name, u.email AS talent_email
       FROM interview_requests ir
       JOIN users u ON u.id = ir.talent_id
       WHERE ir.employer_id = $1
       ORDER BY ir.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/interviews/cancel/:id — employer cancels with reason
router.post('/cancel/:id', auth, async (req, res) => {
  if (req.user.role !== 'employer') return res.status(403).json({ error: 'Employers only' });
  const { reason } = req.body;
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'Cancellation reason required' });
  try {
    const { rows } = await pool.query(
      `UPDATE interview_requests SET status='cancelled', cancel_reason=$1 WHERE id=$2 AND employer_id=$3 RETURNING talent_id`,
      [reason.trim(), req.params.id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Request not found' });

    // Notify talent
    const { rows: empRows } = await pool.query('SELECT full_name FROM users WHERE id=$1', [req.user.id]);
    const employerName = empRows[0]?.full_name || 'The employer';
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, body, data) VALUES ($1,$2,$3,$4,$5)`,
      [rows[0].talent_id, 'interview_cancelled',
       `Interview cancelled by ${employerName}`,
       `${employerName} cancelled the interview. Reason: ${reason.trim()}`,
       JSON.stringify({ employer_id: req.user.id, employer_name: employerName, reason: reason.trim() })]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/interviews/reschedule/:id — employer proposes new slots
router.post('/reschedule/:id', auth, async (req, res) => {
  if (req.user.role !== 'employer') return res.status(403).json({ error: 'Employers only' });
  const { slot1, slot2, timezone, message } = req.body;
  if (!slot1 || !slot2) return res.status(400).json({ error: 'slot1, slot2 required' });
  try {
    const { rows } = await pool.query(
      `UPDATE interview_requests SET slot1=$1, slot2=$2, employer_timezone=$3, employer_message=$4,
       status='pending', selected_slot=NULL, jitsi_link=NULL WHERE id=$5 AND employer_id=$6 RETURNING talent_id`,
      [new Date(slot1), new Date(slot2), timezone||'UTC', message||'', req.params.id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Request not found' });

    // Notify talent
    const { rows: empRows } = await pool.query('SELECT full_name FROM users WHERE id=$1', [req.user.id]);
    const employerName = empRows[0]?.full_name || 'The employer';
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, body, data) VALUES ($1,$2,$3,$4,$5)`,
      [rows[0].talent_id, 'interview_request',
       `New time options from ${employerName}`,
       `${employerName} has proposed new interview times. Please confirm one.`,
       JSON.stringify({ request_id: parseInt(req.params.id), employer_id: req.user.id, employer_name: employerName, slot1: new Date(slot1).toISOString(), slot2: new Date(slot2).toISOString(), timezone: timezone||'UTC', message: message||'' })]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
