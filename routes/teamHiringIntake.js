const express = require('express');
const router = express.Router();
const { sendEmail } = require('../services/email');
const db = require('../database');

// POST /api/team-hiring-intake
router.post('/', async (req, res) => {
  const { name, email, companyName, role, headcount, timeline, budget, details } = req.body;

  if (!name || !email || !role || !headcount || !budget) {
    return res.status(400).json({ error: 'Name, email, role, headcount, and salary/rate are required.' });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'Invalid email address.' });
  }

  const escape = (s) => String(s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const row = (label, value) => value
    ? `<tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;color:#6b7280;width:150px;vertical-align:top">${label}</td><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;font-weight:600;color:#0d2240">${escape(value)}</td></tr>`
    : '';

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Helvetica Neue',Arial,sans-serif">
<div style="max-width:600px;margin:0 auto;background:#fff">
  <div style="background:#0d2240;padding:28px 40px;text-align:center">
    <div style="font-size:22px;font-weight:900;color:#fff;letter-spacing:-0.5px">Work<span style="color:#f47c20">Base</span> PH</div>
    <div style="color:rgba(255,255,255,0.6);font-size:12px;margin-top:4px">New Team Hiring Intake</div>
  </div>
  <div style="padding:32px 40px">
    <table style="width:100%;border-collapse:collapse;font-size:14px;color:#374151">
      ${row('Name', name)}
      <tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;color:#6b7280;vertical-align:top">Email</td><td style="padding:10px 0;border-bottom:1px solid #f3f4f6"><a href="mailto:${escape(email)}" style="color:#f47c20;font-weight:600">${escape(email)}</a></td></tr>
      ${row('Company', companyName)}
      <tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;color:#6b7280;vertical-align:top">Role</td><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;font-weight:600;color:#0d2240">${escape(role)}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;color:#6b7280;vertical-align:top">Headcount</td><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;font-weight:600;color:#0d2240">${escape(headcount)}</td></tr>
      ${row('Timeline', timeline)}
      <tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;color:#6b7280;vertical-align:top">Salary/rate offered</td><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;font-weight:600;color:#0d2240">${escape(budget)} <span style="font-weight:400;color:#9ca3af">(sets the one-time placement fee)</span></td></tr>
      ${details ? `<tr><td style="padding:10px 0;color:#6b7280;vertical-align:top">Details</td><td style="padding:10px 0;line-height:1.7;white-space:pre-wrap">${escape(details)}</td></tr>` : ''}
    </table>
    <div style="margin-top:24px;padding:16px 20px;background:#f9fafb;border-radius:8px;font-size:13px;color:#6b7280">
      Reply directly to this email to respond to <strong style="color:#0d2240">${escape(name)}</strong>.
    </div>
  </div>
  <div style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:20px 40px;text-align:center">
    <p style="font-size:12px;color:#9ca3af;margin:0">WorkBase PH — admin@workbaseph.com</p>
  </div>
</div>
</body>
</html>`;

  try {
    await sendEmail({
      to: 'admin@workbaseph.com',
      subject: `[Team Hiring] ${role} × ${headcount} — from ${name}`,
      html,
    });

    await db.prepare(
      'INSERT INTO team_hiring_intake (name, email, company_name, role, headcount, timeline, budget, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(name, email, companyName || '', role, headcount, timeline || '', budget || '', details || '').catch(() => {});

    console.log(`📬 Team hiring intake from ${name} <${email}> — ${role} × ${headcount}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('Team hiring intake email error:', err.message);
    res.json({ ok: true });
  }
});

module.exports = router;
