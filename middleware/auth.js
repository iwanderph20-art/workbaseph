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

// Marketplace admin panel (admin.html) roles — deliberately an explicit whitelist,
// not "any truthy admin_role", so a narrower role added later (e.g. services_admin,
// scoped only to admin-leads.html) can never accidentally pass this gate.
const MARKETPLACE_ADMIN_ROLES = ['super_admin', 'reviewer_admin'];

// The main $29-marketplace admin panel (admin.html) and everything requireAdmin/
// requireSuperAdmin gate (employer-verification.js, community.js, triage.js,
// jobs.js, admin.js) is restricted to this ONE account — confirmed with the user
// that no other admin accounts currently rely on these routes. Any reviewer_admin
// account created via admin.html's "Add Reviewer Admin" flow can no longer log
// into admin.html itself; that flow now only makes sense for other purposes, if
// any (it does NOT affect services_admin — see requireServicesAccess below, which
// deliberately does not apply this email check).
const MAIN_ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@workbaseph.com').toLowerCase();

// Requires super_admin/reviewer_admin AND the single allowed email — grants access to admin.html
function requireAdmin(req, res, next) {
  authenticateToken(req, res, async () => {
    try {
      const db = require('../database');
      const user = await db.prepare('SELECT admin_role, email FROM users WHERE id = ?').get(req.user.id);
      if (!user || !MARKETPLACE_ADMIN_ROLES.includes(user.admin_role) || (user.email || '').toLowerCase() !== MAIN_ADMIN_EMAIL) {
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

// Requires super_admin AND the single allowed email
function requireSuperAdmin(req, res, next) {
  authenticateToken(req, res, async () => {
    try {
      const db = require('../database');
      const user = await db.prepare('SELECT admin_role, email FROM users WHERE id = ?').get(req.user.id);
      if (!user || user.admin_role !== 'super_admin' || (user.email || '').toLowerCase() !== MAIN_ADMIN_EMAIL) {
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

// Scoped access for public/admin-leads.html ONLY (founder-services + DFY leads,
// forms, and accounting) — deliberately separate from requireAdmin. A
// `services_admin` account passes this gate but NEVER requireAdmin/requireSuperAdmin,
// so it can use admin-leads.html but has zero access — not even via a direct API
// call — to admin.html's marketplace data (employers, applicants, feedback, etc.).
// Existing super_admin/reviewer_admin accounts pass this too, so nothing already
// working for them changes.
const SERVICES_ADMIN_ROLES = ['super_admin', 'reviewer_admin', 'services_admin'];

function requireServicesAccess(req, res, next) {
  authenticateToken(req, res, async () => {
    try {
      const db = require('../database');
      const user = await db.prepare('SELECT admin_role FROM users WHERE id = ?').get(req.user.id);
      if (!user || !SERVICES_ADMIN_ROLES.includes(user.admin_role)) {
        return res.status(403).json({ error: 'Admin access required' });
      }
      req.adminRole = user.admin_role;
      next();
    } catch (err) {
      console.error('[requireServicesAccess] DB error:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });
}

module.exports = { authenticateToken, optionalAuth, requireAdmin, requireSuperAdmin, requireServicesAccess, JWT_SECRET };
