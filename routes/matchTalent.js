const express = require('express');
const router = express.Router();
const db = require('../database');
const { authenticateToken } = require('../middleware/auth');
const { keywordScore } = require('../services/skillMatch');
const { talentProfileScore } = require('../services/profileCompletion');
const { TALENT_VISIBLE_CLAUSE } = require('./talent');

const BROWSE_ALL_LIMIT = 150;

// profile_pic/specs_image/speedtest_image/personality_type aren't used in the payload
// itself, but talentProfileScore() (used to rank the no-skills "browse all" view)
// checks them, so they still need to be selected or completeness scores undercount.
const TALENT_FIELDS = `
  id, full_name, job_title, bio, skills, professional_level, hourly_rate_range,
  weekly_availability, location, is_verified, video_loom_link, audio_intro_url, resume_file,
  profile_pic, specs_image, speedtest_image, personality_type
`;

function talentPayload(t, score, appliedJobTitle) {
  return {
    id: t.id,
    name: t.full_name || '',
    role: t.job_title || '',
    bio: t.bio || '',
    tags: (t.skills || '').split(',').map(s => s.trim()).filter(Boolean),
    rate: t.hourly_rate_range || '',
    avail: t.weekly_availability || '',
    loc: t.location || '',
    verified: !!t.is_verified,
    video_url: t.video_loom_link || null,
    audio_url: t.audio_intro_url || null,
    resume_url: t.resume_file || null,
    score,
    applied_job_title: appliedJobTitle || null,
  };
}

// Browse Talent's access window runs 30 days from the employer's most recent $29
// payment date — NOT from any job post's own 30-day live window. A job posted a day
// (or more) after payment still gets its own full 30 days from when IT went live, but
// Browse Talent always cuts off exactly 30 days after the employer paid, regardless of
// when (or whether) they've posted since.
async function hasActiveBrowseTalentAccess(user) {
  if (user.employer_access) return true; // admin-granted comp, no expiry
  const { rows } = await db.pool.query(
    `SELECT MAX(paid_at) AS latest_paid_at FROM payment_records WHERE user_id = $1 AND plan = 'pay_per_post'`,
    [user.id]
  );
  const latestPaidAt = rows[0]?.latest_paid_at;
  if (!latestPaidAt) return false;
  return (Date.now() - new Date(latestPaidAt).getTime()) < 30 * 24 * 60 * 60 * 1000;
}

async function checkAllAccess(req, res) {
  if (req.user.role !== 'employer') { res.status(403).json({ error: 'Employers only' }); return false; }
  const user = await db.prepare('SELECT id, employer_access FROM users WHERE id = ?').get(req.user.id);
  if (!(await hasActiveBrowseTalentAccess(user))) {
    res.status(403).json({ error: 'Browse Talent requires an active $29 All-Access plan', code: 'ALL_ACCESS_REQUIRED' });
    return false;
  }
  return true;
}

const DECISIONS = ['liked', 'undecided', 'unliked'];

// ── GET /api/match-talent?skills=a,b,c — ranked deck + Liked/Undecided/Unliked lists ──
router.get('/', authenticateToken, async (req, res) => {
  try {
    if (!(await checkAllAccess(req, res))) return;

    const skills = String(req.query.skills || '').split(',').map(s => s.trim()).filter(Boolean);

    // Résumé is required to appear here — an employer reviewing candidates needs the
    // actual document, not just a profile summary.
    const talents = await db.prepare(
      `SELECT ${TALENT_FIELDS} FROM users
       WHERE role = 'freelancer' AND ${TALENT_VISIBLE_CLAUSE}
         AND resume_file IS NOT NULL AND TRIM(resume_file) LIKE 'http%'`
    ).all();
    const decisions = await db.prepare(
      'SELECT talent_id, decision FROM match_talent_decisions WHERE employer_id = ? AND job_id IS NULL'
    ).all(req.user.id);
    const decisionByTalent = new Map(decisions.map(d => [d.talent_id, d.decision]));

    // Cross-signal: has this talent already applied to one of this employer's job
    // posts? Pure context on the card — never filters or reorders the deck. Ordered
    // oldest-first so the map ends up keyed to their most recent application.
    const appliedRows = await db.prepare(`
      SELECT a.freelancer_id AS talent_id, j.title AS job_title
      FROM applications a JOIN jobs j ON a.job_id = j.id
      WHERE j.employer_id = ? ORDER BY a.created_at ASC
    `).all(req.user.id);
    const appliedJobByTalent = new Map(appliedRows.map(r => [r.talent_id, r.job_title]));

    const queue = [], liked = [], undecided = [], unliked = [];
    const bucket = { liked, undecided, unliked };

    if (!skills.length) {
      // No skills typed yet — browse the general pool, most-complete profiles first,
      // capped at a manageable deck size. Typing a skill switches to the ranked-match
      // branch below to specialize the search.
      const ranked = talents
        .map(t => ({ t, score: talentProfileScore(t) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, BROWSE_ALL_LIMIT);
      for (const { t, score } of ranked) {
        const payload = talentPayload(t, score, appliedJobByTalent.get(t.id));
        const d = decisionByTalent.get(t.id);
        if (d) bucket[d].push(payload); else queue.push(payload);
      }
    } else {
      // A synthetic "job" built from the skills the employer typed, fed into the same
      // matching engine used for job-apply matching (keywordScore reads title/
      // skills_required/category/nice_to_have_skills off whatever object it's given).
      const searchJob = { title: '', skills_required: skills.join(', '), category: '', nice_to_have_skills: '', experience_level: null };
      for (const t of talents) {
        const { score, exact_skills, related_skills } = keywordScore(searchJob, t);
        if (exact_skills.length === 0 && related_skills.length === 0) continue;
        const payload = talentPayload(t, score, appliedJobByTalent.get(t.id));
        const d = decisionByTalent.get(t.id);
        if (d) bucket[d].push(payload); else queue.push(payload);
      }
      queue.sort((a, b) => b.score - a.score);
    }

    res.json({ queue, liked, undecided, unliked, mode: skills.length ? 'skills' : 'browse' });
  } catch (err) {
    console.error('[match-talent GET] error:', err.message);
    res.status(500).json({ error: 'Failed to load matches' });
  }
});

// ── POST /api/match-talent/decisions — record Like / Undecided / Unlike ─────────
router.post('/decisions', authenticateToken, async (req, res) => {
  const { talent_id, decision } = req.body;
  if (!talent_id || !DECISIONS.includes(decision)) {
    return res.status(400).json({ error: `talent_id and a decision in [${DECISIONS.join(', ')}] are required` });
  }
  try {
    if (!(await checkAllAccess(req, res))) return;

    await db.prepare(`
      INSERT INTO match_talent_decisions (employer_id, job_id, talent_id, decision)
      VALUES (?, NULL, ?, ?)
      ON CONFLICT (employer_id, talent_id) DO UPDATE SET decision = EXCLUDED.decision, job_id = NULL, created_at = NOW()
    `).run(req.user.id, talent_id, decision);

    res.json({ ok: true });
  } catch (err) {
    console.error('[match-talent decide] error:', err.message);
    res.status(500).json({ error: 'Failed to save decision' });
  }
});

// ── DELETE /api/match-talent/decisions/:talentId — clear a decision (back to queue) ──
router.delete('/decisions/:talentId', authenticateToken, async (req, res) => {
  try {
    if (!(await checkAllAccess(req, res))) return;

    await db.prepare(
      'DELETE FROM match_talent_decisions WHERE employer_id = ? AND job_id IS NULL AND talent_id = ?'
    ).run(req.user.id, req.params.talentId);

    res.json({ ok: true });
  } catch (err) {
    console.error('[match-talent undo] error:', err.message);
    res.status(500).json({ error: 'Failed to undo decision' });
  }
});

module.exports = router;
