const express = require('express');
const router = express.Router();
const db = require('../database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const Anthropic = require('@anthropic-ai/sdk');

// GET /api/triage/jobs — list all jobs needing triage (admin only)
router.get('/jobs', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const jobs = await db.prepare(`
      SELECT j.*, u.full_name as employer_name, u.email as employer_email,
             jt.status as triage_status,
             (SELECT COUNT(*) FROM job_matches WHERE job_id = j.id AND status = 'pushed') as pushed_count
      FROM jobs j
      JOIN users u ON j.employer_id = u.id
      LEFT JOIN job_triage jt ON jt.job_id = j.id
      WHERE j.status = 'open'
      ORDER BY j.created_at DESC
    `).all();
    res.json(jobs);
  } catch(err) {
    console.error('[triage GET /jobs]', err.message);
    res.status(500).json({ error: 'Failed to fetch triage jobs' });
  }
});

// POST /api/triage/jobs/:jobId/run — run AI matching for a job
router.post('/jobs/:jobId/run', authenticateToken, requireAdmin, async (req, res) => {
  const { jobId } = req.params;
  try {
    const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    // Get all active talent profiles
    const talents = await db.prepare(`
      SELECT u.id, u.full_name, u.email, u.skills, u.bio, u.professional_level,
             u.education_level, u.hourly_rate_range, u.weekly_availability
      FROM users u
      WHERE u.role = 'freelancer' AND u.talent_status != 'denied'
    `).all();

    if (!talents.length) return res.json({ matches: [], auto_pushed: 0 });

    const client = new Anthropic();

    const prompt = `You are a talent matching system. Given this job post, extract requirements and score each candidate.

JOB POST:
Title: ${job.title}
Description: ${job.description}
Experience Level: ${job.experience_level || 'not specified'}
Skills/Category: ${job.category || 'not specified'}
Certifications: ${job.certifications || 'none'}

CANDIDATES (JSON array):
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

Return a JSON object with this exact structure:
{
  "extracted_skills": ["skill1", "skill2"],
  "experience_required": "junior/mid/senior",
  "matches": [
    {"talent_id": 123, "score": 85, "matched_skills": ["skill1", "skill2"], "reason": "brief reason"}
  ]
}
Sort matches by score descending. Only include candidates with score >= 20. Return ONLY the JSON, no other text.`;

    const msg = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }]
    });

    let result;
    try {
      result = JSON.parse(msg.content[0].text);
    } catch(e) {
      const jsonMatch = msg.content[0].text.match(/\{[\s\S]*\}/);
      result = jsonMatch ? JSON.parse(jsonMatch[0]) : { extracted_skills: [], experience_required: '', matches: [] };
    }

    // Save triage record
    await db.prepare(`INSERT INTO job_triage (job_id, status, ai_extracted_skills, ai_experience_required, triaged_at, triaged_by)
      VALUES (?, 'completed', ?, ?, NOW(), ?)
      ON CONFLICT (job_id) DO UPDATE SET status='completed', ai_extracted_skills=EXCLUDED.ai_extracted_skills,
        ai_experience_required=EXCLUDED.ai_experience_required, triaged_at=NOW(), triaged_by=EXCLUDED.triaged_by`
    ).run(jobId, JSON.stringify(result.extracted_skills), result.experience_required, req.user.id);

    // Save match scores
    for (const match of (result.matches || [])) {
      await db.prepare(`INSERT INTO job_matches (job_id, talent_id, match_score, matched_skills, status)
        VALUES (?, ?, ?, ?, 'suggested')
        ON CONFLICT (job_id, talent_id) DO UPDATE SET match_score=EXCLUDED.match_score, matched_skills=EXCLUDED.matched_skills`
      ).run(jobId, match.talent_id, match.score, JSON.stringify(match.matched_skills));
    }

    // Auto-push candidates with score >= 50
    await db.prepare(`UPDATE job_matches SET status = 'pushed', pushed_at = NOW()
      WHERE job_id = ? AND match_score >= 50 AND status = 'suggested'`).run(jobId);

    res.json({
      extracted_skills: result.extracted_skills,
      matches: result.matches,
      auto_pushed: (result.matches || []).filter(m => m.score >= 50).length
    });
  } catch(err) {
    console.error('[triage POST /run]', err.message);
    res.status(500).json({ error: 'Triage failed: ' + err.message });
  }
});

// GET /api/triage/jobs/:jobId/matches — get matches for a job
router.get('/jobs/:jobId/matches', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const matches = await db.prepare(`
      SELECT jm.*, u.full_name, u.email, u.skills, u.bio, u.professional_level,
             u.profile_pic as profile_pic_url, u.video_loom_link, u.hourly_rate_range, u.weekly_availability
      FROM job_matches jm
      JOIN users u ON jm.talent_id = u.id
      WHERE jm.job_id = ?
      ORDER BY jm.match_score DESC
    `).all(req.params.jobId);
    res.json(matches);
  } catch(err) {
    console.error('[triage GET /matches]', err.message);
    res.status(500).json({ error: 'Failed to fetch matches' });
  }
});

// POST /api/triage/jobs/:jobId/push/:talentId — manually push a candidate
router.post('/jobs/:jobId/push/:talentId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await db.prepare(`UPDATE job_matches SET status = 'pushed', pushed_at = NOW()
      WHERE job_id = ? AND talent_id = ?`).run(req.params.jobId, req.params.talentId);
    res.json({ ok: true });
  } catch(err) {
    console.error('[triage POST /push]', err.message);
    res.status(500).json({ error: 'Failed to push candidate' });
  }
});

// POST /api/triage/jobs/:jobId/request-interview/:talentId — employer requests interview
router.post('/jobs/:jobId/request-interview/:talentId', authenticateToken, async (req, res) => {
  try {
    await db.prepare(`UPDATE job_matches SET status = 'interview_requested', interview_requested_at = NOW()
      WHERE job_id = ? AND talent_id = ?`).run(req.params.jobId, req.params.talentId);
    res.json({ ok: true });
  } catch(err) {
    console.error('[triage POST /request-interview]', err.message);
    res.status(500).json({ error: 'Failed to request interview' });
  }
});

// GET /api/triage/employer/:jobId/shortlist — employer views pushed candidates
router.get('/employer/:jobId/shortlist', authenticateToken, async (req, res) => {
  try {
    const job = await db.prepare('SELECT * FROM jobs WHERE id = ? AND employer_id = ?').get(req.params.jobId, req.user.id);
    if (!job) return res.status(403).json({ error: 'Not authorized' });

    const shortlist = await db.prepare(`
      SELECT jm.match_score, jm.status, jm.interview_requested_at,
             u.full_name, u.email, u.skills, u.bio, u.professional_level,
             u.profile_pic as profile_pic_url, u.video_loom_link, u.hourly_rate_range, u.weekly_availability,
             u.id as talent_id
      FROM job_matches jm
      JOIN users u ON jm.talent_id = u.id
      WHERE jm.job_id = ? AND jm.status IN ('pushed', 'interview_requested')
      ORDER BY jm.match_score DESC
    `).all(req.params.jobId);

    res.json(shortlist);
  } catch(err) {
    console.error('[triage GET /shortlist]', err.message);
    res.status(500).json({ error: 'Failed to fetch shortlist' });
  }
});

module.exports = router;
