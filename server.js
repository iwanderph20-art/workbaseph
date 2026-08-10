require('dotenv').config();
const express = require('express');
const compression = require('compression');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Server-side SEO for public job pages (JobPosting JSON-LD, canonical, social cards)
const { fetchPublicJob, renderJobHead, toPublicJob } = require('./services/jobSeo');
const JOB_TEMPLATE_PATH = path.join(__dirname, 'public', 'job.html');
let _jobTemplate = null;
function jobTemplate() {
  // Cached in production; re-read each time locally so edits show without a restart
  if (_jobTemplate && process.env.NODE_ENV === 'production') return _jobTemplate;
  _jobTemplate = fs.readFileSync(JOB_TEMPLATE_PATH, 'utf8');
  return _jobTemplate;
}

// Upload root: persisted volume on Railway (/data/uploads), or public/uploads locally
const UPLOAD_ROOT = process.env.UPLOAD_DIR || path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(UPLOAD_ROOT)) fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

// Middleware
app.use(compression()); // gzip all responses — reduces payload size by 60-80%
app.use(cors());

// Redirect non-www to www so canonical tags always match the crawled URL
app.use((req, res, next) => {
  const host = req.headers.host || '';
  if (host && !host.startsWith('www.') && !host.includes('localhost') && !host.includes('railway')) {
    return res.redirect(301, `https://www.${host}${req.originalUrl}`);
  }
  next();
});

// Explicitly allow social media crawlers (Facebook, Twitter, LinkedIn, Google)
app.use((req, res, next) => {
  const ua = req.headers['user-agent'] || '';
  if (
    ua.includes('facebookexternalhit') ||
    ua.includes('Facebot') ||
    ua.includes('Twitterbot') ||
    ua.includes('LinkedInBot') ||
    ua.includes('Googlebot')
  ) {
    res.setHeader('X-Robots-Tag', 'all');
  }
  next();
});

// Stripe webhook MUST receive raw body — register BEFORE express.json()
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve uploaded files from the persisted volume at /uploads/*
app.use('/uploads', express.static(UPLOAD_ROOT));

// Consolidate duplicate blog URLs to their canonical version (301) — must run
// BEFORE express.static so the old file is never served. Keeps link equity on
// one URL and avoids duplicate-content dilution.
const BLOG_REDIRECTS = {
  '/blog/filipino-va-contract-template.html': '/blog/free-filipino-va-contract-template.html',
  '/blog/hire-filipino-bookkeeper.html': '/blog/how-much-does-filipino-bookkeeper-cost.html',
  '/blog/workbaseph-vs-onlinejobs-ph.html': '/blog/workbaseph-vs-onlinejobs.html'
};
app.use((req, res, next) => {
  const dest = BLOG_REDIRECTS[req.path];
  if (dest) return res.redirect(301, dest);
  next();
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.includes('/blog/') && filePath.endsWith('.html')) {
      // Blog articles change infrequently — cache 1 hour so Google gets fast responses on re-crawls
      res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
    } else if (filePath.endsWith('.html')) {
      // App pages must not be cached so deploys take effect immediately
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else if (/\.(css|js|svg|png|jpg|jpeg|webp|woff|woff2|ico)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }
}));

// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/jobs', require('./routes/jobs'));
app.use('/api/contact', require('./routes/contact'));
app.use('/api/talent', require('./routes/talent'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/uploads', require('./routes/uploads'));
app.use('/api/employer-verification', require('./routes/employer-verification'));
app.use('/api/community', require('./routes/community'));
app.use('/api/growth', require('./routes/growth'));
app.use('/api/interviews', require('./routes/interviews'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/tracking', require('./routes/tracking'));
app.use('/api/triage', require('./routes/triage'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/pipeline', require('./routes/pipeline'));
app.use('/api/reviews', require('./routes/reviews'));
app.use('/api/feedback', require('./routes/feedback'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'WorkBasePH API is running', version: '1.0.0' });
});

// Lightweight ping endpoint — used by UptimeRobot to keep Railway server warm
app.get('/ping', (req, res) => res.send('pong'));

// Legacy Browse Jobs page removed — redirect old shared links to the clean
// single-job view (preserving ?code= / ?id=), or home if no job specified.
app.get('/jobs.html', (req, res) => {
  const ref = req.query.code || req.query.id;
  if (ref) return res.redirect(301, `/jobs/${encodeURIComponent(ref)}`);
  return res.redirect(301, '/');
});

// Clean URL for public job referral pages.
// Server-render the SEO head so crawlers that don't run JS — Googlebot's first
// pass and every social scraper (Facebook, LinkedIn, Twitter) — get the real
// job title, description, canonical, social card, and JobPosting structured
// data. The client JS re-applies the same values on load (no duplication).
app.get('/jobs/:id', async (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  try {
    const job = await fetchPublicJob(req.params.id);
    if (job) {
      // Publicize before rendering: generic employer label + general description
      // (identity-safe, same content served to humans and crawlers — no cloaking).
      const canonicalUrl = `https://www.workbaseph.com/jobs/${encodeURIComponent(req.params.id)}`;
      return res.type('html').send(renderJobHead(jobTemplate(), toPublicJob(job), canonicalUrl));
    }
  } catch (err) {
    console.error('[jobs SSR] error:', err.message);
  }
  // Not found or render error — serve the raw template; its JS shows the
  // "no longer available" state after the API returns 404.
  res.sendFile(JOB_TEMPLATE_PATH);
});

// Dynamic sitemap of live job listings so Google discovers/refreshes them fast.
// Kept separate from the static sitemap.xml (both are referenced in robots.txt).
app.get('/sitemap-jobs.xml', async (req, res) => {
  try {
    const jobs = await require('./database').prepare(
      `SELECT job_code, id, created_at FROM jobs
       WHERE status = 'open' AND COALESCE(job_type, 'REAL') = 'REAL'
       ORDER BY created_at DESC LIMIT 5000`
    ).all();
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const urls = jobs.map(j => {
      const ref = j.job_code || j.id;
      const lastmod = j.created_at ? new Date(j.created_at).toISOString().slice(0, 10) : '';
      return `  <url>\n    <loc>https://www.workbaseph.com/jobs/${esc(ref)}</loc>` +
             (lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : '') +
             `\n    <changefreq>daily</changefreq>\n  </url>`;
    }).join('\n');
    res.type('application/xml').setHeader('Cache-Control', 'public, max-age=3600');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`);
  } catch (err) {
    console.error('[sitemap-jobs] error:', err.message);
    res.status(500).type('application/xml').send('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>');
  }
});

// Catch-all: serve index.html for SPA-like navigation.
// But never mask a missing upload/API path as the landing page — a missing file
// under /uploads or /api should 404 honestly, not silently render index.html
// (which made a dead document link look like a redirect to the homepage).
app.get('*', (req, res) => {
  if (req.path.startsWith('/uploads/') || req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🚀 WorkBasePH Server running at http://localhost:${PORT}`);
  console.log(`📄 API available at http://localhost:${PORT}/api`);
  console.log(`\nDemo accounts:`);
  console.log(`  Employer: employer@demo.com / demo1234`);
  console.log(`  Freelancer: freelancer@demo.com / demo1234\n`);
});

// ── Profile completion drip email scheduler ───────────────────────────────────
const { sendEmail, dripD1Email, dripD3Email, dripD7Email, interviewReminderEmail, testimonialFollowUpEmail, subscriptionLapsedEmail, subscriptionExpiringEmail, trialEndingEmail, starterPostExpiringEmail, starterPostExpiredEmail } = require('./services/email');
const db = require('./database');

async function runDripScheduler() {
  try {
    // Day 1 — sent 24h after signup if profile incomplete
    const d1 = await db.prepare(`
      SELECT id, full_name, email FROM users
      WHERE role = 'freelancer'
        AND drip_d1_sent = 0
        AND created_at < NOW() - INTERVAL '24 hours'
        AND created_at > NOW() - INTERVAL '72 hours'
        AND (video_loom_link IS NULL OR video_loom_link = ''
             OR resume_file IS NULL OR resume_file = ''
             OR skills IS NULL OR skills = '')
      LIMIT 50
    `).all();
    for (const u of d1) {
      await sendEmail({ to: u.email, ...dripD1Email(u.full_name) }).catch(() => {});
      await db.prepare('UPDATE users SET drip_d1_sent = 1 WHERE id = ?').run(u.id);
      console.log(`[drip D1] Sent to ${u.email}`);
    }

    // Day 3
    const d3 = await db.prepare(`
      SELECT id, full_name, email FROM users
      WHERE role = 'freelancer'
        AND drip_d3_sent = 0
        AND created_at < NOW() - INTERVAL '72 hours'
        AND created_at > NOW() - INTERVAL '168 hours'
        AND (video_loom_link IS NULL OR video_loom_link = ''
             OR resume_file IS NULL OR resume_file = ''
             OR skills IS NULL OR skills = '')
      LIMIT 50
    `).all();
    for (const u of d3) {
      await sendEmail({ to: u.email, ...dripD3Email(u.full_name) }).catch(() => {});
      await db.prepare('UPDATE users SET drip_d3_sent = 1 WHERE id = ?').run(u.id);
      console.log(`[drip D3] Sent to ${u.email}`);
    }

    // Day 7
    const d7 = await db.prepare(`
      SELECT id, full_name, email FROM users
      WHERE role = 'freelancer'
        AND drip_d7_sent = 0
        AND created_at < NOW() - INTERVAL '168 hours'
        AND (video_loom_link IS NULL OR video_loom_link = ''
             OR resume_file IS NULL OR resume_file = ''
             OR skills IS NULL OR skills = '')
      LIMIT 50
    `).all();
    for (const u of d7) {
      await sendEmail({ to: u.email, ...dripD7Email(u.full_name) }).catch(() => {});
      await db.prepare('UPDATE users SET drip_d7_sent = 1 WHERE id = ?').run(u.id);
      console.log(`[drip D7] Sent to ${u.email}`);
    }
  } catch (err) {
    console.error('[drip scheduler] error:', err.message);
  }
}

// Run every hour
setInterval(runDripScheduler, 60 * 60 * 1000);
// Also run once 30s after startup (to catch any missed drips on redeploy)
setTimeout(runDripScheduler, 30000);
console.log('📬 Drip email scheduler started');

// ── Interview day-of reminder scheduler ──────────────────────────────────────
const { pool: reminderPool } = require('./database');

async function runInterviewReminderScheduler() {
  try {
    // Find accepted interviews happening today (within next 24h) where reminder not yet sent
    const { rows: interviews } = await reminderPool.query(`
      SELECT ir.id, ir.employer_id, ir.talent_id, ir.selected_slot, ir.jitsi_link,
             ir.employer_timezone,
             eu.full_name AS employer_name, eu.email AS employer_email,
             tu.full_name AS talent_name, tu.email AS talent_email
      FROM interview_requests ir
      JOIN users eu ON eu.id = ir.employer_id
      JOIN users tu ON tu.id = ir.talent_id
      WHERE ir.status = 'accepted'
        AND ir.interview_reminder_sent = 0
        AND (
          (ir.selected_slot = 'slot1' AND ir.slot1 BETWEEN NOW() AND NOW() + INTERVAL '24 hours')
          OR
          (ir.selected_slot = 'slot2' AND ir.slot2 BETWEEN NOW() AND NOW() + INTERVAL '24 hours')
        )
    `);

    for (const iv of interviews) {
      const slotCol = iv.selected_slot === 'slot1' ? 'slot1' : 'slot2';
      // Get the actual timestamp value
      const { rows: slotRow } = await reminderPool.query(
        `SELECT ${slotCol} AS slot_time FROM interview_requests WHERE id = $1`, [iv.id]
      );
      const confirmedTime = new Date(slotRow[0].slot_time).toLocaleString('en-PH', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZone: iv.employer_timezone || 'Asia/Manila'
      });

      // Send to talent
      if (iv.talent_email) {
        sendEmail({
          to: iv.talent_email,
          ...interviewReminderEmail(iv.talent_name, iv.employer_name, confirmedTime, iv.jitsi_link, 'talent')
        }).catch(err => console.error('[interview reminder → talent]', err.message));
      }
      // Send to employer
      if (iv.employer_email) {
        sendEmail({
          to: iv.employer_email,
          ...interviewReminderEmail(iv.employer_name, iv.talent_name, confirmedTime, iv.jitsi_link, 'employer')
        }).catch(err => console.error('[interview reminder → employer]', err.message));
      }

      // Mark reminder sent
      await reminderPool.query(
        'UPDATE interview_requests SET interview_reminder_sent = 1 WHERE id = $1', [iv.id]
      );
      console.log(`[interview reminder] Sent for interview #${iv.id} at ${confirmedTime}`);
    }
  } catch (err) {
    console.error('[interview reminder scheduler]', err.message);
  }
}

// Run every hour
setInterval(runInterviewReminderScheduler, 60 * 60 * 1000);
setTimeout(runInterviewReminderScheduler, 45000); // 45s after startup
console.log('📅 Interview reminder scheduler started');

// ── Testimonial follow-up scheduler (5 days after hire) ──────────────────────
async function runTestimonialFollowUpScheduler() {
  try {
    const { rows: hires } = await reminderPool.query(`
      SELECT ep.id, ep.talent_id, ep.hired_at,
             u.full_name AS talent_name, u.email AS talent_email,
             eu.full_name AS employer_name
      FROM employer_pipeline ep
      JOIN users u ON u.id = ep.talent_id
      JOIN users eu ON eu.id = ep.employer_id
      WHERE ep.stage = 'hired'
        AND ep.testimonial_follow_up_sent = 0
        AND ep.hired_at IS NOT NULL
        AND ep.hired_at < NOW() - INTERVAL '5 days'
    `);
    for (const hire of hires) {
      if (hire.talent_email) {
        sendEmail({
          to: hire.talent_email,
          ...testimonialFollowUpEmail(hire.talent_name, hire.employer_name)
        }).catch(err => console.error('[testimonial follow-up]', err.message));
      }
      await reminderPool.query(
        'UPDATE employer_pipeline SET testimonial_follow_up_sent = 1 WHERE id = $1', [hire.id]
      );
      console.log(`[testimonial follow-up] Sent to ${hire.talent_email}`);
    }
  } catch (err) {
    console.error('[testimonial follow-up scheduler]', err.message);
  }
}

// Run every 6 hours
setInterval(runTestimonialFollowUpScheduler, 6 * 60 * 60 * 1000);
setTimeout(runTestimonialFollowUpScheduler, 60000); // 60s after startup
console.log('🎉 Testimonial follow-up scheduler started');

// ── Subscription-expiry auto-pause scheduler ─────────────────────────────────
// When an employer's paid subscription (essential/growth/pro) lapses, hide their
// live job posts from the marketplace so renewal becomes the required next step.
// Auto-paused jobs are flagged (auto_paused = 1) and restored automatically on renewal.
function planDisplayName(plan) {
  if (plan === 'pro') return 'Pro';
  return 'Essential'; // essential + legacy growth
}
async function runSubscriptionExpiryScheduler() {
  try {
    // Employers with a lapsed paid plan that still have live (open, non-seeded) posts
    const { rows: lapsed } = await reminderPool.query(`
      SELECT DISTINCT u.id, u.email, u.full_name, u.employer_plan
      FROM users u
      JOIN jobs j ON j.employer_id = u.id
      WHERE u.role = 'employer'
        AND u.employer_plan IN ('essential', 'growth', 'pro')
        AND NOT (u.subscription_tier = 'tier_1' AND u.subscription_expires_at IS NOT NULL AND u.subscription_expires_at > NOW())
        AND j.status = 'open'
        AND j.is_seeded = 0
        AND j.auto_paused = 0
    `);
    for (const emp of lapsed) {
      const { rowCount } = await reminderPool.query(`
        UPDATE jobs SET status = 'paused', auto_paused = 1, updated_at = NOW()
        WHERE employer_id = $1 AND status = 'open' AND is_seeded = 0 AND auto_paused = 0
      `, [emp.id]);
      if (rowCount > 0) {
        const planName = planDisplayName(emp.employer_plan);
        // Applicants sitting on the posts we just paused — drives the win-back hook
        const { rows: appRows } = await reminderPool.query(
          "SELECT COUNT(*) AS c FROM applications a JOIN jobs j ON a.job_id = j.id WHERE j.employer_id = $1 AND j.auto_paused = 1",
          [emp.id]
        );
        const applicantCount = parseInt(appRows[0]?.c || 0);

        await reminderPool.query(
          `INSERT INTO notifications (user_id, type, title, body, data) VALUES ($1, 'subscription_lapsed', $2, $3, $4)`,
          [emp.id,
           'Your job posts are paused',
           `Your ${planName} plan has expired, so your ${rowCount} active job post${rowCount === 1 ? ' is' : 's are'} paused and hidden from specialists. Renew to reactivate instantly.`,
           JSON.stringify({ paused_count: rowCount, applicant_count: applicantCount })]
        ).catch(err => console.error('[subscription-expiry] notify failed:', err.message));

        if (emp.email) {
          sendEmail({ to: emp.email, ...subscriptionLapsedEmail(emp.full_name || 'there', planName, rowCount, applicantCount) })
            .catch(err => console.error('[subscription-expiry] email failed:', err.message));
        }
        console.log(`[subscription-expiry] Paused ${rowCount} job(s), ${applicantCount} applicant(s) locked for ${emp.email}`);
      }
    }
  } catch (err) {
    console.error('[subscription-expiry scheduler]', err.message);
  }
}
setInterval(runSubscriptionExpiryScheduler, 60 * 60 * 1000);
setTimeout(runSubscriptionExpiryScheduler, 90000); // 90s after startup
console.log('🔒 Subscription-expiry auto-pause scheduler started');

// ── Renewal reminder scheduler (3 days before expiry) ────────────────────────
// Emails paid employers approaching expiry so they renew before their posts lapse.
// renewal_reminder_expiry is keyed to the expiry it was sent for, so it fires once
// per billing period and auto-resets when a renewal pushes the expiry forward.
async function runRenewalReminderScheduler() {
  try {
    const { rows: expiring } = await reminderPool.query(`
      SELECT id, email, full_name, employer_plan, subscription_expires_at, paypal_subscription_id
      FROM users
      WHERE role = 'employer'
        AND subscription_tier = 'tier_1'
        AND employer_plan IN ('essential', 'growth', 'pro')
        AND subscription_auto_renew = 0
        AND subscription_expires_at IS NOT NULL
        AND subscription_expires_at > NOW()
        AND subscription_expires_at <= NOW() + INTERVAL '3 days'
        AND (renewal_reminder_expiry IS NULL OR renewal_reminder_expiry <> subscription_expires_at)
    `);
    for (const emp of expiring) {
      const planName = planDisplayName(emp.employer_plan);
      const expiry = new Date(emp.subscription_expires_at);
      const expiryStr = expiry.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' });
      const daysLeft = Math.max(1, Math.ceil((expiry - Date.now()) / (24 * 60 * 60 * 1000)));
      const whenText = daysLeft === 1 ? 'tomorrow' : `in ${daysLeft} days`;
      // Never subscribed via PayPal → this is the no-card free trial ending, not a paid renewal.
      const isTrial = !emp.paypal_subscription_id;

      if (emp.email) {
        const builder = isTrial ? trialEndingEmail : subscriptionExpiringEmail;
        sendEmail({ to: emp.email, ...builder(emp.full_name || 'there', planName, expiryStr, whenText) })
          .catch(err => console.error('[renewal-reminder] email failed:', err.message));
      }
      // Mark sent for this exact expiry so it won't repeat until the date changes on renewal
      await reminderPool.query(
        'UPDATE users SET renewal_reminder_expiry = subscription_expires_at WHERE id = $1', [emp.id]
      );
      console.log(`[renewal-reminder] Sent ${planName} ${isTrial ? 'trial-ending' : 'renewal'} T-${daysLeft}d reminder to ${emp.email}`);
    }
  } catch (err) {
    console.error('[renewal-reminder scheduler]', err.message);
  }
}
setInterval(runRenewalReminderScheduler, 60 * 60 * 1000);
setTimeout(runRenewalReminderScheduler, 120000); // 120s after startup
console.log('⏰ Renewal reminder scheduler started');

// ── Starter (pay-per-post) 30-day listing scheduler ──────────────────────────
// Starter posts carry expires_at = created_at + 30 days. Three days out we email a
// heads-up that upsells Essential; at expiry we auto-pause the post (auto_paused = 1,
// so an Essential/Pro upgrade auto-restores it) and email the employer to upgrade.
// Posts whose employer has since taken an active subscription are skipped — their
// subscription governs visibility, not the per-post 30-day window.
async function runStarterExpiryScheduler() {
  try {
    // ── T-3 day reminder (once per post, tracked by expiry_reminder_sent) ──
    const { rows: expiring } = await reminderPool.query(`
      SELECT j.id, j.title, j.expires_at, u.email, u.full_name
      FROM jobs j
      JOIN users u ON j.employer_id = u.id
      WHERE j.status = 'open'
        AND j.is_seeded = 0
        AND j.auto_paused = 0
        AND j.expires_at IS NOT NULL
        AND j.expiry_reminder_sent = 0
        AND j.expires_at > NOW()
        AND j.expires_at <= NOW() + INTERVAL '3 days'
        AND NOT (u.subscription_tier = 'tier_1' AND u.subscription_expires_at IS NOT NULL AND u.subscription_expires_at > NOW())
    `);
    for (const job of expiring) {
      const expiry = new Date(job.expires_at);
      const expiryStr = expiry.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' });
      const daysLeft = Math.max(1, Math.ceil((expiry - Date.now()) / (24 * 60 * 60 * 1000)));
      const whenText = daysLeft === 1 ? 'tomorrow' : `in ${daysLeft} days`;
      if (job.email) {
        sendEmail({ to: job.email, ...starterPostExpiringEmail(job.full_name || 'there', job.title, expiryStr, whenText) })
          .catch(err => console.error('[starter-expiry] reminder email failed:', err.message));
      }
      await reminderPool.query('UPDATE jobs SET expiry_reminder_sent = 1 WHERE id = $1', [job.id]);
      console.log(`[starter-expiry] Sent T-${daysLeft}d reminder for job ${job.id} to ${job.email}`);
    }

    // ── Auto-pause posts past their 30-day window ──
    const { rows: expired } = await reminderPool.query(`
      SELECT j.id, j.title, j.employer_id, u.email, u.full_name
      FROM jobs j
      JOIN users u ON j.employer_id = u.id
      WHERE j.status = 'open'
        AND j.is_seeded = 0
        AND j.auto_paused = 0
        AND j.expires_at IS NOT NULL
        AND j.expires_at < NOW()
        AND NOT (u.subscription_tier = 'tier_1' AND u.subscription_expires_at IS NOT NULL AND u.subscription_expires_at > NOW())
    `);
    for (const job of expired) {
      await reminderPool.query(
        "UPDATE jobs SET status = 'paused', auto_paused = 1, updated_at = NOW() WHERE id = $1", [job.id]
      );
      const { rows: appRows } = await reminderPool.query(
        'SELECT COUNT(*) AS c FROM applications WHERE job_id = $1', [job.id]
      );
      const applicantCount = parseInt(appRows[0]?.c || 0);
      await reminderPool.query(
        `INSERT INTO notifications (user_id, type, title, body, data) VALUES ($1, 'starter_post_expired', $2, $3, $4)`,
        [job.employer_id,
         'Your job post reached 30 days',
         `"${job.title}" completed its 30-day Starter run and is now paused. Upgrade to Essential ($49/mo) to relist it instantly, or post a new job.`,
         JSON.stringify({ job_id: job.id, applicant_count: applicantCount })]
      ).catch(err => console.error('[starter-expiry] notify failed:', err.message));
      if (job.email) {
        sendEmail({ to: job.email, ...starterPostExpiredEmail(job.full_name || 'there', job.title, applicantCount) })
          .catch(err => console.error('[starter-expiry] expired email failed:', err.message));
      }
      console.log(`[starter-expiry] Paused job ${job.id} (${applicantCount} applicant(s)) for ${job.email}`);
    }
  } catch (err) {
    console.error('[starter-expiry scheduler]', err.message);
  }
}
setInterval(runStarterExpiryScheduler, 60 * 60 * 1000);
setTimeout(runStarterExpiryScheduler, 150000); // 150s after startup
console.log('🗓️  Starter 30-day listing scheduler started');
