const express = require('express');
const router = express.Router();
const db = require('../database');
const { authenticateToken } = require('../middleware/auth');
const { sendEmail, newJobNotificationEmail } = require('../services/email');

// GET /api/jobs - List all open jobs (with optional filters)
router.get('/', async (req, res) => {
  const { category, budget_type, engagement_type, job_type, search, page = 1, limit = 12 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  // Build a shared WHERE + JOIN base so count and data queries stay in sync
  let baseFrom = `FROM jobs j JOIN users u ON j.employer_id = u.id WHERE j.status = 'open'`;
  const params = [];

  if (category && category !== 'all') {
    baseFrom += ' AND j.category = ?';
    params.push(category);
  }
  if (budget_type && budget_type !== 'all') {
    baseFrom += ' AND j.budget_type = ?';
    params.push(budget_type);
  }
  if (engagement_type && engagement_type !== 'all') {
    baseFrom += ' AND j.engagement_type = ?';
    params.push(engagement_type);
  }
  if (job_type && job_type !== 'all') {
    baseFrom += ' AND j.job_type = ?';
    params.push(job_type.toUpperCase());
  }
  if (search) {
    baseFrom += ' AND (j.title ILIKE ? OR j.description ILIKE ? OR j.skills_required ILIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  try {
    const countRow = await db.prepare(`SELECT COUNT(*) as count ${baseFrom}`).get(...params);
    const total = parseInt(countRow.count);

    const dataQuery = `
      SELECT j.*, u.full_name as employer_name, u.is_verified as employer_verified,
        u.trust_score as employer_trust_score,
        u.employer_verification_status,
        u.is_business_verified,
        (SELECT COUNT(*) FROM applications WHERE job_id = j.id) as application_count
      ${baseFrom}
      ORDER BY j.is_seeded ASC, j.created_at DESC LIMIT ? OFFSET ?
    `;
    const jobs = await db.prepare(dataQuery).all(...params, parseInt(limit), offset);

    res.json({ jobs, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
  } catch (err) {
    console.error('[jobs GET /] error:', err.message);
    res.status(500).json({ error: 'Failed to fetch jobs' });
  }
});

// GET /api/jobs/categories - Get job categories
router.get('/categories', async (req, res) => {
  try {
    const categories = await db.prepare(
      "SELECT DISTINCT category, COUNT(*) as count FROM jobs WHERE status = 'open' GROUP BY category ORDER BY count DESC"
    ).all();
    res.json(categories);
  } catch (err) {
    console.error('[categories] error:', err.message);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

// GET /api/jobs/employer/my-jobs - Get employer's own jobs  (must be before /:id)
router.get('/employer/my-jobs', authenticateToken, async (req, res) => {
  if (req.user.role !== 'employer') {
    return res.status(403).json({ error: 'Employers only' });
  }
  try {
    const jobs = await db.prepare(`
      SELECT j.*, (SELECT COUNT(*) FROM applications WHERE job_id = j.id) as application_count
      FROM jobs j WHERE j.employer_id = ? ORDER BY j.created_at DESC
    `).all(req.user.id);
    res.json(jobs);
  } catch (err) {
    console.error('[my-jobs] error:', err.message);
    res.status(500).json({ error: 'Failed to fetch jobs' });
  }
});

// GET /api/jobs/freelancer/my-applications - Get freelancer's applications (must be before /:id)
router.get('/freelancer/my-applications', authenticateToken, async (req, res) => {
  if (req.user.role !== 'freelancer') {
    return res.status(403).json({ error: 'Freelancers only' });
  }
  try {
    const applications = await db.prepare(`
      SELECT a.*, j.title as job_title, j.category, j.budget_type, j.budget_min, j.budget_max, j.status as job_status,
      u.full_name as employer_name
      FROM applications a
      JOIN jobs j ON a.job_id = j.id
      JOIN users u ON j.employer_id = u.id
      WHERE a.freelancer_id = ? ORDER BY a.created_at DESC
    `).all(req.user.id);
    res.json(applications);
  } catch (err) {
    console.error('[my-applications] error:', err.message);
    res.status(500).json({ error: 'Failed to fetch applications' });
  }
});

// GET /api/jobs/:id - Get single job
router.get('/:id', async (req, res) => {
  try {
    const job = await db.prepare(`
      SELECT j.*, u.full_name as employer_name, u.bio as employer_bio, u.is_verified as employer_verified, u.created_at as employer_since
      FROM jobs j JOIN users u ON j.employer_id = u.id
      WHERE j.id = ?
    `).get(parseInt(req.params.id));

    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
  } catch (err) {
    console.error('[jobs GET /:id] error:', err.message);
    res.status(500).json({ error: 'Failed to fetch job' });
  }
});

// POST /api/jobs - Create a job (employer only)
router.post('/', authenticateToken, async (req, res) => {
  if (req.user.role !== 'employer') {
    return res.status(403).json({ error: 'Only employers can post jobs' });
  }

  const { title, description, category, engagement_type, budget_type, budget_min, budget_max, skills_required, location } = req.body;
  if (!title || !description || !category || !budget_type || !budget_min || !budget_max) {
    return res.status(400).json({ error: 'Required fields missing' });
  }

  try {
    /* TEMP BYPASS — plan/credits gate disabled */
    /*
    const employer = await db.prepare(
      'SELECT subscription_tier, subscription_expires_at, post_credits FROM users WHERE id = ?'
    ).get(req.user.id);

    // Check if employer has posting access: active subscription OR post credits
    const hasSubscription = employer.subscription_tier === 'tier_1'
      && employer.subscription_expires_at
      && new Date(employer.subscription_expires_at) > new Date();
    const hasCredits = (employer.post_credits || 0) > 0;

    if (!hasSubscription && !hasCredits) {
      return res.status(402).json({
        error: 'A posting plan is required to publish jobs.',
        code: 'PLAN_REQUIRED',
      });
    }
    */

    const result = await db.prepare(`
      INSERT INTO jobs (employer_id, title, description, category, engagement_type, budget_type, budget_min, budget_max, skills_required, location, job_type, is_seeded)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'REAL', 0)
    `).run(req.user.id, title, description, category, engagement_type || 'long_term', budget_type, budget_min, budget_max, skills_required || '', location || 'Remote');

    /* TEMP BYPASS — credit deduction also disabled */
    /*
    // Deduct a credit if not on subscription
    if (!hasSubscription && hasCredits) {
      await db.prepare('UPDATE users SET post_credits = post_credits - 1 WHERE id = ?').run(req.user.id);
    }
    */

    const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').get(result.lastInsertRowid);

    // Notify admin of new job post (non-blocking)
    const employer = await db.prepare('SELECT full_name, email FROM users WHERE id = ?').get(req.user.id);
    sendEmail({ to: 'admin@workbaseph.com', ...newJobNotificationEmail(employer, job) })
      .catch(err => console.error('[job notification email] failed:', err.message));

    res.status(201).json(job);
  } catch (err) {
    console.error('[jobs POST] error:', err.message);
    res.status(500).json({ error: 'Failed to create job' });
  }
});

// PUT /api/jobs/:id - Update a job
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').get(parseInt(req.params.id));
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.employer_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });

    const { title, description, category, engagement_type, budget_type, budget_min, budget_max, skills_required, location, status } = req.body;
    await db.prepare(`
      UPDATE jobs SET title=?, description=?, category=?, engagement_type=?, budget_type=?, budget_min=?, budget_max=?, skills_required=?, location=?, status=?, updated_at=NOW()
      WHERE id=?
    `).run(title, description, category, engagement_type || 'long_term', budget_type, budget_min, budget_max, skills_required, location, status, parseInt(req.params.id));

    const updated = await db.prepare('SELECT * FROM jobs WHERE id = ?').get(parseInt(req.params.id));
    res.json(updated);
  } catch (err) {
    console.error('[jobs PUT] error:', err.message);
    res.status(500).json({ error: 'Failed to update job' });
  }
});

// DELETE /api/jobs/:id
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').get(parseInt(req.params.id));
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.employer_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });
    await db.prepare('DELETE FROM jobs WHERE id = ?').run(parseInt(req.params.id));
    res.json({ message: 'Job deleted' });
  } catch (err) {
    console.error('[jobs DELETE] error:', err.message);
    res.status(500).json({ error: 'Failed to delete job' });
  }
});

// POST /api/jobs/:id/apply - Apply for a job (freelancer only)
router.post('/:id/apply', authenticateToken, async (req, res) => {
  if (req.user.role !== 'freelancer') {
    return res.status(403).json({ error: 'Only freelancers can apply for jobs' });
  }

  try {
    const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').get(parseInt(req.params.id));
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'open') return res.status(400).json({ error: 'This job is no longer accepting applications' });

    const { cover_letter, proposed_rate } = req.body;

    const result = await db.prepare(
      'INSERT INTO applications (job_id, freelancer_id, cover_letter, proposed_rate, status) VALUES (?, ?, ?, ?, ?)'
    ).run(parseInt(req.params.id), req.user.id, cover_letter || '', proposed_rate || null, 'pending');

    // If pipeline job — also add to talent_pool
    if (job.job_type === 'PIPELINE') {
      await db.prepare(
        'INSERT INTO talent_pool (job_id, freelancer_id) VALUES (?, ?) ON CONFLICT DO NOTHING'
      ).run(job.id, req.user.id);
    }

    res.status(201).json({ message: 'Application submitted successfully', id: result.lastInsertRowid });
  } catch (err) {
    if (err.message && (err.message.includes('unique') || err.message.includes('duplicate'))) {
      return res.status(409).json({ error: 'You have already applied for this job' });
    }
    console.error('[apply] error:', err.message);
    res.status(500).json({ error: 'Failed to submit application' });
  }
});

// GET /api/jobs/:id/applications - Employer views applicants (marks them as viewed)
router.get('/:id/applications', authenticateToken, async (req, res) => {
  if (req.user.role !== 'employer') {
    return res.status(403).json({ error: 'Employers only' });
  }
  try {
    const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').get(parseInt(req.params.id));
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.employer_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });

    const applications = await db.prepare(`
      SELECT a.*, u.full_name, u.bio, u.skills, u.location, u.profile_pic,
        u.talent_status, u.video_loom_link
      FROM applications a
      JOIN users u ON a.freelancer_id = u.id
      WHERE a.job_id = ?
      ORDER BY a.created_at DESC
    `).all(parseInt(req.params.id));

    res.json(applications);
  } catch (err) {
    console.error('[job applications] error:', err.message);
    res.status(500).json({ error: 'Failed to fetch applications' });
  }
});

// PUT /api/jobs/:jobId/applications/:appId/status - Employer updates application status
router.put('/:jobId/applications/:appId/status', authenticateToken, async (req, res) => {
  if (req.user.role !== 'employer') return res.status(403).json({ error: 'Employers only' });

  const { status } = req.body;
  const allowed = ['viewed', 'shortlisted', 'accepted', 'rejected'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
  }

  try {
    const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').get(parseInt(req.params.jobId));
    if (!job || job.employer_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });

    const app = await db.prepare('SELECT * FROM applications WHERE id = ?').get(parseInt(req.params.appId));
    if (!app || app.job_id !== job.id) return res.status(404).json({ error: 'Application not found' });

    let extra = '';
    const params = [status];
    if (status === 'viewed' && !app.viewed_at) {
      extra = ', viewed_at = NOW()';
    } else if (status === 'shortlisted' && !app.shortlisted_at) {
      extra = ', shortlisted_at = NOW()';
      if (!app.viewed_at) extra += ', viewed_at = NOW()';
    } else if (status === 'rejected' && !app.rejected_at) {
      extra = ', rejected_at = NOW()';
    }

    await db.prepare(
      `UPDATE applications SET status = ?${extra} WHERE id = ?`
    ).run(...params, app.id);

    res.json({ message: 'Status updated', status });
  } catch (err) {
    console.error('[update app status] error:', err.message);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// GET /api/jobs/freelancer/my-applications - already returns status; enriched with timestamps
// (Already defined above — no change needed)

// POST /api/jobs/admin/seed - Admin seeds a pipeline/real job
router.post('/admin/seed', authenticateToken, async (req, res) => {
  const { requireAdmin } = require('../middleware/auth');
  // inline admin check
  if (!req.user.admin_role) return res.status(403).json({ error: 'Admin only' });

  const {
    title, description, category, engagement_type, budget_type,
    budget_min, budget_max, skills_required, location, job_type
  } = req.body;

  if (!title || !description || !category || !budget_type || !budget_min || !budget_max) {
    return res.status(400).json({ error: 'Required fields missing' });
  }
  const jt = (job_type || 'PIPELINE').toUpperCase();
  if (!['REAL', 'PIPELINE'].includes(jt)) {
    return res.status(400).json({ error: 'job_type must be REAL or PIPELINE' });
  }

  try {
    const result = await db.prepare(`
      INSERT INTO jobs (employer_id, title, description, category, engagement_type, budget_type,
        budget_min, budget_max, skills_required, location, job_type, is_seeded)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      req.user.id, title, description, category,
      engagement_type || 'gig', budget_type, budget_min, budget_max,
      skills_required || '', location || 'Remote', jt
    );

    const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(job);
  } catch (err) {
    console.error('[seed job] error:', err.message);
    res.status(500).json({ error: 'Failed to seed job' });
  }
});

module.exports = router;
