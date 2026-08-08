// Broadcast: announce the new self-serve "Open Roles" board to all talent.
//
// SAFETY: dry-run by default. Running with no flag only STAGES the recipient
// list (prints who would receive it) and writes a preview HTML — it does NOT
// send anything. Review the list, then re-run with --send to actually deliver.
//
//   node send-open-roles-announcement.js            # stage list + write preview (no email sent)
//   node send-open-roles-announcement.js --send      # actually send to all talent
//   node send-open-roles-announcement.js --send --limit 5   # send to first 5 (test batch)
require('dotenv').config();

const fs = require('fs');
const { Pool } = require('pg');
const { sendEmail, openRolesAnnouncementEmail } = require('./services/email');

const SEND = process.argv.includes('--send');
const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg !== -1 ? parseInt(process.argv[limitArg + 1], 10) : null;

// Do-not-send: these people are excluded from the broadcast (matched on full name).
const EXCLUDE_NAMES = ['Lukas Bukowski', 'Eunice Borja'];

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function run() {
  const { rows: talent } = await pool.query(`
    SELECT id, email, full_name
    FROM users
    WHERE role = 'freelancer'
      AND email IS NOT NULL AND TRIM(email) <> ''
      AND LOWER(TRIM(full_name)) <> ALL($1)
    ORDER BY id
    ${LIMIT ? `LIMIT ${LIMIT}` : ''}
  `, [EXCLUDE_NAMES.map(n => n.toLowerCase())]);

  console.log(`Found ${talent.length} talent recipient(s). Excluded: ${EXCLUDE_NAMES.join(', ')}.\n`);

  if (!SEND) {
    // Stage-only: list who would receive it and drop a preview to review.
    talent.forEach((u, i) => console.log(`  ${String(i + 1).padStart(3)}. ${u.full_name || '(no name)'} <${u.email}>`));
    const preview = openRolesAnnouncementEmail(talent[0]?.full_name || 'Maria');
    fs.writeFileSync('open-roles-announcement.preview.html', preview.html);
    console.log(`\nSubject: ${preview.subject}`);
    console.log('\nDRY RUN — no emails sent. Preview written to open-roles-announcement.preview.html');
    console.log('Review the list above, then re-run with --send to deliver (or --send --limit 5 to test first).');
    await pool.end();
    process.exit(0);
  }

  let sent = 0;
  const errors = [];
  for (const user of talent) {
    try {
      await sendEmail({ to: user.email, ...openRolesAnnouncementEmail(user.full_name) });
      console.log(`  ✓ Sent to ${user.email}`);
      sent++;
    } catch (err) {
      console.error(`  ✗ Failed for ${user.email}: ${err.message}`);
      errors.push(user.email);
    }
  }

  console.log(`\nDone. Sent: ${sent} / ${talent.length}`);
  if (errors.length) console.log(`Failed: ${errors.join(', ')}`);

  await pool.end();
  process.exit(0);
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  pool.end();
  process.exit(1);
});
