const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../database');
const { JWT_SECRET, authenticateToken } = require('../middleware/auth');
const { sendEmail, welcomeSpecialistEmail, welcomeEmployerEmail, adminSignupNotificationEmail } = require('../services/email');

// ── Admin "new employer signup" report ────────────────────────────────────────
// Only fires once an employer has actually chosen a plan or paid — a bare signup
// with no plan and no payment is skipped (no email, and left un-stamped so the
// plan-purchase path in routes/payments.js sends it later if/when they activate).
// admin_signup_notified_at guarantees it only ever goes out once per employer.
async function notifyAdminOfEmployerSignup(userId, planLabel) {
  try {
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user || user.role !== 'employer') return;
    if (user.admin_signup_notified_at) return;              // already reported
    if (user.admin_role) return;                            // don't report admins

    // Skip employers who signed up but haven't chosen a plan or made any payment.
    // planLabel is set only on the plan-purchase / trial paths; a null label means
    // this is a bare signup. Double-check payments so a future caller can't leak one.
    if (!planLabel) {
      const paid = await db.prepare(
        'SELECT COUNT(*)::int AS c FROM payment_records WHERE user_id = ?'
      ).get(userId);
      const activated = user.employer_plan === 'starter' || user.employer_plan === 'pro'
        || user.post_credits > 0 || user.payment_method_added === 1 || (paid?.c > 0);
      if (!activated) return;                                // no plan + no payment → don't notify admin
    }

    // Stamp first so two near-simultaneous calls can't both send.
    const stamped = await db.prepare(
      'UPDATE users SET admin_signup_notified_at = NOW() WHERE id = ? AND admin_signup_notified_at IS NULL'
    ).run(userId);
    if (!stamped?.changes) return;

    let referredBy = null;
    if (user.referred_by) {
      const ref = await db.prepare('SELECT full_name FROM users WHERE referral_code = ?').get(user.referred_by);
      referredBy = ref?.full_name || null;
    }
    const adminEmail = process.env.ADMIN_NOTIFY_EMAIL || 'admin@workbaseph.com';
    await sendEmail({ to: adminEmail, ...adminSignupNotificationEmail(user, referredBy, planLabel || null) });
    console.log(`📨 Admin notified: new employer — ${user.email} (${planLabel || 'no plan yet'})`);
  } catch (err) {
    console.error('[admin employer signup notify]', err.message);
  }
}

// Generate a unique 8-char referral code from user ID + email hash
function generateReferralCode(id, email) {
  const raw = `${id}${email}${Date.now()}`;
  let hash = 0;
  for (let i = 0; i < raw.length; i++) { hash = ((hash << 5) - hash) + raw.charCodeAt(i); hash |= 0; }
  return Math.abs(hash).toString(36).toUpperCase().padStart(6, '0').slice(0, 8);
}

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { email, password, full_name, role, skills, ref, referral_source } = req.body;

  if (!email || !password || !full_name || !role) {
    return res.status(400).json({ error: 'All fields are required' });
  }
  if (!['employer', 'freelancer'].includes(role)) {
    return res.status(400).json({ error: 'Role must be employer or freelancer' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  try {
    const existing = await db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    // Validate referral code if provided
    let referredBy = null;
    if (ref) {
      const referrer = await db.prepare('SELECT id FROM users WHERE referral_code = ?').get(ref.toUpperCase());
      if (referrer) referredBy = ref.toUpperCase();
    }

    const hashed = bcrypt.hashSync(password, 10);
    // Freelancers are live in the marketplace by default (no admin vetting gate).
    // NULL status = visible; the talent controls their own visibility via account_paused.
    const talentStatus = null;

    const result = await db.prepare(
      'INSERT INTO users (email, password, full_name, role, talent_status, skills, referred_by, referral_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(email, hashed, full_name, role, talentStatus, skills || '', referredBy, (referral_source || '').slice(0, 200) || null);

    // Generate and store referral code
    const newUserId = result.lastInsertRowid;
    const refCode = generateReferralCode(newUserId, email);
    await db.prepare('UPDATE users SET referral_code = ? WHERE id = ?').run(refCode, newUserId);

    // Generate Talent ID code for freelancers (T-XXXX)
    if (role === 'freelancer') {
      const talentCode = `T-${String(newUserId).padStart(4, '0')}`;
      await db.prepare('UPDATE users SET talent_code = ? WHERE id = ?').run(talentCode, newUserId);
    }

    const user = await db.prepare('SELECT id, email, full_name, role, is_verified FROM users WHERE id = ?').get(newUserId);
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });

    // Talents get NOTHING here — this is only step 1 of signup (the questionnaire still
    // follows), so emailing now means a "your profile is incomplete" nag lands seconds
    // after they start. The welcome is sent from POST /auth/complete-signup once they
    // actually finish; the D1/D3/D7 drips handle anyone who abandons partway.
    if (user.role === 'employer') {
      sendEmail({ to: user.email, ...welcomeEmployerEmail(user.full_name) }).catch(err =>
        console.error('Employer welcome email failed:', err.message)
      );
      // Notify admin of every new employer immediately — plan or no plan. The report
      // names the referral source (Google, Facebook, etc.) and reads "No plan selected
      // yet" until they buy one. The plan-purchase path in routes/payments.js re-calls
      // this with the plan name, but the once-only guard means the earlier no-plan email
      // has already gone out; the payment itself is still reported via adminPaymentConfirmedEmail.
      notifyAdminOfEmployerSignup(newUserId, null).catch(() => {});
    }

    // Talent signups are tracked by the orange dot on the admin dashboard instead of an
    // email. Every new employer lights the "All Employers" dot immediately, plan or no plan.

    res.status(201).json({ token, user });
  } catch (err) {
    console.error('[register] error:', err.message);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const user = await db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const valid = bcrypt.compareSync(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    const { password: _, ...safeUser } = user;

    res.json({ token, user: safeUser });
  } catch (err) {
    console.error('[login] error:', err.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /api/auth/me
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { password: _, ...safeUser } = user;
    res.json(safeUser);
  } catch (err) {
    console.error('[me] error:', err.message);
    res.status(500).json({ error: 'Failed to fetch user', detail: err.message });
  }
});

// POST /api/auth/complete-signup — talent finished the signup questionnaire.
// This is the ONLY place the specialist welcome email is sent on the email/password
// path: registration is just step 1, so emailing there lands a message before they've
// finished. signup_completed_at makes it fire exactly once.
router.post('/complete-signup', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'freelancer') return res.json({ ok: true, skipped: 'not a specialist' });

    // Stamp first so a double-submit can't send two welcomes.
    const stamped = await db.prepare(
      'UPDATE users SET signup_completed_at = NOW() WHERE id = ? AND signup_completed_at IS NULL'
    ).run(req.user.id);
    if (!stamped?.changes) return res.json({ ok: true, already: true });

    const user = await db.prepare('SELECT full_name, email FROM users WHERE id = ?').get(req.user.id);
    if (user?.email) {
      sendEmail({ to: user.email, ...welcomeSpecialistEmail(user.full_name) })
        .catch(err => console.error('Specialist welcome email failed:', err.message));
      console.log(`👋 Signup complete — welcome sent to ${user.email}`);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[complete-signup] error:', err.message);
    res.status(500).json({ error: 'Failed to complete signup' });
  }
});

// PUT /api/auth/profile
router.put('/profile', authenticateToken, async (req, res) => {
  const {
    full_name, bio, skills, location, video_loom_link, website_url,
    // Talent profile
    job_title, speedtest_url,
    // Gamified talent questionnaire fields
    professional_level, education_level, work_schedule,
    // Extended questionnaire fields (Q8–Q14)
    hourly_rate_range, weekly_availability, start_availability,
    equipment, internet_speed, connection_type,
  } = req.body;
  try {
    // Fetch current values so we only overwrite provided fields
    const current = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!current) return res.status(404).json({ error: 'User not found' });

    const sets = [];
    const vals = [];

    if (full_name       !== undefined) { sets.push('full_name = ?');        vals.push(full_name); }
    if (job_title       !== undefined) { sets.push('job_title = ?');        vals.push(job_title); }
    if (bio             !== undefined) { sets.push('bio = ?');               vals.push(bio); }
    if (skills          !== undefined) { sets.push('skills = ?');            vals.push(skills); }
    if (location        !== undefined) { sets.push('location = ?');          vals.push(location); }
    if (video_loom_link !== undefined) { sets.push('video_loom_link = ?');   vals.push(video_loom_link || ''); }
    if (website_url     !== undefined) { sets.push('website_url = ?');       vals.push(website_url || ''); }
    if (speedtest_url   !== undefined) { sets.push('speedtest_url = ?');     vals.push(speedtest_url || ''); }
    if (professional_level  !== undefined) { sets.push('professional_level = ?');  vals.push(professional_level); }
    if (education_level     !== undefined) { sets.push('education_level = ?');     vals.push(education_level); }
    if (work_schedule       !== undefined) { sets.push('work_schedule = ?');       vals.push(work_schedule); }
    if (hourly_rate_range   !== undefined) { sets.push('hourly_rate_range = ?');   vals.push(hourly_rate_range); }
    if (weekly_availability !== undefined) { sets.push('weekly_availability = ?'); vals.push(weekly_availability); }
    if (start_availability  !== undefined) { sets.push('start_availability = ?');  vals.push(start_availability); }
    if (equipment           !== undefined) { sets.push('equipment = ?');           vals.push(equipment); }
    if (internet_speed      !== undefined) { sets.push('internet_speed = ?');      vals.push(internet_speed); }
    if (connection_type     !== undefined) { sets.push('connection_type = ?');     vals.push(connection_type); }

    if (sets.length > 0) {
      sets.push('updated_at = NOW()');
      vals.push(req.user.id);
      await db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    }

    const user = await db.prepare(
      'SELECT id, email, full_name, role, bio, skills, location, video_loom_link, website_url, job_title, is_verified, professional_level, education_level, work_schedule, speedtest_url FROM users WHERE id = ?'
    ).get(req.user.id);
    res.json(user);
  } catch (err) {
    console.error('[profile] error:', err.message);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });
  try {
    const user = await db.prepare('SELECT id, full_name, email FROM users WHERE email = ?').get(email.toLowerCase().trim());
    // Always respond OK to prevent user enumeration
    if (!user) return res.json({ message: 'If that email exists, a reset link has been sent.' });

    const crypto = require('crypto');
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

    await db.prepare('UPDATE users SET password_reset_token = ?, password_reset_expires_at = ? WHERE id = ?').run(token, expires, user.id);

    const APP_URL = process.env.APP_URL || 'https://workbaseph.com';
    const resetLink = `${APP_URL}/reset-password.html?token=${token}`;

    await sendEmail({
      to: user.email,
      subject: 'Reset your WorkBase PH password',
      html: `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:2rem">
          <div style="font-size:1.5rem;font-weight:900;color:#0d2240;margin-bottom:1rem">Work<span style="color:#f47c20">Base</span>PH</div>
          <h2 style="color:#0d2240;margin-bottom:0.5rem">Reset your password</h2>
          <p style="color:#4b5563">Hi ${user.full_name},</p>
          <p style="color:#4b5563">We received a request to reset your password. Click the button below to choose a new one. This link expires in 1 hour.</p>
          <a href="${resetLink}" style="display:inline-block;margin:1.5rem 0;padding:0.85rem 2rem;background:#f47c20;color:white;font-weight:700;border-radius:8px;text-decoration:none">Reset My Password</a>
          <p style="color:#9ca3af;font-size:0.85rem">If you didn't request this, you can safely ignore this email. Your password won't change.</p>
          <p style="color:#9ca3af;font-size:0.85rem">Or copy this link: ${resetLink}</p>
        </div>
      `,
    });

    res.json({ message: 'If that email exists, a reset link has been sent.' });
  } catch (err) {
    console.error('[forgot-password]', err.message);
    res.status(500).json({ error: 'Failed to send reset email' });
  }
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token and new password are required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    const user = await db.prepare(
      'SELECT id FROM users WHERE password_reset_token = ? AND password_reset_expires_at > NOW()'
    ).get(token);
    if (!user) return res.status(400).json({ error: 'This reset link is invalid or has expired.' });

    const hashed = bcrypt.hashSync(password, 10);
    await db.prepare(
      'UPDATE users SET password = ?, password_reset_token = NULL, password_reset_expires_at = NULL WHERE id = ?'
    ).run(hashed, user.id);

    res.json({ message: 'Password updated successfully. You can now log in.' });
  } catch (err) {
    console.error('[reset-password]', err.message);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

const crypto = require('crypto');

// GET /api/auth/google?next=<url> — initiate Google OAuth
router.get('/google', (req, res) => {
  const next = req.query.next || '/dashboard.html';
  const state = Buffer.from(JSON.stringify({ next })).toString('base64url');
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID || '',
    redirect_uri: `${process.env.APP_URL || 'https://www.workbaseph.com'}/api/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account'
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// GET /api/auth/google/callback
router.get('/google/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error || !code) return res.redirect('/login.html?error=google_cancelled');

  let nextUrl = '/dashboard.html';
  try {
    const decoded = JSON.parse(Buffer.from(state, 'base64url').toString());
    nextUrl = decoded.next || nextUrl;
  } catch {}

  try {
    const appUrl = process.env.APP_URL || 'https://www.workbaseph.com';
    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${appUrl}/api/auth/google/callback`,
        grant_type: 'authorization_code'
      })
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) {
      console.error('[google-oauth] no access_token:', tokens);
      return res.redirect('/login.html?error=google_failed');
    }

    // Get Google profile
    const profileRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    const gUser = await profileRes.json();
    if (!gUser.email) return res.redirect('/login.html?error=google_failed');

    // Find or create user
    let user = await db.prepare('SELECT * FROM users WHERE email = ?').get(gUser.email);
    if (!user) {
      const randomPass = bcrypt.hashSync(crypto.randomBytes(20).toString('hex'), 10);
      const result = await db.prepare(
        `INSERT INTO users (email, password, full_name, role, talent_status, profile_pic)
         VALUES (?, ?, ?, 'freelancer', NULL, ?)`
      ).run(gUser.email, randomPass, gUser.name || gUser.email.split('@')[0], gUser.picture || null);
      const newId = result.lastInsertRowid;
      const refCode = generateReferralCode(newId, gUser.email);
      await db.prepare('UPDATE users SET referral_code = ? WHERE id = ?').run(refCode, newId);
      user = await db.prepare('SELECT * FROM users WHERE id = ?').get(newId);
      // Google gives us name/email/photo and there's no questionnaire on this path, so
      // signup IS complete here — send the actual welcome (not a "profile incomplete"
      // nag). No admin notification: this path only ever creates freelancers, which are
      // tracked by the orange dot on the admin dashboard instead.
      await db.prepare('UPDATE users SET signup_completed_at = NOW() WHERE id = ?').run(newId);
      sendEmail({ to: user.email, ...welcomeSpecialistEmail(user.full_name) }).catch(() => {});
    }

    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    const safeUser = { id: user.id, email: user.email, full_name: user.full_name, role: user.role, talent_status: user.talent_status };
    const encodedUser = encodeURIComponent(JSON.stringify(safeUser));
    res.redirect(`/auth-callback.html?token=${encodeURIComponent(token)}&user=${encodedUser}&next=${encodeURIComponent(nextUrl)}`);
  } catch (err) {
    console.error('[google-oauth] callback error:', err.message);
    res.redirect('/login.html?error=google_failed');
  }
});

module.exports = router;
