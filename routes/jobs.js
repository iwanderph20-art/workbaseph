const express = require('express');
const router = express.Router();
const db = require('../database');
const { authenticateToken, optionalAuth, requireSuperAdmin } = require('../middleware/auth');
const { sendEmail, jobPostTipsEmail, newJobNotificationEmail } = require('../services/email');
const { talentProfileCompletion, isReadyToApply, READY_THRESHOLD } = require('../services/profileCompletion');
const { hasRelevantSkills, keywordScore } = require('../services/skillMatch');
const { distributeJobToTalents } = require('../services/distributeJob');
const { toPublicJob } = require('../services/jobSeo');

// ── Plan post limits ──────────────────────────────────────────────────────────
// 2026-08 single-plan model: every employer is pay-per-post. One active job post per
// $29 All-Access purchase (credit-gated); open/in_progress/paused all count as "active".
// 'standard' = no plan / no access yet. Subscriptions (Essential/Pro) are retired, so any
// legacy plan value resolves to the single 'starter' (pay-per-post) tier.
const PLAN_POST_LIMITS = {
  standard:  0,
  starter:   1,
};

// Resolve any account to the single active tier: 'standard' (no plan, no access) or
// 'starter' (pay-per-post — includes every legacy essential/growth/pro account).
function resolvePlan(user) {
  const rawPlan = user.employer_plan || 'standard';
  return (rawPlan === 'standard' && !user.employer_access) ? 'standard' : 'starter';
}

// A post's 30-day window starts on the $29 credit's purchase date, not when the post itself
// goes live — a credit bought and left unused keeps ticking down, so post soon after buying.
// Matches the oldest not-yet-spent pay_per_post payment_records row for this user (job_id IS
// NULL means it hasn't been applied to a post yet) and links it to the job being (re)opened so
// it can't be spent twice. Falls back to "starting now" only when there's no purchase record to
// match against (e.g. an admin-granted credit).
async function resolveCreditWindow(userId, jobId) {
  const credit = await db.prepare(
    "SELECT id, paid_at FROM payment_records WHERE user_id = ? AND plan = 'pay_per_post' AND job_id IS NULL ORDER BY paid_at ASC LIMIT 1"
  ).get(userId);
  if (!credit) return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await db.prepare('UPDATE payment_records SET job_id = ? WHERE id = ?').run(jobId, credit.id);
  return new Date(new Date(credit.paid_at).getTime() + 30 * 24 * 60 * 60 * 1000);
}

// GET /api/jobs/post-limit — check if employer can post another job
router.get('/post-limit', authenticateToken, async (req, res) => {
  if (req.user.role !== 'employer') return res.json({ can_post: false, reason: 'not_employer' });
  try {
    const user = await db.prepare(
      'SELECT employer_plan, post_credits, employer_access FROM users WHERE id = ?'
    ).get(req.user.id);
    const plan = resolvePlan(user);
    const limit = PLAN_POST_LIMITS[plan] ?? 0;
    const active = parseInt(
      (await db.prepare(
        "SELECT COUNT(*) AS c FROM jobs WHERE employer_id = ? AND status IN ('open','in_progress','paused')"
      ).get(req.user.id))?.c || 0
    );
    const credits = parseInt(user.post_credits || 0);

    if (plan === 'standard')               return res.json({ can_post: false, reason: 'no_plan', plan, limit, active_count: active });
    if (credits <= 0)                      return res.json({ can_post: false, reason: 'no_credits', plan, limit, active_count: active, credits });
    if (limit !== null && active >= limit) return res.json({ can_post: false, reason: 'limit_reached', plan, limit, active_count: active, credits });
    return res.json({ can_post: true, plan, limit, active_count: active, credits });
  } catch (err) {
    console.error('[post-limit]', err.message);
    res.status(500).json({ error: 'Failed to check post limit' });
  }
});

// GET /api/jobs - List all open jobs (with optional filters).
// optionalAuth: logged-in users get the real employer identity; anonymous/public
// callers get it masked (this endpoint is publicly reachable — e.g. the landing-page
// job count — so we must not ship real employer names to the open web).
router.get('/', optionalAuth, async (req, res) => {
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
      ORDER BY j.is_seeded ASC,
               CASE WHEN j.featured_until IS NOT NULL AND j.featured_until > NOW() THEN 0 ELSE 1 END ASC,
               j.created_at DESC LIMIT ? OFFSET ?
    `;
    const rawJobs = await db.prepare(dataQuery).all(...params, parseInt(limit), offset);
    // Anonymous/public callers never see the real employer identity; logged-in users do.
    const jobs = req.user ? rawJobs : rawJobs.map(toPublicJob);

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
    // Default view hides matches the talent archived; ?archived=1 shows only archived ones.
    const onlyArchived = req.query.archived === '1' || req.query.archived === 'true';
    const archiveFilter = onlyArchived
      ? 'jm.talent_archived_at IS NOT NULL'
      : 'jm.talent_archived_at IS NULL';
    const matches = await db.prepare(`
      SELECT jm.id AS match_id, jm.match_score, jm.matched_skills, jm.status AS match_status,
             jm.pushed_at AS matched_at, jm.talent_archived_at,
             j.id AS job_id, j.title, j.description, j.category, j.budget_type,
             j.budget_min, j.budget_max, j.skills_required, j.location,
             j.experience_level, j.project_type, j.time_commitment,
             j.communication_style, j.hiring_urgency, j.engagement_type,
             j.status AS job_status, j.created_at, j.job_code,
             u.full_name AS employer_name,
             EXISTS(SELECT 1 FROM job_favorites jf WHERE jf.job_id = j.id AND jf.talent_id = jm.talent_id) AS is_favorited
      FROM job_matches jm
      JOIN jobs j ON jm.job_id = j.id
      JOIN users u ON j.employer_id = u.id
      WHERE jm.talent_id = ? AND jm.status IN ('notified', 'submitted', 'applied', 'interview_requested')
        AND ${archiveFilter}
      ORDER BY jm.pushed_at DESC
    `).all(req.user.id);
    res.json(matches);
  } catch (err) {
    console.error('[my-matches] error:', err.message);
    res.status(500).json({ error: 'Failed to fetch matches' });
  }
});

// PATCH /api/jobs/matches/:matchId/archive — talent archives (or unarchives) a match so
// it drops off their Job Matches list. Only the owning talent may touch their own match.
router.patch('/matches/:matchId/archive', authenticateToken, async (req, res) => {
  if (req.user.role !== 'freelancer') return res.status(403).json({ error: 'Freelancers only' });
  try {
    const unarchive = req.body && req.body.unarchive;
    const result = await db.prepare(
      `UPDATE job_matches SET talent_archived_at = ${unarchive ? 'NULL' : 'NOW()'}
       WHERE id = ? AND talent_id = ?`
    ).run(req.params.matchId, req.user.id);
    if (!result.changes) return res.status(404).json({ error: 'Match not found' });
    res.json({ ok: true, archived: !unarchive });
  } catch (err) {
    console.error('[match-archive] error:', err.message);
    res.status(500).json({ error: 'Failed to update match' });
  }
});

// GET /api/jobs/open-roles — self-serve board any talent can browse and apply to.
// Includes:
//   • Active Starter (non-subscribed) OPEN jobs — self-serve.
//   • Jobs admin pinned to the board from Job Triage (open_role_override, still open).
// Excludes CLOSED jobs, admin-archived jobs, ACTIVE subscribed jobs (admin-curated), and
// — since the 2026-08 single-plan model — EXPIRED jobs. Once a post's 30-day window ends
// the scheduler auto-pauses it (auto_paused = 1); it is then archived: off this board and
// no longer collecting applications.
router.get('/open-roles', authenticateToken, async (req, res) => {
  if (req.user.role !== 'freelancer') return res.status(403).json({ error: 'Freelancers only' });
  const onlyArchived = req.query.archived === '1' || req.query.archived === 'true';
  try {
    const rows = await db.prepare(`
      SELECT j.id AS job_id, j.title, j.description, j.category, j.budget_type,
             j.budget_min, j.budget_max, j.skills_required, j.nice_to_have_skills,
             j.location, j.experience_level, j.engagement_type, j.job_code, j.created_at,
             -- Logged-in talents see the real employer name here (same as Job Matches /
             -- Applications). Identity is only masked on PUBLIC/social surfaces (SSR job
             -- pages, /api/jobs/public/:id via toPublicJob). Employer EMAIL is never
             -- selected for talents — it stays admin-only.
             u.full_name AS employer_name,
             EXISTS(SELECT 1 FROM applications a WHERE a.job_id = j.id AND a.freelancer_id = ?) AS already_applied,
             EXISTS(SELECT 1 FROM job_favorites jf WHERE jf.job_id = j.id AND jf.talent_id = ?) AS is_favorited
      FROM jobs j
      JOIN users u ON j.employer_id = u.id
      LEFT JOIN open_role_archives ora ON ora.job_id = j.id AND ora.talent_id = ?
      WHERE COALESCE(j.job_type, 'REAL') = 'REAL'
        AND COALESCE(j.admin_archived, FALSE) = FALSE
        AND ${onlyArchived ? 'ora.archived_at IS NOT NULL' : 'ora.archived_at IS NULL'}
        -- 2026-08 single-plan model: every employer is pay-per-post, so every open post is
        -- browsable (the old split that hid subscribed employers' jobs from the board is retired).
        -- 2026-08 single-plan model: once a post's 30-day window ends the scheduler
        -- auto-pauses it (auto_paused = 1). Such posts are ARCHIVED — off the board and
        -- no longer collecting applications (the old "keep piling up to drive a resubscribe"
        -- behaviour is retired). Only genuinely open posts remain browsable.
        AND j.status = 'open'
      ORDER BY j.created_at DESC
      LIMIT 100
    `).all(req.user.id, req.user.id, req.user.id);
    res.json(rows);
  } catch (err) {
    console.error('[open-roles] error:', err.message);
    res.status(500).json({ error: 'Failed to fetch open roles' });
  }
});

// PATCH /api/jobs/open-roles/:jobId/archive — talent dismisses (or restores) an
// open role so it drops off (or returns to) their Open Roles board. One-sided.
router.patch('/open-roles/:jobId/archive', authenticateToken, async (req, res) => {
  if (req.user.role !== 'freelancer') return res.status(403).json({ error: 'Freelancers only' });
  const jobId = parseInt(req.params.jobId);
  if (!jobId) return res.status(400).json({ error: 'Invalid job id' });
  const unarchive = req.body && req.body.unarchive;
  try {
    if (unarchive) {
      await db.prepare('DELETE FROM open_role_archives WHERE talent_id = ? AND job_id = ?')
        .run(req.user.id, jobId);
    } else {
      await db.prepare(
        `INSERT INTO open_role_archives (talent_id, job_id, archived_at)
         VALUES (?, ?, NOW())
         ON CONFLICT (talent_id, job_id) DO UPDATE SET archived_at = NOW()
         RETURNING talent_id`
      ).run(req.user.id, jobId);
    }
    res.json({ ok: true, archived: !unarchive });
  } catch (err) {
    console.error('[open-role-archive] error:', err.message);
    res.status(500).json({ error: 'Failed to update open role' });
  }
});

// POST /api/jobs/:id/favorite — talent toggles a favorite (heart) on any job, matched
// or open-board. One-sided; doesn't affect the job's visibility to anyone else.
router.post('/:id/favorite', authenticateToken, async (req, res) => {
  if (req.user.role !== 'freelancer') return res.status(403).json({ error: 'Freelancers only' });
  const jobId = parseInt(req.params.id);
  if (!jobId) return res.status(400).json({ error: 'Invalid job id' });
  try {
    const existing = await db.prepare('SELECT talent_id FROM job_favorites WHERE talent_id = ? AND job_id = ?').get(req.user.id, jobId);
    if (existing) {
      await db.prepare('DELETE FROM job_favorites WHERE talent_id = ? AND job_id = ?').run(req.user.id, jobId);
      return res.json({ favorited: false });
    }
    await db.prepare('INSERT INTO job_favorites (talent_id, job_id) VALUES (?, ?)').run(req.user.id, jobId);
    res.json({ favorited: true });
  } catch (err) {
    console.error('[job-favorite] error:', err.message);
    res.status(500).json({ error: 'Failed to update favorite' });
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
    // Default view hides jobs the employer archived; ?archived=1 shows only archived ones.
    const onlyArchived = req.query.archived === '1' || req.query.archived === 'true';
    const archiveFilter = onlyArchived
      ? 'j.employer_archived_at IS NOT NULL'
      : 'j.employer_archived_at IS NULL';
    const jobs = await db.prepare(`
      SELECT j.*,
        (SELECT COUNT(*) FROM applications WHERE job_id = j.id) AS application_count,
        (SELECT COUNT(*) FROM applications WHERE job_id = j.id AND status = 'pending') AS new_application_count,
        (SELECT COUNT(*) FROM job_matches WHERE job_id = j.id AND status IN ('notified','submitted','pushed','shortlisted','interview_requested')) AS pushed_count
      FROM jobs j WHERE j.employer_id = ? AND ${archiveFilter}
      ORDER BY
        CASE j.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END ASC,
        CASE WHEN j.featured_until IS NOT NULL AND j.featured_until > NOW() THEN 0 ELSE 1 END ASC,
        j.created_at DESC
    `).all(req.user.id);
    res.json(jobs);
  } catch (err) {
    console.error('[my-jobs] error:', err.message);
    res.status(500).json({ error: 'Failed to fetch jobs' });
  }
});

// PATCH /api/jobs/:id/archive — employer archives (or unarchives) their own job post so
// it drops off the active list without being deleted. Pass { unarchive: true } to restore.
router.patch('/:id/archive', authenticateToken, async (req, res) => {
  if (req.user.role !== 'employer') return res.status(403).json({ error: 'Employers only' });
  try {
    const unarchive = req.body && req.body.unarchive;
    const result = await db.prepare(
      `UPDATE jobs SET employer_archived_at = ${unarchive ? 'NULL' : 'NOW()'}
       WHERE id = ? AND employer_id = ?`
    ).run(req.params.id, req.user.id);
    if (!result.changes) return res.status(404).json({ error: 'Job not found' });
    res.json({ ok: true, archived: !unarchive });
  } catch (err) {
    console.error('[job-archive] error:', err.message);
    res.status(500).json({ error: 'Failed to update job' });
  }
});

// GET /api/jobs/freelancer/my-applications - Get freelancer's applications (must be before /:id)
router.get('/freelancer/my-applications', authenticateToken, async (req, res) => {
  if (req.user.role !== 'freelancer') {
    return res.status(403).json({ error: 'Freelancers only' });
  }
  try {
    // Default view hides applications the talent archived; ?archived=1 shows only archived.
    const onlyArchived = req.query.archived === '1' || req.query.archived === 'true';
    const archiveFilter = onlyArchived
      ? 'a.talent_archived_at IS NOT NULL'
      : 'a.talent_archived_at IS NULL';
    const applications = await db.prepare(`
      SELECT a.*, j.title as job_title, j.id as job_id, j.job_code, j.category, j.budget_type, j.budget_min, j.budget_max, j.status as job_status,
             u.full_name as employer_name,
             ir.interview_status,
             ir.selected_slot,
             CASE ir.selected_slot
               WHEN 'slot1' THEN ir.slot1
               WHEN 'slot2' THEN ir.slot2
               ELSE NULL
             END as interview_time,
             ir.jitsi_link
      FROM applications a
      JOIN jobs j ON a.job_id = j.id
      JOIN users u ON j.employer_id = u.id
      LEFT JOIN LATERAL (
        SELECT ir2.status AS interview_status, ir2.selected_slot, ir2.slot1, ir2.slot2, ir2.jitsi_link
        FROM interview_requests ir2
        WHERE ir2.talent_id = a.freelancer_id
          AND ir2.employer_id = j.employer_id
          AND ir2.status = 'accepted'
          AND (ir2.job_id = a.job_id OR ir2.job_id IS NULL)
        ORDER BY ir2.job_id DESC NULLS LAST, ir2.id DESC
        LIMIT 1
      ) ir ON TRUE
      WHERE a.freelancer_id = ? AND ${archiveFilter}
      ORDER BY a.created_at DESC
    `).all(req.user.id);
    res.json(applications);
  } catch (err) {
    console.error('[my-applications] error:', err.message);
    res.status(500).json({ error: 'Failed to fetch applications' });
  }
});

// PATCH /api/jobs/applications/:appId/archive — talent archives (or unarchives) one of
// their own applications so it drops off their My Jobs list.
router.patch('/applications/:appId/archive', authenticateToken, async (req, res) => {
  if (req.user.role !== 'freelancer') return res.status(403).json({ error: 'Freelancers only' });
  try {
    const unarchive = req.body && req.body.unarchive;
    const result = await db.prepare(
      `UPDATE applications SET talent_archived_at = ${unarchive ? 'NULL' : 'NOW()'}
       WHERE id = ? AND freelancer_id = ?`
    ).run(req.params.appId, req.user.id);
    if (!result.changes) return res.status(404).json({ error: 'Application not found' });
    res.json({ ok: true, archived: !unarchive });
  } catch (err) {
    console.error('[application-archive] error:', err.message);
    res.status(500).json({ error: 'Failed to update application' });
  }
});

// GET /api/jobs/:id - Get single job.
// optionalAuth: logged-in users (e.g. admin) get the real employer identity; anonymous/
// public callers get it masked, since this endpoint is publicly reachable.
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const job = await db.prepare(`
      SELECT j.*, u.full_name as employer_name, u.bio as employer_bio, u.is_verified as employer_verified, u.created_at as employer_since
      FROM jobs j JOIN users u ON j.employer_id = u.id
      WHERE j.id = ?
    `).get(parseInt(req.params.id));

    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(req.user ? job : toPublicJob(job));
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
    skills_required, nice_to_have_skills, location,
    // Gamified post-job fields
    project_type, time_commitment, communication_style, experience_level,
    degree_required, certifications, hiring_urgency, company_website, company_description,
    company_name,
    work_timezone, employer_country,
    number_of_hires,
  } = req.body;
  if (!title || !description || !category || !budget_type) {
    return res.status(400).json({ error: 'Required fields missing' });
  }
  // Openings: clamp to a sane 1–99, default 1.
  const numHires = Math.min(99, Math.max(1, parseInt(number_of_hires, 10) || 1));

  try {
    // ── Plan / limit gate ─────────────────────────────────────────────────────
    const user  = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const plan  = resolvePlan(user);
    const limit = PLAN_POST_LIMITS[plan] ?? 0;
    const active = parseInt(
      (await db.prepare(
        "SELECT COUNT(*) AS c FROM jobs WHERE employer_id = ? AND status IN ('open','in_progress','paused')"
      ).get(req.user.id))?.c || 0
    );
    const credits = parseInt(user.post_credits || 0);

    if (plan === 'standard') {
      return res.status(403).json({ error: 'No active plan. Please select a plan to post jobs.', code: 'NO_PLAN' });
    }
    // Single-plan model (2026-08): every employer is pay-per-post — a $29 post is credit-gated.
    if (credits <= 0) {
      return res.status(403).json({ error: 'No post credits remaining. Buy a $29 post to continue.', code: 'NO_CREDITS' });
    }
    if (limit !== null && active >= limit) {
      return res.status(403).json({
        error: `You've reached the ${limit} active job posts allowed. Close or delete a post to free a slot.`,
        code: 'LIMIT_REACHED', plan, limit, active_count: active,
      });
    }

    const result = await db.prepare(`
      INSERT INTO jobs (employer_id, title, description, category, engagement_type, budget_type, budget_min, budget_max,
        skills_required, nice_to_have_skills, location, job_type, is_seeded,
        project_type, time_commitment, communication_style, experience_level,
        degree_required, certifications, hiring_urgency, company_website, company_description,
        company_name, work_timezone, employer_country, number_of_hires)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'REAL', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.user.id, title, description, category, engagement_type || 'long_term', budget_type,
      budget_min || 0, budget_max || 0, skills_required || '', nice_to_have_skills || '', location || 'Remote',
      project_type || null, time_commitment || null, communication_style || null,
      experience_level || null, degree_required || null, certifications || null, hiring_urgency || null,
      company_website || null, company_description || null,
      (company_name && company_name.trim()) || null, work_timezone || null, employer_country || null, numHires
    );

    // Deduct a post credit for Starter plan
    if (plan === 'starter') {
      await db.prepare('UPDATE users SET post_credits = post_credits - 1 WHERE id = ?').run(req.user.id);
    }

    const newJobId = result.lastInsertRowid;

    // Single-plan model (2026-08): EVERY post is one pay-per-post job that runs for its own fresh
    // 30-day window (then the expiry scheduler archives it) and is pinned to the public Open Roles
    // board via open_role_override — so "auto-post to open roles" is guaranteed for every post,
    // independent of the employer's plan value. The window itself starts on the credit's purchase
    // date — see resolveCreditWindow.
    const expiresAt = plan === 'starter'
      ? await resolveCreditWindow(req.user.id, newJobId)
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await db.prepare('UPDATE jobs SET expires_at = ?, open_role_override = TRUE WHERE id = ?').run(expiresAt.toISOString(), newJobId);

    // Generate permanent job code: employer initials + zero-padded job ID (e.g. MS-0042)
    const employer = await db.prepare('SELECT full_name FROM users WHERE id = ?').get(req.user.id);
    const initials = (employer.full_name || 'WB')
      .trim().split(/\s+/).map(w => (w[0] || '')).join('').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) || 'WB';
    const jobCode = `${initials}-${String(newJobId).padStart(4, '0')}`;
    await db.prepare('UPDATE jobs SET job_code = ? WHERE id = ?').run(jobCode, newJobId);

    const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').get(newJobId);

    // ── Auto-distribute to skill-matched talents (hands-free, single-plan model) ──
    // Based on the employer's chosen skills, surface the job in the Job Matches of every talent
    // whose skills match or are relevant to it (as many as possible). In-app only — no emails/pushes.
    // The post also auto-shows on the public Open Roles board via open_role_override (set above).
    try {
      const distributed = await distributeJobToTalents(job);
      console.log(`[auto-match] job ${newJobId} → ${distributed} skill-matched talents`);
    } catch (e) { console.error('[auto-match]', e.message); }

    // Notify admin of new job post
    const adminEmail = process.env.ADMIN_NOTIFY_EMAIL || 'admin@workbaseph.com';
    sendEmail({ to: adminEmail, ...newJobNotificationEmail(employer, job) })
      .catch(err => console.error('[new job admin notify]', err.message));

    // Send improvement tips email if salary is missing or description is short
    const wordCount = (description || '').trim().split(/\s+/).filter(Boolean).length;
    const tips = [];
    if (budget_type === 'quotes' || (!budget_min && !budget_max)) {
      tips.push({
        num: tips.length + 1,
        title: 'Pay range or budget',
        body: 'Your post currently shows no pay information. Specialists skip posts without a visible rate because they can\'t assess if it\'s worth their time — even a rough range (e.g. $8–$15/hr or $500 fixed) filters out mismatches early and builds trust.',
        benefit: '✓ Posts with a visible pay range receive 3x more applications and attract candidates who are already budget-aligned.'
      });
    }
    if (wordCount < 80) {
      tips.push({
        num: tips.length + 1,
        title: 'Job description length',
        body: `Your description is around ${wordCount} word${wordCount !== 1 ? 's' : ''} — most specialists want at least 100 words before applying. Add key responsibilities, must-have skills, working hours, and how you prefer to communicate.`,
        benefit: '✓ Detailed descriptions get 2x better applicant fit and reduce back-and-forth screening time.'
      });
    }
    if (tips.length > 0) {
      sendEmail({
        to: req.user.email,
        ...jobPostTipsEmail(employer.full_name || 'there', title, tips)
      }).catch(err => console.error('[job post tips email]', err.message));
    }

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
      degree_required, certifications, hiring_urgency, work_timezone, employer_country,
      number_of_hires
    } = req.body;
    const numHires = number_of_hires == null
      ? (job.number_of_hires ?? 1)
      : Math.min(99, Math.max(1, parseInt(number_of_hires, 10) || 1));

    await db.prepare(`
      UPDATE jobs SET
        title=?, description=?, category=?, engagement_type=?,
        budget_type=?, budget_min=?, budget_max=?, skills_required=?, location=?, status=?,
        project_type=?, time_commitment=?, communication_style=?, experience_level=?,
        degree_required=?, certifications=?, hiring_urgency=?,
        work_timezone=?, employer_country=?, number_of_hires=?,
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
      work_timezone ?? job.work_timezone,
      employer_country ?? job.employer_country,
      numHires,
      jobId
    );

    const updated = await db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);

    // Re-distribute on edit: if the employer changed the skills/title/category, surface the job to
    // any newly-relevant talents (idempotent — only talents not already matched are added). Only
    // for live posts; a closed/expired post shouldn't fan back out.
    if (updated.status === 'open' && (!updated.expires_at || new Date(updated.expires_at) > new Date())) {
      try {
        const added = await distributeJobToTalents(updated);
        if (added) console.log(`[auto-match] job ${jobId} edit → ${added} new skill-matched talents`);
      } catch (e) { console.error('[auto-match on edit]', e.message); }
    }

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

    // Reactivating a locked post — either its own 30-day window closed (flat-fee employers), or
    // a legacy Essential/Growth/Pro subscription lapsed (their own 30-day window runs off the
    // subscription, not the job) — this UNLOCKS its applicants, starts a fresh 30-day run, and
    // costs one $29 post credit. Spend a credit if they have one; otherwise tell the client to
    // send them to a $29 checkout (which reopens the post on capture — see activatePayment).
    // Paying migrates a legacy subscriber onto the flat-fee 'starter' plan going forward.
    const emp = await db.prepare(
      'SELECT employer_plan, subscription_tier, subscription_expires_at, post_credits FROM users WHERE id = ?'
    ).get(req.user.id);
    const isLegacyPlan = ['essential', 'growth', 'pro'].includes(emp?.employer_plan);
    const subscriptionLapsed = isLegacyPlan && !(
      emp.subscription_tier === 'tier_1' &&
      emp.subscription_expires_at &&
      new Date(emp.subscription_expires_at) > new Date()
    );
    const jobWindowExpired = !isLegacyPlan && job.expires_at && new Date(job.expires_at) < new Date();

    if (status === 'open' && (jobWindowExpired || subscriptionLapsed)) {
      if ((emp?.post_credits || 0) <= 0) {
        return res.status(402).json({
          error: subscriptionLapsed
            ? 'Your plan has lapsed. Unlock this post for $29 to view its applicants and move to pay-per-post.'
            : 'This listing has completed its 30-day run. Reactivate it for $29 to unlock its applicants and start a fresh 30-day run.',
          code: 'NEEDS_CREDIT',
          job_id: parseInt(req.params.id),
        });
      }
      await db.prepare(
        "UPDATE users SET post_credits = post_credits - 1, employer_plan = 'starter' WHERE id = ? AND post_credits > 0"
      ).run(req.user.id);
      const reactivateJobId = parseInt(req.params.id);
      const expiresAt = await resolveCreditWindow(req.user.id, reactivateJobId);
      await db.prepare("UPDATE jobs SET status='open', auto_paused=0, expires_at=?, updated_at=NOW() WHERE id=?").run(expiresAt.toISOString(), reactivateJobId);
      return res.json({ ok: true, status: 'open', reactivated: true });
    }

    // Manually re-opening clears any system auto-pause flag so it won't bounce back
    await db.prepare('UPDATE jobs SET status=?, auto_paused = CASE WHEN ?=\'open\' THEN 0 ELSE auto_paused END, updated_at=NOW() WHERE id=?')
      .run(status, status, parseInt(req.params.id));
    res.json({ ok: true, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/jobs/:id/mark-applications-viewed — clears new-applicant badge
// Called when employer opens the View Applications modal for a job.
router.patch('/:id/mark-applications-viewed', authenticateToken, async (req, res) => {
  try {
    const jobId = parseInt(req.params.id);
    // Verify this employer owns the job
    const job = await db.prepare('SELECT employer_id FROM jobs WHERE id = ?').get(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.employer_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });
    // Mark all pending applications as viewed
    await db.prepare(
      `UPDATE applications SET status = 'viewed' WHERE job_id = ? AND status = 'pending'`
    ).run(jobId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[mark-applications-viewed]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/jobs/:id
router.delete('/:id', authenticateToken, async (req, res) => {
  const jobId = parseInt(req.params.id);
  try {
    const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.employer_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });

    // Delete child records that lack ON DELETE CASCADE before removing the job
    await db.prepare('DELETE FROM applications WHERE job_id = ?').run(jobId);
    await db.prepare('DELETE FROM reviews WHERE job_id = ?').run(jobId);

    await db.prepare('DELETE FROM jobs WHERE id = ?').run(jobId);
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
    // Talents can still apply while a job is MANUALLY paused by the EMPLOYER (auto_paused = 0,
    // admin_paused = 0) — this lets employers gauge demand before reopening. An ADMIN pause
    // (admin_paused = 1) blocks applications outright — that's the whole point of the admin
    // having a pause action distinct from the employer's own. A job the scheduler auto-paused
    // (auto_paused = 1, past its 30-day window + the one-week grace period) is fully closed and
    // stops accepting applications too. 'closed' (and other terminal states) also stop.
    // The grace period means a lapsed post keeps accepting applications for one extra week
    // after its nominal expires_at before it's actually cut off — see runStarterExpiryScheduler.
    const GRACE_MS = 7 * 24 * 60 * 60 * 1000;
    const windowExpired = job.expires_at && (new Date(job.expires_at).getTime() + GRACE_MS) < Date.now();
    const adminPaused = job.admin_paused === 1 || job.admin_paused === true;
    if ((job.status !== 'open' && job.status !== 'paused') || job.auto_paused === 1 || adminPaused || windowExpired) {
      return res.status(400).json({ error: 'This job is no longer accepting applications' });
    }

    // Already applied? Answer up front rather than letting the insert trip
    // UNIQUE(job_id, freelancer_id) and reporting it as a database error.
    const existingApp = await db.prepare(
      'SELECT id, created_at FROM applications WHERE job_id = ? AND freelancer_id = ? LIMIT 1'
    ).get(parseInt(req.params.id), req.user.id);
    if (existingApp) {
      return res.status(409).json({
        error: 'You have already applied to this job. Track it in My Jobs on your dashboard.',
        code: 'ALREADY_APPLIED',
        applied_at: existingApp.created_at,
      });
    }

    // If WorkBase already submitted this talent's profile to the employer (Talent Triage
    // curation → status 'submitted'), they can't self-apply — their profile is already in
    // front of the employer, who will reach out with an interview invite if interested.
    const submittedMatch = await db.prepare(
      `SELECT 1 FROM job_matches WHERE job_id = ? AND talent_id = ? AND status = 'submitted' LIMIT 1`
    ).get(parseInt(req.params.id), req.user.id);
    if (submittedMatch) {
      return res.status(403).json({
        error: 'Your profile has already been submitted to this employer by WorkBase. They will reach out with an interview invite if interested — no need to apply.',
        code: 'ALREADY_SUBMITTED',
      });
    }

    // Profile-completion gate — applies ONLY to talents admin actively sent this job to
    // (a job_matches row past the bare 'suggested' stage). Those talents must finish
    // their profile before applying from their dashboard. Outside talents who find the
    // job themselves and apply via the public job page are an acquisition channel and
    // are NEVER blocked here, regardless of profile completeness.
    const wasMatchedByAdmin = await db.prepare(
      `SELECT 1 FROM job_matches WHERE job_id = ? AND talent_id = ? AND status <> 'suggested' LIMIT 1`
    ).get(parseInt(req.params.id), req.user.id);
    if (wasMatchedByAdmin) {
      const applicant = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
      // Incomplete profiles may still apply IF they clearly have the relevant skills
      // for this job — skills are the strongest match signal, so we don't block them.
      const jobForSkills = await db.prepare(
        'SELECT title, skills_required, nice_to_have_skills, category, description, experience_level, certifications, project_type FROM jobs WHERE id = ?'
      ).get(parseInt(req.params.id));
      if (!isReadyToApply(applicant) && !hasRelevantSkills(jobForSkills, applicant)) {
        return res.status(403).json({
          error: `Please add your skills or complete your profile before applying. You're ${talentProfileCompletion(applicant)}% complete — add the skills relevant to this role, or reach ${READY_THRESHOLD}%, to apply.`,
          code: 'PROFILE_INCOMPLETE',
          completion: talentProfileCompletion(applicant),
        });
      }
    }

    const { cover_letter, proposed_rate, application_video_link } = req.body;

    const result = await db.prepare(
      'INSERT INTO applications (job_id, freelancer_id, cover_letter, proposed_rate, status, application_video_link) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(parseInt(req.params.id), req.user.id, cover_letter || '', proposed_rate || null, 'pending', application_video_link || null);

    // Mark any job_match entry as 'applied' so it drops off the talent's Job Matches tab
    await db.prepare(
      `UPDATE job_matches SET status = 'applied' WHERE job_id = ? AND talent_id = ?`
    ).run(parseInt(req.params.id), req.user.id);

    // If pipeline job — also add to talent_pool
    if (job.job_type === 'PIPELINE') {
      await db.prepare(
        'INSERT INTO talent_pool (job_id, freelancer_id) VALUES (?, ?) ON CONFLICT DO NOTHING'
      ).run(job.id, req.user.id);
    }

    res.status(201).json({ message: 'Application submitted successfully', id: result.lastInsertRowid });
  } catch (err) {
    // Backstop for the race the pre-check can't close: two submits landing together.
    // 23505 is Postgres unique_violation; the message test covers drivers that don't
    // surface a code.
    if (err.code === '23505' || /unique|duplicate/i.test(err.message || '')) {
      return res.status(409).json({
        error: 'You have already applied to this job. Track it in My Jobs on your dashboard.',
        code: 'ALREADY_APPLIED',
      });
    }
    console.error('[apply] error:', err.message);
    res.status(500).json({ error: 'Failed to submit application' });
  }
});

// GET /api/jobs/:jobId/cover-letter/:talentId — employer fetches cover letter for a specific applicant
router.get('/:jobId/cover-letter/:talentId', authenticateToken, async (req, res) => {
  if (req.user.role !== 'employer') return res.status(403).json({ error: 'Employers only' });
  try {
    const jobId    = parseInt(req.params.jobId);
    const talentId = parseInt(req.params.talentId);
    const job = await db.prepare('SELECT employer_id FROM jobs WHERE id = ?').get(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.employer_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });
    const app = await db.prepare(
      'SELECT cover_letter, status, created_at FROM applications WHERE job_id = ? AND freelancer_id = ?'
    ).get(jobId, talentId);
    if (!app) return res.json({ cover_letter: null });
    res.json({ cover_letter: app.cover_letter || null, status: app.status, applied_at: app.created_at });
  } catch (err) {
    res.status(500).json({ error: err.message });
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

    const emp = await db.prepare(
      'SELECT employer_plan, subscription_tier, subscription_expires_at FROM users WHERE id = ?'
    ).get(req.user.id);

    // Legacy Essential/Growth/Pro subscribers have their OWN 30-day window: it starts when
    // they subscribed, not when they posted a job — a lapsed subscription locks applicant
    // access on ALL their jobs immediately, regardless of any individual job's own expires_at.
    const isLegacyPlan = ['essential', 'growth', 'pro'].includes(emp?.employer_plan);
    const subscriptionLapsed = isLegacyPlan && !(
      emp.subscription_tier === 'tier_1' &&
      emp.subscription_expires_at &&
      new Date(emp.subscription_expires_at) > new Date()
    );

    // Flat $29-per-post employers (2026-08 single-plan rule) instead have a per-job 30-day
    // window: once THAT post's window closes, its applicant list is locked until they post
    // again for $29. Nothing is deleted; the count is shown to drive the $29 unlock.
    const jobWindowExpired = !isLegacyPlan && job.expires_at && new Date(job.expires_at) < new Date();

    if (subscriptionLapsed || jobWindowExpired) {
      const countRow = await db.prepare('SELECT COUNT(*) AS c FROM applications WHERE job_id = ?').get(parseInt(req.params.id));
      return res.json({
        locked: true,
        code: subscriptionLapsed ? 'SUBSCRIPTION_EXPIRED' : 'STARTER_WINDOW_EXPIRED',
        plan: emp?.employer_plan,
        application_count: parseInt(countRow?.c || 0),
        applications: [],
      });
    }

    const applications = await db.prepare(`
      SELECT a.*, u.full_name, u.email, u.bio, u.skills, u.location, u.profile_pic,
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

    const seedId = result.lastInsertRowid;
    const seedEmployer = await db.prepare('SELECT full_name FROM users WHERE id = ?').get(req.user.id);
    const seedInitials = (seedEmployer.full_name || 'WB')
      .trim().split(/\s+/).map(w => (w[0] || '')).join('').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) || 'WB';
    await db.prepare('UPDATE jobs SET job_code = ? WHERE id = ?').run(`${seedInitials}-${String(seedId).padStart(4,'0')}`, seedId);

    const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').get(seedId);
    res.status(201).json(job);
  } catch (err) {
    console.error('[seed job] error:', err.message);
    res.status(500).json({ error: 'Failed to seed job' });
  }
});

// POST /api/jobs/admin/post-open-role — admin posts a real open role that appears
// on eligible talent's Open Roles board (open_role_override bypasses plan gating).
router.post('/admin/post-open-role', requireSuperAdmin, async (req, res) => {
  const {
    title, description, category, engagement_type, budget_type,
    budget_min, budget_max, skills_required, location
  } = req.body;

  if (!title || !description || !category || !budget_type || budget_min == null || budget_max == null) {
    return res.status(400).json({ error: 'Required fields missing' });
  }
  const eng = engagement_type || 'long_term';
  if (!['long_term', 'gig'].includes(eng)) {
    return res.status(400).json({ error: "engagement_type must be 'long_term' or 'gig'" });
  }
  if (!['fixed', 'hourly'].includes(budget_type)) {
    return res.status(400).json({ error: "budget_type must be 'fixed' or 'hourly'" });
  }

  try {
    const result = await db.prepare(`
      INSERT INTO jobs (employer_id, title, description, category, engagement_type, budget_type,
        budget_min, budget_max, skills_required, location, job_type, status, open_role_override)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'REAL', 'open', TRUE)
    `).run(
      req.user.id, title, description, category,
      eng, budget_type, budget_min, budget_max,
      skills_required || '', location || 'Remote'
    );

    const newId = result.lastInsertRowid;
    const emp = await db.prepare('SELECT full_name FROM users WHERE id = ?').get(req.user.id);
    const initials = (emp?.full_name || 'WB')
      .trim().split(/\s+/).map(w => (w[0] || '')).join('').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) || 'WB';
    await db.prepare('UPDATE jobs SET job_code = ? WHERE id = ?').run(`${initials}-${String(newId).padStart(4, '0')}`, newId);

    const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').get(newId);
    res.status(201).json(job);
  } catch (err) {
    console.error('[post-open-role] error:', err.message);
    res.status(500).json({ error: 'Failed to post open role' });
  }
});

// GET /api/jobs/public/:id — no auth, for social referral landing pages
router.get('/public/:id', async (req, res) => {
  try {
    const job = await db.prepare(`
      SELECT j.id, j.title, j.description, j.category, j.engagement_type,
             j.budget_type, j.budget_min, j.budget_max, j.skills_required,
             j.location, j.status, j.created_at, j.job_code,
             j.experience_level, j.time_commitment, j.hiring_urgency,
             j.project_type, j.certifications, j.number_of_hires,
             j.work_timezone, j.employer_country, j.company_name,
             u.full_name AS employer_name
      FROM jobs j
      JOIN users u ON j.employer_id = u.id
      WHERE j.job_code = ?
    `).get(req.params.id);
    // fall back to numeric ID lookup if param is all digits
    const jobByCode = job;
    if (!jobByCode && /^\d+$/.test(req.params.id)) {
      const jobById = await db.prepare(`
        SELECT j.id, j.title, j.description, j.category, j.engagement_type,
               j.budget_type, j.budget_min, j.budget_max, j.skills_required,
               j.location, j.status, j.created_at, j.job_code,
               j.experience_level, j.time_commitment, j.hiring_urgency,
               j.project_type, j.certifications, j.number_of_hires,
               j.work_timezone, j.employer_country, j.company_name,
               u.full_name AS employer_name
        FROM jobs j
        JOIN users u ON j.employer_id = u.id
        WHERE j.id = ?
      `).get(req.params.id);
      if (!jobById || jobById.status === 'closed') return res.status(404).json({ error: 'Job not found or no longer available' });
      // Identity-safe public view: generic employer + general description.
      return res.json(toPublicJob(jobById));
    }
    if (!job) return res.status(404).json({ error: `Job "${req.params.id}" not found in database` });
    if (job.status === 'closed') return res.status(404).json({ error: `Job "${req.params.id}" exists but is closed` });
    res.json(toPublicJob(job));
  } catch (err) {
    console.error('[jobs/public] error:', err.message);
    res.status(500).json({ error: 'Failed to load job' });
  }
});

module.exports = router;
