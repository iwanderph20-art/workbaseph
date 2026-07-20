const express = require('express');
const router = express.Router();
const db = require('../database');
const { requireAdmin, requireSuperAdmin } = require('../middleware/auth');
const { sendEmail, requestReuploadEmail, incompleteProfileWarningEmail, profileRemovedEmail } = require('../services/email');
const { analyzeApplication, generateSleekProfile } = require('../services/ai');

// ─── GET /api/admin/stats ────────────────────────────────────────────────────
router.get('/stats', requireAdmin, async (req, res) => {
  try {
    const [totalTalent, activeTalent, employers, totalJobs] = await Promise.all([
      db.prepare("SELECT COUNT(*) as c FROM users WHERE role='freelancer'").get(),
      // Live in the marketplace: not hired, not denied, not self-paused
      db.prepare("SELECT COUNT(*) as c FROM users WHERE role='freelancer' AND COALESCE(account_paused, FALSE) = FALSE AND (talent_status IS NULL OR talent_status NOT IN ('hired','denied'))").get(),
      db.prepare("SELECT COUNT(*) as c FROM users WHERE role='employer' AND (admin_role IS NULL OR admin_role = '')").get(),
      db.prepare("SELECT COUNT(*) as c FROM jobs").get(),
    ]);

    res.json({
      total_talent:  parseInt(totalTalent.c),
      active_talent: parseInt(activeTalent.c),
      employers:     parseInt(employers.c),
      total_jobs:    parseInt(totalJobs.c),
    });
  } catch (err) {
    console.error('[admin stats] error:', err.message);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ─── Vetting gate removed ─────────────────────────────────────────────────────
// Freelancers are live in the marketplace by default — there is no admin approval
// step. The former vetting-queue / elite-pool / approve / approve-standard / deny /
// reject endpoints were removed. Talent visibility is now self-serve via the
// dashboard "Pause My Account" toggle (account_paused).

// ─── PUT /api/admin/notes/:id ─────────────────────────────────────────────────
router.put('/notes/:id', requireAdmin, async (req, res) => {
  const { notes } = req.body;
  try {
    await db.prepare("UPDATE users SET admin_notes = ?, updated_at = NOW() WHERE id = ?")
      .run(notes || '', parseInt(req.params.id));
    res.json({ message: 'Notes saved' });
  } catch (err) {
    console.error('[notes] error:', err.message);
    res.status(500).json({ error: 'Failed to save notes' });
  }
});

// ─── GET /api/admin/users ─────────────────────────────────────────────────────
router.get('/users', requireSuperAdmin, async (req, res) => {
  const { role, status, search, page = 1, limit = 50 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  let whereClause = 'WHERE 1=1';
  const params = [];

  if (role && role !== 'all') { whereClause += ' AND role = ?'; params.push(role); }
  if (status && status !== 'all') { whereClause += ' AND talent_status = ?'; params.push(status); }
  if (search) { whereClause += ' AND (full_name ILIKE ? OR email ILIKE ?)'; params.push(`%${search}%`, `%${search}%`); }

  try {
    const countRow = await db.prepare(`SELECT COUNT(*) as c FROM users ${whereClause}`).get(...params);
    const total = parseInt(countRow.c);

    const users = await db.prepare(
      `SELECT id, email, full_name, role, talent_status, account_paused, admin_role, is_verified, created_at FROM users ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).all(...params, parseInt(limit), offset);

    res.json({ users, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
  } catch (err) {
    console.error('[admin users] error:', err.message);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// ─── DELETE /api/admin/users/:id ─────────────────────────────────────────────
router.delete('/users/:id', requireSuperAdmin, async (req, res) => {
  try {
    const user = await db.prepare('SELECT id, full_name, admin_role FROM users WHERE id = ?').get(parseInt(req.params.id));
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.admin_role === 'super_admin') return res.status(403).json({ error: 'Cannot delete a super admin' });

    await db.prepare('DELETE FROM applications WHERE freelancer_id = ? OR job_id IN (SELECT id FROM jobs WHERE employer_id = ?)').run(parseInt(req.params.id), parseInt(req.params.id));
    await db.prepare('DELETE FROM jobs WHERE employer_id = ?').run(parseInt(req.params.id));
    await db.prepare('DELETE FROM users WHERE id = ?').run(parseInt(req.params.id));

    res.json({ message: `User ${user.full_name} deleted` });
  } catch (err) {
    console.error('[delete user] error:', err.message);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// ─── POST /api/admin/warn-incomplete/:id ─────────────────────────────────────
// Send an incomplete-profile "final warning" email to a freelancer (no deletion).
router.post('/warn-incomplete/:id', requireAdmin, async (req, res) => {
  try {
    const talent = await db.prepare("SELECT id, full_name, email FROM users WHERE id = ? AND role = 'freelancer'").get(parseInt(req.params.id));
    if (!talent) return res.status(404).json({ error: 'Talent not found' });
    if (!talent.email) return res.status(422).json({ error: 'This talent has no email on file' });

    await sendEmail({ to: talent.email, ...incompleteProfileWarningEmail(talent.full_name || 'there') });
    // Record when the warning went out so the admin can see who's overdue for deletion.
    await db.prepare('UPDATE users SET incomplete_warning_sent_at = NOW() WHERE id = ?').run(talent.id);
    res.json({ message: `Warning email sent to ${talent.full_name}`, warned_at: new Date().toISOString() });
  } catch (err) {
    console.error('[warn-incomplete] error:', err.message);
    res.status(500).json({ error: 'Failed to send warning email' });
  }
});

// ─── POST /api/admin/delete-incomplete/:id ───────────────────────────────────
// Notify the freelancer their profile was removed, then hard-delete the account.
// Mirrors the DELETE /users/:id cleanup. Super-admin only, like the plain delete.
router.post('/delete-incomplete/:id', requireSuperAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const talent = await db.prepare("SELECT id, full_name, email, admin_role FROM users WHERE id = ? AND role = 'freelancer'").get(id);
    if (!talent) return res.status(404).json({ error: 'Talent not found' });
    if (talent.admin_role) return res.status(403).json({ error: 'Cannot delete an admin account' });

    // Send the removal notice BEFORE deleting (we lose the email address after).
    // Don't block deletion on a mail failure — log it and continue.
    if (talent.email) {
      try {
        await sendEmail({ to: talent.email, ...profileRemovedEmail(talent.full_name || 'there') });
      } catch (mailErr) {
        console.error('[delete-incomplete] email failed:', mailErr.message);
      }
    }

    await db.prepare('DELETE FROM applications WHERE freelancer_id = ?').run(id);
    await db.prepare('DELETE FROM users WHERE id = ?').run(id);

    res.json({ message: `${talent.full_name} was notified and their profile deleted` });
  } catch (err) {
    console.error('[delete-incomplete] error:', err.message);
    res.status(500).json({ error: 'Failed to delete talent' });
  }
});

// ─── GET /api/admin/full-profile/:id ─────────────────────────────────────────
router.get('/full-profile/:id', requireAdmin, async (req, res) => {
  try {
    const user = await db.prepare(`
      SELECT id, full_name, email, bio, skills, location,
             profile_pic, hardware_specs, speedtest_url, video_loom_link,
             resume_file, specs_image, speedtest_image,
             detected_ram, detected_cpu, detected_speed_down, detected_speed_up,
             ai_tier_recommendation, ai_summary,
             pre_screen_status, talent_status, admin_notes, sleek_profile,
             is_top_tier, personality_type, personality_badge, personality_scores, created_at,
             account_paused, account_paused_at, account_delete_requested_at, account_delete_reason
      FROM users WHERE id = ? AND role = 'freelancer'
    `).get(parseInt(req.params.id));
    if (!user) return res.status(404).json({ error: 'Candidate not found' });
    res.json(user);
  } catch (err) {
    console.error('[full-profile] error:', err.message);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// ─── POST /api/admin/reanalyze/:id ────────────────────────────────────────────
router.post('/reanalyze/:id', requireAdmin, async (req, res) => {
  try {
    const user = await db.prepare("SELECT id, full_name FROM users WHERE id = ? AND role = 'freelancer'").get(parseInt(req.params.id));
    if (!user) return res.status(404).json({ error: 'Candidate not found' });
    await db.prepare("UPDATE users SET pre_screen_status = 'processing' WHERE id = ?").run(parseInt(req.params.id));
    analyzeApplication(req.params.id).catch(err => console.error('[reanalyze] AI error:', err.message));
    res.json({ message: `AI re-analysis started for ${user.full_name}` });
  } catch (err) {
    console.error('[reanalyze] error:', err.message);
    res.status(500).json({ error: 'Failed to start re-analysis' });
  }
});

// ─── POST /api/admin/request-reupload/:id ─────────────────────────────────────
router.post('/request-reupload/:id', requireAdmin, async (req, res) => {
  const { items, message } = req.body;
  try {
    const candidate = await db.prepare("SELECT * FROM users WHERE id = ? AND role = 'freelancer'").get(parseInt(req.params.id));
    if (!candidate) return res.status(404).json({ error: 'Candidate not found' });

    await db.prepare("UPDATE users SET pre_screen_status = 'pending_correction', updated_at = NOW() WHERE id = ?")
      .run(parseInt(req.params.id));

    sendEmail({ to: candidate.email, ...requestReuploadEmail(candidate.full_name, items || [], message || '') })
      .catch(err => console.error('Re-upload email failed:', err.message));

    res.json({ message: `Re-upload request sent to ${candidate.full_name}` });
  } catch (err) {
    console.error('[request-reupload] error:', err.message);
    res.status(500).json({ error: 'Failed to send re-upload request' });
  }
});

// ─── GET /api/admin/employer-profile/:id ─────────────────────────────────────
router.get('/employer-profile/:id', requireAdmin, async (req, res) => {
  try {
    const employer = await db.prepare(`
      SELECT u.id, u.full_name, u.email, u.role, u.subscription_tier, u.subscription_expires_at,
             u.subscription_auto_renew, u.subscription_cancelled_at, u.subscription_cancel_reason, u.employer_plan, u.post_credits,
             u.payment_method_added, u.employer_access, u.created_at, u.paypal_order_id, u.paymongo_payment_id,
             (SELECT MIN(pr.paid_at) FROM payment_records pr WHERE pr.user_id = u.id) AS first_payment_at,
             (SELECT MAX(pr.paid_at) FROM payment_records pr WHERE pr.user_id = u.id) AS latest_payment_at
      FROM users u WHERE u.id = ? AND u.role = 'employer'
    `).get(parseInt(req.params.id));
    if (!employer) return res.status(404).json({ error: 'Employer not found' });
    res.json(employer);
  } catch (err) {
    console.error('[employer-profile] error:', err.message);
    res.status(500).json({ error: 'Failed to fetch employer profile' });
  }
});

// ─── POST /api/admin/message-employer ────────────────────────────────────────
router.post('/message-employer', requireAdmin, async (req, res) => {
  const { employer_id, subject, body } = req.body;
  if (!employer_id || !subject || !body) {
    return res.status(400).json({ error: 'employer_id, subject, and body are required.' });
  }
  try {
    const employer = await db.prepare('SELECT email, full_name FROM users WHERE id = ? AND role = \'employer\'').get(parseInt(employer_id));
    if (!employer) return res.status(404).json({ error: 'Employer not found' });

    const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Helvetica Neue',Arial,sans-serif">
<div style="max-width:600px;margin:0 auto;background:#fff">
  <div style="background:#0d2240;padding:28px 40px;text-align:center">
    <div style="font-size:22px;font-weight:900;color:#fff;letter-spacing:-0.5px">Work<span style="color:#f47c20">Base</span> PH</div>
    <div style="color:rgba(255,255,255,0.6);font-size:12px;margin-top:4px">Message from WorkBase PH Team</div>
  </div>
  <div style="padding:32px 40px">
    <p style="font-size:15px;font-weight:600;color:#0d2240;margin-bottom:16px">Hi ${employer.full_name || 'there'},</p>
    <div style="font-size:14px;color:#374151;line-height:1.8;white-space:pre-wrap">${body.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
  </div>
  <div style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:20px 40px;text-align:center">
    <p style="font-size:12px;color:#9ca3af;margin:0">WorkBase PH — <a href="mailto:admin@workbaseph.com" style="color:#f47c20">admin@workbaseph.com</a></p>
    <p style="font-size:11px;color:#d1d5db;margin:4px 0 0">Reply to this email to reach our team directly.</p>
  </div>
</div>
</body>
</html>`;

    await sendEmail({ to: employer.email, subject, html, replyTo: 'admin@workbaseph.com' });
    console.log(`[admin] Sent direct message to employer ${employer.email}: "${subject}"`);
    res.json({ ok: true, recipient: employer.email });
  } catch (err) {
    console.error('[message-employer] error:', err.message);
    res.status(500).json({ error: 'Failed to send message.' });
  }
});

// ─── GET /api/admin/employer-contacts/:id ─────────────────────────────────────
router.get('/employer-contacts/:id', requireAdmin, async (req, res) => {
  try {
    const user = await db.prepare('SELECT email FROM users WHERE id = ?').get(parseInt(req.params.id));
    if (!user) return res.status(404).json({ error: 'User not found' });
    const submissions = await db.prepare(
      'SELECT * FROM contact_submissions WHERE LOWER(email) = LOWER(?) ORDER BY submitted_at DESC'
    ).all(user.email);
    res.json(submissions);
  } catch (err) {
    console.error('[employer-contacts] error:', err.message);
    res.status(500).json({ error: 'Failed to fetch contact history' });
  }
});

// ─── POST /api/admin/reply-contact ────────────────────────────────────────────
router.post('/reply-contact', requireAdmin, async (req, res) => {
  const { to_email, to_name, subject, reply_message, contact_id } = req.body;
  if (!to_email || !reply_message) return res.status(400).json({ error: 'Missing fields' });
  try {
    const { sendEmail } = require('../services/email');
    await sendEmail({
      to: to_email,
      subject: `Re: ${subject || 'Your WorkBase PH enquiry'}`,
      html: `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:2rem">
          <div style="font-size:1.4rem;font-weight:900;color:#0d2240;margin-bottom:1rem">Work<span style="color:#f47c20">Base</span>PH</div>
          <p style="color:#374151">Hi ${to_name || 'there'},</p>
          <div style="white-space:pre-wrap;color:#374151;line-height:1.7">${reply_message.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
          <hr style="border:none;border-top:1px solid #e5e7eb;margin:1.5rem 0"/>
          <p style="font-size:0.85rem;color:#9ca3af">WorkBase PH — admin@workbaseph.com</p>
        </div>`,
    });
    if (contact_id) {
      await db.prepare('UPDATE contact_submissions SET replied_at = NOW(), reply_message = ? WHERE id = ?')
        .run(reply_message, contact_id).catch(() => {});
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[reply-contact]', err.message);
    res.status(500).json({ error: 'Failed to send reply' });
  }
});

// ─── GET /api/admin/applicants/:jobId — applicants for a specific job ─────────
router.get('/applicants/:jobId', requireAdmin, async (req, res) => {
  try {
    // Applicants = people who applied themselves (source 'applied') PLUS candidates the
    // admin submitted from Talent Triage (job_matches status 'submitted', source
    // 'admin_sent') — those never apply, so they'd otherwise be invisible here.
    const applicants = await db.prepare(`
      SELECT a.id, a.status, a.proposed_rate, a.cover_letter, a.created_at,
             u.id AS talent_id, u.full_name, u.email, 'applied' AS source
      FROM applications a
      JOIN users u ON a.freelancer_id = u.id
      WHERE a.job_id = ?
      UNION ALL
      SELECT jm.id, jm.status, NULL::real AS proposed_rate, NULL::text AS cover_letter,
             jm.pushed_at AS created_at,
             u.id AS talent_id, u.full_name, u.email, 'admin_sent' AS source
      FROM job_matches jm
      JOIN users u ON jm.talent_id = u.id
      WHERE jm.job_id = ? AND jm.status = 'submitted'
      ORDER BY created_at DESC
    `).all(parseInt(req.params.jobId), parseInt(req.params.jobId));
    res.json(applicants);
  } catch (err) {
    console.error('[admin applicants/:jobId]', err.message);
    res.status(500).json({ error: 'Failed to fetch applicants for job' });
  }
});

// ─── GET /api/admin/featured-listings ────────────────────────────────────────
router.get('/featured-listings', requireAdmin, async (req, res) => {
  try {
    const jobs = await db.prepare(`
      SELECT j.id, j.title, j.category, j.featured_until, j.status,
             u.full_name AS employer_name, u.email AS employer_email,
             (SELECT COUNT(*) FROM job_matches jm WHERE jm.job_id = j.id) AS pushed_count
      FROM jobs j
      JOIN users u ON j.employer_id = u.id
      WHERE j.featured_until IS NOT NULL AND j.featured_until > NOW()
      ORDER BY j.featured_until ASC
    `).all();
    res.json(jobs);
  } catch (err) {
    console.error('[featured-listings] error:', err.message);
    res.status(500).json({ error: 'Failed to fetch featured listings' });
  }
});

// ─── GET /api/admin/employer-payments/:id ────────────────────────────────────
router.get('/employer-payments/:id', requireAdmin, async (req, res) => {
  try {
    const records = await db.prepare(
      'SELECT * FROM payment_records WHERE user_id = ? ORDER BY paid_at DESC'
    ).all(parseInt(req.params.id));
    res.json(records);
  } catch (err) {
    console.error('[employer-payments] error:', err.message);
    res.status(500).json({ error: 'Failed to fetch payment records' });
  }
});

// ─── GET /api/admin/employer-jobs/:id ────────────────────────────────────────
router.get('/employer-jobs/:id', requireAdmin, async (req, res) => {
  try {
    const jobs = await db.prepare(`
      SELECT j.id, j.job_code, j.title, j.status, j.created_at, j.updated_at,
        (SELECT COUNT(*) FROM applications a WHERE a.job_id = j.id) AS applicant_count
      FROM jobs j
      WHERE j.employer_id = ? AND j.is_seeded = 0
      ORDER BY j.created_at DESC
    `).all(parseInt(req.params.id));
    res.json(jobs);
  } catch (err) {
    console.error('[employer-jobs] error:', err.message);
    res.status(500).json({ error: 'Failed to fetch employer jobs' });
  }
});

// ─── GET /api/admin/employer-hired/:id ───────────────────────────────────────
router.get('/employer-hired/:id', requireAdmin, async (req, res) => {
  try {
    const { pool } = require('../database');
    const { rows } = await pool.query(`
      SELECT ep.talent_id, ep.hired_at, ep.job_id,
             u.full_name AS talent_name, u.email AS talent_email, u.profile_pic,
             j.title AS job_title
      FROM employer_pipeline ep
      JOIN users u ON u.id = ep.talent_id
      LEFT JOIN jobs j ON j.id = ep.job_id
      WHERE ep.employer_id = $1 AND ep.stage = 'hired'
      ORDER BY ep.hired_at DESC
    `, [parseInt(req.params.id)]);
    res.json(rows);
  } catch (err) {
    console.error('[employer-hired] error:', err.message);
    res.status(500).json({ error: 'Failed to fetch hired candidates' });
  }
});

// ─── PUT /api/admin/employer-brief/:id ───────────────────────────────────────
router.put('/employer-brief/:id', requireAdmin, async (req, res) => {
  const { client_brief } = req.body;
  try {
    await db.prepare('UPDATE users SET client_brief = ?, updated_at = NOW() WHERE id = ?')
      .run(client_brief || '', parseInt(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    console.error('[employer-brief] error:', err.message);
    res.status(500).json({ error: 'Failed to save client brief' });
  }
});

// ─── POST /api/admin/employers/:id/grant-access ──────────────────────────────
// Manually unlock an employer's account (used while payment is pending)
router.post('/employers/:id/grant-access', requireAdmin, async (req, res) => {
  const { plan = 'growth', post_credits = 0 } = req.body;
  const validPlans = ['starter', 'growth', 'essential', 'pro'];
  if (!validPlans.includes(plan)) {
    return res.status(400).json({ error: 'plan must be starter, growth, or pro' });
  }
  try {
    const user = await db.prepare("SELECT id, full_name, email FROM users WHERE id = ? AND role = 'employer'").get(req.params.id);
    if (!user) return res.status(404).json({ error: 'Employer not found' });

    const expires = new Date();
    expires.setFullYear(expires.getFullYear() + 10); // 10-year manual grant

    await db.prepare(`
      UPDATE users SET
        employer_plan = ?,
        subscription_tier = 'tier_1',
        subscription_expires_at = ?,
        post_credits = post_credits + ?,
        payment_method_added = 1
      WHERE id = ?
    `).run(plan, expires.toISOString(), post_credits, req.params.id);

    // Reactivate any job posts that were auto-paused when this employer's plan lapsed
    await db.prepare(
      "UPDATE jobs SET status = 'open', auto_paused = 0, updated_at = NOW() WHERE employer_id = ? AND auto_paused = 1 AND status = 'paused'"
    ).run(req.params.id);

    console.log(`[admin] Granted ${plan} access to employer ${user.email} (id ${req.params.id})`);
    res.json({ success: true, message: `Access granted: ${plan} plan`, employer: user.full_name });
  } catch (err) {
    console.error('[grant-access] error:', err.message);
    res.status(500).json({ error: 'Failed to grant access' });
  }
});

// ─── POST /api/admin/employers/:id/revoke-access ─────────────────────────────
router.post('/employers/:id/revoke-access', requireAdmin, async (req, res) => {
  try {
    const user = await db.prepare("SELECT id, full_name FROM users WHERE id = ? AND role = 'employer'").get(req.params.id);
    if (!user) return res.status(404).json({ error: 'Employer not found' });

    await db.prepare(`
      UPDATE users SET
        employer_plan = 'standard',
        subscription_tier = 'free',
        subscription_expires_at = NULL,
        post_credits = 0,
        payment_method_added = 0
      WHERE id = ?
    `).run(req.params.id);

    res.json({ success: true, message: 'Access revoked' });
  } catch (err) {
    console.error('[revoke-access] error:', err.message);
    res.status(500).json({ error: 'Failed to revoke access' });
  }
});

// ─── GET /api/admin/employers-list ───────────────────────────────────────────
router.get('/employers-list', requireAdmin, async (req, res) => {
  try {
    const employers = await db.prepare(`
      SELECT id, full_name, email, role, employer_plan, subscription_tier, subscription_expires_at,
             subscription_auto_renew, subscription_cancelled_at, paypal_subscription_id, paypal_order_id, paymongo_payment_id,
             post_credits, payment_method_added, client_brief, referral_source, created_at
      FROM users
      WHERE role = 'employer' AND (admin_role IS NULL OR admin_role = '')
      ORDER BY created_at DESC
    `).all();
    res.json(employers);
  } catch (err) {
    console.error('[employers-list] error:', err.message);
    res.status(500).json({ error: 'Failed to fetch employers' });
  }
});

// ─── GET /api/admin/referral-breakdown — "Where did you hear about us?" counts ──
router.get('/referral-breakdown', requireAdmin, async (req, res) => {
  try {
    const rows = await db.prepare(`
      SELECT role, referral_source, COUNT(*)::int AS c
      FROM users
      WHERE role = 'employer' AND (admin_role IS NULL OR admin_role = '')
      GROUP BY role, referral_source
    `).all();

    const LABELS = {
      google: 'Google Search', facebook: 'Facebook', instagram: 'Instagram',
      linkedin: 'LinkedIn', tiktok: 'TikTok', youtube: 'YouTube',
      referral: 'Friend / Colleague', ai: 'AI / ChatGPT', other: 'Other',
      none: 'Not specified',
    };
    // Employers who picked "Other" and typed an AI tool are a real channel, not "Other" —
    // bucket them under 'ai' so the breakdown shows it. Anchored so it can't match
    // substrings inside unrelated words.
    const AI_RE = /^(other:\s*)?(a\.?i\.?|chat ?gpt|gpt|openai|claude|gemini|copilot|perplexity|grok)$/i;
    // Normalize: blank → 'none'; known AI free-text → 'ai'; any other free-text → 'other'.
    const normalize = (s) => {
      if (!s || !String(s).trim()) return 'none';
      const v = String(s).trim().toLowerCase();
      if (LABELS[v]) return v;
      if (AI_RE.test(v)) return 'ai';
      return 'other';
    };

    const buckets = {};
    let total = 0;
    for (const r of rows) {
      const key = normalize(r.referral_source);
      const b = buckets[key] || (buckets[key] = { key, label: LABELS[key], employer: 0, freelancer: 0, total: 0 });
      b[r.role] += r.c;
      b.total   += r.c;
      total     += r.c;
    }

    // Sort by total desc, but always keep "Not specified" last.
    const sources = Object.values(buckets).sort((a, b) =>
      (a.key === 'none') - (b.key === 'none') || b.total - a.total);

    res.json({ total, sources });
  } catch (err) {
    console.error('[referral-breakdown] error:', err.message);
    res.status(500).json({ error: 'Failed to load referral breakdown' });
  }
});

// ─── GET /api/admin/talent-list ───────────────────────────────────────────────
router.get('/talent-list', requireAdmin, async (req, res) => {
  try {
    const talent = await db.prepare(`
      SELECT u.id, u.full_name, u.email, u.role, u.talent_status, u.profile_pic, u.pre_screen_status, u.talent_code, u.created_at,
             u.incomplete_warning_sent_at,
             (SELECT COUNT(*) FROM applications a WHERE a.freelancer_id = u.id) AS application_count
      FROM users u
      WHERE u.role = 'freelancer'
      ORDER BY u.created_at DESC
    `).all();
    res.json(talent);
  } catch (err) {
    console.error('[talent-list] error:', err.message);
    res.status(500).json({ error: 'Failed to fetch talent list' });
  }
});

// ─── POST /api/admin/test-email ──────────────────────────────────────────────
// Send a test email to the logged-in admin to verify Resend is working
router.post('/test-email', requireAdmin, async (req, res) => {
  const db2 = require('../database');
  const user = await db2.prepare('SELECT email, full_name FROM users WHERE id = ?').get(req.user.id);
  try {
    await sendEmail({
      to: user.email,
      subject: 'WorkBase PH — Email Test',
      html: `<div style="font-family:sans-serif;padding:32px;max-width:500px">
        <h2 style="color:#0d2240">Email is working!</h2>
        <p>This is a test email from WorkBase PH sent to <strong>${user.email}</strong>.</p>
        <p style="color:#6b7280;font-size:13px">If you received this, your Resend integration is correctly configured.</p>
      </div>`,
    });
    res.json({ ok: true, message: `Test email sent to ${user.email}` });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── PUT /api/admin/sleek/:id ────────────────────────────────────────────────
// Manually save a sleek profile written by admin
router.put('/sleek/:id', requireAdmin, async (req, res) => {
  const { sleek_profile } = req.body;
  try {
    await db.prepare('UPDATE users SET sleek_profile = ?, updated_at = NOW() WHERE id = ?')
      .run(sleek_profile || '', parseInt(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    console.error('[sleek PUT] error:', err.message);
    res.status(500).json({ error: 'Failed to save sleek profile' });
  }
});

// ─── POST /api/admin/generate-sleek/:id ──────────────────────────────────────
// Generate (or regenerate) a Sleek View profile for a talent from raw data
router.post('/generate-sleek/:id', requireAdmin, async (req, res) => {
  try {
    const user = await db.prepare("SELECT id, full_name FROM users WHERE id = ? AND role = 'freelancer'").get(parseInt(req.params.id));
    if (!user) return res.status(404).json({ error: 'Candidate not found' });
    const sleek = await generateSleekProfile(parseInt(req.params.id), 'generate');
    res.json({ ok: true, sleek_profile: sleek, message: `Sleek profile generated for ${user.full_name}` });
  } catch (err) {
    console.error('[generate-sleek] error:', err.message);
    res.status(500).json({ error: 'Failed to generate sleek profile: ' + err.message });
  }
});

// ─── POST /api/admin/edit-sleek/:id ──────────────────────────────────────────
// Editorial mode: polish/reformat existing admin notes or bio text
router.post('/edit-sleek/:id', requireAdmin, async (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'text field required' });
  try {
    const user = await db.prepare("SELECT id, full_name FROM users WHERE id = ? AND role = 'freelancer'").get(parseInt(req.params.id));
    if (!user) return res.status(404).json({ error: 'Candidate not found' });
    const sleek = await generateSleekProfile(parseInt(req.params.id), 'edit', text);
    res.json({ ok: true, sleek_profile: sleek, message: `Sleek profile edited for ${user.full_name}` });
  } catch (err) {
    console.error('[edit-sleek] error:', err.message);
    res.status(500).json({ error: 'Failed to edit sleek profile: ' + err.message });
  }
});

// ─── POST /api/admin/create-reviewer ─────────────────────────────────────────
router.post('/create-reviewer', requireSuperAdmin, async (req, res) => {
  const { email, full_name, password } = req.body;
  if (!email || !full_name || !password) return res.status(400).json({ error: 'email, full_name, and password required' });

  try {
    const existing = await db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) return res.status(409).json({ error: 'Email already in use' });

    const bcrypt = require('bcryptjs');
    const result = await db.prepare(
      "INSERT INTO users (email, password, full_name, role, admin_role) VALUES (?, ?, ?, 'employer', 'reviewer_admin')"
    ).run(email, bcrypt.hashSync(password, 10), full_name);

    res.status(201).json({ id: result.lastInsertRowid, email, full_name, admin_role: 'reviewer_admin' });
  } catch (err) {
    console.error('[create-reviewer] error:', err.message);
    res.status(500).json({ error: 'Failed to create reviewer' });
  }
});

// ─── PUT /api/admin/set-elite-employer/:id ───────────────────────────────────
router.put('/set-elite-employer/:id', requireAdmin, async (req, res) => {
  const { employer_plan } = req.body;
  try {
    await db.prepare("UPDATE users SET employer_plan = ?, updated_at = NOW() WHERE id = ? AND role = 'employer'")
      .run(employer_plan || 'elite', parseInt(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    console.error('[set-elite-employer] error:', err.message);
    res.status(500).json({ error: 'Failed to update employer plan' });
  }
});

// ─── GET /api/admin/talent-triage ─────────────────────────────────────────────
// Returns all freelancer profiles with profile_score, sorted 80%+ first
router.get('/talent-triage', requireAdmin, async (req, res) => {
  try {
    const rows = await db.prepare(`
      SELECT id, full_name, email, profile_pic, job_title, talent_status, is_top_tier,
             bio, skills, location, video_loom_link, resume_file, account_paused,
             hardware_specs, specs_image, speedtest_url, speedtest_image, personality_type,
             (
               CASE WHEN profile_pic IS NOT NULL AND profile_pic != '' THEN 10 ELSE 0 END +
               CASE WHEN bio IS NOT NULL AND bio != '' THEN 10 ELSE 0 END +
               CASE WHEN skills IS NOT NULL AND skills != '' AND skills != '[]' THEN 10 ELSE 0 END +
               CASE WHEN location IS NOT NULL AND location != '' THEN 5 ELSE 0 END +
               CASE WHEN video_loom_link IS NOT NULL AND video_loom_link != '' THEN 20 ELSE 0 END +
               CASE WHEN resume_file IS NOT NULL AND resume_file != '' THEN 15 ELSE 0 END +
               CASE WHEN (hardware_specs IS NOT NULL AND hardware_specs != '') OR (specs_image IS NOT NULL AND specs_image != '') THEN 10 ELSE 0 END +
               CASE WHEN (speedtest_url IS NOT NULL AND speedtest_url != '') OR (speedtest_image IS NOT NULL AND speedtest_image != '') THEN 5 ELSE 0 END +
               CASE WHEN personality_type IS NOT NULL AND personality_type != '' THEN 5 ELSE 0 END
             ) AS profile_score,
             (
               SELECT json_agg(json_build_object(
                        'job_id', j.id, 'title', j.title,
                        'job_code', j.job_code, 'status', jm.status,
                        'viewed', COALESCE(epv.view_count, 0) > 0,
                        'view_count', COALESCE(epv.view_count, 0),
                        'last_viewed_at', epv.last_viewed_at,
                        'stage', ep.stage
                      ) ORDER BY jm.pushed_at DESC)
               FROM job_matches jm
               JOIN jobs j ON j.id = jm.job_id
               LEFT JOIN employer_profile_views epv
                      ON epv.talent_id = jm.talent_id AND epv.job_id = j.id
               LEFT JOIN employer_pipeline ep
                      ON ep.talent_id = jm.talent_id AND ep.employer_id = j.employer_id
               WHERE jm.talent_id = users.id
                 AND jm.status IN ('notified','submitted','pushed','shortlisted','interview_requested')
             ) AS sent_to_jobs
      FROM users
      WHERE role = 'freelancer'
        AND talent_status NOT IN ('denied')
      ORDER BY profile_score DESC, is_top_tier DESC, created_at DESC
    `).all();

    // Annotate missing fields for display
    const result = rows.map(r => {
      const missing = [];
      if (!r.profile_pic)    missing.push('Photo');
      if (!r.bio)            missing.push('Bio');
      if (!r.skills || r.skills === '[]') missing.push('Skills');
      if (!r.location)       missing.push('Location');
      if (!r.video_loom_link) missing.push('Video');
      if (!r.resume_file)    missing.push('Resume');
      if (!r.hardware_specs && !r.specs_image) missing.push('Specs');
      if (!r.speedtest_url && !r.speedtest_image) missing.push('Speedtest');
      if (!r.personality_type) missing.push('Assessment');
      return { ...r, missing_fields: missing.join(', ') || null };
    });

    res.json(result);
  } catch (err) {
    console.error('[talent-triage]', err.message);
    res.status(500).json({ error: 'Failed to load talent triage' });
  }
});

// ─── PUT /api/admin/top-tier/:id ─────────────────────────────────────────────
router.put('/top-tier/:id', requireAdmin, async (req, res) => {
  const { is_top_tier } = req.body;
  try {
    await db.prepare('UPDATE users SET is_top_tier = ?, updated_at = NOW() WHERE id = ?')
      .run(is_top_tier ? 1 : 0, parseInt(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    console.error('[top-tier] error:', err.message);
    res.status(500).json({ error: 'Failed to update badge' });
  }
});

// ─── PATCH /api/admin/employer/:id/access ────────────────────────────────────
// Grant or revoke employer dashboard access without requiring payment
router.patch('/employer/:id/access', requireAdmin, async (req, res) => {
  const { grant } = req.body; // true = grant, false = revoke
  try {
    const employer = await db.prepare("SELECT id, email, full_name, role FROM users WHERE id = ? AND role = 'employer'").get(parseInt(req.params.id));
    if (!employer) return res.status(404).json({ error: 'Employer not found' });
    await db.prepare('UPDATE users SET employer_access = ?, updated_at = NOW() WHERE id = ?')
      .run(grant ? 1 : 0, parseInt(req.params.id));
    console.log(`[admin] employer_access ${grant ? 'granted' : 'revoked'} for ${employer.email}`);
    res.json({ ok: true, employer_access: grant ? 1 : 0 });
  } catch (err) {
    console.error('[employer access] error:', err.message);
    res.status(500).json({ error: 'Failed to update access' });
  }
});

// ─── GET /api/admin/employers ─────────────────────────────────────────────────
// List all employer accounts with their access status
router.get('/employers', requireAdmin, async (req, res) => {
  try {
    const employers = await db.prepare(`
      SELECT id, email, full_name, employer_plan, employer_access,
             subscription_tier, post_credits, is_business_verified,
             created_at
      FROM users
      WHERE role = 'employer'
        AND (admin_role IS NULL OR admin_role = '')
      ORDER BY created_at DESC
      LIMIT 200
    `).all();
    res.json(employers);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch employers' });
  }
});

// ─── GET /api/admin/new-counts ───────────────────────────────────────────────
router.get('/new-counts', requireAdmin, async (req, res) => {
  try {
    const admin = await db.prepare(
      'SELECT admin_seen_employers_at, admin_seen_jobs_at, admin_seen_talent_at FROM users WHERE id = ?'
    ).get(req.user.id);

    const seenEmployers = admin?.admin_seen_employers_at || new Date(0);
    const seenJobs      = admin?.admin_seen_jobs_at      || new Date(0);
    const seenTalent    = admin?.admin_seen_talent_at    || new Date(0);

    const [newTalent, newEmployers, newJobs] = await Promise.all([
      db.prepare(`
        SELECT COUNT(*) AS c FROM users
        WHERE role = 'freelancer'
          AND (talent_status IS NULL OR talent_status = 'pending')
          AND created_at > $1
      `).get(seenTalent),
      db.prepare(`
        SELECT COUNT(*) AS c FROM users
        WHERE role = 'employer'
          AND (admin_role IS NULL OR admin_role = '')
          AND created_at > $1
      `).get(seenEmployers),
      db.prepare(`
        SELECT COUNT(*) AS c FROM jobs j
        WHERE j.created_at > $1
          AND NOT EXISTS (
            SELECT 1 FROM job_matches jm
            WHERE jm.job_id = j.id
              AND jm.status IN ('pushed', 'notified', 'interview_requested')
          )
      `).get(seenJobs),
    ]);

    res.json({
      new_talent:    parseInt(newTalent.c)   || 0,
      new_employers: parseInt(newEmployers.c) || 0,
      new_jobs:      parseInt(newJobs.c)     || 0,
    });
  } catch (err) {
    console.error('[admin new-counts] error:', err.message);
    res.status(500).json({ error: 'Failed to fetch counts' });
  }
});

// ─── POST /api/admin/mark-seen/:section ──────────────────────────────────────
router.post('/mark-seen/:section', requireAdmin, async (req, res) => {
  const col = {
    employers: 'admin_seen_employers_at',
    jobs:      'admin_seen_jobs_at',
    talent:    'admin_seen_talent_at',
  }[req.params.section];
  if (!col) return res.status(400).json({ error: 'Unknown section' });
  try {
    await db.prepare(`UPDATE users SET ${col} = NOW() WHERE id = ?`).run(req.user.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark seen' });
  }
});

// ─── POST /api/admin/broadcast-email ─────────────────────────────────────────
router.post('/broadcast-email', requireSuperAdmin, async (req, res) => {
  const { audience, subject, body } = req.body;
  if (!audience || !subject || !body) {
    return res.status(400).json({ error: 'audience, subject, and body are required.' });
  }
  const validAudiences = ['employers', 'specialists', 'all'];
  if (!validAudiences.includes(audience)) {
    return res.status(400).json({ error: 'Invalid audience.' });
  }

  try {
    let whereClause = '';
    if (audience === 'employers')   whereClause = "WHERE role = 'employer' AND (admin_role IS NULL OR admin_role = '')";
    if (audience === 'specialists') whereClause = "WHERE role = 'freelancer' AND talent_status NOT IN ('pending', 'denied')";
    if (audience === 'all')         whereClause = "WHERE role IN ('employer','freelancer') AND (admin_role IS NULL OR admin_role = '') AND (role = 'employer' OR talent_status NOT IN ('pending','denied'))";

    const recipients = await db.prepare(`SELECT email, full_name FROM users ${whereClause}`).all();

    if (!recipients.length) {
      return res.json({ sent: 0 });
    }

    const audienceLabel = { employers: 'All Employers', specialists: 'All Specialists', all: 'Everyone' }[audience];
    let sent = 0;
    const errors = [];

    for (const user of recipients) {
      try {
        const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Helvetica Neue',Arial,sans-serif">
<div style="max-width:600px;margin:0 auto;background:#fff">
  <div style="background:#0d2240;padding:28px 40px;text-align:center">
    <div style="font-size:22px;font-weight:900;color:#fff;letter-spacing:-0.5px">Work<span style="color:#f47c20">Base</span> PH</div>
    <div style="color:rgba(255,255,255,0.6);font-size:12px;margin-top:4px">Platform Announcement</div>
  </div>
  <div style="padding:32px 40px">
    <p style="font-size:15px;font-weight:600;color:#0d2240;margin-bottom:16px">Hi ${user.full_name || 'there'},</p>
    <div style="font-size:14px;color:#374151;line-height:1.8;white-space:pre-wrap">${body.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
  </div>
  <div style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:20px 40px;text-align:center">
    <p style="font-size:12px;color:#9ca3af;margin:0">WorkBase PH — <a href="mailto:admin@workbaseph.com" style="color:#f47c20">admin@workbaseph.com</a></p>
    <p style="font-size:11px;color:#d1d5db;margin:4px 0 0">You're receiving this because you have an account on WorkBase PH.</p>
  </div>
</div>
</body>
</html>`;
        await sendEmail({ to: user.email, subject, html, replyTo: 'admin@workbaseph.com' });
        sent++;
      } catch (err) {
        errors.push(user.email);
        console.error(`[broadcast] Failed to send to ${user.email}:`, err.message);
      }
    }

    console.log(`[broadcast] Sent to ${sent}/${recipients.length} recipients (audience: ${audienceLabel})`);
    res.json({ sent, total: recipients.length, errors: errors.length ? errors : undefined });
  } catch (err) {
    console.error('[broadcast-email] error:', err.message);
    res.status(500).json({ error: 'Failed to send broadcast email.' });
  }
});

module.exports = router;
