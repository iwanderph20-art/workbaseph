// ── Auto-distribution: surface a job to every talent whose skills match/relate to it ──
// The hands-free core of WorkBase PH: based on the employer's chosen skills, a job is pushed
// (in-app) to as many relevant talents as possible, and — since posts carry open_role_override —
// it also shows on the public Open Roles board. This inserts "notified" job_matches only; it never
// emails or pushes talents (that would violate the stage-don't-send rule) — it just makes the job
// appear in each matched talent's Job Matches.
//
// Idempotent + efficient: only talents NOT already matched to the job are scored (ON CONFLICT is a
// backstop). So it's safe to call at create, on every skill edit, and from the periodic backfill —
// each call only ever adds newly-relevant talents, never duplicates.
const db = require('../database');
const { keywordScore } = require('./skillMatch');

async function distributeJobToTalents(job) {
  if (!job || !job.id) return 0;
  const pool = await db.prepare(
    `SELECT u.id, u.skills, u.bio, u.professional_level
       FROM users u
      WHERE u.role = 'freelancer'
        AND COALESCE(u.account_paused, FALSE) = FALSE
        AND (u.talent_status IS NULL OR u.talent_status NOT IN ('hired','denied'))
        AND NOT EXISTS (SELECT 1 FROM job_matches jm WHERE jm.job_id = ? AND jm.talent_id = u.id)`
  ).all(job.id);

  let added = 0;
  for (const t of pool) {
    if (!t.skills) continue; // no skill tags → nothing to match on
    const m = keywordScore(job, t);
    if (m.exact_skills.length === 0 && m.related_skills.length === 0) continue; // relevant only
    try {
      const res = await db.prepare(
        `INSERT INTO job_matches (job_id, talent_id, match_score, matched_skills, status, pushed_at)
         VALUES (?, ?, ?, ?, 'notified', NOW())
         ON CONFLICT (job_id, talent_id) DO NOTHING`
      ).run(job.id, t.id, m.score, JSON.stringify(m.matched_skills));
      if (res && res.changes) added += res.changes;
    } catch (e) {
      // One bad row shouldn't stop the sweep.
      console.error('[distributeJob] insert failed:', e.message);
    }
  }
  return added;
}

module.exports = { distributeJobToTalents };
