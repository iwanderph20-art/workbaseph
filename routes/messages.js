const express = require('express');
const router  = express.Router();
const { pool } = require('../database');
const jwt = require('jsonwebtoken');
const { sendEmail, newMessageEmail } = require('../services/email');

const JWT_SECRET = process.env.JWT_SECRET || 'workbaseph_secret_2026';

function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(h.replace('Bearer ', ''), JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

// ─── POST /api/messages/send ──────────────────────────────────────────────────
router.post('/send', auth, async (req, res) => {
  const { receiver_id, body, job_id } = req.body;
  if (!receiver_id || !body?.trim()) return res.status(400).json({ error: 'receiver_id and body required' });
  try {
    const jobIdVal = job_id ? parseInt(job_id) : null;
    const { rows } = await pool.query(
      `INSERT INTO direct_messages (sender_id, receiver_id, body, job_id) VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.user.id, receiver_id, body.trim(), jobIdVal]
    );
    const msg = rows[0];

    // Get job title + code if job_id provided
    let jobTitle = null;
    let jobCode  = null;
    if (jobIdVal) {
      const { rows: jobRows } = await pool.query('SELECT id, title, job_code FROM jobs WHERE id=$1', [jobIdVal]);
      jobTitle = jobRows[0]?.title    || null;
      jobCode  = jobRows[0]?.job_code || null;
    }

    // In-app notification
    const { rows: senderRows } = await pool.query('SELECT full_name FROM users WHERE id=$1', [req.user.id]);
    const senderName = senderRows[0]?.full_name || 'Someone';
    const jobTag = jobCode ? `${jobCode}: ` : jobTitle ? `JOB-${String(jobIdVal).padStart(4,'0')}: ` : '';
    const notifTitle = jobTitle
      ? `Message from ${senderName} · ${jobTag}${jobTitle}`
      : `Message from ${senderName}`;
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, body, data) VALUES ($1,$2,$3,$4,$5)`,
      [receiver_id, 'direct_message', notifTitle,
       body.trim().slice(0, 120),
       JSON.stringify({ sender_id: req.user.id, sender_name: senderName, message_id: msg.id, job_id: jobIdVal, job_title: jobTitle })]
    );

    // Email notification (non-blocking)
    const { rows: receiverRows } = await pool.query('SELECT full_name, email FROM users WHERE id=$1', [receiver_id]);
    const receiver = receiverRows[0];
    if (receiver?.email) {
      sendEmail({ to: receiver.email, ...newMessageEmail(receiver.full_name, senderName, body.trim()) })
        .catch(err => console.error('[message email]', err.message));
    }

    res.json(msg);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/messages/thread/:userId — full conversation with a user ─────────
router.get('/thread/:userId', auth, async (req, res) => {
  const other = parseInt(req.params.userId);
  try {
    const { rows } = await pool.query(
      `SELECT dm.*, j.title AS job_title, j.job_code
       FROM direct_messages dm
       LEFT JOIN jobs j ON j.id = dm.job_id
       WHERE (dm.sender_id=$1 AND dm.receiver_id=$2) OR (dm.sender_id=$2 AND dm.receiver_id=$1)
       ORDER BY dm.created_at ASC`,
      [req.user.id, other]
    );
    // Mark received messages as read
    await pool.query(
      `UPDATE direct_messages SET is_read=1 WHERE receiver_id=$1 AND sender_id=$2 AND is_read=0`,
      [req.user.id, other]
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/messages/inbox — all conversation partners (for sidebar badge) ──
router.get('/inbox', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (other_id)
         other_id,
         other_name,
         last_body,
         last_at,
         unread_count,
         job_id,
         job_title,
         job_code
       FROM (
         SELECT
           CASE WHEN dm.sender_id=$1 THEN dm.receiver_id ELSE dm.sender_id END AS other_id,
           CASE WHEN dm.sender_id=$1 THEN ru.full_name ELSE su.full_name END AS other_name,
           dm.body AS last_body,
           dm.created_at AS last_at,
           dm.job_id AS job_id,
           j.title AS job_title,
           j.job_code AS job_code,
           (SELECT COUNT(*) FROM direct_messages
            WHERE receiver_id=$1
              AND sender_id = CASE WHEN dm.sender_id=$1 THEN dm.receiver_id ELSE dm.sender_id END
              AND is_read=0) AS unread_count
         FROM direct_messages dm
         JOIN users su ON su.id = dm.sender_id
         JOIN users ru ON ru.id = dm.receiver_id
         LEFT JOIN jobs j ON j.id = dm.job_id
         WHERE dm.sender_id=$1 OR dm.receiver_id=$1
         ORDER BY dm.created_at DESC
       ) t
       ORDER BY other_id, last_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/messages/unread-count ──────────────────────────────────────────
router.get('/unread-count', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM direct_messages WHERE receiver_id=$1 AND is_read=0`,
      [req.user.id]
    );
    res.json({ count: rows[0].count });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
