const express = require('express');
const router = express.Router();
const db = require('../database');
const { authenticateToken } = require('../middleware/auth');

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

    // Group by stage
    const stages = { saved: [], reviewing: [], interviewed: [], hired: [], passed: [] };
    rows.forEach(r => { if (stages[r.stage]) stages[r.stage].push(r); });
    res.json(stages);
  } catch (err) {
    console.error('[pipeline get]', err.message);
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
// Move to a different stage
router.patch('/:talentId', authenticateToken, requireEmployer, async (req, res) => {
  const talentId = parseInt(req.params.talentId);
  const { stage, notes } = req.body;
  const validStages = ['saved','reviewing','interviewed','hired','passed'];
  if (!validStages.includes(stage)) return res.status(400).json({ error: 'Invalid stage' });
  try {
    const sets = ['stage = ?', 'updated_at = NOW()'];
    const vals = [stage];
    if (notes !== undefined) { sets.push('notes = ?'); vals.push(notes); }
    if (stage === 'hired') { sets.push('hired_at = NOW()'); }
    vals.push(req.user.id, talentId);
    await db.prepare(
      `UPDATE employer_pipeline SET ${sets.join(', ')} WHERE employer_id = ? AND talent_id = ?`
    ).run(...vals);
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
  try {
    await db.prepare(
      `UPDATE employer_pipeline SET stage = 'hired', hired_at = NOW(), updated_at = NOW()
       WHERE employer_id = ? AND talent_id = ?`
    ).run(req.user.id, talentId);
    // Notify talent
    const employer = await db.prepare('SELECT full_name FROM users WHERE id = ?').get(req.user.id);
    await db.prepare(
      "INSERT INTO notifications (user_id, type, title, body, data) VALUES (?, 'hire_confirmed', ?, ?, ?)"
    ).run(talentId, 'Hire Confirmed', `Congratulations! ${employer.full_name} confirmed your hire on WorkBase PH.`, JSON.stringify({ employer_id: req.user.id }));
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
