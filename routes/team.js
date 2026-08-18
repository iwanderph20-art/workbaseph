const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../database');
const { authenticateToken } = require('../middleware/auth');
const { isSubscriptionActive } = require('../services/planAccess');

// Total logins allowed per plan, INCLUDING the owner. Extra seat rows allowed = total - 1.
// Only Pro carries extra seats today; everything else is a single (owner-only) login.
const PLAN_SEATS_TOTAL = { pro: 3 };
function extraSeatsAllowed(user) {
  const plan = user?.employer_plan;
  if (plan === 'pro' && isSubscriptionActive(user)) return (PLAN_SEATS_TOTAL.pro || 1) - 1;
  return 0;
}

// Owner-only guard: must be an authenticated employer AND not itself a seat login.
async function requireOwner(req, res, next) {
  if (req.user.role !== 'employer') return res.status(403).json({ error: 'Employers only' });
  if (req.user.seat_id) return res.status(403).json({ error: 'Only the account owner can manage team seats' });
  const owner = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!owner) return res.status(404).json({ error: 'Account not found' });
  req.owner = owner;
  next();
}

// GET /api/team — list the owner's seats + capacity
router.get('/', authenticateToken, requireOwner, async (req, res) => {
  try {
    const seats = await db.prepare(
      'SELECT id, email, member_name, created_at, last_login_at FROM team_seats WHERE owner_id = ? ORDER BY created_at ASC'
    ).all(req.user.id);
    const allowed = extraSeatsAllowed(req.owner);
    res.json({
      seats,
      seats_used: seats.length,
      seats_allowed: allowed,           // extra seats (excludes owner)
      total_logins_allowed: allowed + 1, // owner + extra seats
      can_add: seats.length < allowed,
      plan: req.owner.employer_plan || 'standard',
    });
  } catch (e) {
    console.error('[team GET]', e.message);
    res.status(500).json({ error: 'Failed to load team' });
  }
});

// POST /api/team — add a seat { email, password, member_name }
router.post('/', authenticateToken, requireOwner, async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  const memberName = (req.body.member_name || '').trim();

  if (!email || !password) return res.status(400).json({ error: 'Email and a temporary password are required' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
  if (password.length < 8) return res.status(400).json({ error: 'Temporary password must be at least 8 characters' });

  try {
    const allowed = extraSeatsAllowed(req.owner);
    if (allowed <= 0) {
      return res.status(403).json({ error: 'Team seats are a Pro plan feature. Upgrade to Pro to add teammates.', code: 'SEATS_NOT_AVAILABLE' });
    }
    const used = parseInt((await db.prepare('SELECT COUNT(*) AS c FROM team_seats WHERE owner_id = ?').get(req.user.id))?.c || 0);
    if (used >= allowed) {
      return res.status(403).json({ error: `You've used all ${allowed} team seats on your plan.`, code: 'SEAT_LIMIT_REACHED', seats_allowed: allowed });
    }
    // Email must not collide with a real user account or another seat.
    const existingUser = await db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existingUser) return res.status(409).json({ error: 'That email already belongs to a WorkBase PH account.' });
    const existingSeat = await db.prepare('SELECT id FROM team_seats WHERE email = ?').get(email);
    if (existingSeat) return res.status(409).json({ error: 'That email is already a seat on an account.' });

    const hash = bcrypt.hashSync(password, 10);
    const result = await db.prepare(
      'INSERT INTO team_seats (owner_id, email, password, member_name) VALUES (?, ?, ?, ?)'
    ).run(req.user.id, email, hash, memberName);

    res.status(201).json({ ok: true, seat: { id: result.lastInsertRowid, email, member_name: memberName } });
  } catch (e) {
    console.error('[team POST]', e.message);
    res.status(500).json({ error: 'Failed to add seat' });
  }
});

// DELETE /api/team/:id — remove a seat (owner-only, must belong to the owner)
router.delete('/:id', authenticateToken, requireOwner, async (req, res) => {
  try {
    const seat = await db.prepare('SELECT id FROM team_seats WHERE id = ? AND owner_id = ?').get(parseInt(req.params.id), req.user.id);
    if (!seat) return res.status(404).json({ error: 'Seat not found' });
    await db.prepare('DELETE FROM team_seats WHERE id = ?').run(seat.id);
    res.json({ ok: true });
  } catch (e) {
    console.error('[team DELETE]', e.message);
    res.status(500).json({ error: 'Failed to remove seat' });
  }
});

module.exports = router;
