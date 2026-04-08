const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'workbaseph_secret_2026';

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
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

module.exports = { authenticateToken, requireAdmin, requireSuperAdmin, JWT_SECRET };
