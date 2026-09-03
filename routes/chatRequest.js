const express = require('express');
const router = express.Router();
const { sendEmail } = require('../services/email');
const db = require('../database');

// POST /api/chat-request
router.post('/', async (req, res) => {
  const { name, email, concern, page } = req.body;

  if (!email || !concern) {
    return res.status(400).json({ error: 'Email and a short note are required.' });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'Invalid email address.' });
  }

  const escape = (s) => String(s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const pageLabel = escape(page || 'WorkBase PH');
  const displayName = name && name.trim() ? name.trim() : 'Someone';

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Helvetica Neue',Arial,sans-serif">
<div style="max-width:600px;margin:0 auto;background:#fff;border-top:6px solid #dc2626">
  <div style="background:#dc2626;padding:20px 40px;text-align:center">
    <div style="display:inline-block;padding:5px 16px;background:rgba(255,255,255,0.2);border-radius:99px;color:#fff;font-size:12px;font-weight:900;letter-spacing:1px;text-transform:uppercase">🔴 Urgent &mdash; Chat Request</div>
  </div>
  <div style="padding:32px 40px">
    <table style="width:100%;border-collapse:collapse;font-size:14px;color:#374151">
      <tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;color:#6b7280;width:130px;vertical-align:top">From</td><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;font-weight:600;color:#0d2240">${escape(displayName)}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;color:#6b7280;vertical-align:top">Email</td><td style="padding:10px 0;border-bottom:1px solid #f3f4f6"><a href="mailto:${escape(email)}" style="color:#dc2626;font-weight:600">${escape(email)}</a></td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;color:#6b7280;vertical-align:top">Page</td><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;font-weight:600;color:#0d2240">${pageLabel}</td></tr>
      <tr><td style="padding:10px 0;color:#6b7280;vertical-align:top">Concern</td><td style="padding:10px 0;line-height:1.7;white-space:pre-wrap">${escape(concern)}</td></tr>
    </table>
    <div style="margin-top:24px;padding:16px 20px;background:#fef2f2;border-left:3px solid #dc2626;border-radius:0 8px 8px 0;font-size:13px;color:#374151">
      This visitor clicked "chat" and is waiting to hear back &mdash; reply directly to this email or reach out to <strong style="color:#0d2240">${escape(displayName)}</strong> as soon as possible.
    </div>
  </div>
  <div style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:20px 40px;text-align:center">
    <p style="font-size:12px;color:#9ca3af;margin:0">WorkBase PH &middot; admin@workbaseph.com</p>
  </div>
</div>
</body>
</html>`;

  try {
    await sendEmail({
      to: 'hello@workbaseph.com',
      cc: ['support@workbaseph.com', 'admin@workbaseph.com'],
      subject: `🔴 URGENT — Chat Request from ${displayName} (${pageLabel})`,
      html,
    });

    await db.prepare(
      'INSERT INTO chat_requests (name, email, page, concern) VALUES (?, ?, ?, ?)'
    ).run(name || '', email, page || '', concern).catch(() => {});

    console.log(`💬 Urgent chat request from ${displayName} <${email}> — ${pageLabel}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('Chat request email error:', err.message);
    res.json({ ok: true });
  }
});

module.exports = router;
