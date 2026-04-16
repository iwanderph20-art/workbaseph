const express = require('express');
const router  = express.Router();
const db      = require('../database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

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
             (SELECT COUNT(*) FROM job_matches WHERE job_id = j.id AND status = 'pushed') AS pushed_count
      FROM jobs j
      JOIN users u ON j.employer_id = u.id
      LEFT JOIN job_triage jt ON jt.job_id = j.id
      ORDER BY
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
router.get('/all-talents', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const talents = await db.prepare(`
      SELECT u.id, u.full_name, u.email, u.skills, u.bio, u.professional_level,
             u.education_level, u.hourly_rate_range, u.weekly_availability,
             u.start_availability, u.profile_pic, u.video_loom_link,
             u.internet_speed, u.equipment, u.resume_file, u.created_at
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
