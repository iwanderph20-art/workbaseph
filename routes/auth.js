const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../database');
const { JWT_SECRET, authenticateToken } = require('../middleware/auth');
const { sendEmail, welcomeSpecialistEmail, welcomeEmployerEmail, adminSignupNotificationEmail } = require('../services/email');

// Generate a unique 8-char referral code from user ID + email hash
function generateReferralCode(id, email) {
  const raw = `${id}${email}${Date.now()}`;
  let hash = 0;
  for (let i = 0; i < raw.length; i++) { hash = ((hash << 5) - hash) + raw.charCodeAt(i); hash |= 0; }
  return Math.abs(hash).toString(36).toUpperCase().padStart(6, '0').slice(0, 8);
}

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { email, password, full_name, role, skills, ref } = req.body;

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
    const talentStatus = role === 'freelancer' ? 'standard_marketplace' : null;

    const result = await db.prepare(
      'INSERT INTO users (email, password, full_name, role, talent_status, skills, referred_by) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(email, hashed, full_name, role, talentStatus, skills || '', referredBy);

    // Generate and store referral code
    const newUserId = result.lastInsertRowid;
    const refCode = generateReferralCode(newUserId, email);
    await db.prepare('UPDATE users SET referral_code = ? WHERE id = ?').run(refCode, newUserId);

    const user = await db.prepare('SELECT id, email, full_name, role, is_verified FROM users WHERE id = ?').get(newUserId);
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });

    // Send welcome email based on role
    if (user.role === 'freelancer') {
      sendEmail({ to: user.email, ...welcomeSpecialistEmail(user.full_name) }).catch(err =>
        console.error('Welcome specialist email failed:', err.message)
      );
    } else if (user.role === 'employer') {
      sendEmail({ to: user.email, ...welcomeEmployerEmail(user.full_name) }).catch(err =>
        console.error('Employer welcome email failed:', err.message)
      );
    }

    // Notify admin of new signup
    const adminEmail = process.env.ADMIN_NOTIFY_EMAIL || 'admin@workbaseph.com';
    sendEmail({ to: adminEmail, ...adminSignupNotificationEmail(user, referredBy) }).catch(err =>
      console.error('Admin signup notification failed:', err.message)
    );

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

// PUT /api/auth/profile
router.put('/profile', authenticateToken, async (req, res) => {
  const {
    full_name, bio, skills, location, video_loom_link,
    // Talent profile
    job_title,
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
      'SELECT id, email, full_name, role, bio, skills, location, video_loom_link, job_title, is_verified, professional_level, education_level, work_schedule FROM users WHERE id = ?'
    ).get(req.user.id);
    res.json(user);
  } catch (err) {
    console.error('[profile] error:', err.message);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

module.exports = router;
