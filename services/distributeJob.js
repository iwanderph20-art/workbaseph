// ── Auto-distribution: surface a job to every talent whose skills match/relate to it ──
// The hands-free core of WorkBase PH. Based on the employer's chosen skills, a job is pushed
// (in-app) to as many relevant talents as possible, and — since posts carry open_role_override —
// it also shows on the public Open Roles board.
//
// Notification rule (2026-08, owner-directed):
//   • EVERY relevant talent gets the in-app "notified" job_matches row (+ the job is on Open Roles).
//   • Talents who ALSO fall within the job's hourly-rate preference get a job-match EMAIL.
//     (This is a deliberate, scoped exception to the usual stage-don't-send rule — only the
//      best-fit slice: matching skills AND matching rate.)
//
// Idempotent + efficient: only talents NOT already matched to the job are scored (ON CONFLICT is a
// backstop), so each call only ever ADDS newly-relevant talents and each talent is emailed at most
// once per job (the email fires only when a NEW match row is actually inserted).
const db = require('../database');
const { keywordScore } = require('./skillMatch');
const { sendEmail, jobMatchEmail } = require('./email');

// Talent hourly-rate buckets (from signup) → numeric [min, max] in USD/hr.
// 'fixed_only' and unset talents have no hourly rate, so they never rate-qualify for an email.
const RATE_BUCKETS = { '5_12': [5, 12], '13_25': [13, 25], '26_plus': [26, Infinity] };

// The job's hourly-rate preference, or null when the post isn't hourly (fixed / open-to-quotes) —
// in which case there is no hourly preference to match, so no emails are sent for it.
function jobHourlyRange(job) {
  if (job.budget_type !== 'hourly') return null;
  const min = job.budget_min != null && job.budget_min !== '' ? Number(job.budget_min) : 0;
  const max = job.budget_max != null && job.budget_max !== '' ? Number(job.budget_max) : Infinity;
  if (!isFinite(min) && !isFinite(max)) return null;
  return { min: isFinite(min) ? min : 0, max: isFinite(max) ? max : Infinity };
}

// Does the talent's rate bucket overlap the job's hourly range?
function rateFits(bucketKey, range) {
  const b = RATE_BUCKETS[bucketKey];
  if (!b || !range) return false;
  return b[0] <= range.max && b[1] >= range.min;
}

// Safety cap on job-match emails per call, so a single popular post can't exhaust the shared
// Resend daily quota (and starve transactional emails like payment confirmations). Talents beyond
// the cap still get the in-app match + Open Roles; they just aren't emailed.
const EMAIL_CAP_PER_RUN = 50;

async function distributeJobToTalents(job) {
  if (!job || !job.id) return 0;
  const range = jobHourlyRange(job);

  const pool = await db.prepare(
    `SELECT u.id, u.full_name, u.email, u.skills, u.bio, u.professional_level, u.hourly_rate_range
       FROM users u
      WHERE u.role = 'freelancer'
        AND COALESCE(u.account_paused, FALSE) = FALSE
        AND (u.talent_status IS NULL OR u.talent_status NOT IN ('hired','denied'))
        AND NOT EXISTS (SELECT 1 FROM job_matches jm WHERE jm.job_id = ? AND jm.talent_id = u.id)`
  ).all(job.id);

  let added = 0, emailed = 0;
  for (const t of pool) {
    if (!t.skills) continue; // no skill tags → nothing to match on
    const m = keywordScore(job, t);
    if (m.exact_skills.length === 0 && m.related_skills.length === 0) continue; // relevant only

    let inserted = false;
    try {
      const res = await db.prepare(
        `INSERT INTO job_matches (job_id, talent_id, match_score, matched_skills, status, pushed_at)
         VALUES (?, ?, ?, ?, 'notified', NOW())
         ON CONFLICT (job_id, talent_id) DO NOTHING`
      ).run(job.id, t.id, m.score, JSON.stringify(m.matched_skills));
      inserted = !!(res && res.changes);
    } catch (e) {
      console.error('[distributeJob] insert failed:', e.message);
      continue;
    }
    if (!inserted) continue;
    added++;

    // Email only the best-fit slice: matching skills (already true) AND within the job's hourly
    // rate preference. In-app + Open Roles already cover everyone else.
    if (range && t.email && emailed < EMAIL_CAP_PER_RUN && rateFits(t.hourly_rate_range, range)) {
      sendEmail({ to: t.email, ...jobMatchEmail(t.full_name || 'there', job.title, job.category, job.description) })
        .catch(err => console.error('[distributeJob] job-match email failed:', err.message));
      emailed++;
    }
  }
  if (emailed) console.log(`[distributeJob] job ${job.id}: ${added} new matches, ${emailed} rate-fit emails`);
  return added;
}

module.exports = { distributeJobToTalents };
