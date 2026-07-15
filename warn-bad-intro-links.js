// Finds talents whose video/audio introduction link is broken, malformed, or points at
// an unrelated site, and emails them a warning with a chance to correct it.
//
// Two checks:
//   1. Structural — is it a real URL on a recognised video/audio host? (services/introLink.js)
//   2. Liveness   — does it actually resolve? (skipped with --no-liveness)
//
// Usage:
//   node warn-bad-intro-links.js --dry-run      # report who'd be warned, sends nothing
//   node warn-bad-intro-links.js --no-liveness  # structural check only (fast)
//   node warn-bad-intro-links.js                # report, then send warnings
//
// Talents warned are flagged pre_screen_status = 'pending_correction', matching the
// admin "request re-upload" flow.
require('dotenv').config();

const { Pool } = require('pg');
const { sendEmail, introLinkWarningEmail } = require('./services/email');
const { classifyIntroLink, checkIntroLinkLive } = require('./services/introLink');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

const DRY_RUN = process.argv.includes('--dry-run');
const NO_LIVENESS = process.argv.includes('--no-liveness');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run() {
  const { rows: talents } = await pool.query(`
    SELECT id, email, full_name, video_loom_link
    FROM users
    WHERE role = 'freelancer'
      AND (admin_role IS NULL OR admin_role = '')
      AND email IS NOT NULL AND TRIM(email) <> ''
      AND COALESCE(talent_status, '') <> 'denied'
      AND COALESCE(account_paused, FALSE) = FALSE
      AND video_loom_link IS NOT NULL AND TRIM(video_loom_link) <> ''
    ORDER BY id
  `);

  const bad = [];
  for (const t of talents) {
    const c = classifyIntroLink(t.video_loom_link);
    if (!c.ok) { bad.push({ t, reason: c.reason }); continue; }
    if (NO_LIVENESS) continue;
    const live = await checkIntroLinkLive(t.video_loom_link);
    if (!live.reachable) {
      bad.push({
        t,
        reason: live.status
          ? `The link returns an error (${live.status}) — it may have been deleted or set to private`
          : `We couldn't reach the link (${live.error})`,
      });
    }
  }

  console.log(`\nTalents with an intro link : ${talents.length}`);
  console.log(`  Working                  : ${talents.length - bad.length}`);
  console.log(`  BROKEN — to warn         : ${bad.length}\n`);
  for (const { t, reason } of bad) {
    console.log(`  ${t.full_name} <${t.email}>`);
    console.log(`     link: ${JSON.stringify(t.video_loom_link).slice(0, 100)}`);
    console.log(`     why : ${reason}`);
  }

  if (!bad.length) { console.log('\nNothing to warn about.'); return; }
  if (DRY_RUN) { console.log('\n--dry-run: no emails sent.'); return; }

  console.log('');
  let sent = 0;
  const errors = [];
  for (const { t, reason } of bad) {
    const firstName = (t.full_name || 'there').trim().split(/\s+/)[0];
    try {
      await sendEmail({ to: t.email, ...introLinkWarningEmail(firstName, t.video_loom_link, reason) });
      await pool.query(
        "UPDATE users SET pre_screen_status = 'pending_correction', updated_at = NOW() WHERE id = $1",
        [t.id]
      );
      console.log(`  ✓ warned ${t.email}`);
      sent++;
      await sleep(150);
    } catch (err) {
      console.error(`  ✗ ${t.email}: ${err.message}`);
      errors.push(t.email);
    }
  }
  console.log(`\nDone. Warned: ${sent} / ${bad.length}`);
  if (errors.length) console.log(`Failed: ${errors.join(', ')}`);
}

run()
  .catch(err => { console.error('❌ Failed:', err.message); process.exitCode = 1; })
  .finally(() => pool.end());
