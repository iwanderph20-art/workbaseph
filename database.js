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
    // Grandfather flag: employers existing before the 2026-07 plan restructure keep the old
    // Starter rules (2 credits, in-app messaging/interviews, no applicant lock). New employers
    // default FALSE and are subject to the new Starter rules. Backfilled once below.
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS starter_legacy BOOLEAN DEFAULT FALSE",

    // ── Personality Assessment ──
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS personality_type TEXT DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS personality_badge TEXT DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS personality_scores TEXT DEFAULT NULL",

    // ── Top-tier badge ──
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_top_tier INTEGER DEFAULT 0",

    // ── Interview scheduling extras ──
    "ALTER TABLE interview_requests ADD COLUMN IF NOT EXISTS employer_timezone TEXT DEFAULT 'UTC'",
    "ALTER TABLE interview_requests ADD COLUMN IF NOT EXISTS employer_message TEXT DEFAULT ''",
    // Recorded outcome for a scheduled interview: 'happened' | 'no_show' | NULL (unset),
    // plus an optional free-text note from the employer/admin.
    "ALTER TABLE interview_requests ADD COLUMN IF NOT EXISTS outcome TEXT DEFAULT NULL",
    "ALTER TABLE interview_requests ADD COLUMN IF NOT EXISTS outcome_note TEXT DEFAULT NULL",

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
    // How many people the employer wants to hire for this role (openings). Defaults to 1.
    "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS number_of_hires INTEGER DEFAULT 1",
    "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS company_website TEXT DEFAULT NULL",
    "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS company_description TEXT DEFAULT NULL",
    // Timezone the specialist must work in (e.g. US_PST) and the employer's country — both shown on the job post.
    "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS work_timezone TEXT DEFAULT NULL",
    "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS employer_country TEXT DEFAULT NULL",
    "ALTER TABLE applications ADD COLUMN IF NOT EXISTS application_video_link TEXT DEFAULT NULL",
    "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS triage_status TEXT DEFAULT 'pending'",
    // Admin can archive a job out of the Job Triage list (e.g. once the employer has hired)
    // without closing it on the employer's side.
    "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS admin_archived BOOLEAN DEFAULT FALSE",
    // Employer's optional "nice-to-have" skills (in addition to skills_required) — used
    // as a RELATED (lower-weight) signal in matching.
    "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS nice_to_have_skills TEXT DEFAULT ''",
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

    // ── Password reset ──
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_token TEXT DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_expires_at TIMESTAMP DEFAULT NULL",

    // ── Contact reply tracking ──
    "ALTER TABLE contact_submissions ADD COLUMN IF NOT EXISTS replied_at TIMESTAMP DEFAULT NULL",
    "ALTER TABLE contact_submissions ADD COLUMN IF NOT EXISTS reply_message TEXT DEFAULT NULL",

    // ── Subscription cancellation timestamp ──
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_cancelled_at TIMESTAMP DEFAULT NULL",

    // ── Subscription cancellation reason ──
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_cancel_reason TEXT DEFAULT NULL",

    // ── Admin last-seen timestamps for sidebar dot suppression ──
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_seen_employers_at TIMESTAMP DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_seen_jobs_at TIMESTAMP DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_seen_talent_at TIMESTAMP DEFAULT NULL",

    // ── Talent ID code (T-XXXX) ──
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS talent_code TEXT DEFAULT NULL",

    // ── Auto-pause open jobs when an employer's subscription lapses (1 = paused by system, restored on renewal) ──
    "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS auto_paused INTEGER DEFAULT 0",

    // ── Starter (pay-per-post) listings run for 30 days, then auto-pause. Subscription
    //    posts leave this NULL (they're governed by the employer's subscription_expires_at). ──
    "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP DEFAULT NULL",
    // Tracks whether the T-3-day "listing expiring" reminder has been sent for the current expiry.
    "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS expiry_reminder_sent INTEGER DEFAULT 0",

    // ── T-3-day renewal reminder: stores the expiry the reminder was sent for, so it auto-resets on renewal ──
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS renewal_reminder_expiry TIMESTAMP DEFAULT NULL",

    // ── PayPal recurring subscription id (for renewal webhooks + cancellation) ──
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS paypal_subscription_id TEXT DEFAULT NULL",

    // ── Admin "new employer signup" report is sent once, after the employer finishes
    //    signup (picks a plan), so the report can name the plan. This stamps when it went. ──
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_signup_notified_at TIMESTAMP DEFAULT NULL",

    // ── Talent finished the signup questionnaire. Gates the welcome email so it fires
    //    once, on completion — never at account creation, mid-signup. ──
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_completed_at TIMESTAMP DEFAULT NULL",

    // ── "Where did you hear about us?" (employer signup attribution) ──
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_source TEXT DEFAULT NULL",
  ];

  // ── Contact form submissions ──────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contact_submissions (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      role TEXT DEFAULT '',
      subject TEXT NOT NULL,
      message TEXT NOT NULL,
      submitted_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // ── Payment records table ─────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payment_records (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan TEXT NOT NULL,
      plan_label TEXT NOT NULL,
      amount_usd TEXT NOT NULL,
      paypal_order_id TEXT DEFAULT NULL,
      job_id INTEGER DEFAULT NULL,
      paid_at TIMESTAMP DEFAULT NOW()
    )
  `);

  for (const sql of migrations) {
    await pool.query(sql);
  }

  // One-time grandfather backfill: every employer that existed before the 2026-07 plan
  // restructure keeps the old Starter rules. New employers (created after this runs) default
  // to starter_legacy = FALSE via the column default and get the new rules. Idempotent: once
  // rows are TRUE, re-running is a harmless no-op; new rows are never flipped by it.
  await pool.query(`
    UPDATE users SET starter_legacy = TRUE
    WHERE role = 'employer' AND starter_legacy = FALSE AND created_at < '2026-07-28'
  `).catch(() => {});

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

  // ── Employer applicant profile views (admin activity signal) ──────────────────
  // Records each time an employer opens an applicant's profile for a job, so the
  // admin Job Triage can show the employer is actively reviewing candidates.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS employer_profile_views (
      id SERIAL PRIMARY KEY,
      employer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      talent_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
      view_count INTEGER NOT NULL DEFAULT 1,
      first_viewed_at TIMESTAMP DEFAULT NOW(),
      last_viewed_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(employer_id, talent_id, job_id)
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

  // ── Hired flow: testimonial follow-up tracking ───────────────────────────────
  await pool.query(`ALTER TABLE employer_pipeline ADD COLUMN IF NOT EXISTS testimonial_follow_up_sent INTEGER DEFAULT 0`);

  // ── Job codes: permanent unique human-readable ID per job post ────────────────
  await pool.query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS job_code TEXT DEFAULT NULL`);
  // Backfill existing jobs that have no code: initials from employer name + zero-padded job ID
  await pool.query(`
    UPDATE jobs SET job_code = (
      SELECT UPPER(
        REGEXP_REPLACE(
          LEFT(
            ARRAY_TO_STRING(
              ARRAY(SELECT LEFT(word,1) FROM UNNEST(STRING_TO_ARRAY(TRIM(u.full_name), ' ')) AS word WHERE word <> ''),
              ''
            ),
            3
          ),
          '[^A-Z]', '', 'g'
        )
      ) || '-' || LPAD(jobs.id::TEXT, 4, '0')
      FROM users u WHERE u.id = jobs.employer_id
    )
    WHERE job_code IS NULL
  `).catch(err => console.error('[job_code backfill]', err.message));

  // ── Reviews: add is_public flag ──────────────────────────────────────────────
  await pool.query(`ALTER TABLE reviews ADD COLUMN IF NOT EXISTS is_public INTEGER DEFAULT 1`);

  // ── Featured listings ────────────────────────────────────────────────────────
  await pool.query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS featured_until TIMESTAMP DEFAULT NULL`);

  // ── Payment tracking ──────────────────────────────────────────────────────────
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS paymongo_payment_id TEXT DEFAULT NULL`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS paypal_order_id TEXT DEFAULT NULL`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_auto_renew INTEGER DEFAULT 1`);

  // ── Talent Pool Access add-on ─────────────────────────────────────────────────
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS talent_pool_access INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS talent_pool_expires_at TIMESTAMP DEFAULT NULL`);

  // ── Referral program ─────────────────────────────────────────────────────────
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT DEFAULT NULL`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by TEXT DEFAULT NULL`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_credits INTEGER DEFAULT 0`);
  // Backfill existing users without a referral code
  await pool.query(`
    UPDATE users SET referral_code = UPPER(SUBSTRING(MD5(id::TEXT || email), 1, 8))
    WHERE referral_code IS NULL
  `).catch(err => console.error('[referral_code backfill]', err.message));

  // Interview requests
  await pool.query(`ALTER TABLE interview_requests ADD COLUMN IF NOT EXISTS job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL`).catch(()=>{});
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

  // Employer feedback — collected any time (not tied to a hire), to improve the service.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS employer_feedback (
      id SERIAL PRIMARY KEY,
      employer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      did_hire BOOLEAN DEFAULT NULL,
      rating INTEGER DEFAULT NULL,
      message TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

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

  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS website_url TEXT DEFAULT NULL`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS account_paused BOOLEAN DEFAULT FALSE`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS account_paused_at TIMESTAMPTZ DEFAULT NULL`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS account_delete_requested_at TIMESTAMPTZ DEFAULT NULL`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS account_delete_reason TEXT DEFAULT NULL`);
  // When an admin sent the "your profile is incomplete" final-warning email
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS incomplete_warning_sent_at TIMESTAMPTZ DEFAULT NULL`);

  // ── Backfill talent_code for existing freelancers who don't have one yet ──
  const { rows: uncodedTalent } = await pool.query(
    `SELECT id FROM users WHERE role = 'freelancer' AND (talent_code IS NULL OR talent_code = '')`
  );
  for (const { id } of uncodedTalent) {
    const code = `T-${String(id).padStart(4, '0')}`;
    await pool.query(`UPDATE users SET talent_code = $1 WHERE id = $2`, [code, id]);
  }
  if (uncodedTalent.length > 0) {
    console.log(`✅ Backfilled talent_code for ${uncodedTalent.length} freelancer(s)`);
  }

  // ── Retire the vetting-gate statuses ──
  // Freelancers are live in the marketplace by default now; the old approval tiers
  // (standard_marketplace / elite_candidate / pending) no longer gate visibility, so
  // clear them to NULL. Terminal states (hired / denied / self_deleted) are preserved.
  const { rowCount: clearedTiers } = await pool.query(
    `UPDATE users SET talent_status = NULL
      WHERE role = 'freelancer'
        AND talent_status IN ('standard_marketplace','elite_candidate','pending')`
  );
  if (clearedTiers > 0) {
    console.log(`✅ Cleared legacy vetting tier on ${clearedTiers} freelancer(s)`);
  }

  console.log('✅ PostgreSQL database ready');
}

// Run init when module is first loaded; server won't start until this resolves
initializeDatabase().catch(err => {
  console.error('❌ Database initialisation failed:', err.message);
  process.exit(1);
});

module.exports = { prepare, exec, pool };
