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

// Loads the job (must belong to this employer) and confirms the employer's plan
// resolves to 'starter' (the $29 All-Access tier) before any candidate data is sent.
async function loadGatedJob(req, res) {
  const job = await db.prepare(
    'SELECT id, employer_id, title, skills_required, nice_to_have_skills, category, description, experience_level FROM jobs WHERE id = ?'
  ).get(req.params.jobId);
  if (!job || job.employer_id !== req.user.id) {
    res.status(404).json({ error: 'Job not found' });
    return null;
  }
  const user = await db.prepare('SELECT employer_plan, employer_access FROM users WHERE id = ?').get(req.user.id);
  if (resolvePlan(user) !== 'starter') {
    res.status(403).json({ error: 'Match Talent requires the $29 All-Access plan', code: 'ALL_ACCESS_REQUIRED' });
    return null;
  }
  return job;
}

// ── GET /api/match-talent/:jobId — ranked deck + persisted Loved/Archived lists ──
router.get('/:jobId', authenticateToken, async (req, res) => {
  if (req.user.role !== 'employer') return res.status(403).json({ error: 'Employers only' });
  try {
    const job = await loadGatedJob(req, res);
    if (!job) return;

    const talents = await db.prepare(
      `SELECT ${TALENT_FIELDS} FROM users WHERE role = 'freelancer' AND ${TALENT_VISIBLE_CLAUSE}`
    ).all();
    const decisions = await db.prepare(
      'SELECT talent_id, decision FROM match_talent_decisions WHERE employer_id = ? AND job_id = ?'
    ).all(req.user.id, job.id);
    const decisionByTalent = new Map(decisions.map(d => [d.talent_id, d.decision]));

    const queue = [], loved = [], archived = [];
    for (const t of talents) {
      const { score, exact_skills, related_skills } = keywordScore(job, t);
      if (exact_skills.length === 0 && related_skills.length === 0) continue;
      const payload = talentPayload(t, score);
      const decision = decisionByTalent.get(t.id);
      if (decision === 'loved') loved.push(payload);
      else if (decision === 'archived') archived.push(payload);
      else queue.push(payload);
    }
    queue.sort((a, b) => b.score - a.score);
    loved.sort((a, b) => b.score - a.score);

    res.json({ job: { id: job.id, title: job.title }, queue, loved, archived });
  } catch (err) {
    console.error('[match-talent GET] error:', err.message);
    res.status(500).json({ error: 'Failed to load matches' });
  }
});

// ── POST /api/match-talent/:jobId/decisions — record Love or Archive ────────────
router.post('/:jobId/decisions', authenticateToken, async (req, res) => {
  if (req.user.role !== 'employer') return res.status(403).json({ error: 'Employers only' });
  const { talent_id, decision } = req.body;
  if (!talent_id || !['loved', 'archived'].includes(decision)) {
    return res.status(400).json({ error: 'talent_id and a valid decision are required' });
  }
  try {
    const job = await loadGatedJob(req, res);
    if (!job) return;

    await db.prepare(`
      INSERT INTO match_talent_decisions (employer_id, job_id, talent_id, decision)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (employer_id, job_id, talent_id) DO UPDATE SET decision = EXCLUDED.decision, created_at = NOW()
    `).run(req.user.id, job.id, talent_id, decision);

    res.json({ ok: true });
  } catch (err) {
    console.error('[match-talent decide] error:', err.message);
    res.status(500).json({ error: 'Failed to save decision' });
  }
});

// ── DELETE /api/match-talent/:jobId/decisions/:talentId — undo a Love/Archive ───
router.delete('/:jobId/decisions/:talentId', authenticateToken, async (req, res) => {
  if (req.user.role !== 'employer') return res.status(403).json({ error: 'Employers only' });
  try {
    const job = await loadGatedJob(req, res);
    if (!job) return;

    await db.prepare(
      'DELETE FROM match_talent_decisions WHERE employer_id = ? AND job_id = ? AND talent_id = ?'
    ).run(req.user.id, job.id, req.params.talentId);

    res.json({ ok: true });
  } catch (err) {
    console.error('[match-talent undo] error:', err.message);
    res.status(500).json({ error: 'Failed to undo decision' });
  }
});

module.exports = router;
