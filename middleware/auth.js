const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'workbaseph_secret_2026';

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, async (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    // Team-seat tokens carry the owner's id plus a seat_id. Confirm the seat still exists so
    // a removed seat loses access immediately instead of lingering until the token expires.
    // Only seat tokens pay this lookup; ordinary owner/user tokens are unaffected.
    if (user && user.seat_id) {
      try {
        const db = require('../database');
        const seat = await db.prepare('SELECT id FROM team_seats WHERE id = ? AND owner_id = ?').get(user.seat_id, user.id);
        if (!seat) return res.status(403).json({ error: 'This team seat has been removed' });
      } catch (e) {
        console.error('[auth] seat check failed:', e.message);
        return res.status(500).json({ error: 'Server error' });
      }
    }
    req.user = user;
    next();
  });
}

// Optional auth: populates req.user when a valid token is present, but never rejects
// anonymous callers. Used by public endpoints that return richer data (e.g. the real
// employer identity) to logged-in users while masking it for the public.
function optionalAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return next(); // anonymous — proceed with req.user undefined

  jwt.verify(token, JWT_SECRET, async (err, user) => {
    if (err) return next(); // bad/expired token — treat as anonymous, don't 403
    if (user && user.seat_id) {
      try {
        const db = require('../database');
        const seat = await db.prepare('SELECT id FROM team_seats WHERE id = ? AND owner_id = ?').get(user.seat_id, user.id);
        if (!seat) return next(); // removed seat — treat as anonymous
      } catch (e) {
        console.error('[optionalAuth] seat check failed:', e.message);
        return next();
      }
    }
    req.user = user;
    next();
  });
}

// Requires either super_admin or reviewer_admin
function requireAdmin(req, res, next) {
  authenticateToken(req, res, async () => {
    try {
      const db = require('../database');
      const user = await db.prepare('SELECT admin_role FROM users WHERE id = ?').get(req.user.id);
      if (!user || !user.admin_role) {
        return res.status(403).json({ error: 'Admin access required' });
      }
      req.adminRole = user.admin_role;
      next();
    } catch (err) {
      console.error('[requireAdmin] DB error:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });
}

// Requires super_admin only
function requireSuperAdmin(req, res, next) {
  authenticateToken(req, res, async () => {
    try {
      const db = require('../database');
      const user = await db.prepare('SELECT admin_role FROM users WHERE id = ?').get(req.user.id);
      if (!user || user.admin_role !== 'super_admin') {
        return res.status(403).json({ error: 'Super admin access required' });
      }
      req.adminRole = 'super_admin';
      next();
    } catch (err) {
      console.error('[requireSuperAdmin] DB error:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });
}

module.exports = { authenticateToken, optionalAuth, requireAdmin, requireSuperAdmin, JWT_SECRET };
