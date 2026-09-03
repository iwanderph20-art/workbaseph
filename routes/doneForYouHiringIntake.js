const express = require('express');
const router = express.Router();
const { sendEmail } = require('../services/email');
const { createLead } = require('../services/chatThread');
const db = require('../database');

// POST /api/done-for-you-hiring-intake
router.post('/', async (req, res) => {
  const { name, email, companyName, role, roleDetails, headcount, timeline, experience, employment, tools, budget, details } = req.body;

  if (!name || !email || !role || !roleDetails || !headcount || !experience || !employment || !budget) {
    return res.status(400).json({ error: 'Name, email, role, role details, headcount, experience level, employment type, and salary/rate are required.' });
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
<div style="max-width:600px;margin:0 auto;background:#fff;border-top:6px solid #1a8a7a">
  <div style="background:linear-gradient(135deg, #1a8a7a 0%, #0d2240 100%);padding:28px 40px;text-align:center">
    <div style="font-size:22px;font-weight:900;color:#fff;letter-spacing:-0.5px">Work<span style="color:#f47c20">Base</span> PH</div>
    <div style="display:inline-block;margin-top:10px;padding:5px 16px;background:rgba(255,255,255,0.16);border-radius:99px;color:#fff;font-size:11px;font-weight:800;letter-spacing:0.6px;text-transform:uppercase">⚡ Done-For-You Hiring — New Intake</div>
  </div>
  <div style="padding:32px 40px">
    <table style="width:100%;border-collapse:collapse;font-size:14px;color:#374151">
      ${row('Name', name)}
      <tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;color:#6b7280;vertical-align:top">Email</td><td style="padding:10px 0;border-bottom:1px solid #f3f4f6"><a href="mailto:${escape(email)}" style="color:#1a8a7a;font-weight:600">${escape(email)}</a></td></tr>
      ${row('Company', companyName)}
      <tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;color:#6b7280;vertical-align:top">Role</td><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;font-weight:600;color:#0d2240">${escape(role)}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;color:#6b7280;vertical-align:top">Role details &amp; tasks</td><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;line-height:1.7;white-space:pre-wrap">${escape(roleDetails)}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;color:#6b7280;vertical-align:top">Headcount</td><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;font-weight:600;color:#0d2240">${escape(headcount)}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;color:#6b7280;vertical-align:top">Experience level</td><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;font-weight:600;color:#0d2240">${escape(experience)}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;color:#6b7280;vertical-align:top">Employment type</td><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;font-weight:600;color:#0d2240">${escape(employment)}</td></tr>
      ${row('Timeline', timeline)}
      ${row('Tools / software / certifications', tools)}
      <tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;color:#6b7280;vertical-align:top">Salary/rate offered</td><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;font-weight:600;color:#0d2240">${escape(budget)} <span style="font-weight:400;color:#9ca3af">(sets the one-time placement fee)</span></td></tr>
      ${details ? `<tr><td style="padding:10px 0;color:#6b7280;vertical-align:top">Details</td><td style="padding:10px 0;line-height:1.7;white-space:pre-wrap">${escape(details)}</td></tr>` : ''}
    </table>
    <div style="margin-top:24px;padding:16px 20px;background:#f0faf9;border-left:3px solid #1a8a7a;border-radius:0 8px 8px 0;font-size:13px;color:#374151">
      Reply directly to this email to respond to <strong style="color:#0d2240">${escape(name)}</strong>.
    </div>
  </div>
  <div style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:20px 40px;text-align:center">
    <p style="font-size:12px;color:#9ca3af;margin:0">WorkBase PH — Done-For-You Hiring · admin@workbaseph.com</p>
  </div>
</div>
</body>
</html>`;

  try {
    await sendEmail({
      to: 'hello@workbaseph.com',
      cc: ['support@workbaseph.com', 'admin@workbaseph.com'],
      replyTo: email,
      subject: `⚡ [Done-For-You Hiring] ${role} × ${headcount} — from ${name}`,
      html,
    });

    const inserted = await db.prepare(
      'INSERT INTO done_for_you_hiring_intake (name, email, company_name, role, role_details, headcount, timeline, experience_level, employment_type, tools, budget, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(name, email, companyName || '', role, roleDetails, headcount, timeline || '', experience, employment, tools || '', budget || '', details || '').catch(() => null);

    if (inserted && inserted.lastInsertRowid) {
      createLead({ source: 'dfy_intake', sourceId: inserted.lastInsertRowid, service: 'Done-For-You Hiring', name, email, summary: `${role} × ${headcount}` });
    }

    console.log(`📬 Done-For-You Hiring intake from ${name} <${email}> — ${role} × ${headcount}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('Done-For-You Hiring intake email error:', err.message);
    res.json({ ok: true });
  }
});

module.exports = router;
