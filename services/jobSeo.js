// Server-side SEO helpers for public job pages.
//
// Two jobs here:
//   1. buildJobPostingLd — the JobPosting structured data (mirrors the client
//      builder in public/job.html so JS-rendering and SSR agree).
//   2. renderJobHead — inject per-job <title>, meta description, OG/Twitter
//      tags, canonical, and the JSON-LD into the static job.html template so
//      crawlers that DON'T run JS (Googlebot on first pass, and every social
//      scraper — Facebook, LinkedIn, Twitter) still get correct metadata.
//
// Also exposes fetchPublicJob so both /jobs/:id (SSR) and the jobs sitemap can
// resolve a listing the same way the public API does.

const db = require('../database');

const SITE = 'https://www.workbaseph.com';
const DEFAULT_OG_IMAGE = `${SITE}/images/og-social.jpg?v=2`;

// Columns needed to render the page + structured data. Kept in sync with the
// public API SELECT in routes/jobs.js.
const JOB_COLUMNS = `
  j.id, j.title, j.description, j.category, j.engagement_type,
  j.budget_type, j.budget_min, j.budget_max, j.skills_required,
  j.location, j.status, j.created_at, j.job_code, j.expires_at,
  j.experience_level, j.time_commitment, j.hiring_urgency,
  j.project_type, j.certifications, j.number_of_hires,
  j.work_timezone, j.employer_country,
  u.full_name AS employer_name`;

// Resolve a public job by job_code first, then numeric id — same order as the
// public API. Returns the row, or null if not found / closed.
async function fetchPublicJob(idOrCode) {
  if (!idOrCode) return null;
  let job = await db.prepare(
    `SELECT ${JOB_COLUMNS} FROM jobs j JOIN users u ON j.employer_id = u.id WHERE j.job_code = ?`
  ).get(idOrCode);
  if (!job && /^\d+$/.test(String(idOrCode))) {
    job = await db.prepare(
      `SELECT ${JOB_COLUMNS} FROM jobs j JOIN users u ON j.employer_id = u.id WHERE j.id = ?`
    ).get(idOrCode);
  }
  if (!job || job.status === 'closed') return null;
  return job;
}

function truncate(str, n) {
  if (!str) return '';
  const s = String(str).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n).trimEnd() + '…' : s;
}

// HTML-attribute-safe escaping for values placed inside content="…".
function escAttr(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Escape a closing </script> so JSON-LD can't break out of its script tag.
function escJsonLd(json) {
  return json.replace(/<\/(script)/gi, '<\\/$1');
}

function buildJobPostingLd(job, canonicalUrl) {
  const company = job.company_name || job.employer_name || 'WorkBase PH';
  const tc = (job.time_commitment || '').toLowerCase();
  const eng = `${job.engagement_type || ''} ${job.project_type || ''}`.toLowerCase();
  const employmentType = [];
  if (tc.includes('full')) employmentType.push('FULL_TIME');
  if (tc.includes('part')) employmentType.push('PART_TIME');
  if (/project|one[_ ]?time|contract|freelance/.test(eng)) employmentType.push('CONTRACTOR');
  if (!employmentType.length) employmentType.push('CONTRACTOR');

  const data = {
    '@context': 'https://schema.org/',
    '@type': 'JobPosting',
    title: job.title,
    description: job.description || job.title,
    datePosted: job.created_at ? new Date(job.created_at).toISOString() : undefined,
    validThrough: job.expires_at ? new Date(job.expires_at).toISOString() : undefined,
    employmentType: [...new Set(employmentType)],
    hiringOrganization: { '@type': 'Organization', name: company, sameAs: SITE },
    jobLocationType: 'TELECOMMUTE',
    applicantLocationRequirements: { '@type': 'Country', name: 'Philippines' },
    directApply: true,
    url: canonicalUrl,
    identifier: { '@type': 'PropertyValue', name: 'WorkBase PH', value: String(job.job_code || job.id) }
  };

  if (job.budget_min || job.budget_max) {
    const unit = job.budget_type === 'hourly' ? 'HOUR' : 'MONTH';
    const value = (job.budget_min && job.budget_max)
      ? { '@type': 'QuantitativeValue', minValue: Number(job.budget_min), maxValue: Number(job.budget_max), unitText: unit }
      : { '@type': 'QuantitativeValue', value: Number(job.budget_min || job.budget_max), unitText: unit };
    data.baseSalary = { '@type': 'MonetaryAmount', currency: 'USD', value };
  }

  Object.keys(data).forEach(k => data[k] === undefined && delete data[k]);
  return data;
}

// Inject per-job SEO into the static job.html template string.
// The client JS in job.html re-applies the same values on load (reusing the
// canonical link + #jobPostingLd script by id), so there's no duplication.
function renderJobHead(templateHtml, job, canonicalUrl) {
  const title = `${job.title} — WorkBase PH`;
  const desc = truncate(job.description, 160) || 'Remote role for Filipino specialists on WorkBase PH.';
  const ld = escJsonLd(JSON.stringify(buildJobPostingLd(job, canonicalUrl)));

  let html = templateHtml
    .replace('<title>Job — WorkBase PH</title>', `<title>${escAttr(title)}</title>`)
    .replace(
      '<meta name="description" content="Find Filipino specialists on WorkBase PH." />',
      `<meta name="description" content="${escAttr(desc)}" />`
    )
    .replace(
      '<meta property="og:title" content="Job Opportunity — WorkBase PH" />',
      `<meta property="og:title" content="${escAttr(title)}" />`
    )
    .replace(
      '<meta property="og:description" content="Find Filipino specialists on WorkBase PH." />',
      `<meta property="og:description" content="${escAttr(desc)}" />`
    )
    .replace(
      '<meta name="twitter:title" content="Job Opportunity — WorkBase PH" />',
      `<meta name="twitter:title" content="${escAttr(title)}" />`
    )
    .replace(
      '<meta name="twitter:description" content="Find Filipino specialists on WorkBase PH." />',
      `<meta name="twitter:description" content="${escAttr(desc)}" />`
    );

  const injected =
    `  <link rel="canonical" href="${escAttr(canonicalUrl)}" />\n` +
    `  <meta property="og:url" content="${escAttr(canonicalUrl)}" />\n` +
    `  <script type="application/ld+json" id="jobPostingLd">${ld}</script>\n</head>`;

  return html.replace('</head>', injected);
}

module.exports = { fetchPublicJob, buildJobPostingLd, renderJobHead, SITE, DEFAULT_OG_IMAGE };
