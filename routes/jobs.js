const express = require('express');
const router = express.Router();
const db = require('../database');
const { authenticateToken } = require('../middleware/auth');

// GET /api/jobs - List all open jobs (with optional filters)
router.get('/', (req, res) => {
  const { category, budget_type, search, page = 1, limit = 12 } = req.query;
  const offset = (page - 1) * limit;

  let query = `
    SELECT j.*, u.full_name as employer_name, u.is_verified as employer_verified,
    (SELECT COUNT(*) FROM applications WHERE job_id = j.id) as application_count
    FROM jobs j JOIN users u ON j.employer_id = u.id
    WHERE j.status = 'open'
  `;
  const params = [];

  if (category && category !== 'all') {
    query += ' AND j.category = ?';
    params.push(category);
  }
  if (budget_type && budget_type !== 'all') {
    query += ' AND j.budget_type = ?';
    params.push(budget_type);
  }
  if (search) {
    query += ' AND (j.title LIKE ? OR j.description LIKE ? OR j.skills_required LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  const countQuery = query.replace('SELECT j.*, u.full_name as employer_name, u.is_verified as employer_verified,\n    (SELECT COUNT(*) FROM applications WHERE job_id = j.id) as application_count', 'SELECT COUNT(*) as count');
  const total = db.prepare(countQuery).get(...params).count;

  query += ' ORDER BY j.created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), offset);

  const jobs = db.prepare(query).all(...params);
  res.json({ jobs, total, page: parseInt(page), pages: Math.ceil(total / limit) });
});

// GET /api/jobs/categories - Get job categories
router.get('/categories', (req, res) => {
  const categories = db.prepare('SELECT DISTINCT category, COUNT(*) as count FROM jobs WHERE status = "open" GROUP BY category ORDER BY count DESC').all();
  res.json(categories);
});

// GET /api/jobs/:id - Get single job
router.get('/:id', (req, res) => {
  const job = db.prepare(`
    SELECT j.*, u.full_name as employer_name, u.bio as employer_bio, u.is_verified as employer_verified, u.created_at as employer_since
    FROM jobs j JOIN users u ON j.employer_id = u.id
    WHERE j.id = ?
  `).get(req.params.id);

  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// POST /api/jobs - Create a job (employer only)
router.post('/', authenticateToken, (req, res) => {
  if (req.user.role !== 'employer') {
    return res.status(403).json({ error: 'Only employers can post jobs' });
  }

  const { title, description, category, budget_type, budget_min, budget_max, skills_required, location } = req.body;
  if (!title || !description || !category || !budget_type || !budget_min || !budget_max) {
    return res.status(400).json({ error: 'Required fields missing' });
  }

  const result = db.prepare(`
    INSERT INTO jobs (employer_id, title, description, category, budget_type, budget_min, budget_max, skills_required, location)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.user.id, title, description, category, budget_type, budget_min, budget_max, skills_required || '', location || 'Remote');

  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(job);
});

// PUT /api/jobs/:id - Update a job
router.put('/:id', authenticateToken, (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.employer_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });

  const { title, description, category, budget_type, budget_min, budget_max, skills_required, location, status } = req.body;
  db.prepare(`
    UPDATE jobs SET title=?, description=?, category=?, budget_type=?, budget_min=?, budget_max=?, skills_required=?, location=?, status=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(title, description, category, budget_type, budget_min, budget_max, skills_required, location, status, req.params.id);

  const updated = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// DELETE /api/jobs/:id
router.delete('/:id', authenticateToken, (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.employer_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });
  db.prepare('DELETE FROM jobs WHERE id = ?').run(req.params.id);
  res.json({ message: 'Job deleted' });
});

// POST /api/jobs/:id/apply - Apply for a job (freelancer only)
router.post('/:id/apply', authenticateToken, (req, res) => {
  if (req.user.role !== 'freelancer') {
    return res.status(403).json({ error: 'Only freelancers can apply for jobs' });
  }

  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'open') return res.status(400).json({ error: 'This job is no longer accepting applications' });

  const { cover_letter, proposed_rate } = req.body;

  try {
    const result = db.prepare(
      'INSERT INTO applications (job_id, freelancer_id, cover_letter, proposed_rate) VALUES (?, ?, ?, ?)'
    ).run(req.params.id, req.user.id, cover_letter || '', proposed_rate || null);

    res.status(201).json({ message: 'Application submitted successfully', id: result.lastInsertRowid });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'You have already applied for this job' });
    }
    res.status(500).json({ error: 'Failed to submit application' });
  }
});

// GET /api/jobs/employer/my-jobs - Get employer's own jobs
router.get('/employer/my-jobs', authenticateToken, (req, res) => {
  if (req.user.role !== 'employer') {
    return res.status(403).json({ error: 'Employers only' });
  }
  const jobs = db.prepare(`
    SELECT j.*, (SELECT COUNT(*) FROM applications WHERE job_id = j.id) as application_count
    FROM jobs j WHERE j.employer_id = ? ORDER BY j.created_at DESC
  `).all(req.user.id);
  res.json(jobs);
});

// GET /api/jobs/freelancer/my-applications - Get freelancer's applications
router.get('/freelancer/my-applications', authenticateToken, (req, res) => {
  if (req.user.role !== 'freelancer') {
    return res.status(403).json({ error: 'Freelancers only' });
  }
  const applications = db.prepare(`
    SELECT a.*, j.title as job_title, j.category, j.budget_type, j.budget_min, j.budget_max, j.status as job_status,
    u.full_name as employer_name
    FROM applications a
    JOIN jobs j ON a.job_id = j.id
    JOIN users u ON j.employer_id = u.id
    WHERE a.freelancer_id = ? ORDER BY a.created_at DESC
  `).all(req.user.id);
  res.json(applications);
});

module.exports = router;
