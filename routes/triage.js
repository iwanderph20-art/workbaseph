const express = require('express');
const router  = express.Router();
const db      = require('../database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { sendEmail, jobMatchEmail, profileCompleteInviteEmail } = require('../services/email');
const { talentProfileCompletion, isReadyToApply } = require('../services/profileCompletion');

// ─── Skill synonym groups (any word in a group matches any other in the group) ─
const SKILL_SYNONYMS = [
  ['javascript','js','node.js','nodejs','node','typescript','ts','es6','ecmascript','react native','expo'],
  ['react','reactjs','react.js','next.js','nextjs','next','redux','zustand'],
  ['vue','vuejs','vue.js','nuxt','nuxtjs','quasar'],
  ['angular','angularjs','angular.js','ng'],
  ['python','django','flask','fastapi','pandas','numpy','scipy'],
  ['php','laravel','wordpress','wp','elementor','divi','woocommerce','magento'],
  ['ruby','rails','ruby on rails','sinatra'],
  ['java','spring','springboot','spring boot','maven','gradle'],
  ['kotlin','android','android studio','mobile development','flutter','dart'],
  ['swift','ios','xcode','objective-c'],
  ['sql','mysql','postgresql','postgres','database','databases','db','mongodb','nosql','redis','supabase','firebase'],
  ['aws','amazon web services','cloud','azure','gcp','google cloud','digitalocean','heroku','railway'],
  ['devops','docker','kubernetes','k8s','ci/cd','github actions','jenkins','nginx'],
  ['figma','sketch','adobe xd','ux','ui','user interface','user experience','wireframe','prototype'],
  ['photoshop','illustrator','indesign','adobe','lightroom','affinity','graphic design','canva'],
  ['video editing','premiere','after effects','final cut','final cut pro','davinci','davinci resolve','capcut','avid'],
  ['social media','facebook','instagram','tiktok','twitter','x (twitter)','linkedin','youtube','pinterest','snapchat','threads'],
  ['seo','sem','search engine optimisation','search engine optimization','google analytics','google ads','adwords','ppc','ahrefs','semrush','moz'],
  ['email marketing','mailchimp','klaviyo','hubspot','activecampaign','convertkit','newsletter','drip','marketo'],
  ['copywriting','content writing','blogging','article writing','copywriter','content creation','ghostwriting','scriptwriting'],
  ['customer support','customer service','helpdesk','zendesk','freshdesk','intercom','live chat','client success'],
  ['data entry','data analysis','excel','google sheets','spreadsheet','airtable','notion','tableau','power bi'],
  ['project management','asana','trello','jira','monday','notion','clickup','basecamp','scrum','agile','kanban'],
  ['accounting','bookkeeping','quickbooks','xero','invoicing','payroll','accounts payable','accounts receivable'],
  ['virtual assistant','va','executive assistant','admin assistant','administrative'],
  ['lead generation','sales','cold calling','outreach','crm','salesforce','hubspot','pipedrive','cold email'],
  ['chatgpt','ai','artificial intelligence','machine learning','ml','openai','llm','generative ai','prompt engineering'],
  ['shopify','ecommerce','e-commerce','woo','woocommerce','dropshipping','print on demand'],
  ['wordpress','wp','elementor','divi','gutenberg','cms','content management'],
  ['zapier','make','integromat','automation','n8n','workflow automation'],
];

// Expand text with synonyms: if a word/phrase is found, add the whole synonym group
function expandWithSynonyms(text) {
  let expanded = text;
  for (const group of SKILL_SYNONYMS) {
    if (group.some(term => text.includes(term))) {
      expanded += ' ' + group.join(' ');
    }
  }
  return expanded;
}

// ─── Keyword-based scorer with synonym expansion ──────────────────────────────
function keywordScore(job, talent) {
  const rawJob    = [job.title, job.description, job.category, job.skills_required,
                     job.experience_level, job.certifications, job.project_type]
    .filter(Boolean).join(' ').toLowerCase();
  const rawTalent = [talent.skills, talent.bio, talent.professional_level, talent.education_level]
    .filter(Boolean).join(' ').toLowerCase();

  const jobText    = expandWithSynonyms(rawJob);
  const talentText = expandWithSynonyms(rawTalent);

  // Extract meaningful words from job (4+ chars, deduplicated)
  const jobWords = [...new Set((jobText.match(/\b\w{4,}\b/g) || []))];
  const matched  = jobWords.filter(w => talentText.includes(w));
  const base     = jobWords.length ? Math.round((matched.length / jobWords.length) * 100) : 0;

  // Bonus for level alignment
  let bonus = 0;
  if (job.experience_level === 'expert'       && ['senior','lead','director','c_level'].includes(talent.professional_level)) bonus = 20;
  if (job.experience_level === 'intermediate' && ['mid','senior'].includes(talent.professional_level))                       bonus = 12;
  if (job.experience_level === 'entry'        && ['entry','junior'].includes(talent.professional_level))                     bonus = 12;

  // Find which of the talent's actual skill tags matched (for display)
  const talentSkillTags = (talent.skills || '').split(',').map(s => s.trim()).filter(Boolean);
  const matchedTags = talentSkillTags.filter(skill => {
    const skillExp = expandWithSynonyms(skill.toLowerCase());
    return jobWords.some(w => skillExp.includes(w));
  });

  return {
    talent_id:      talent.id,
    score:          Math.min(base + bonus, 99),
    matched_skills: matchedTags.length ? matchedTags : matched.slice(0, 6),
    reason:         matchedTags.length
      ? `Skill match: ${matchedTags.slice(0, 4).join(', ')}`
      : `Keyword match: ${matched.slice(0, 3).join(', ') || 'general profile'}`,
  };
}

// ─── GET /api/triage/jobs/:jobId/quick-match — instant keyword scores (no DB write) ──
router.get('/jobs/:jobId/quick-match', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const talents = await db.prepare(`
      SELECT u.id, u.full_name, u.email, u.skills, u.bio, u.professional_level,
             u.education_level, u.hourly_rate_range, u.weekly_availability
      FROM users u WHERE u.role = 'freelancer'
    `).all();

    const results = talents
      .map(t => keywordScore(job, t))
      .filter(m => m.score >= 10)
      .sort((a, b) => b.score - a.score);

    res.json({ matches: results });
  } catch (err) {
    console.error('[triage GET /quick-match]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/triage/jobs — all jobs for admin triage ────────────────────────
router.get('/jobs', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const jobs = await db.prepare(`
      SELECT j.*, u.full_name AS employer_name, u.email AS employer_email,
             jt.status AS triage_status,
             (SELECT COUNT(*) FROM job_matches WHERE job_id = j.id AND status IN ('pushed','notified','interview_requested')) AS pushed_count,
             (SELECT COUNT(*) FROM applications WHERE job_id = j.id) AS applicant_count,
             -- Employer hiring activity for this job (from the employer's pipeline / kanban + match actions)
             (SELECT COUNT(*) FROM employer_pipeline ep
                WHERE ep.job_id = j.id AND (ep.stage = 'hired' OR ep.hired_at IS NOT NULL)) AS emp_hired_count,
             (SELECT COUNT(*) FROM employer_pipeline ep
                WHERE ep.job_id = j.id AND ep.stage IN ('interview_stage','interviewing','interviewed')) AS emp_interviewing_count,
             (SELECT COUNT(*) FROM job_matches jm
                WHERE jm.job_id = j.id AND jm.status = 'interview_requested') AS emp_interview_requested_count,
             (SELECT COUNT(*) FROM employer_pipeline ep
                WHERE ep.job_id = j.id AND ep.stage IN ('under_review','reviewing','saved')) AS emp_reviewing_count,
             (SELECT COUNT(*) FROM job_matches jm
                WHERE jm.job_id = j.id AND jm.status = 'shortlisted') AS emp_shortlisted_count,
             (SELECT COUNT(*) FROM employer_profile_views epv
                WHERE epv.job_id = j.id) AS emp_viewed_count
      FROM jobs j
      JOIN users u ON j.employer_id = u.id
      LEFT JOIN job_triage jt ON jt.job_id = j.id
      WHERE j.status != 'closed'
      ORDER BY
        CASE WHEN j.status = 'paused' THEN 1 ELSE 0 END ASC,
        CASE WHEN jt.status = 'completed' THEN 1 ELSE 0 END ASC,
        j.created_at DESC
    `).all();
    res.json(jobs);
  } catch (err) {
    console.error('[triage GET /jobs]', err.message);
    res.status(500).json({ error: 'Failed to fetch jobs: ' + err.message });
  }
});

// ─── GET /api/triage/all-talents — all freelancers for manual selection ───────
// Optional query param: ?job_id=123 → excludes talents already pushed/notified for that job
router.get('/all-talents', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { job_id } = req.query;
    let query = `
      SELECT u.id, u.full_name, u.email, u.skills, u.bio, u.professional_level,
             u.education_level, u.hourly_rate_range, u.weekly_availability,
             u.start_availability, u.profile_pic, u.video_loom_link,
             u.internet_speed, u.equipment, u.resume_file, u.created_at
      FROM users u
      WHERE u.role = 'freelancer'
    `;
    const params = [];
    if (job_id) {
      query += `
        AND NOT EXISTS (
          SELECT 1 FROM job_matches jm
          WHERE jm.job_id = ? AND jm.talent_id = u.id
            AND jm.status <> 'suggested'
        )
      `;
      params.push(parseInt(job_id));
    }
    query += ' ORDER BY u.created_at DESC';
    const talents = params.length
      ? await db.prepare(query).all(...params)
      : await db.prepare(query).all();
    res.json(talents);
  } catch (err) {
    console.error('[triage GET /all-talents]', err.message);
    res.status(500).json({ error: 'Failed to fetch talents: ' + err.message });
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

// ─── POST /api/triage/jobs/:jobId/bulk-push — notify selected talents about the job ──
router.post('/jobs/:jobId/bulk-push', authenticateToken, requireAdmin, async (req, res) => {
  const { talent_ids } = req.body;
  if (!Array.isArray(talent_ids) || !talent_ids.length) {
    return res.status(400).json({ error: 'talent_ids array required' });
  }
  try {
    const { pool } = require('../database');

    // Get job details for email/notification
    const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    // Check which talents have paused their account — skip them
    const { rows: pauseCheck } = await pool.query(
      'SELECT id, full_name, account_paused FROM users WHERE id = ANY($1::int[])',
      [talent_ids.map(Number)]
    );
    const pausedTalents = pauseCheck.filter(t => t.account_paused);
    const activeTalentIds = talent_ids.filter(id => !pauseCheck.find(t => t.id === id && t.account_paused));

    if (pausedTalents.length && !activeTalentIds.length) {
      return res.status(422).json({
        error: `All selected candidates have paused their accounts and cannot receive new matches.`,
        paused: pausedTalents.map(t => ({ id: t.id, name: t.full_name }))
      });
    }

    // Upsert job_matches with status 'notified' (talent sees this in their Job Matches tab)
    for (const tid of activeTalentIds) {
      await db.prepare(`
        INSERT INTO job_matches (job_id, talent_id, match_score, matched_skills, status, pushed_at)
        VALUES (?, ?, 0, '[]', 'notified', NOW())
        ON CONFLICT (job_id, talent_id) DO UPDATE SET
          status = 'notified',
          pushed_at = NOW()
      `).run(req.params.jobId, tid);
    }

    // Fetch talents (with the fields we need to judge profile completeness, so we
    // can pick the right email). Everyone still gets the job match on their dashboard
    // — incomplete profiles just receive a "finish your profile to apply" nudge
    // instead of the standard match email.
    const { rows: talentList } = await pool.query(
      `SELECT id, full_name, email, bio, skills, profile_pic, resume_file,
              video_loom_link, hourly_rate_range, weekly_availability,
              professional_level, equipment
         FROM users WHERE id = ANY($1::int[])`,
      [activeTalentIds.map(Number)]
    );

    let invitedIncomplete = 0;
    for (const talent of talentList) {
      const ready = isReadyToApply(talent);
      if (!ready) invitedIncomplete++;

      // In-app notification
      pool.query(
        `INSERT INTO notifications (user_id, type, title, body, data) VALUES ($1,$2,$3,$4,$5)`,
        [
          talent.id, 'job_match',
          `New Job Match: ${job.title}`,
          ready
            ? `Your profile was matched to a ${job.category} role. Check it out in Job Matches and apply if interested.`
            : `You were matched to a ${job.category} role. Complete your profile first, then you can apply from Job Matches.`,
          JSON.stringify({ job_id: job.id, job_title: job.title, category: job.category })
        ]
      ).catch(() => {});

      // Email notification (non-blocking) — complete profiles get the match email,
      // incomplete profiles get the "complete your profile to apply" invite.
      if (talent.email) {
        const email = ready
          ? jobMatchEmail(talent.full_name || 'there', job.title, job.category, job.description)
          : profileCompleteInviteEmail(talent.full_name || 'there', job.title, job.job_code);
        sendEmail({ to: talent.email, ...email })
          .catch(err => console.error('[job match email]', err.message));
      }
    }

    const response = { ok: true, notified: activeTalentIds.length, invited_incomplete: invitedIncomplete };
    if (pausedTalents.length) {
      response.skipped_paused = pausedTalents.map(t => ({ id: t.id, name: t.full_name }));
    }
    res.json(response);
  } catch (err) {
    console.error('[triage POST /bulk-push]', err.message);
    res.status(500).json({ error: 'Bulk notify failed: ' + err.message });
  }
});

// ─── POST /api/triage/jobs/:jobId/resend-emails — resend job match emails to already-notified talents ──
router.post('/jobs/:jobId/resend-emails', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { pool } = require('../database');
    const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const { rows: talents } = await pool.query(
      `SELECT u.id, u.full_name, u.email
       FROM job_matches jm
       JOIN users u ON u.id = jm.talent_id
       WHERE jm.job_id = $1 AND jm.status IN ('notified','pushed')`,
      [req.params.jobId]
    );

    let sent = 0;
    for (const talent of talents) {
      if (!talent.email) continue;
      await sendEmail({
        to: talent.email,
        ...jobMatchEmail(talent.full_name || 'there', job.title, job.category, job.description)
      }).catch(err => console.error('[resend-emails]', talent.email, err.message));
      sent++;
    }

    res.json({ ok: true, sent, total: talents.length });
  } catch (err) {
    console.error('[triage POST /resend-emails]', err.message);
    res.status(500).json({ error: 'Resend failed: ' + err.message });
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
  const jobId    = parseInt(req.params.jobId);
  const talentId = parseInt(req.params.talentId);
  try {
    await db.prepare(`
      UPDATE job_matches SET status = 'interview_requested', interview_requested_at = NOW()
      WHERE job_id = ? AND talent_id = ?
    `).run(jobId, talentId);

    // Auto-move talent to 'interviewing' stage in the job pipeline (UPSERT to avoid UNIQUE constraint violation)
    try {
      await db.prepare(`
        INSERT INTO employer_pipeline (employer_id, talent_id, stage, job_id)
        VALUES (?, ?, 'interviewing', ?)
        ON CONFLICT (employer_id, talent_id)
        DO UPDATE SET stage = EXCLUDED.stage, job_id = EXCLUDED.job_id, updated_at = NOW()
      `).run(req.user.id, talentId, jobId);
    } catch (pe) {
      console.error('[triage interview → pipeline]', pe.message);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[triage POST /request-interview]', err.message);
    res.status(500).json({ error: 'Failed to request interview: ' + err.message });
  }
});

// ─── PATCH /api/triage/jobs/:jobId/match-status/:talentId — employer updates match status ──
router.patch('/jobs/:jobId/match-status/:talentId', authenticateToken, async (req, res) => {
  const { status } = req.body;
  const allowed = ['shortlisted', 'rejected', 'pushed'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  try {
    // Ensure employer owns this job
    const job = await db.prepare('SELECT id FROM jobs WHERE id = ? AND employer_id = ?').get(req.params.jobId, req.user.id);
    if (!job) return res.status(403).json({ error: 'Not authorized' });
    await db.prepare(`
      UPDATE job_matches SET status = ? WHERE job_id = ? AND talent_id = ?
    `).run(status, req.params.jobId, req.params.talentId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[triage PATCH /match-status]', err.message);
    res.status(500).json({ error: 'Failed to update status: ' + err.message });
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
      WHERE jm.job_id = ? AND jm.status IN ('pushed', 'interview_requested', 'shortlisted', 'rejected')
      ORDER BY jm.match_score DESC
    `).all(req.params.jobId);

    res.json(shortlist);
  } catch (err) {
    console.error('[triage GET /shortlist]', err.message);
    res.status(500).json({ error: 'Failed to fetch shortlist: ' + err.message });
  }
});

module.exports = router;
