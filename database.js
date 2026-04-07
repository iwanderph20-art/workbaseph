const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'workbaseph.db'));

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('employer', 'freelancer')),
    bio TEXT DEFAULT '',
    skills TEXT DEFAULT '',
    location TEXT DEFAULT 'Philippines',
    profile_pic TEXT DEFAULT '',
    is_verified INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employer_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    category TEXT NOT NULL,
    engagement_type TEXT NOT NULL DEFAULT 'long_term' CHECK(engagement_type IN ('long_term', 'gig')),
    budget_type TEXT NOT NULL CHECK(budget_type IN ('fixed', 'hourly')),
    budget_min REAL NOT NULL,
    budget_max REAL NOT NULL,
    skills_required TEXT DEFAULT '',
    location TEXT DEFAULT 'Remote',
    status TEXT DEFAULT 'open' CHECK(status IN ('open', 'in_progress', 'closed')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(employer_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL,
    freelancer_id INTEGER NOT NULL,
    cover_letter TEXT DEFAULT '',
    proposed_rate REAL,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'accepted', 'rejected')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(job_id) REFERENCES jobs(id),
    FOREIGN KEY(freelancer_id) REFERENCES users(id),
    UNIQUE(job_id, freelancer_id)
  );

  CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reviewer_id INTEGER NOT NULL,
    reviewee_id INTEGER NOT NULL,
    job_id INTEGER NOT NULL,
    rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
    comment TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(reviewer_id) REFERENCES users(id),
    FOREIGN KEY(reviewee_id) REFERENCES users(id),
    FOREIGN KEY(job_id) REFERENCES jobs(id)
  );
`);

// No demo seed data — production database starts clean.

// ─── Migrations: add new columns to existing DBs safely ─────────────────────
const migrations = [
  "ALTER TABLE users ADD COLUMN talent_status TEXT DEFAULT 'pending'",
  "ALTER TABLE users ADD COLUMN admin_role TEXT DEFAULT NULL",
  "ALTER TABLE users ADD COLUMN hardware_specs TEXT DEFAULT ''",
  "ALTER TABLE users ADD COLUMN speedtest_url TEXT DEFAULT ''",
  "ALTER TABLE users ADD COLUMN video_loom_link TEXT DEFAULT ''",
  "ALTER TABLE users ADD COLUMN admin_notes TEXT DEFAULT ''",
  "ALTER TABLE users ADD COLUMN subscription_tier TEXT DEFAULT 'free'",
  "ALTER TABLE users ADD COLUMN subscription_expires_at DATETIME DEFAULT NULL",
  "ALTER TABLE users ADD COLUMN stripe_customer_id TEXT DEFAULT NULL",
  "ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT DEFAULT NULL",
];
for (const sql of migrations) {
  try { db.exec(sql); } catch (_) { /* column already exists */ }
}

// Set existing freelancers to standard_marketplace if still on default 'pending'
// (only touches rows where talent_status is NULL, which happens on first migration)
db.prepare(`
  UPDATE users SET talent_status = 'standard_marketplace'
  WHERE role = 'freelancer' AND (talent_status IS NULL OR talent_status = '')
`).run();

// ─── Seed Super Admin if none exists ────────────────────────────────────────
const adminExists = db.prepare("SELECT id FROM users WHERE admin_role = 'super_admin'").get();
if (!adminExists) {
  const bcrypt = require('bcryptjs');
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@workbaseph.com';
  const adminPassword = process.env.ADMIN_PASSWORD || 'WorkBasePH@2026!';
  const already = db.prepare('SELECT id FROM users WHERE email = ?').get(adminEmail);
  if (!already) {
    db.prepare(
      "INSERT INTO users (email, password, full_name, role, admin_role, talent_status) VALUES (?, ?, ?, ?, ?, NULL)"
    ).run(adminEmail, bcrypt.hashSync(adminPassword, 10), 'Eunice (Super Admin)', 'employer', 'super_admin');
    console.log(`\n👑 Super Admin seeded: ${adminEmail} / ${adminPassword}`);
    console.log('   Set ADMIN_EMAIL and ADMIN_PASSWORD in Railway env vars to customise.\n');
  }
}

module.exports = db;
