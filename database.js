const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

// Railway injects DATABASE_URL automatically when you add a Postgres service
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// ─── Compatibility shim ───────────────────────────────────────────────────────
// Mimics the better-sqlite3 synchronous API but returns Promises.
// All callers must use `await db.prepare(...).get/all/run(...)`.
function prepare(sql) {
  // Convert SQLite ? placeholders → PostgreSQL $1, $2, ...
  let i = 0;
  const pgSql = sql.replace(/\?/g, () => `$${++i}`);

  return {
    async get(...args) {
      const params = args.flat();
      const { rows } = await pool.query(pgSql, params);
      return rows[0] || null;
    },
    async all(...args) {
      const params = args.flat();
      const { rows } = await pool.query(pgSql, params);
      return rows;
    },
    async run(...args) {
      const params = args.flat();
      const isInsert = pgSql.trim().toUpperCase().startsWith('INSERT');
      if (isInsert && !pgSql.toUpperCase().includes('RETURNING')) {
        const { rows } = await pool.query(pgSql + ' RETURNING id', params);
        return { lastInsertRowid: rows[0]?.id || null, changes: rows.length };
      }
      const result = await pool.query(pgSql, params);
      return { changes: result.rowCount, lastInsertRowid: null };
    },
  };
}

async function exec(sql) {
  const statements = sql.split(';').map(s => s.trim()).filter(Boolean);
  for (const stmt of statements) {
    await pool.query(stmt);
  }
}

// ─── Schema creation ──────────────────────────────────────────────────────────
async function initializeDatabase() {
  // Core tables
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('employer', 'freelancer')),
      bio TEXT DEFAULT '',
      skills TEXT DEFAULT '',
      location TEXT DEFAULT 'Philippines',
      profile_pic TEXT DEFAULT '',
      is_verified INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS jobs (
      id SERIAL PRIMARY KEY,
      employer_id INTEGER NOT NULL REFERENCES users(id),
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
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS applications (
      id SERIAL PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES jobs(id),
      freelancer_id INTEGER NOT NULL REFERENCES users(id),
      cover_letter TEXT DEFAULT '',
      proposed_rate REAL,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'accepted', 'rejected')),
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(job_id, freelancer_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS reviews (
      id SERIAL PRIMARY KEY,
      reviewer_id INTEGER NOT NULL REFERENCES users(id),
      reviewee_id INTEGER NOT NULL REFERENCES users(id),
      job_id INTEGER NOT NULL REFERENCES jobs(id),
      rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
      comment TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // ─── Migrations: safely add new columns (IF NOT EXISTS = no crash on re-deploy)
  const migrations = [
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS talent_status TEXT DEFAULT 'pending'",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_role TEXT DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS hardware_specs TEXT DEFAULT ''",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS speedtest_url TEXT DEFAULT ''",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS video_loom_link TEXT DEFAULT ''",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_notes TEXT DEFAULT ''",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_tier TEXT DEFAULT 'free'",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMP DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS resume_file TEXT DEFAULT ''",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS specs_image TEXT DEFAULT ''",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS speedtest_image TEXT DEFAULT ''",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS detected_ram TEXT DEFAULT ''",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS detected_cpu TEXT DEFAULT ''",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS detected_speed_down TEXT DEFAULT ''",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS detected_speed_up TEXT DEFAULT ''",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_tier_recommendation TEXT DEFAULT ''",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_summary TEXT DEFAULT ''",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS pre_screen_status TEXT DEFAULT 'pending'",
  ];
  for (const sql of migrations) {
    await pool.query(sql);
  }

  // Set existing freelancers without a status to standard_marketplace
  await pool.query(`
    UPDATE users SET talent_status = 'standard_marketplace'
    WHERE role = 'freelancer' AND (talent_status IS NULL OR talent_status = '')
  `);

  // ─── Seed Super Admin if none exists ────────────────────────────────────────
  const { rows: adminRows } = await pool.query("SELECT id FROM users WHERE admin_role = 'super_admin' LIMIT 1");
  if (!adminRows[0]) {
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@workbaseph.com';
    const adminPassword = process.env.ADMIN_PASSWORD || 'WorkBasePH@2026!';
    const { rows: existing } = await pool.query('SELECT id FROM users WHERE email = $1', [adminEmail]);
    if (!existing[0]) {
      await pool.query(
        "INSERT INTO users (email, password, full_name, role, admin_role, talent_status) VALUES ($1, $2, $3, 'employer', 'super_admin', NULL)",
        [adminEmail, bcrypt.hashSync(adminPassword, 10), 'Eunice (Super Admin)']
      );
      console.log(`\n👑 Super Admin seeded: ${adminEmail} / ${adminPassword}`);
      console.log('   Set ADMIN_EMAIL and ADMIN_PASSWORD in Railway env vars to customise.\n');
    }
  }

  console.log('✅ PostgreSQL database ready');
}

// Run init when module is first loaded; server won't start until this resolves
initializeDatabase().catch(err => {
  console.error('❌ Database initialisation failed:', err.message);
  process.exit(1);
});

module.exports = { prepare, exec, pool };
