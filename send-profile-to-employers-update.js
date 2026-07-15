// One-time campaign: tell every signed-up talent that we now send 80%+ profiles
// straight to matched employers — no applying — and nudge them to complete theirs
// (especially the video/audio intro, which is the single biggest score item).
//
// Usage:
//   node send-profile-to-employers-update.js --dry-run          # report only, sends nothing
//   node send-profile-to-employers-update.js --preview out.html # write one sample email to a file
//   node send-profile-to-employers-update.js                    # actually send
//
// Skips denied and paused accounts. Personalises each email with the talent's real
// score (same maths as their dashboard) and what they're missing.
require('dotenv').config();

const fs = require('fs');
const { Pool } = require('pg');
const { sendEmail, profileToEmployersUpdateEmail } = require('./services/email');
const { talentProfileScore, missingProfileItems } = require('./services/profileCompletion');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// Only nudge profiles UNDER this score. 70%+ are close enough or already visible —
// they don't need the push, so we don't email them.
const SCORE_CEILING = 70;

const DRY_RUN = process.argv.includes('--dry-run');
const previewIdx = process.argv.indexOf('--preview');
const PREVIEW_PATH = previewIdx !== -1 ? process.argv[previewIdx + 1] : null;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run() {
  const { rows: talents } = await pool.query(`
    SELECT id, email, full_name,
           profile_pic, bio, skills, location, video_loom_link, resume_file,
           specs_image, speedtest_image, hourly_rate_range, professional_level,
           personality_type
    FROM users
    WHERE role = 'freelancer'
      AND (admin_role IS NULL OR admin_role = '')
      AND email IS NOT NULL AND TRIM(email) <> ''
      AND COALESCE(talent_status, '') <> 'denied'
      AND COALESCE(account_paused, FALSE) = FALSE
    ORDER BY id
  `);

  const all = talents.map(t => ({
    t,
    score: talentProfileScore(t),
    missing: missingProfileItems(t),
  }));

  // Under 70% only — everyone at/above the ceiling is left alone.
  const enriched = all.filter(e => e.score < SCORE_CEILING);
  const excluded = all.length - enriched.length;
  const withIntro = enriched.filter(e => !!(e.t.video_loom_link || '').trim()).length;

  console.log(`\nTalents scanned                 : ${all.length}`);
  console.log(`  Excluded (${SCORE_CEILING}% and up)          : ${excluded}`);
  console.log(`  RECIPIENTS (under ${SCORE_CEILING}%)         : ${enriched.length}`);
  console.log(`     with a video/audio intro   : ${withIntro}`);
  console.log(`     missing an intro (+20%)    : ${enriched.length - withIntro}`);
  if (!enriched.length) { console.log('\nNo one under the ceiling — nothing to send.'); return; }

  // Write a sample email to disk so the design can be eyeballed before sending.
  if (PREVIEW_PATH) {
    const sample = enriched.find(e => e.score < 80) || enriched[0];
    if (!sample) { console.log('\nNo talents found — nothing to preview.'); return; }
    const { subject, html } = profileToEmployersUpdateEmail(
      (sample.t.full_name || 'there').split(' ')[0], sample.score, sample.missing
    );
    fs.writeFileSync(PREVIEW_PATH, html);
    console.log(`\nPreview written to ${PREVIEW_PATH}`);
    console.log(`  Sample: ${sample.t.full_name} — ${sample.score}%`);
    console.log(`  Subject: ${subject}`);
    return;
  }

  if (DRY_RUN) {
    console.log('\n--dry-run: no emails sent. Sample subjects:');
    for (const e of enriched.slice(0, 5)) {
      const { subject } = profileToEmployersUpdateEmail(
        (e.t.full_name || 'there').split(' ')[0], e.score, e.missing
      );
      console.log(`  ${String(e.score + '%').padStart(4)}  ${e.t.email.padEnd(34)} ${subject}`);
    }
    return;
  }

  let sent = 0;
  const errors = [];
  for (const { t, score, missing } of enriched) {
    const firstName = (t.full_name || 'there').trim().split(/\s+/)[0];
    try {
      await sendEmail({ to: t.email, ...profileToEmployersUpdateEmail(firstName, score, missing) });
      console.log(`  ✓ ${String(score + '%').padStart(4)}  ${t.email}`);
      sent++;
      await sleep(120); // be gentle on the mail provider
    } catch (err) {
      console.error(`  ✗ ${t.email}: ${err.message}`);
      errors.push(t.email);
    }
  }

  console.log(`\nDone. Sent: ${sent} / ${enriched.length}`);
  if (errors.length) console.log(`Failed (${errors.length}): ${errors.join(', ')}`);
}

run()
  .catch(err => { console.error('❌ Failed:', err.message); process.exitCode = 1; })
  .finally(() => pool.end());
