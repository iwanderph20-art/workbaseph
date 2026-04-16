const express = require('express');
const router = express.Router();
const db = require('../database');
const { authenticateToken } = require('../middleware/auth');
// email import removed — admin job notification disabled

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

// POST /api/jobs/ai-description - Generate job description with AI (template fallback if API unavailable)
router.post('/ai-description', authenticateToken, async (req, res) => {
  const { title, category } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });

  // ── Try AI first ──────────────────────────────────────────────────────────
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic();
    const msg = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `Write a concise, professional job description for a remote role titled "${title}"${category ? ` in the ${category} field` : ''}.
Format it as:
- 2-3 sentences about what the role involves
- 4-5 bullet points for key responsibilities
- Keep it under 200 words. Do not include salary or application instructions.`
      }]
    });
    return res.json({ description: msg.content[0].text });
  } catch(err) {
    console.warn('[ai-description] AI unavailable, using template fallback:', err.message);
    // Fall through to template fallback below
  }

  // ── Template fallback ─────────────────────────────────────────────────────
  const t = title.trim();
  const cat = (category || '').toLowerCase();

  // Determine role flavour from title keywords
  const isManager    = /manager|lead|head|director|supervisor/i.test(t);
  const isDev        = /developer|engineer|programmer|coder|software|fullstack|frontend|backend|mobile/i.test(t);
  const isDesign     = /design|ux|ui|graphic|creative|illustrat/i.test(t);
  const isMarketing  = /market|seo|content|copywrite|social media|ads|growth/i.test(t);
  const isVA         = /virtual assistant|va |executive assistant|admin assist/i.test(t);
  const isFinance    = /accountant|bookkeep|finance|cfo|controller|payroll/i.test(t);
  const isCS         = /customer support|customer service|client success|support agent/i.test(t);
  const isSales      = /sales|business development|account exec|bdr|sdr/i.test(t);
  const isData       = /data|analyst|analytics|bi |business intel/i.test(t);
  const isVideo      = /video|editor|motion|animator/i.test(t);

  let intro = '';
  let bullets = [];

  if (isDev) {
    intro = `We are looking for a skilled ${t} to join our remote team and help build reliable, scalable software solutions. You will collaborate closely with cross-functional teammates to deliver high-quality features from design through deployment.`;
    bullets = [
      'Write clean, well-documented, and maintainable code',
      'Participate in code reviews and contribute to technical discussions',
      'Collaborate with designers and product managers to implement features',
      'Troubleshoot, debug, and optimise existing applications',
      'Follow agile workflows and meet sprint delivery timelines',
    ];
  } else if (isDesign) {
    intro = `We are seeking a talented ${t} to create compelling visual experiences for our brand and products. You will own design projects end-to-end, from concept through final delivery, working closely with our marketing and product teams.`;
    bullets = [
      'Produce high-quality visuals, layouts, and design assets',
      'Translate briefs and feedback into polished deliverables',
      'Maintain brand consistency across all touchpoints',
      'Collaborate with stakeholders to iterate on designs quickly',
      'Organise and manage design files and asset libraries',
    ];
  } else if (isMarketing) {
    intro = `We are hiring a results-driven ${t} to grow our online presence and drive measurable results. You will develop and execute strategies across digital channels to attract, engage, and convert our target audience.`;
    bullets = [
      'Plan and execute campaigns across relevant digital channels',
      'Create engaging content tailored to each platform and audience',
      'Track key metrics and report on campaign performance',
      'Conduct competitor and keyword research to identify opportunities',
      'Collaborate with the design and product teams on launches',
    ];
  } else if (isVA) {
    intro = `We are looking for a proactive ${t} to provide administrative and operational support to our leadership team. You will handle a variety of tasks to keep our business running smoothly so the team can focus on high-impact work.`;
    bullets = [
      'Manage calendars, emails, and scheduling for team members',
      'Coordinate meetings, prepare agendas, and take notes',
      'Handle data entry, document management, and filing',
      'Research and compile information as requested',
      'Assist with ad hoc projects and administrative tasks',
    ];
  } else if (isFinance) {
    intro = `We are seeking a detail-oriented ${t} to manage our financial records and ensure accuracy across all accounts. You will play a critical role in maintaining financial health and compliance for our remote-first business.`;
    bullets = [
      'Maintain accurate bookkeeping and financial records',
      'Prepare monthly, quarterly, and annual financial reports',
      'Manage accounts payable, accounts receivable, and reconciliations',
      'Ensure compliance with relevant tax and regulatory requirements',
      'Support budgeting and financial planning processes',
    ];
  } else if (isCS) {
    intro = `We are looking for a customer-focused ${t} to deliver exceptional support experiences to our clients. You will be the first point of contact for customer enquiries, resolving issues efficiently while representing our brand with professionalism.`;
    bullets = [
      'Respond to customer enquiries via chat, email, or phone promptly',
      'Diagnose and resolve issues with empathy and accuracy',
      'Escalate complex cases to the appropriate team',
      'Document interactions and maintain up-to-date support records',
      'Identify patterns in customer feedback to improve processes',
    ];
  } else if (isSales) {
    intro = `We are hiring an ambitious ${t} to grow our client base and drive revenue. You will identify opportunities, build relationships, and guide prospects through our sales process from first contact to close.`;
    bullets = [
      'Prospect and qualify leads through outbound and inbound channels',
      'Conduct discovery calls and product demonstrations',
      'Build and manage a healthy sales pipeline in our CRM',
      'Negotiate proposals and close deals to meet monthly targets',
      'Collaborate with onboarding and account management on handoffs',
    ];
  } else if (isData) {
    intro = `We are looking for an analytical ${t} to turn data into actionable insights that drive business decisions. You will work across teams to design dashboards, analyse trends, and recommend data-driven improvements.`;
    bullets = [
      'Collect, clean, and organise data from multiple sources',
      'Build dashboards and reports to track key business metrics',
      'Analyse trends and surface insights to stakeholders',
      'Partner with product and operations to define KPIs',
      'Maintain data quality standards and documentation',
    ];
  } else if (isVideo) {
    intro = `We are seeking a creative ${t} to produce polished video content that captivates our audience. You will manage projects from raw footage through final export, ensuring every deliverable aligns with our brand standards.`;
    bullets = [
      'Edit raw footage into compelling, on-brand video content',
      'Add motion graphics, captions, and sound design as needed',
      'Manage multiple projects and meet deadlines consistently',
      'Collaborate with the creative team on concepts and scripts',
      'Organise and archive project files for easy retrieval',
    ];
  } else if (isManager) {
    intro = `We are looking for an experienced ${t} to lead and develop a high-performing remote team. You will set clear goals, drive execution, and ensure your team delivers outstanding results in alignment with company objectives.`;
    bullets = [
      'Set team goals, priorities, and performance expectations',
      'Coach, mentor, and develop team members through regular feedback',
      'Coordinate cross-functional projects and remove blockers',
      'Report on team performance and KPIs to leadership',
      'Foster a positive, collaborative, and accountable team culture',
    ];
  } else {
    // Generic fallback
    intro = `We are looking for a motivated ${t} to join our growing remote team${cat ? ` in the ${category} space` : ''}. You will take ownership of your responsibilities, collaborate with cross-functional teammates, and contribute directly to our company's success.`;
    bullets = [
      `Execute core ${t.toLowerCase()} responsibilities with a high standard of quality`,
      'Collaborate with team members across departments to achieve shared goals',
      'Proactively identify problems and propose practical solutions',
      'Manage your time effectively and meet agreed deadlines',
      'Continuously improve your skills and contribute to team knowledge',
    ];
  }

  const description = `${intro}\n\nKey Responsibilities:\n${bullets.map(b => `• ${b}`).join('\n')}`;
  res.json({ description, generated_by: 'template' });
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

// GET /api/jobs/my-matches — talent sees jobs admin matched them with
router.get('/my-matches', authenticateToken, async (req, res) => {
  if (req.user.role !== 'freelancer') return res.status(403).json({ error: 'Freelancers only' });
  try {
    const matches = await db.prepare(`
      SELECT jm.id AS match_id, jm.match_score, jm.matched_skills, jm.status AS match_status,
             jm.pushed_at AS matched_at,
             j.id AS job_id, j.title, j.description, j.category, j.budget_type,
             j.budget_min, j.budget_max, j.skills_required, j.location,
             j.experience_level, j.project_type, j.time_commitment,
             j.communication_style, j.hiring_urgency, j.engagement_type,
             j.status AS job_status, j.created_at,
             u.full_name AS employer_name
      FROM job_matches jm
      JOIN jobs j ON jm.job_id = j.id
      JOIN users u ON j.employer_id = u.id
      WHERE jm.talent_id = ? AND jm.status IN ('notified', 'applied')
      ORDER BY jm.pushed_at DESC
    `).all(req.user.id);
    res.json(matches);
  } catch (err) {
    console.error('[my-matches] error:', err.message);
    res.status(500).json({ error: 'Failed to fetch matches' });
  }
});

// POST /api/jobs/:id/generate-cover-letter — AI-generated cover letter with template fallback
router.post('/:id/generate-cover-letter', authenticateToken, async (req, res) => {
  if (req.user.role !== 'freelancer') return res.status(403).json({ error: 'Freelancers only' });
  try {
    const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').get(parseInt(req.params.id));
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const talent = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

    // Try AI first
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic();
      const msg = await client.messages.create({
        model: 'claude-opus-4-5',
        max_tokens: 800,
        messages: [{
          role: 'user',
          content: `Write a professional, concise cover letter for this job application.

JOB:
Title: ${job.title}
Category: ${job.category || ''}
Description: ${(job.description || '').slice(0, 500)}
Skills required: ${job.skills_required || 'not specified'}
Experience level: ${job.experience_level || 'not specified'}

APPLICANT:
Name: ${talent.full_name}
Skills: ${talent.skills || 'not listed'}
Bio: ${(talent.bio || '').slice(0, 300)}
Experience level: ${talent.professional_level || 'not specified'}
Availability: ${talent.weekly_availability || 'not specified'}

Write 3 concise paragraphs (under 200 words total). Address it to "Dear Hiring Manager". Sign off as "${talent.full_name}". Do not include placeholders or brackets.`
        }]
      });
      return res.json({ cover_letter: msg.content[0].text });
    } catch (aiErr) {
      console.warn('[cover-letter] AI unavailable, using template:', aiErr.message);
    }

    // Template fallback
    const name      = talent.full_name || 'there';
    const skills    = (talent.skills || '').split(',').slice(0, 4).filter(Boolean).join(', ');
    const bio       = (talent.bio || '').slice(0, 200);
    const avail     = talent.weekly_availability || 'full-time';
    const startDate = talent.start_availability  || 'immediately';
    const cover = `Dear Hiring Manager,

I am writing to express my strong interest in the ${job.title} position. ${bio ? bio + ' ' : ''}With expertise in ${skills || 'the relevant field'}, I am confident I can deliver high-quality work that meets your expectations.

I am particularly excited about this opportunity because it aligns with my background and career goals. I am a reliable, self-motivated professional accustomed to working in a remote environment, and I consistently deliver results on time.

I am available ${avail} and can start ${startDate}. I would love the opportunity to discuss how I can contribute to your team. Thank you for considering my application.

Best regards,
${name}`;
    res.json({ cover_letter: cover });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/jobs/employer/my-jobs - Get employer's own jobs  (must be before /:id)
router.get('/employer/my-jobs', authenticateToken, async (req, res) => {
  if (req.user.role !== 'employer') {
    return res.status(403).json({ error: 'Employers only' });
  }
  try {
    const jobs = await db.prepare(`
      SELECT j.*,
        (SELECT COUNT(*) FROM applications WHERE job_id = j.id) AS application_count,
        (SELECT COUNT(*) FROM job_matches WHERE job_id = j.id AND status IN ('pushed','interview_requested','shortlisted')) AS pushed_count
      FROM jobs j WHERE j.employer_id = ?
      ORDER BY
        CASE j.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END ASC,
        j.created_at DESC
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

  const {
    title, description, category, engagement_type, budget_type, budget_min, budget_max,
    skills_required, location,
    // Gamified post-job fields
    project_type, time_commitment, communication_style, experience_level,
    degree_required, certifications, hiring_urgency,
  } = req.body;
  if (!title || !description || !category || !budget_type) {
    return res.status(400).json({ error: 'Required fields missing' });
  }

  try {
    /* TEMP BYPASS — plan/credits gate disabled */

    const result = await db.prepare(`
      INSERT INTO jobs (employer_id, title, description, category, engagement_type, budget_type, budget_min, budget_max,
        skills_required, location, job_type, is_seeded,
        project_type, time_commitment, communication_style, experience_level,
        degree_required, certifications, hiring_urgency)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'REAL', 0, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.user.id, title, description, category, engagement_type || 'long_term', budget_type,
      budget_min || 0, budget_max || 0, skills_required || '', location || 'Remote',
      project_type || null, time_commitment || null, communication_style || null,
      experience_level || null, degree_required || null, certifications || null, hiring_urgency || null
    );

    /* TEMP BYPASS — credit deduction also disabled */
    /*
    // Deduct a credit if not on subscription
    if (!hasSubscription && hasCredits) {
      await db.prepare('UPDATE users SET post_credits = post_credits - 1 WHERE id = ?').run(req.user.id);
    }
    */

    const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').get(result.lastInsertRowid);

    // Admin job-post notification email removed

    res.status(201).json(job);
  } catch (err) {
    console.error('[jobs POST] error:', err.message);
    res.status(500).json({ error: 'Failed to create job' });
  }
});

// PUT /api/jobs/:id - Update a job
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const jobId = parseInt(req.params.id);
    const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.employer_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });

    const {
      title, description, category, engagement_type,
      budget_type, budget_min, budget_max, skills_required, location, status,
      project_type, time_commitment, communication_style, experience_level,
      degree_required, certifications, hiring_urgency
    } = req.body;

    await db.prepare(`
      UPDATE jobs SET
        title=?, description=?, category=?, engagement_type=?,
        budget_type=?, budget_min=?, budget_max=?, skills_required=?, location=?, status=?,
        project_type=?, time_commitment=?, communication_style=?, experience_level=?,
        degree_required=?, certifications=?, hiring_urgency=?,
        updated_at=NOW()
      WHERE id=?
    `).run(
      title        ?? job.title,
      description  ?? job.description,
      category     ?? job.category,
      engagement_type ?? job.engagement_type ?? 'long_term',
      budget_type  ?? job.budget_type,
      budget_min   ?? job.budget_min,
      budget_max   ?? job.budget_max,
      skills_required ?? job.skills_required,
      location     ?? job.location,
      status       ?? job.status,
      project_type ?? job.project_type,
      time_commitment ?? job.time_commitment,
      communication_style ?? job.communication_style,
      experience_level ?? job.experience_level,
      degree_required ?? job.degree_required,
      certifications ?? job.certifications,
      hiring_urgency ?? job.hiring_urgency,
      jobId
    );

    const updated = await db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    res.json(updated);
  } catch (err) {
    console.error('[jobs PUT] error:', err.message);
    res.status(500).json({ error: 'Failed to update job: ' + err.message });
  }
});

// PATCH /api/jobs/:id/status — quick status change (open / paused / closed)
router.patch('/:id/status', authenticateToken, async (req, res) => {
  const allowed = ['open', 'in_progress', 'closed', 'paused'];
  const { status } = req.body;
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  try {
    const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').get(parseInt(req.params.id));
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.employer_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });
    await db.prepare('UPDATE jobs SET status=?, updated_at=NOW() WHERE id=?').run(status, parseInt(req.params.id));
    res.json({ ok: true, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
        u.talent_status, u.video_loom_link, u.professional_level, u.hourly_rate_range
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
