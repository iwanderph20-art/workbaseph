const express = require('express');
const router = express.Router();
const db = require('../database');
const { authenticateToken } = require('../middleware/auth');
const { keywordScore } = require('../services/skillMatch');
const { TALENT_VISIBLE_CLAUSE } = require('./talent');
const { resolvePlan } = require('./jobs');

const TALENT_FIELDS = `
  id, full_name, job_title, bio, skills, professional_level, hourly_rate_range,
  weekly_availability, location, is_verified, video_loom_link, audio_intro_url, resume_file
`;

function talentPayload(t, score) {
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
  };
}

// Confirms the employer's plan resolves to 'starter' (the $29 All-Access tier)
// before any candidate data is sent. Browse Talent isn't tied to a specific job post.
async function checkAllAccess(req, res) {
  if (req.user.role !== 'employer') { res.status(403).json({ error: 'Employers only' }); return false; }
  const user = await db.prepare('SELECT employer_plan, employer_access FROM users WHERE id = ?').get(req.user.id);
  if (resolvePlan(user) !== 'starter') {
    res.status(403).json({ error: 'Browse Talent requires the $29 All-Access plan', code: 'ALL_ACCESS_REQUIRED' });
    return false;
  }
  return true;
}

// ── GET /api/match-talent?skills=a,b,c — ranked deck + persisted Archived list ──
router.get('/', authenticateToken, async (req, res) => {
  try {
    if (!(await checkAllAccess(req, res))) return;

    const skills = String(req.query.skills || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!skills.length) return res.json({ queue: [], archived: [] });

    // A synthetic "job" built from the skills the employer typed, fed into the same
    // matching engine used for job-apply matching (keywordScore reads title/
    // skills_required/category/nice_to_have_skills off whatever object it's given).
    const searchJob = { title: '', skills_required: skills.join(', '), category: '', nice_to_have_skills: '', experience_level: null };

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
    const archivedIds = new Set(decisions.filter(d => d.decision === 'archived').map(d => d.talent_id));

    const queue = [], archived = [];
    for (const t of talents) {
      const { score, exact_skills, related_skills } = keywordScore(searchJob, t);
      if (exact_skills.length === 0 && related_skills.length === 0) continue;
      const payload = talentPayload(t, score);
      if (archivedIds.has(t.id)) archived.push(payload);
      else queue.push(payload);
    }
    queue.sort((a, b) => b.score - a.score);

    res.json({ queue, archived });
  } catch (err) {
    console.error('[match-talent GET] error:', err.message);
    res.status(500).json({ error: 'Failed to load matches' });
  }
});

// ── POST /api/match-talent/decisions — record an Archive ────────────────────────
router.post('/decisions', authenticateToken, async (req, res) => {
  const { talent_id, decision } = req.body;
  if (!talent_id || decision !== 'archived') {
    return res.status(400).json({ error: 'talent_id and decision "archived" are required' });
  }
  try {
    if (!(await checkAllAccess(req, res))) return;

    await db.prepare(`
      INSERT INTO match_talent_decisions (employer_id, job_id, talent_id, decision)
      VALUES (?, NULL, ?, ?)
      ON CONFLICT (employer_id, talent_id) DO UPDATE SET decision = EXCLUDED.decision, created_at = NOW()
    `).run(req.user.id, talent_id, decision);

    res.json({ ok: true });
  } catch (err) {
    console.error('[match-talent decide] error:', err.message);
    res.status(500).json({ error: 'Failed to save decision' });
  }
});

// ── DELETE /api/match-talent/decisions/:talentId — undo an Archive ──────────────
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
