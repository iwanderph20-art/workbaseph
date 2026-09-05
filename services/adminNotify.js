const { pool } = require('../database');

// Fan an in-app notification out to every reviewer-facing admin (super_admin +
// reviewer_admin — NOT services_admin, who works out of admin-leads.html and
// isn't part of this employer-activity feed). Reuses the existing
// `notifications` table/API (routes/notifications.js) — admins are just
// regular `users` rows, so no new storage or endpoints are needed.
async function notifyAdmins(type, title, body, data) {
  try {
    const { rows } = await pool.query(
      `SELECT id FROM users WHERE admin_role IN ('super_admin', 'reviewer_admin')`
    );
    for (const { id } of rows) {
      await pool.query(
        `INSERT INTO notifications (user_id, type, title, body, data) VALUES ($1,$2,$3,$4,$5)`,
        [id, type, title, body, JSON.stringify(data || {})]
      );
    }
  } catch (e) {
    console.error('[notifyAdmins]', e.message);
  }
}

module.exports = { notifyAdmins };
