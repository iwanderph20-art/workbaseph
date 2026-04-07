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

// Seed some demo data if DB is empty
const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
if (userCount.count === 0) {
  const bcrypt = require('bcryptjs');
  const salt = bcrypt.genSaltSync(10);

  // Demo employer
  db.prepare(`INSERT INTO users (email, password, full_name, role, bio, location, is_verified) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run('employer@demo.com', bcrypt.hashSync('demo1234', salt), 'Maria Santos', 'employer', 'Tech startup founder looking for talented Filipino developers.', 'Manila, PH', 1);

  // Demo freelancer
  db.prepare(`INSERT INTO users (email, password, full_name, role, bio, skills, location, is_verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('freelancer@demo.com', bcrypt.hashSync('demo1234', salt), 'Juan dela Cruz', 'freelancer', 'Full-stack developer with 5 years of experience in React, Node.js, and PostgreSQL.', 'React,Node.js,TypeScript,PostgreSQL', 'Cebu, PH', 1);

  // Demo jobs
  const jobs = [
    [1, 'Full-Stack Web Developer', 'We are looking for an experienced full-stack developer to build our SaaS platform. Must have strong skills in React and Node.js.', 'Web Development', 'long_term', 'fixed', 30000, 60000, 'React,Node.js,PostgreSQL', 'Remote', 'open'],
    [1, 'UI/UX Designer', 'Seeking a creative UI/UX designer to revamp our mobile app. Experience with Figma required.', 'Design', 'gig', 'fixed', 20000, 40000, 'Figma,UI/UX,Mobile Design', 'Remote', 'open'],
    [1, 'Virtual Assistant', 'Need a reliable VA for 20 hours/week. Tasks include email management, scheduling, and data entry.', 'Admin Support', 'long_term', 'hourly', 150, 250, 'Email Management,Google Workspace,Communication', 'Remote', 'open'],
    [1, 'Social Media Manager', 'Looking for a social media expert to manage our Facebook, Instagram, and TikTok accounts.', 'Marketing', 'long_term', 'fixed', 15000, 25000, 'Facebook,Instagram,Content Creation,Copywriting', 'Remote', 'open'],
    [1, 'WordPress Developer', 'Need a WordPress expert to build a custom e-commerce website. WooCommerce experience required.', 'Web Development', 'gig', 'fixed', 25000, 45000, 'WordPress,WooCommerce,PHP,CSS', 'Hybrid', 'open'],
    [1, 'Video Editor', 'Seeking a skilled video editor for our YouTube channel. Must be proficient in Adobe Premiere Pro.', 'Creative', 'gig', 'hourly', 200, 400, 'Adobe Premiere,After Effects,Color Grading', 'Remote', 'open'],
  ];

  const insertJob = db.prepare(`INSERT INTO jobs (employer_id, title, description, category, engagement_type, budget_type, budget_min, budget_max, skills_required, location, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  jobs.forEach(job => insertJob.run(...job));
}

// ─── Migrations: add new columns to existing DBs safely ─────────────────────
const migrations = [
  "ALTER TABLE users ADD COLUMN talent_status TEXT DEFAULT 'pending'",
  "ALTER TABLE users ADD COLUMN admin_role TEXT DEFAULT NULL",
  "ALTER TABLE users ADD COLUMN hardware_specs TEXT DEFAULT ''",
  "ALTER TABLE users ADD COLUMN speedtest_url TEXT DEFAULT ''",
  "ALTER TABLE users ADD COLUMN video_loom_link TEXT DEFAULT ''",
  "ALTER TABLE users ADD COLUMN admin_notes TEXT DEFAULT ''",
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
