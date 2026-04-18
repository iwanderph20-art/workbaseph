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
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS sleek_profile TEXT DEFAULT ''",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS client_brief TEXT DEFAULT ''",

    // ── Employer Verification System ──
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS employer_type TEXT DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS trust_score INTEGER DEFAULT 0",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS employer_verification_status TEXT DEFAULT 'unverified'",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS payment_method_added INTEGER DEFAULT 0",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_business_verified INTEGER DEFAULT 0",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS post_credits INTEGER DEFAULT 0",

    // ── Application Transparency ──
    "ALTER TABLE applications ADD COLUMN IF NOT EXISTS viewed_at TIMESTAMP DEFAULT NULL",
    "ALTER TABLE applications ADD COLUMN IF NOT EXISTS shortlisted_at TIMESTAMP DEFAULT NULL",
    "ALTER TABLE applications ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMP DEFAULT NULL",

    // ── Job Seeding ──
    "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS job_type TEXT DEFAULT 'REAL'",
    "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS is_seeded INTEGER DEFAULT 0",

    // ── Employer Plan ──
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS employer_plan TEXT DEFAULT 'standard'",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS elite_brief TEXT DEFAULT NULL",

    // ── Personality Assessment ──
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS personality_type TEXT DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS personality_badge TEXT DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS personality_scores TEXT DEFAULT NULL",

    // ── Top-tier badge ──
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_top_tier INTEGER DEFAULT 0",

    // ── Interview scheduling extras ──
    "ALTER TABLE interview_requests ADD COLUMN IF NOT EXISTS employer_timezone TEXT DEFAULT 'UTC'",
    "ALTER TABLE interview_requests ADD COLUMN IF NOT EXISTS employer_message TEXT DEFAULT ''",

    // ── Talent document uploads ──
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS certifications_url TEXT DEFAULT ''",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS reference_letter_url TEXT DEFAULT ''",

    // ── AI Candidate Audits ──
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_audit_uses_month INTEGER DEFAULT 0",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_audit_month TEXT DEFAULT NULL",
    "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS ai_audit_unlocked INTEGER DEFAULT 0",
    "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS ai_audit_completed_at TIMESTAMP DEFAULT NULL",
    "ALTER TABLE applications ADD COLUMN IF NOT EXISTS ai_mismatch_reason TEXT DEFAULT NULL",

    // ── Gamified Talent Signup Fields ──
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS professional_level TEXT DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS education_level TEXT DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS work_schedule TEXT DEFAULT NULL",

    // ── Extended Talent Questionnaire Fields ──
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS hourly_rate_range TEXT DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS weekly_availability TEXT DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS start_availability TEXT DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS equipment TEXT DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS internet_speed TEXT DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS connection_type TEXT DEFAULT NULL",

    // ── Gamified Post-Job Fields ──
    "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS project_type TEXT DEFAULT NULL",
    "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS time_commitment TEXT DEFAULT NULL",
    "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS communication_style TEXT DEFAULT NULL",
    "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS experience_level TEXT DEFAULT NULL",
    "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS degree_required TEXT DEFAULT NULL",
    "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS certifications TEXT DEFAULT NULL",
    "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS hiring_urgency TEXT DEFAULT NULL",
    "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS triage_status TEXT DEFAULT 'pending'",
    "ALTER TABLE interview_requests ADD COLUMN IF NOT EXISTS cancel_reason TEXT DEFAULT NULL",

    // ── Talent Profile – Job Title / Specialty ──
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS job_title TEXT DEFAULT NULL",

    // ── Vetting notes (admin feedback shown to talent) ──
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS vetting_notes TEXT DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS vetting_submitted_at TIMESTAMP DEFAULT NULL",

    // ── Profile completion drip email tracking ──
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS drip_d1_sent INTEGER DEFAULT 0",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS drip_d3_sent INTEGER DEFAULT 0",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS drip_d7_sent INTEGER DEFAULT 0",

    // ── Employer access gate (1 = allowed, 0 = payment required) ──
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS employer_access INTEGER DEFAULT 0",

    // ── Job context on direct messages ──
    "ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS job_id INTEGER DEFAULT NULL",

    // ── Interview day-of reminder tracking ──
    "ALTER TABLE interview_requests ADD COLUMN IF NOT EXISTS interview_reminder_sent INTEGER DEFAULT 0",
  ];
  for (const sql of migrations) {
    await pool.query(sql);
  }

  // Fix job status check to include 'paused'
  await pool.query(`ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status_check`).catch(() => {});
  await pool.query(`
    ALTER TABLE jobs ADD CONSTRAINT IF NOT EXISTS jobs_status_check
    CHECK (status IN ('open', 'in_progress', 'closed', 'paused'))
  `).catch(() => {});

  // Fix application status check to include viewed/shortlisted
  await pool.query(`
    ALTER TABLE applications DROP CONSTRAINT IF EXISTS applications_status_check
  `).catch(() => {});
  await pool.query(`
    ALTER TABLE applications ADD CONSTRAINT IF NOT EXISTS applications_status_check
    CHECK (status IN ('pending','viewed','shortlisted','accepted','rejected'))
  `).catch(() => {});

  // ── Employer Documents table ──────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS employer_documents (
      id SERIAL PRIMARY KEY,
      employer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      doc_type TEXT NOT NULL,
      file_path TEXT NOT NULL,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
      admin_notes TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW(),
      reviewed_at TIMESTAMP DEFAULT NULL
    )
  `);

  // ── Community tables ──────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_posts (
      id SERIAL PRIMARY KEY,
      author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'General',
      upvotes INTEGER DEFAULT 0,
      is_flagged INTEGER DEFAULT 0,
      is_removed INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_comments (
      id SERIAL PRIMARY KEY,
      post_id INTEGER NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
      author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      is_best_answer INTEGER DEFAULT 0,
      is_flagged INTEGER DEFAULT 0,
      is_removed INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_upvotes (
      id SERIAL PRIMARY KEY,
      post_id INTEGER NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(post_id, user_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_bookmarks (
      id SERIAL PRIMARY KEY,
      post_id INTEGER NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(post_id, user_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_reports (
      id SERIAL PRIMARY KEY,
      content_type TEXT NOT NULL CHECK(content_type IN ('post','comment')),
      content_id INTEGER NOT NULL,
      reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reason TEXT DEFAULT '',
      status TEXT DEFAULT 'open' CHECK(status IN ('open','resolved','dismissed')),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // ── Talent Pool (pipeline jobs) ───────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS talent_pool (
      id SERIAL PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      freelancer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(job_id, freelancer_id)
    )
  `);

  // ── Job Triage & AI Match tables ─────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS job_matches (
      id SERIAL PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      talent_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      match_score REAL DEFAULT 0,
      matched_skills TEXT,
      status TEXT DEFAULT 'suggested',
      pushed_at TIMESTAMP DEFAULT NULL,
      interview_requested_at TIMESTAMP DEFAULT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(job_id, talent_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS job_triage (
      id SERIAL PRIMARY KEY,
      job_id INTEGER NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
      status TEXT DEFAULT 'pending',
      ai_extracted_skills TEXT,
      ai_experience_required TEXT,
      triaged_at TIMESTAMP DEFAULT NULL,
      triaged_by INTEGER REFERENCES users(id) ON DELETE SET NULL
    )
  `);

  // Notifications / Inbox
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT DEFAULT '',
      data TEXT DEFAULT '{}',
      is_read INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // HitPay payment requests
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hitpay_requests (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      plan TEXT NOT NULL,
      reference TEXT UNIQUE,
      payment_request_id TEXT,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Employer talent tracking
  await pool.query(`
    CREATE TABLE IF NOT EXISTS employer_talent_tracking (
      id SERIAL PRIMARY KEY,
      employer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      talent_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(employer_id, talent_id)
    )
  `);

  // ── Employer talent pipeline (kanban) ─────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS employer_pipeline (
      id SERIAL PRIMARY KEY,
      employer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      talent_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      stage TEXT NOT NULL DEFAULT 'saved',
      notes TEXT DEFAULT '',
      job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
      hired_at TIMESTAMP DEFAULT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(employer_id, talent_id)
    )
  `);
  // Migrate stage CHECK constraint to support extended pipeline stages
  await pool.query(`ALTER TABLE employer_pipeline DROP CONSTRAINT IF EXISTS employer_pipeline_stage_check`).catch(()=>{});
  await pool.query(`
    ALTER TABLE employer_pipeline ADD CONSTRAINT employer_pipeline_stage_check
    CHECK(stage IN (
      'application_submitted','under_review','interview_stage','hired','archived',
      'saved','reviewing','interviewing','interviewed','reject','not_a_fit','applications','passed'
    ))
  `).catch(()=>{});

  // ── Reviews: add is_public flag ──────────────────────────────────────────────
  await pool.query(`ALTER TABLE reviews ADD COLUMN IF NOT EXISTS is_public INTEGER DEFAULT 1`);

  // Interview requests
  await pool.query(`
    CREATE TABLE IF NOT EXISTS interview_requests (
      id SERIAL PRIMARY KEY,
      employer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      talent_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      slot1 TIMESTAMP NOT NULL,
      slot2 TIMESTAMP NOT NULL,
      selected_slot TEXT DEFAULT NULL,
      jitsi_link TEXT DEFAULT NULL,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Direct messages between employers and candidates
  await pool.query(`
    CREATE TABLE IF NOT EXISTS direct_messages (
      id SERIAL PRIMARY KEY,
      sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      is_read INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_dm_receiver ON direct_messages(receiver_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_dm_thread ON direct_messages(sender_id, receiver_id)`);

  // Set existing freelancers without a status to standard_marketplace
  await pool.query(`
    UPDATE users SET talent_status = 'standard_marketplace'
    WHERE role = 'freelancer' AND (talent_status IS NULL OR talent_status = '')
  `);

  // ─── Seed test employer: hello@bayanco.org ────────────────────────────────────
  // This account has employer_access = 1 so it can bypass the payment gate for testing
  {
    const TEST_EMAIL = 'hello@bayanco.org';
    const TEST_PASS  = process.env.BAYANCO_PASSWORD || 'BayancoTest2026!';
    const { rows: existing } = await pool.query('SELECT id, employer_access FROM users WHERE email = $1', [TEST_EMAIL]);
    if (!existing[0]) {
      await pool.query(
        "INSERT INTO users (email, password, full_name, role, employer_access, employer_plan) VALUES ($1, $2, $3, 'employer', 1, 'standard')",
        [TEST_EMAIL, bcrypt.hashSync(TEST_PASS, 10), 'Bayanco (Test Employer)']
      );
      console.log(`\n🧪 Test employer seeded: ${TEST_EMAIL} / ${TEST_PASS}\n`);
    } else if (!existing[0].employer_access) {
      // If account already exists but access wasn't granted, grant it now
      await pool.query("UPDATE users SET employer_access = 1 WHERE email = $1", [TEST_EMAIL]);
      console.log(`\n🧪 Test employer access granted: ${TEST_EMAIL}\n`);
    }
  }

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
