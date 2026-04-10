const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../database');
const { JWT_SECRET, authenticateToken } = require('../middleware/auth');
const { sendEmail, underReviewEmail } = require('../services/email');

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { email, password, full_name, role, skills } = req.body;

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

    const hashed = bcrypt.hashSync(password, 10);
    const talentStatus = role === 'freelancer' ? 'standard_marketplace' : null;

    const result = await db.prepare(
      'INSERT INTO users (email, password, full_name, role, talent_status, skills) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(email, hashed, full_name, role, talentStatus, skills || '');

    const user = await db.prepare('SELECT id, email, full_name, role, is_verified FROM users WHERE id = ?').get(result.lastInsertRowid);
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });

    // Send "Under Review" email to new talent
    if (user.role === 'freelancer') {
      sendEmail({ to: user.email, ...underReviewEmail(user.full_name) }).catch(err =>
        console.error('Under review email failed:', err.message)
      );
    }

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
  const { full_name, bio, skills, location, video_loom_link } = req.body;
  try {
    await db.prepare(
      'UPDATE users SET full_name = ?, bio = ?, skills = ?, location = ?, video_loom_link = ?, updated_at = NOW() WHERE id = ?'
    ).run(full_name, bio, skills, location, video_loom_link || '', req.user.id);

    const user = await db.prepare(
      'SELECT id, email, full_name, role, bio, skills, location, video_loom_link, is_verified FROM users WHERE id = ?'
    ).get(req.user.id);
    res.json(user);
  } catch (err) {
    console.error('[profile] error:', err.message);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

module.exports = router;
