const express = require('express');
const router  = express.Router();
const db      = require('../database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

// ─── Keyword-based fallback scorer (no API credits needed) ───────────────────
function keywordScore(job, talent) {
  const jobText    = [job.title, job.description, job.category, job.experience_level, job.certifications]
    .filter(Boolean).join(' ').toLowerCase();
  const talentText = [talent.skills, talent.bio, talent.professional_level, talent.education_level]
    .filter(Boolean).join(' ').toLowerCase();

  const jobWords = [...new Set((jobText.match(/\b\w{4,}\b/g) || []))];
  const matched  = jobWords.filter(w => talentText.includes(w));
  const base     = jobWords.length ? Math.round((matched.length / jobWords.length) * 100) : 0;

  let bonus = 0;
  if (job.experience_level === 'expert'       && ['senior','lead','director','c_level'].includes(talent.professional_level)) bonus = 15;
  if (job.experience_level === 'intermediate' && ['mid','senior'].includes(talent.professional_level))                       bonus = 10;
  if (job.experience_level === 'entry'        && ['entry','junior'].includes(talent.professional_level))                     bonus = 10;

  return {
    talent_id:      talent.id,
    score:          Math.min(base + bonus, 99),
    matched_skills: matched.slice(0, 8),
    reason:         `Keyword match: ${matched.slice(0, 4).join(', ') || 'general profile'}`
  };
}

// ─── AI scorer via Claude (with graceful fallback) ───────────────────────────
async function runClaudeScore(job, talents) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const Anthropic = require('@anthropic-ai/sdk');
  const client    = new Anthropic({ apiKey });

  const msg = await client.messages.create({
    model:      'claude-opus-4-5',
    max_tokens: 2048,
    messages: [{
      role:    'user',
      content: `You are a talent matching system. Score each candidate against this job.

JOB:
Title: ${job.title}
Description: ${job.description || ''}
Experience Level: ${job.experience_level || 'not specified'}
Category: ${job.category || 'not specified'}
Certifications: ${job.certifications || 'none'}

CANDIDATES:
${JSON.stringify(talents.map(t => ({
  id: t.id, name: t.full_name, skills: t.skills,
  bio: t.bio, level: t.professional_level,
  education: t.education_level, rate: t.hourly_rate_range
})))}

Return ONLY a JSON object, no markdown:
{"extracted_skills":["skill1"],"experience_required":"entry/mid/senior","matches":[{"talent_id":123,"score":85,"matched_skills":["skill1"],"reason":"brief"}]}
Only include candidates with score >= 20. Sort descending by score.`
    }]
  });

  const text = msg.content[0].text;
  try { return JSON.parse(text); }
  catch { const m = text.match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null; }
}

// ─── GET /api/triage/jobs — all jobs for admin triage ────────────────────────
router.get('/jobs', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const jobs = await db.prepare(`
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

// ─── GET /api/triage/all-talents — all freelancers for manual selection ───────
router.get('/all-talents', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const talents = await db.prepare(`
      SELECT u.id, u.full_name, u.email, u.skills, u.bio, u.professional_level,
             u.education_level, u.hourly_rate_range, u.weekly_availability,
             u.start_availability, u.profile_pic, u.video_loom_link,
             u.internet_speed, u.equipment, u.created_at
      FROM users u
      WHERE u.role = 'freelancer'
      ORDER BY u.created_at DESC
    `).all();
    res.json(talents);
  } catch (err) {
    console.error('[triage GET /all-talents]', err.message);
    res.status(500).json({ error: 'Failed to fetch talents: ' + err.message });
  }
});

// ─── POST /api/triage/jobs/:jobId/run — AI/keyword scoring (no auto-push) ────
router.post('/jobs/:jobId/run', authenticateToken, requireAdmin, async (req, res) => {
  const { jobId } = req.params;
  try {
    const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const talents = await db.prepare(`
      SELECT u.id, u.full_name, u.email, u.skills, u.bio, u.professional_level,
             u.education_level, u.hourly_rate_range, u.weekly_availability
      FROM users u WHERE u.role = 'freelancer'
    `).all();

    if (!talents.length) return res.json({ matches: [], method: 'none', message: 'No freelancers yet.' });

    let result = null;
    let method = 'ai';
    let aiError = null;

    try {
      result = await runClaudeScore(job, talents);
    } catch (err) {
      aiError = err.message;
      method  = 'keyword';
    }

    if (!result) {
      const matches = talents.map(t => keywordScore(job, t)).filter(m => m.score >= 10).sort((a, b) => b.score - a.score);
      result = { extracted_skills: [], experience_required: job.experience_level || '', matches };
    }

    // Save triage record (upsert)
    await db.prepare(`
      INSERT INTO job_triage (job_id, status, ai_extracted_skills, ai_experience_required, triaged_at, triaged_by)
      VALUES (?, 'completed', ?, ?, NOW(), ?)
      ON CONFLICT (job_id) DO UPDATE SET
        status = 'completed',
        ai_extracted_skills = EXCLUDED.ai_extracted_skills,
        ai_experience_required = EXCLUDED.ai_experience_required,
        triaged_at = NOW(),
        triaged_by = EXCLUDED.triaged_by
    `).run(jobId, JSON.stringify(result.extracted_skills || []), result.experience_required || '', req.user.id);

    // Save match scores (upsert, do NOT push automatically)
    for (const m of (result.matches || [])) {
      await db.prepare(`
        INSERT INTO job_matches (job_id, talent_id, match_score, matched_skills, status)
        VALUES (?, ?, ?, ?, 'suggested')
        ON CONFLICT (job_id, talent_id) DO UPDATE SET
          match_score = EXCLUDED.match_score,
          matched_skills = EXCLUDED.matched_skills
      `).run(jobId, m.talent_id, m.score, JSON.stringify(m.matched_skills || []));
    }

    res.json({
      method,
      ai_error: aiError || undefined,
      extracted_skills: result.extracted_skills,
      matches: result.matches,
      message: method === 'keyword'
        ? `Keyword scoring used (AI: ${aiError}). Profiles sorted by relevance — select and send manually.`
        : `AI scoring complete. Profiles sorted by relevance — select and send manually.`
    });
  } catch (err) {
    console.error('[triage POST /run]', err.message);
    res.status(500).json({ error: 'Scoring failed: ' + err.message });
  }
});

// ─── GET /api/triage/jobs/:jobId/matches ─────────────────────────────────────
router.get('/jobs/:jobId/matches', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const matches = await db.prepare(`
      SELECT jm.*, u.full_name, u.email, u.skills, u.bio, u.professional_level,
             u.profile_pic, u.video_loom_link, u.hourly_rate_range, u.weekly_availability
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

// ─── POST /api/triage/jobs/:jobId/bulk-push — push selected talent IDs ────────
router.post('/jobs/:jobId/bulk-push', authenticateToken, requireAdmin, async (req, res) => {
  const { talent_ids } = req.body;
  if (!Array.isArray(talent_ids) || !talent_ids.length) {
    return res.status(400).json({ error: 'talent_ids array required' });
  }
  try {
    for (const tid of talent_ids) {
      await db.prepare(`
        INSERT INTO job_matches (job_id, talent_id, match_score, matched_skills, status, pushed_at)
        VALUES (?, ?, 0, '[]', 'pushed', NOW())
        ON CONFLICT (job_id, talent_id) DO UPDATE SET
          status = 'pushed',
          pushed_at = NOW()
      `).run(req.params.jobId, tid);
    }
    res.json({ ok: true, pushed: talent_ids.length });
  } catch (err) {
    console.error('[triage POST /bulk-push]', err.message);
    res.status(500).json({ error: 'Bulk push failed: ' + err.message });
  }
});

// ─── POST /api/triage/jobs/:jobId/push/:talentId — single push ───────────────
router.post('/jobs/:jobId/push/:talentId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await db.prepare(`
      INSERT INTO job_matches (job_id, talent_id, match_score, matched_skills, status, pushed_at)
      VALUES (?, ?, 0, '[]', 'pushed', NOW())
      ON CONFLICT (job_id, talent_id) DO UPDATE SET status = 'pushed', pushed_at = NOW()
    `).run(req.params.jobId, req.params.talentId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[triage POST /push]', err.message);
    res.status(500).json({ error: 'Failed to push: ' + err.message });
  }
});

// ─── POST /api/triage/jobs/:jobId/request-interview/:talentId ────────────────
router.post('/jobs/:jobId/request-interview/:talentId', authenticateToken, async (req, res) => {
  try {
    await db.prepare(`
      UPDATE job_matches SET status = 'interview_requested', interview_requested_at = NOW()
      WHERE job_id = ? AND talent_id = ?
    `).run(req.params.jobId, req.params.talentId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[triage POST /request-interview]', err.message);
    res.status(500).json({ error: 'Failed to request interview: ' + err.message });
  }
});

// ─── GET /api/triage/employer/:jobId/shortlist ───────────────────────────────
router.get('/employer/:jobId/shortlist', authenticateToken, async (req, res) => {
  try {
    const job = await db.prepare('SELECT id FROM jobs WHERE id = ? AND employer_id = ?').get(req.params.jobId, req.user.id);
    if (!job) return res.status(403).json({ error: 'Not authorized' });

    const shortlist = await db.prepare(`
      SELECT jm.match_score, jm.status, jm.interview_requested_at,
             u.full_name, u.email, u.skills, u.bio, u.professional_level,
             u.profile_pic, u.video_loom_link, u.hourly_rate_range, u.weekly_availability,
             u.id AS talent_id
      FROM job_matches jm
      JOIN users u ON jm.talent_id = u.id
      WHERE jm.job_id = ? AND jm.status IN ('pushed', 'interview_requested')
      ORDER BY jm.match_score DESC
    `).all(req.params.jobId);

    res.json(shortlist);
  } catch (err) {
    console.error('[triage GET /shortlist]', err.message);
    res.status(500).json({ error: 'Failed to fetch shortlist: ' + err.message });
  }
});

module.exports = router;
