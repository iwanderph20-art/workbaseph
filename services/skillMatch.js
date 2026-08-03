// Shared skill-matching engine used by Job Triage (admin) and the job-apply gate.
// A talent's own skill tags drive the match, split into EXACT (matches the job's
// stated required skills / title) and RELATED (same synonym family as something the
// job needs). Exact matches dominate the score so specialists rank above generalists.

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
  ['accounting','bookkeeping','quickbooks','xero','invoicing','payroll','accounts payable','accounts receivable','reconciliation'],
  ['virtual assistant','va','executive assistant','admin assistant','administrative'],
  ['lead generation','sales','cold calling','outreach','crm','salesforce','hubspot','pipedrive','cold email'],
  ['chatgpt','ai','artificial intelligence','machine learning','ml','openai','llm','generative ai','prompt engineering'],
  ['shopify','ecommerce','e-commerce','woo','woocommerce','dropshipping','print on demand'],
  ['wordpress','wp','elementor','divi','gutenberg','cms','content management'],
  ['zapier','make','integromat','automation','n8n','workflow automation'],
  ['medical billing','medical biller','billing','medical coding','medical coder','icd','icd-10','cpt','hcpcs','claims','claims processing','revenue cycle','rcm','insurance verification','eligibility','prior authorization','denial management','ehr','emr','athenahealth','kareo','medisoft','clearinghouse','superbill','medical','healthcare'],
  ['appointment setting','appointment setter','scheduling','calendar management','telemarketing','inside sales','cold calling'],
  ['recruiting','recruiter','recruitment','talent acquisition','talent sourcing','candidate sourcing','sourcing','headhunting','staffing','hr','human resources','hris','onboarding','screening','applicant tracking','ats','boolean search','interviewing'],
  ['real estate','realtor','property management','mls','zillow','wholesaling','acquisitions','dispositions','transaction coordinator'],
];

// Expand text with synonyms: if a word/phrase is found, add the whole synonym group.
function expandWithSynonyms(text) {
  let expanded = text;
  for (const group of SKILL_SYNONYMS) {
    if (group.some(term => text.includes(term))) expanded += ' ' + group.join(' ');
  }
  return expanded;
}

// Normalize a skill/term for comparison: lowercase, punctuation → spaces.
function normSkill(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9+.# ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Which synonym family (if any) a term belongs to. Single-word group terms must
// match as WHOLE words (so 'ng' in the angular group can't match "billing"),
// while multi-word phrases match as substrings.
function synonymGroupFor(term) {
  const t = normSkill(term);
  if (!t) return null;
  const tWords = new Set(t.split(' '));
  for (const group of SKILL_SYNONYMS) {
    for (const g of group) {
      if (t === g) return group;
      if (g.includes(' ')) {
        // Multi-word group phrase: match when the term CONTAINS the whole phrase
        // (e.g. "senior react native dev" → "react native"), or when both are phrases
        // and the group phrase contains the term. Never let a single word match just
        // by being a substring of a longer phrase — that mis-grouped "react" into the
        // JavaScript family via "react native".
        if (t.includes(g)) return group;
        if (t.includes(' ') && g.includes(t)) return group;
      } else if (tWords.has(g)) {
        return group;
      }
    }
  }
  return null;
}

// Words too generic to signal a real skill match (avoids false "exact" hits on
// job titles like "... for a diagnostic Laboratory in the US").
const STOPWORDS = new Set(['the','and','for','with','you','your','our','are','job','role','remote','full','time','part',
  'work','from','home','team','looking','needed','must','have','who','can','will','this','that','their','they','into',
  'diagnostic','laboratory','company','business','based','experience','experienced','skills','required','preferred','usa','us',
  // ── Generic SOFT skills & filler adjectives ──────────────────────────────────
  // These pollute matching: they appear in almost every job description AND are
  // common self-tagged talent skills (e.g. "Communication"), so left un-filtered
  // they make an unrelated talent look like an exact match. A skill tag whose only
  // words are these is treated as NO signal.
  'communication','communications','communicate','spoken','verbal','fluent','fluency','english','bilingual','multilingual',
  'organisation','organization','organised','organized','organisational','organizational',
  'attention','detail','details','oriented','orientation','minded',
  'relationship','relationships','interpersonal','rapport',
  'reliable','reliability','dependable','trustworthy','honest',
  'proactive','confident','confidence','initiative','resourceful',
  'motivated','motivation','driven','passionate','enthusiastic','enthusiasm','ambitious',
  'positive','attitude','professional','professionalism','friendly','courteous',
  'flexible','flexibility','adaptable','adaptability','adaptive','versatile',
  'dedicated','dedication','hardworking','diligent','committed','punctual','punctuality',
  'teamwork','collaborative','collaboration','cooperative',
  'independent','independently','autonomous','autonomy','selfstarter','self','starter',
  'proficient','proficiency','skilled','competent','excellent','strong','good','great','solid','basic',
  'ability','able','capable','capability','aptitude',
  'understanding','knowledge','knowledgeable','familiar','familiarity',
  'problem','solving','critical','thinking','analytical','logical',
  'multitasking','multitask','multiple','fast','learner','quick','eager',
  'deadline','deadlines','timely','comfortable','environment','ethic','patient','patience',
  'excellent','reliable','detail']);

function keywordScore(job, talent) {
  // The job's "needed" signal = its title + required skills + category ONLY. The
  // free-text description is deliberately excluded — it's too noisy and made almost
  // everyone match. Employers who fill in Skills Required get the sharpest matches.
  const needText  = normSkill([job.title, job.skills_required, job.category].filter(Boolean).join(' , '));
  const needTerms = needText.split(/[,;/|\n]|\band\b/).map(normSkill).filter(Boolean);
  const needWords = new Set(needText.split(' ').filter(w => w.length >= 3 && !STOPWORDS.has(w)));

  // "Nice-to-have" skills from the employer are a RELATED (lower-weight) signal.
  const prefText  = normSkill(job.nice_to_have_skills || '');
  const prefTerms = prefText.split(/[,;/|\n]|\band\b/).map(normSkill).filter(Boolean);
  const prefWords = new Set(prefText.split(' ').filter(w => w.length >= 3 && !STOPWORDS.has(w)));

  // Curated synonym families the job belongs to, split by weight: CORE families come
  // from the required skills / title / category; PREF families only from the
  // nice-to-haves. The family signal is what makes "Primary — exact skill match"
  // precise — a recruiter role resolves to the recruiting/sourcing/HR family, while
  // generic soft skills (communication, organised, reliable…) belong to NO family and
  // so can never register as a match on either tier.
  const coreGroups = new Set();
  for (const term of [...needTerms, ...needWords]) { const g = synonymGroupFor(term); if (g) coreGroups.add(g); }
  const prefGroups = new Set();
  for (const term of [...prefTerms, ...prefWords]) { const g = synonymGroupFor(term); if (g) prefGroups.add(g); }

  const talentSkillTags = (talent.skills || '').split(',').map(s => s.trim()).filter(Boolean);

  const exact = [], related = [];
  for (const skill of talentSkillTags) {
    const s = normSkill(skill);
    if (!s) continue;
    const words = s.split(' ').filter(w => w.length >= 3 && !STOPWORDS.has(w));
    const g = synonymGroupFor(s);

    // EXACT (primary) — the talent's own skill is genuinely on-domain for the role:
    //   • it belongs to the same curated family as a CORE required skill, OR
    //   • it exactly equals a required skill, OR
    //   • it's a multi-word phrase that contains / is contained by a required phrase
    //     AND shares a real (non-generic) word with it.
    // A bare soft skill can't qualify: its only words are stopwords, so `words` is
    // empty and it belongs to no family.
    const isExact =
      (g && coreGroups.has(g)) ||
      needTerms.some(r => r === s) ||
      (words.length > 0 && needTerms.some(r =>
        r.includes(' ') && s.includes(' ') && (r.includes(s) || s.includes(r)) &&
        words.some(w => needWords.has(w))));
    if (isExact) { exact.push(skill); continue; }

    // RELATED (relevant) — adjacent / transferable, not the core role:
    //   • same family as a nice-to-have skill, OR
    //   • exactly equals a nice-to-have skill, OR
    //   • shares a real (non-generic) keyword with the required or nice-to-have skills.
    const isRelated =
      (g && prefGroups.has(g)) ||
      prefTerms.some(r => r === s) ||
      (words.length > 0 && words.some(w => needWords.has(w) || prefWords.has(w)));
    if (isRelated) related.push(skill);
  }

  // Weak tie-breaker: overlap of the talent's profile with the job's explicit words.
  const talentText = normSkill([talent.skills, talent.bio, talent.professional_level].filter(Boolean).join(' '));
  const overlap    = [...needWords].filter(w => talentText.includes(w)).length;
  const overlapPct = needWords.size ? overlap / needWords.size : 0;

  let score = exact.length * 36 + related.length * 20 + Math.min(Math.round(overlapPct * 12), 10);

  if      (job.experience_level === 'expert'       && ['senior','lead','director','c_level'].includes(talent.professional_level)) score += 10;
  else if (job.experience_level === 'intermediate' && ['mid','senior'].includes(talent.professional_level))                       score += 8;
  else if (job.experience_level === 'entry'        && ['entry','junior'].includes(talent.professional_level))                     score += 8;

  // No exact or related skill → keep below the match threshold (18).
  if (exact.length === 0 && related.length === 0) score = Math.min(score, 15);
  score = Math.min(score, 99);

  return {
    talent_id:      talent.id,
    score,
    exact_skills:   exact,
    related_skills: related,
    matched_skills: [...exact, ...related],
    reason: exact.length   ? `Exact skills: ${exact.slice(0, 3).join(', ')}`
          : related.length ? `Related skills: ${related.slice(0, 3).join(', ')}`
          : 'General profile',
  };
}

// Does the talent have any exact/related skill for this job?
function hasRelevantSkills(job, talent) {
  const r = keywordScore(job, talent);
  return r.exact_skills.length > 0 || r.related_skills.length > 0;
}

module.exports = { SKILL_SYNONYMS, expandWithSynonyms, keywordScore, hasRelevantSkills, normSkill };
