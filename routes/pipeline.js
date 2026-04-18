const express = require('express');
const router = express.Router();
const db = require('../database');
const { authenticateToken } = require('../middleware/auth');
const { sendEmail, hiredCongratulationsEmail } = require('../services/email');

// Require employer role
function requireEmployer(req, res, next) {
  if (req.user.role !== 'employer') return res.status(403).json({ error: 'Employer only' });
  next();
}

// ── POST /api/pipeline/save/:talentId ────────────────────────────────────────
// Save a talent to the pipeline (stage = 'saved')
router.post('/save/:talentId', authenticateToken, requireEmployer, async (req, res) => {
  const talentId = parseInt(req.params.talentId);
  const { job_id } = req.body;
  try {
    const existing = await db.prepare(
      'SELECT id, stage FROM employer_pipeline WHERE employer_id = ? AND talent_id = ?'
    ).get(req.user.id, talentId);
    if (existing) {
      return res.json({ ok: true, stage: existing.stage, already: true });
    }
    await db.prepare(
      'INSERT INTO employer_pipeline (employer_id, talent_id, stage, job_id) VALUES (?, ?, ?, ?)'
    ).run(req.user.id, talentId, 'saved', job_id || null);
    // Create in-app notification for talent
    const employer = await db.prepare('SELECT full_name FROM users WHERE id = ?').get(req.user.id);
    await db.prepare(
      "INSERT INTO notifications (user_id, type, title, body, data) VALUES (?, 'pipeline_saved', ?, ?, ?)"
    ).run(talentId, 'An employer saved your profile', `${employer.full_name} added you to their talent pipeline.`, JSON.stringify({ employer_id: req.user.id }));
    res.json({ ok: true, stage: 'saved' });
  } catch (err) {
    console.error('[pipeline save]', err.message);
    res.status(500).json({ error: 'Failed to save' });
  }
});

// ── GET /api/pipeline ─────────────────────────────────────────────────────────
// Get all pipeline entries for current employer, grouped by stage
router.get('/', authenticateToken, requireEmployer, async (req, res) => {
  try {
    const rows = await db.prepare(`
      SELECT p.id, p.stage, p.notes, p.job_id, p.hired_at, p.created_at, p.updated_at,
             u.id as talent_id, u.full_name, u.email, u.profile_pic, u.bio, u.skills,
             u.location, u.job_title, u.video_loom_link, u.hourly_rate_range,
             u.talent_status, u.personality_type, u.personality_badge,
             u.resume_file, u.is_top_tier,
             j.title as job_title_ref
      FROM employer_pipeline p
      JOIN users u ON u.id = p.talent_id
      LEFT JOIN jobs j ON j.id = p.job_id
      WHERE p.employer_id = ?
      ORDER BY p.updated_at DESC
    `).all(req.user.id);

    const allStages = ['saved','reviewing','interviewing','interviewed','hired','reject','not_a_fit','applications','passed'];
    const stages = {};
    allStages.forEach(s => { stages[s] = []; });
    rows.forEach(r => { if (stages[r.stage]) stages[r.stage].push(r); });
    res.json(stages);
  } catch (err) {
    console.error('[pipeline get]', err.message);
    res.status(500).json({ error: 'Failed to fetch pipeline' });
  }
});

// ── GET /api/pipeline/job/:jobId ──────────────────────────────────────────────
// Get pipeline + applicants for a specific job, grouped by kanban stage
router.get('/job/:jobId', authenticateToken, requireEmployer, async (req, res) => {
  const jobId = parseInt(req.params.jobId);
  try {
    // Pipeline entries for this job
    const pipelineRows = await db.prepare(`
      SELECT p.id, p.stage, p.notes, p.job_id, p.hired_at, p.created_at, p.updated_at,
             u.id as talent_id, u.full_name, u.email, u.profile_pic, u.bio, u.skills,
             u.location, u.job_title as user_job_title, u.hourly_rate_range,
             u.talent_status, u.resume_file, u.is_top_tier, u.professional_level,
             EXISTS (
               SELECT 1 FROM interview_requests ir
               WHERE ir.employer_id = p.employer_id
                 AND ir.talent_id = p.talent_id
                 AND (ir.job_id = p.job_id OR ir.job_id IS NULL)
                 AND ir.status NOT IN ('cancelled')
             ) AS has_interview
      FROM employer_pipeline p
      JOIN users u ON u.id = p.talent_id
      WHERE p.employer_id = ? AND p.job_id = ?
      ORDER BY p.updated_at DESC
    `).all(req.user.id, jobId);

    // Applicants not yet placed in the pipeline for this job
    const appRows = await db.prepare(`
      SELECT a.id as app_id, a.status as app_status, a.cover_letter, a.created_at,
             u.id as talent_id, u.full_name, u.email, u.profile_pic, u.bio, u.skills,
             u.location, u.job_title as user_job_title, u.hourly_rate_range,
             u.talent_status, u.resume_file, u.is_top_tier, u.professional_level
      FROM applications a
      JOIN users u ON u.id = a.freelancer_id
      WHERE a.job_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM employer_pipeline ep
          WHERE ep.employer_id = ? AND ep.talent_id = a.freelancer_id AND ep.job_id = ?
        )
      ORDER BY a.created_at DESC
    `).all(jobId, req.user.id, jobId);

    // Map old stage names → new stage names for backward compatibility
    const stageMap = {
      applications: 'application_submitted',
      application_submitted: 'application_submitted',
      reviewing: 'under_review',
      under_review: 'under_review',
      interviewing: 'interview_stage',
      interviewed: 'interview_stage',
      interview_stage: 'interview_stage',
      hired: 'hired',
      not_a_fit: 'archived',
      reject: 'archived',
      saved: 'archived',
      archived: 'archived',
    };

    const stages = {
      application_submitted: appRows.map(r => ({ ...r, stage: 'application_submitted', from_application: true })),
      under_review: [], interview_stage: [], hired: [], archived: []
    };
    pipelineRows.forEach(r => {
      const mapped = stageMap[r.stage] || 'archived';
      if (stages[mapped] !== undefined) stages[mapped].push({ ...r, stage: mapped });
    });

    res.json(stages);
  } catch (err) {
    console.error('[pipeline job get]', err.message);
    res.status(500).json({ error: 'Failed to fetch pipeline' });
  }
});

// ── GET /api/pipeline/counts ───────────────────────────────────────────────────
router.get('/counts', authenticateToken, requireEmployer, async (req, res) => {
  try {
    const rows = await db.prepare(
      'SELECT stage, COUNT(*) as c FROM employer_pipeline WHERE employer_id = ? GROUP BY stage'
    ).all(req.user.id);
    const counts = {};
    rows.forEach(r => { counts[r.stage] = parseInt(r.c); });
    res.json(counts);
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

// ── PATCH /api/pipeline/:talentId ─────────────────────────────────────────────
// Move to a different stage (upserts when job_id provided)
router.patch('/:talentId', authenticateToken, requireEmployer, async (req, res) => {
  const talentId = parseInt(req.params.talentId);
  const { stage, notes, job_id } = req.body;
  const validStages = ['application_submitted','under_review','interview_stage','hired','archived',
                       'saved','reviewing','interviewing','interviewed','reject','not_a_fit','applications','passed'];
  if (!validStages.includes(stage)) return res.status(400).json({ error: 'Invalid stage' });
  try {
    if (job_id) {
      // True UPSERT — handles UNIQUE(employer_id, talent_id) constraint safely
      const noteVal = notes !== undefined ? notes : '';
      const hiredExtra = stage === 'hired' ? ', hired_at = NOW()' : '';
      await db.prepare(`
        INSERT INTO employer_pipeline (employer_id, talent_id, stage, job_id, notes${stage === 'hired' ? ', hired_at' : ''})
        VALUES (?, ?, ?, ?, ?${stage === 'hired' ? ', NOW()' : ''})
        ON CONFLICT (employer_id, talent_id)
        DO UPDATE SET stage = EXCLUDED.stage, job_id = EXCLUDED.job_id,
                      notes = EXCLUDED.notes, updated_at = NOW()${hiredExtra}
      `).run(req.user.id, talentId, stage, parseInt(job_id), noteVal);
    } else {
      // Legacy global pipeline (backward compat)
      const existing = await db.prepare(
        'SELECT id FROM employer_pipeline WHERE employer_id = ? AND talent_id = ?'
      ).get(req.user.id, talentId);
      if (!existing) {
        await db.prepare(
          `INSERT INTO employer_pipeline (employer_id, talent_id, stage) VALUES (?, ?, ?)`
        ).run(req.user.id, talentId, stage);
      } else {
        const sets = ['stage = ?', 'updated_at = NOW()'];
        const vals = [stage];
        if (notes !== undefined) { sets.push('notes = ?'); vals.push(notes); }
        if (stage === 'hired') sets.push('hired_at = NOW()');
        vals.push(req.user.id, talentId);
        await db.prepare(
          `UPDATE employer_pipeline SET ${sets.join(', ')} WHERE employer_id = ? AND talent_id = ?`
        ).run(...vals);
      }
    }
    res.json({ ok: true, stage });
  } catch (err) {
    console.error('[pipeline patch]', err.message);
    res.status(500).json({ error: 'Failed to update' });
  }
});

// ── DELETE /api/pipeline/:talentId ────────────────────────────────────────────
router.delete('/:talentId', authenticateToken, requireEmployer, async (req, res) => {
  try {
    await db.prepare(
      'DELETE FROM employer_pipeline WHERE employer_id = ? AND talent_id = ?'
    ).run(req.user.id, parseInt(req.params.talentId));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove' });
  }
});

// ── POST /api/pipeline/:talentId/confirm-hire ─────────────────────────────────
router.post('/:talentId/confirm-hire', authenticateToken, requireEmployer, async (req, res) => {
  const talentId = parseInt(req.params.talentId);
  const { job_id } = req.body;
  try {
    // Update pipeline stage + hired_at
    if (job_id) {
      await db.prepare(
        `UPDATE employer_pipeline SET stage = 'hired', hired_at = NOW(), updated_at = NOW()
         WHERE employer_id = ? AND talent_id = ? AND job_id = ?`
      ).run(req.user.id, talentId, parseInt(job_id));
    } else {
      await db.prepare(
        `UPDATE employer_pipeline SET stage = 'hired', hired_at = NOW(), updated_at = NOW()
         WHERE employer_id = ? AND talent_id = ?`
      ).run(req.user.id, talentId);
    }

    // Pause talent profile so they stop appearing in browse results
    await db.prepare(`UPDATE users SET talent_status = 'hired' WHERE id = ?`).run(talentId);

    // Look up employer name + talent email/name for notifications
    const employer = await db.prepare('SELECT full_name FROM users WHERE id = ?').get(req.user.id);
    const talent   = await db.prepare('SELECT full_name, email FROM users WHERE id = ?').get(talentId);

    // Get job title if available
    let jobTitleStr = '';
    if (job_id) {
      const jobRow = await db.prepare('SELECT title FROM jobs WHERE id = ?').get(parseInt(job_id));
      if (jobRow) jobTitleStr = jobRow.title;
    }

    // In-app notification to talent
    await db.prepare(
      "INSERT INTO notifications (user_id, type, title, body, data) VALUES (?, 'hire_confirmed', ?, ?, ?)"
    ).run(
      talentId,
      'You\'ve Been Hired!',
      `Congratulations! ${employer.full_name} confirmed your hire on WorkBase PH${jobTitleStr ? ` for ${jobTitleStr}` : ''}.`,
      JSON.stringify({ employer_id: req.user.id, job_id: job_id || null })
    );

    // Congratulations email to talent
    if (talent && talent.email) {
      sendEmail({
        to: talent.email,
        ...hiredCongratulationsEmail(talent.full_name, employer.full_name, jobTitleStr)
      }).catch(err => console.error('[confirm-hire email]', err.message));
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[confirm-hire]', err.message);
    res.status(500).json({ error: 'Failed' });
  }
});

// ── GET /api/pipeline/re-engagement ───────────────────────────────────────────
// Return pipeline entries viewed but not moved in 5+ days
router.get('/re-engagement', authenticateToken, requireEmployer, async (req, res) => {
  try {
    const rows = await db.prepare(`
      SELECT p.talent_id, p.stage, p.updated_at,
             u.full_name, u.profile_pic, u.job_title, u.skills
      FROM employer_pipeline p
      JOIN users u ON u.id = p.talent_id
      WHERE p.employer_id = ?
        AND p.stage IN ('saved','reviewing')
        AND p.updated_at < NOW() - INTERVAL '5 days'
      ORDER BY p.updated_at DESC
      LIMIT 5
    `).all(req.user.id);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

module.exports = router;
