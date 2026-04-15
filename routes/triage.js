const express = require('express');
const router  = express.Router();
const db      = require('../database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

// ─── Keyword-based fallback matcher (no API needed) ──────────────────────────
function keywordMatch(job, talent) {
  const jobText = [job.title, job.description, job.category, job.experience_level, job.certifications]
    .filter(Boolean).join(' ').toLowerCase();

  const talentText = [talent.skills, talent.bio, talent.professional_level, talent.education_level]
    .filter(Boolean).join(' ').toLowerCase();

  // Extract words 4+ chars from job text
  const jobWords  = [...new Set(jobText.match(/\b\w{4,}\b/g) || [])];
  const matched   = jobWords.filter(w => talentText.includes(w));
  const score     = jobWords.length ? Math.round((matched.length / jobWords.length) * 100) : 0;

  // Seniority bonus
  let bonus = 0;
  if (job.experience_level === 'expert'       && ['senior','lead','director','c_level'].includes(talent.professional_level)) bonus = 15;
  if (job.experience_level === 'intermediate' && ['mid','senior'].includes(talent.professional_level))                       bonus = 10;
  if (job.experience_level === 'entry'        && ['entry','junior'].includes(talent.professional_level))                     bonus = 10;

  return {
    talent_id:      talent.id,
    score:          Math.min(score + bonus, 99),
    matched_skills: matched.slice(0, 8),
    reason:         `Keyword match: ${matched.slice(0, 4).join(', ') || 'general profile'}`
  };
}

// ─── AI match via Claude (with credit-balance fallback) ──────────────────────
async function runAiMatch(job, talents) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('NO_API_KEY');

  const Anthropic = require('@anthropic-ai/sdk');
  const client    = new Anthropic({ apiKey });

  const prompt = `You are a talent matching system. Given this job post, extract requirements and score each candidate.

JOB POST:
Title: ${job.title}
Description: ${job.description || ''}
Experience Level: ${job.experience_level || 'not specified'}
Category: ${job.category || 'not specified'}
Certifications: ${job.certifications || 'none'}

CANDIDATES:
${JSON.stringify(talents.map(t => ({
  id: t.id,
  name: t.full_name,
  skills: t.skills,
  bio: t.bio,
  level: t.professional_level,
  education: t.education_level,
  rate: t.hourly_rate_range,
  availability: t.weekly_availability
})))}

Return ONLY a JSON object (no markdown, no explanation):
{
  "extracted_skills": ["skill1", "skill2"],
  "experience_required": "entry/mid/senior",
  "matches": [
    {"talent_id": 123, "score": 85, "matched_skills": ["skill1"], "reason": "brief reason"}
  ]
}
Only include candidates with score >= 20. Sort by score descending.`;

  const msg = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }]
  });

  const text = msg.content[0].text;
  try {
    return JSON.parse(text);
  } catch (e) {
    const m = text.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  }
}

// ─── GET /api/triage/jobs — list all jobs (admin) ────────────────────────────
router.get('/jobs', authenticateToken, requireAdmin, (req, res) => {
  try {
    const jobs = db.prepare(`
      SELECT j.*, u.full_name AS employer_name, u.email AS employer_email,
             jt.status AS triage_status,
             (SELECT COUNT(*) FROM job_matches WHERE job_id = j.id AND status = 'pushed') AS pushed_count
      FROM jobs j
      JOIN users u ON j.employer_id = u.id
      LEFT JOIN job_triage jt ON jt.job_id = j.id
      ORDER BY j.created_at DESC
    `).all();
    res.json(jobs);
  } catch (err) {
    console.error('[triage GET /jobs]', err.message);
    res.status(500).json({ error: 'Failed to fetch jobs: ' + err.message });
  }
});

// ─── POST /api/triage/jobs/:jobId/run — AI match (admin) ─────────────────────
router.post('/jobs/:jobId/run', authenticateToken, requireAdmin, async (req, res) => {
  const { jobId } = req.params;
  try {
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const talents = db.prepare(`
      SELECT u.id, u.full_name, u.email, u.skills, u.bio, u.professional_level,
             u.education_level, u.hourly_rate_range, u.weekly_availability
      FROM users u
      WHERE u.role = 'freelancer'
    `).all();

    if (!talents.length) return res.json({ matches: [], auto_pushed: 0, method: 'none', message: 'No freelancers on platform yet.' });

    let result    = null;
    let method    = 'ai';
    let aiError   = null;

    // Try AI match first
    try {
      result = await runAiMatch(job, talents);
    } catch (err) {
      aiError = err.message;
      method  = 'keyword';
      console.warn('[triage] AI match unavailable, using keyword fallback:', err.message);
    }

    // Fallback: keyword matching
    if (!result) {
      const matches = talents
        .map(t => keywordMatch(job, t))
        .filter(m => m.score >= 10)
        .sort((a, b) => b.score - a.score);

      result = {
        extracted_skills: (job.category || job.title || '').split(/[\s,]+/).filter(w => w.length > 3),
        experience_required: job.experience_level || 'not specified',
        matches
      };
    }

    // Upsert triage record (SQLite syntax)
    db.prepare(`
      INSERT INTO job_triage (job_id, status, ai_extracted_skills, ai_experience_required, triaged_at, triaged_by)
      VALUES (?, 'completed', ?, ?, datetime('now'), ?)
      ON CONFLICT(job_id) DO UPDATE SET
        status='completed',
        ai_extracted_skills=excluded.ai_extracted_skills,
        ai_experience_required=excluded.ai_experience_required,
        triaged_at=excluded.triaged_at,
        triaged_by=excluded.triaged_by
    `).run(jobId, JSON.stringify(result.extracted_skills || []), result.experience_required || '', req.user.id);

    // Upsert match scores
    const upsertMatch = db.prepare(`
      INSERT INTO job_matches (job_id, talent_id, match_score, matched_skills, status)
      VALUES (?, ?, ?, ?, 'suggested')
      ON CONFLICT(job_id, talent_id) DO UPDATE SET
        match_score=excluded.match_score,
        matched_skills=excluded.matched_skills
    `);
    for (const m of (result.matches || [])) {
      upsertMatch.run(jobId, m.talent_id, m.score, JSON.stringify(m.matched_skills || []));
    }

    // Auto-push >= 50
    db.prepare(`
      UPDATE job_matches SET status='pushed', pushed_at=datetime('now')
      WHERE job_id=? AND match_score>=50 AND status='suggested'
    `).run(jobId);

    const autoPushed = (result.matches || []).filter(m => m.score >= 50).length;

    res.json({
      method,
      ai_error: aiError || undefined,
      extracted_skills: result.extracted_skills,
      matches: result.matches,
      auto_pushed: autoPushed,
      message: method === 'keyword'
        ? `Keyword matching used (AI unavailable: ${aiError}). ${autoPushed} candidate(s) auto-pushed.`
        : `AI matching complete. ${autoPushed} candidate(s) auto-pushed.`
    });
  } catch (err) {
    console.error('[triage POST /run]', err.message);
    res.status(500).json({ error: 'Triage failed: ' + err.message });
  }
});

// ─── GET /api/triage/jobs/:jobId/matches ─────────────────────────────────────
router.get('/jobs/:jobId/matches', authenticateToken, requireAdmin, (req, res) => {
  try {
    const matches = db.prepare(`
      SELECT jm.*, u.full_name, u.email, u.skills, u.bio, u.professional_level,
             u.profile_pic_url, u.video_loom_link, u.hourly_rate_range, u.weekly_availability
      FROM job_matches jm
      JOIN users u ON jm.talent_id = u.id
      WHERE jm.job_id = ?
      ORDER BY jm.match_score DESC
    `).all(req.params.jobId);
    res.json(matches);
  } catch (err) {
    console.error('[triage GET /matches]', err.message);
    res.status(500).json({ error: 'Failed to fetch matches: ' + err.message });
  }
});

// ─── POST /api/triage/jobs/:jobId/push/:talentId ─────────────────────────────
router.post('/jobs/:jobId/push/:talentId', authenticateToken, requireAdmin, (req, res) => {
  try {
    db.prepare(`
      UPDATE job_matches SET status='pushed', pushed_at=datetime('now')
      WHERE job_id=? AND talent_id=?
    `).run(req.params.jobId, req.params.talentId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[triage POST /push]', err.message);
    res.status(500).json({ error: 'Failed to push: ' + err.message });
  }
});

// ─── POST /api/triage/jobs/:jobId/request-interview/:talentId ────────────────
router.post('/jobs/:jobId/request-interview/:talentId', authenticateToken, (req, res) => {
  try {
    db.prepare(`
      UPDATE job_matches SET status='interview_requested', interview_requested_at=datetime('now')
      WHERE job_id=? AND talent_id=?
    `).run(req.params.jobId, req.params.talentId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[triage POST /request-interview]', err.message);
    res.status(500).json({ error: 'Failed to request interview: ' + err.message });
  }
});

// ─── GET /api/triage/employer/:jobId/shortlist ───────────────────────────────
router.get('/employer/:jobId/shortlist', authenticateToken, (req, res) => {
  try {
    const job = db.prepare('SELECT id FROM jobs WHERE id=? AND employer_id=?').get(req.params.jobId, req.user.id);
    if (!job) return res.status(403).json({ error: 'Not authorized' });

    const shortlist = db.prepare(`
      SELECT jm.match_score, jm.status, jm.interview_requested_at,
             u.full_name, u.email, u.skills, u.bio, u.professional_level,
             u.profile_pic_url, u.video_loom_link, u.hourly_rate_range, u.weekly_availability,
             u.id AS talent_id
      FROM job_matches jm
      JOIN users u ON jm.talent_id = u.id
      WHERE jm.job_id=? AND jm.status IN ('pushed','interview_requested')
      ORDER BY jm.match_score DESC
    `).all(req.params.jobId);

    res.json(shortlist);
  } catch (err) {
    console.error('[triage GET /shortlist]', err.message);
    res.status(500).json({ error: 'Failed to fetch shortlist: ' + err.message });
  }
});

module.exports = router;
