// One-time script: send profile completion reminder to all freelancers with incomplete profiles.
// Run: node send-profile-reminders.js
require('dotenv').config();

const { Pool } = require('pg');
const { sendEmail, profileCompletionReminderEmail } = require('./services/email');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function run() {
  const { rows: specialists } = await pool.query(`
    SELECT id, email, full_name
    FROM users
    WHERE role = 'freelancer'
      AND (
        skills IS NULL OR TRIM(skills) = ''
        OR video_loom_link IS NULL OR TRIM(video_loom_link) = ''
        OR speedtest_url IS NULL OR TRIM(speedtest_url) = ''
        OR personality_type IS NULL
      )
  `);

  console.log(`Found ${specialists.length} specialists with incomplete profiles.`);

  let sent = 0;
  const errors = [];

  for (const user of specialists) {
    try {
      await sendEmail({ to: user.email, ...profileCompletionReminderEmail(user.full_name) });
      console.log(`  ✓ Sent to ${user.email}`);
      sent++;
    } catch (err) {
      console.error(`  ✗ Failed for ${user.email}: ${err.message}`);
      errors.push(user.email);
    }
  }

  console.log(`\nDone. Sent: ${sent} / ${specialists.length}`);
  if (errors.length) console.log(`Failed: ${errors.join(', ')}`);

  await pool.end();
  process.exit(0);
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  pool.end();
  process.exit(1);
});
