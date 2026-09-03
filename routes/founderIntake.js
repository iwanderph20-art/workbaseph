const express = require('express');
const router = express.Router();
const { sendEmail } = require('../services/email');
const { createLead } = require('../services/chatThread');
const db = require('../database');

// POST /api/founder-intake
router.post('/', async (req, res) => {
  const { name, email, companyName, services, leadType, hasWebsite, timeline, budget, details } = req.body;

  if (!name || !email || !Array.isArray(services) || services.length === 0 || !Array.isArray(leadType) || leadType.length === 0 || !details) {
    return res.status(400).json({ error: 'Name, email, at least one service, at least one lead type, and company/good-lead details are required.' });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'Invalid email address.' });
  }

  const servicesText = services.join(', ');
  const leadTypeText = leadType.join(', ');
  const escape = (s) => String(s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const row = (label, value) => value
    ? `<tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;color:#6b7280;width:150px;vertical-align:top">${label}</td><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;font-weight:600;color:#0d2240">${escape(value)}</td></tr>`
    : '';

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Helvetica Neue',Arial,sans-serif">
<div style="max-width:600px;margin:0 auto;background:#fff;border-top:6px solid #f47c20">
  <div style="background:linear-gradient(135deg, #0a1929 0%, #0d2240 50%, #0e3d35 100%);padding:28px 40px;text-align:center">
    <div style="font-size:22px;font-weight:900;color:#fff;letter-spacing:-0.5px">Work<span style="color:#f47c20">Base</span> PH</div>
    <div style="display:inline-block;margin-top:10px;padding:5px 16px;background:rgba(244,124,32,0.2);border-radius:99px;color:#fff;font-size:11px;font-weight:800;letter-spacing:0.6px;text-transform:uppercase">🚀 Launch Startup Services — New Intake</div>
  </div>
  <div style="padding:32px 40px">
    <table style="width:100%;border-collapse:collapse;font-size:14px;color:#374151">
      ${row('Name', name)}
      <tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;color:#6b7280;vertical-align:top">Email</td><td style="padding:10px 0;border-bottom:1px solid #f3f4f6"><a href="mailto:${escape(email)}" style="color:#f47c20;font-weight:600">${escape(email)}</a></td></tr>
      ${row('Company', companyName)}
      <tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;color:#6b7280;vertical-align:top">Services needed</td><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;font-weight:600;color:#0d2240">${escape(servicesText)}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;color:#6b7280;vertical-align:top">Leads wanted</td><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;font-weight:600;color:#0d2240">${escape(leadTypeText)}</td></tr>
      ${row('Existing website?', hasWebsite)}
      ${row('Timeline', timeline)}
      ${row('Budget (approx.)', budget)}
      ${details ? `<tr><td style="padding:10px 0;color:#6b7280;vertical-align:top">Company &amp; good-lead definition</td><td style="padding:10px 0;line-height:1.7;white-space:pre-wrap">${escape(details)}</td></tr>` : ''}
    </table>
    <div style="margin-top:24px;padding:16px 20px;background:#fff7ed;border-left:3px solid #f47c20;border-radius:0 8px 8px 0;font-size:13px;color:#374151">
      Reply directly to this email to respond to <strong style="color:#0d2240">${escape(name)}</strong>.
    </div>
  </div>
  <div style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:20px 40px;text-align:center">
    <p style="font-size:12px;color:#9ca3af;margin:0">WorkBase PH — Launch Startup Services · admin@workbaseph.com</p>
  </div>
</div>
</body>
</html>`;

  try {
    await sendEmail({
      to: 'hello@workbaseph.com',
      cc: ['support@workbaseph.com', 'admin@workbaseph.com'],
      replyTo: email,
      subject: `🚀 [Launch Startup Services] ${servicesText} — from ${name}`,
      html,
    });

    const inserted = await db.prepare(
      'INSERT INTO founder_service_intake (name, email, company_name, services, lead_type, has_website, timeline, budget, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(name, email, companyName || '', servicesText, leadTypeText, hasWebsite || '', timeline || '', budget || '', details || '').catch(() => null);

    if (inserted && inserted.lastInsertRowid) {
      createLead({ source: 'founder_intake', sourceId: inserted.lastInsertRowid, service: 'Launch Startup Services', name, email, summary: servicesText });
    }

    console.log(`📬 Founder services intake from ${name} <${email}> — ${servicesText}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('Founder intake email error:', err.message);
    res.json({ ok: true });
  }
});

module.exports = router;
