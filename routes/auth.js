const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../database');
const { JWT_SECRET, authenticateToken } = require('../middleware/auth');
const { sendEmail, welcomeFreelancerEmail, welcomeEmployerEmail } = require('../services/email');

// POST /api/auth/register
router.post('/register', (req, res) => {
  const { email, password, full_name, role } = req.body;

  if (!email || !password || !full_name || !role) {
    return res.status(400).json({ error: 'All fields are required' });
  }
  if (!['employer', 'freelancer'].includes(role)) {
    return res.status(400).json({ error: 'Role must be employer or freelancer' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    return res.status(409).json({ error: 'Email already registered' });
  }

  const salt = bcrypt.genSaltSync(10);
  const hashed = bcrypt.hashSync(password, salt);

  try {
    const result = db.prepare(
      'INSERT INTO users (email, password, full_name, role) VALUES (?, ?, ?, ?)'
    ).run(email, hashed, full_name, role);

    const user = db.prepare('SELECT id, email, full_name, role, is_verified FROM users WHERE id = ?').get(result.lastInsertRowid);
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });

    // Send welcome email (non-blocking — don't fail registration if email fails)
    const template = user.role === 'freelancer'
      ? welcomeFreelancerEmail(user.full_name)
      : welcomeEmployerEmail(user.full_name);
    sendEmail({ to: user.email, ...template }).catch(err =>
      console.error('Welcome email failed:', err.message)
    );

    res.status(201).json({ token, user });
  } catch (err) {
    res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
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
});

// GET /api/auth/me
router.get('/me', authenticateToken, (req, res) => {
  const user = db.prepare('SELECT id, email, full_name, role, bio, skills, location, profile_pic, is_verified, created_at FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

// PUT /api/auth/profile
router.put('/profile', authenticateToken, (req, res) => {
  const { full_name, bio, skills, location } = req.body;
  db.prepare('UPDATE users SET full_name = ?, bio = ?, skills = ?, location = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(full_name, bio, skills, location, req.user.id);
  const user = db.prepare('SELECT id, email, full_name, role, bio, skills, location, is_verified FROM users WHERE id = ?').get(req.user.id);
  res.json(user);
});

module.exports = router;
