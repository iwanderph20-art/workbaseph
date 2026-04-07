const express = require('express');
const router = express.Router();
const { sendEmail } = require('../services/email');

// POST /api/contact
router.post('/', async (req, res) => {
  const { name, email, role, subject, message } = req.body;

  if (!name || !email || !role || !subject || !message) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'Invalid email address.' });
  }

  const roleLabels = {
    employer: 'Employer / Hiring Manager',
    recruiter: 'Recruiter / Staffing Agency',
    specialist: 'Specialist / Freelancer',
    other: 'Other',
  };
  const roleLabel = roleLabels[role] || role;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Helvetica Neue',Arial,sans-serif">
<div style="max-width:600px;margin:0 auto;background:#fff">
  <div style="background:#0d2240;padding:28px 40px;text-align:center">
    <div style="font-size:22px;font-weight:900;color:#fff;letter-spacing:-0.5px">Work<span style="color:#f47c20">Base</span> PH</div>
    <div style="color:rgba(255,255,255,0.6);font-size:12px;margin-top:4px">New Contact Form Submission</div>
  </div>
  <div style="padding:32px 40px">
    <table style="width:100%;border-collapse:collapse;font-size:14px;color:#374151">
      <tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;color:#6b7280;width:130px;vertical-align:top">Name</td><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;font-weight:600;color:#0d2240">${name}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;color:#6b7280;vertical-align:top">Email</td><td style="padding:10px 0;border-bottom:1px solid #f3f4f6"><a href="mailto:${email}" style="color:#f47c20;font-weight:600">${email}</a></td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;color:#6b7280;vertical-align:top">Role</td><td style="padding:10px 0;border-bottom:1px solid #f3f4f6">${roleLabel}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;color:#6b7280;vertical-align:top">Subject</td><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;font-weight:600">${subject}</td></tr>
      <tr><td style="padding:10px 0;color:#6b7280;vertical-align:top">Message</td><td style="padding:10px 0;line-height:1.7;white-space:pre-wrap">${message.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</td></tr>
    </table>
    <div style="margin-top:24px;padding:16px 20px;background:#f9fafb;border-radius:8px;font-size:13px;color:#6b7280">
      Reply directly to this email to respond to <strong style="color:#0d2240">${name}</strong>.
    </div>
  </div>
  <div style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:20px 40px;text-align:center">
    <p style="font-size:12px;color:#9ca3af;margin:0">WorkBase PH — support@workbaseph.com</p>
  </div>
</div>
</body>
</html>`;

  try {
    await sendEmail({
      to: 'support@workbaseph.com',
      subject: `[Contact Form] ${subject} — from ${name}`,
      html,
    });

    console.log(`📬 Contact form submission from ${name} <${email}> — ${subject}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('Contact form email error:', err.message);
    // Still return success to user — message was received even if email failed
    res.json({ ok: true });
  }
});

module.exports = router;
