const express = require('express');
const router  = express.Router();
const db = require('../database');
const { authenticateToken } = require('../middleware/auth');
const { sendEmail } = require('../services/email');

// ─── POST /api/feedback — employer shares feedback, any time (not tied to a hire) ─
router.post('/', authenticateToken, async (req, res) => {
  if (req.user.role !== 'employer') return res.status(403).json({ error: 'Employers only' });
  const message = (req.body.message || '').trim();
  if (!message) return res.status(400).json({ error: 'Please include a short message' });

  const raw = req.body.did_hire;
  const didHire = (raw === true || raw === 'yes') ? true : (raw === false || raw === 'no') ? false : null;
  let rating = parseInt(req.body.rating, 10);
  rating = (rating >= 1 && rating <= 5) ? rating : null;

  try {
    await db.prepare(
      'INSERT INTO employer_feedback (employer_id, did_hire, rating, message) VALUES (?, ?, ?, ?)'
    ).run(req.user.id, didHire, rating, message.slice(0, 4000));

    // Notify the team (non-blocking) so feedback is actioned even without a dashboard.
    const emp = await db.prepare('SELECT full_name, email FROM users WHERE id = ?').get(req.user.id);
    const adminEmail = process.env.ADMIN_NOTIFY_EMAIL || 'admin@workbaseph.com';
    const safe = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    sendEmail({
      to: adminEmail,
      subject: `Employer feedback${rating ? ` (${rating}★)` : ''} — ${emp?.full_name || 'Employer'}`,
      html: `<p><strong>${emp?.full_name || 'An employer'}</strong> (${emp?.email || '—'}) shared feedback:</p>
             <p>Hired through WorkBase PH: <strong>${didHire === true ? 'Yes' : didHire === false ? 'No' : 'Not specified'}</strong>${rating ? ` · Rating: ${rating}/5` : ''}</p>
             <blockquote style="border-left:3px solid #f47c20;padding-left:12px;color:#374151;margin:8px 0">${safe}</blockquote>`,
    }).catch(err => console.error('[feedback admin notify]', err.message));

    res.json({ ok: true });
  } catch (e) {
    console.error('[feedback POST]', e.message);
    res.status(500).json({ error: 'Failed to submit feedback' });
  }
});

module.exports = router;
