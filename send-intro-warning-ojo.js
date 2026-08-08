// One-off: warn Daniel Olamiposi Ojo (id 158) that his profile's introduction
// video appears to feature someone other than him, and must be replaced with a
// genuine recording of himself.
//
// SAFETY: dry-run by default — writes a preview and prints the target, sends
// nothing. Re-run with --send to actually deliver.
//   node send-intro-warning-ojo.js            # preview only, no email sent
//   node send-intro-warning-ojo.js --send      # send the warning to Daniel
require('dotenv').config();

const fs = require('fs');
const { Pool } = require('pg');
const { sendEmail, introNotYouWarningEmail } = require('./services/email');

const SEND = process.argv.includes('--send');
const TARGET_ID = 158; // Daniel Olamiposi Ojo

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function run() {
  const { rows } = await pool.query(
    `SELECT id, full_name, email, video_loom_link FROM users WHERE id = $1 AND role = 'freelancer'`,
    [TARGET_ID]
  );
  const user = rows[0];
  if (!user) { console.error(`Talent id ${TARGET_ID} not found.`); process.exit(1); }

  const mail = introNotYouWarningEmail(user.full_name, user.video_loom_link);
  console.log(`Target : ${user.full_name} <${user.email}>`);
  console.log(`Intro  : ${user.video_loom_link}`);
  console.log(`Subject: ${mail.subject}`);

  if (!SEND) {
    fs.writeFileSync('intro-warning-ojo.preview.html', mail.html);
    console.log('\nDRY RUN — no email sent. Preview written to intro-warning-ojo.preview.html');
    console.log('Re-run with --send to deliver.');
    await pool.end();
    process.exit(0);
  }

  await sendEmail({ to: user.email, ...mail });
  await pool.query(
    "UPDATE users SET pre_screen_status = 'pending_correction', updated_at = NOW() WHERE id = $1",
    [TARGET_ID]
  );
  console.log(`\n✓ Warning sent to ${user.email} — account flagged pending_correction`);
  await pool.end();
  process.exit(0);
}

run().catch(err => { console.error('Failed:', err.message); pool.end(); process.exit(1); });
