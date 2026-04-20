const express = require('express');
const router = express.Router();
const https = require('https');
const crypto = require('crypto');
const db = require('../database');
const { authenticateToken } = require('../middleware/auth');
const { sendEmail, welcomeEmployerPostPaymentEmail } = require('../services/email');

const APP_URL = process.env.APP_URL || 'https://workbaseph.com';
const PM_SECRET_KEY  = process.env.PAYMONGO_SECRET_KEY;
const PM_WEBHOOK_SECRET = process.env.PAYMONGO_WEBHOOK_SECRET;

// ── PHP amounts in centavos (₱1 = 100 centavos) ──────────────────────────────
// Override any of these via Railway env vars (e.g. PM_AMOUNT_ESSENTIAL=300000)
const AMOUNTS = {
  pay_per_post:     parseInt(process.env.PM_AMOUNT_PAY_PER_POST    || '84000'),   // ₱840  (~$15)
  essential:        parseInt(process.env.PM_AMOUNT_ESSENTIAL        || '275000'),  // ₱2,750/mo (~$49)
  essential_annual: parseInt(process.env.PM_AMOUNT_ESSENTIAL_ANNUAL || '2750000'), // ₱27,500/yr (~$490)
  pro:              parseInt(process.env.PM_AMOUNT_PRO             || '445000'),  // ₱4,450/mo (~$79)
  pro_annual:       parseInt(process.env.PM_AMOUNT_PRO_ANNUAL      || '4450000'), // ₱44,500/yr (~$790)
  ai_audit:         parseInt(process.env.PM_AMOUNT_AI_AUDIT         || '84000'),   // ₱840  (~$15)
  featured_listing: parseInt(process.env.PM_AMOUNT_FEATURED         || '84000'),   // ₱840  (~$15)
};

const PLAN_DESCRIPTIONS = {
  pay_per_post:     'WorkBase PH — Starter (job post credit)',
  essential:        'WorkBase PH — Essential Plan (monthly)',
  essential_annual: 'WorkBase PH — Essential Plan (annual)',
  pro:              'WorkBase PH — Pro Plan (monthly)',
  pro_annual:       'WorkBase PH — Pro Plan (annual)',
  ai_audit:         'WorkBase PH — AI Applicant Audit',
  featured_listing: 'WorkBase PH — Featured Job Listing (7 days)',
};

// How many days of access each subscription plan grants
const PLAN_DAYS = {
  essential: 30, essential_annual: 365,
  pro: 30,       pro_annual: 365,
};

// What value to store in users.employer_plan
const PLAN_DB_VALUE = {
  essential: 'essential', essential_annual: 'essential',
  pro: 'pro',             pro_annual: 'pro',
};

const SUBSCRIPTION_PLANS = Object.keys(PLAN_DAYS);

// ── PayMongo API helper ────────────────────────────────────────────────────────
function pmRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    if (!PM_SECRET_KEY) return reject(new Error('PAYMONGO_SECRET_KEY not set in Railway env vars'));
    const auth = Buffer.from(PM_SECRET_KEY + ':').toString('base64');
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.paymongo.com',
      path: `/v1${path}`,
      method,
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400) {
            const msg = json.errors?.[0]?.detail || `PayMongo error ${res.statusCode}`;
            reject(new Error(msg));
          } else {
            resolve(json);
          }
        } catch (e) {
          reject(new Error('Invalid PayMongo response'));
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ─── GET /api/payments/referral-info ─────────────────────────────────────────
router.get('/referral-info', authenticateToken, async (req, res) => {
  try {
    const user = await db.prepare('SELECT referral_code, referral_credits FROM users WHERE id = ?').get(req.user.id);
    const count = await db.prepare('SELECT COUNT(*) as c FROM users WHERE referred_by = ?').get(user.referral_code || '');
    res.json({
      referral_code: user.referral_code,
      referral_link: `${APP_URL}/signup.html?role=employer&ref=${user.referral_code}`,
      referral_count: parseInt(count?.c || 0),
      referral_credits: user.referral_credits || 0,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load referral info' });
  }
});

// ─── POST /api/payments/create-checkout ──────────────────────────────────────
// plan: pay_per_post | essential | essential_annual | pro | pro_annual
router.post('/create-checkout', authenticateToken, async (req, res) => {
  if (req.user.role !== 'employer') return res.status(403).json({ error: 'Only employers can purchase plans' });

  const { plan = 'essential' } = req.body;
  const validPlans = ['pay_per_post', 'essential', 'essential_annual', 'pro', 'pro_annual'];
  if (!validPlans.includes(plan)) return res.status(400).json({ error: 'Invalid plan' });

  try {
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

    // Block duplicate active subscriptions
    if (plan !== 'pay_per_post') {
      if (
        user.subscription_tier === 'tier_1' &&
        user.subscription_expires_at &&
        new Date(user.subscription_expires_at) > new Date()
      ) {
        return res.status(400).json({ error: 'You already have an active subscription. Manage it from your billing tab.' });
      }
    }

    // For Essential/Pro: grant 7-day trial immediately (first-time only)
    const isTrialEligible = SUBSCRIPTION_PLANS.includes(plan)
      && !user.paymongo_payment_id
      && user.subscription_tier !== 'tier_1';
    const trialDays = isTrialEligible ? 7 : 0;

    if (trialDays > 0) {
      const trialExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      const dbPlan = PLAN_DB_VALUE[plan];
      await db.prepare(
        `UPDATE users SET subscription_tier = 'tier_1', subscription_expires_at = ?, employer_plan = ?, payment_method_added = 1 WHERE id = ?`
      ).run(trialExpiry, dbPlan, user.id);
      console.log(`🎁 7-day trial granted for user ${user.id} until ${trialExpiry}`);
    }

    // Encode metadata in remarks: plan|userId  (pipe-separated, safe string)
    const remarks = `${plan}|${user.id}`;
    const successUrl = SUBSCRIPTION_PLANS.includes(plan)
      ? `${APP_URL}/payment-success.html?plan=${plan}`
      : `${APP_URL}/payment-success.html?plan=${plan}`;

    const link = await pmRequest('POST', '/links', {
      data: {
        attributes: {
          amount: AMOUNTS[plan],
          description: PLAN_DESCRIPTIONS[plan],
          remarks,
          currency: 'PHP',
          redirect: {
            success: successUrl,
            failed: `${APP_URL}/dashboard.html?tab=billing&cancelled=1`,
          },
        },
      },
    });

    const checkoutUrl = link.data?.attributes?.checkout_url;
    if (!checkoutUrl) throw new Error('No checkout URL returned from PayMongo');

    res.json({ url: checkoutUrl, trial_days: trialDays });
  } catch (err) {
    console.error('[create-checkout]', err.message);
    res.status(500).json({ error: err.message || 'Failed to create payment session' });
  }
});

// ─── POST /api/payments/create-featured-checkout ─────────────────────────────
// Boost a job post to featured for 7 days
router.post('/create-featured-checkout', authenticateToken, async (req, res) => {
  if (req.user.role !== 'employer') return res.status(403).json({ error: 'Employers only' });
  const { job_id } = req.body;
  if (!job_id) return res.status(400).json({ error: 'job_id is required' });

  try {
    const job = await db.prepare('SELECT id, title FROM jobs WHERE id = ? AND employer_id = ?').get(parseInt(job_id), req.user.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const link = await pmRequest('POST', '/links', {
      data: {
        attributes: {
          amount: AMOUNTS.featured_listing,
          description: `WorkBase PH — Featured Listing: "${job.title}" (7 days)`,
          remarks: `featured_listing|${req.user.id}|${job_id}`,
          currency: 'PHP',
          redirect: {
            success: `${APP_URL}/dashboard.html?featured_success=1&job_id=${job_id}`,
            failed: `${APP_URL}/dashboard.html?tab=myJobs`,
          },
        },
      },
    });

    const checkoutUrl = link.data?.attributes?.checkout_url;
    if (!checkoutUrl) throw new Error('No checkout URL returned');

    res.json({ url: checkoutUrl });
  } catch (err) {
    console.error('[featured-checkout]', err.message);
    res.status(500).json({ error: 'Failed to create featured listing checkout' });
  }
});

// ─── GET /api/payments/status ─────────────────────────────────────────────────
router.get('/status', authenticateToken, async (req, res) => {
  try {
    const user = await db.prepare(
      'SELECT subscription_tier, subscription_expires_at, employer_plan, subscription_auto_renew FROM users WHERE id = ?'
    ).get(req.user.id);
    const isActive =
      user.subscription_tier === 'tier_1' &&
      user.subscription_expires_at &&
      new Date(user.subscription_expires_at) > new Date();
    res.json({
      tier: user.subscription_tier,
      active: isActive,
      expires_at: user.subscription_expires_at,
      plan: user.employer_plan,
      auto_renew: user.subscription_auto_renew !== 0,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch status' });
  }
});

// ─── POST /api/payments/create-audit-checkout ─────────────────────────────────
router.post('/create-audit-checkout', authenticateToken, async (req, res) => {
  if (req.user.role !== 'employer') return res.status(403).json({ error: 'Employers only' });
  const { job_id } = req.body;
  if (!job_id) return res.status(400).json({ error: 'job_id is required' });

  try {
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (user.employer_plan === 'pro') {
      return res.json({ skip_payment: true, message: 'Pro plan — audit unlocked automatically' });
    }

    const link = await pmRequest('POST', '/links', {
      data: {
        attributes: {
          amount: AMOUNTS.ai_audit,
          description: PLAN_DESCRIPTIONS.ai_audit,
          remarks: `ai_audit|${req.user.id}|${job_id}`,
          currency: 'PHP',
          redirect: {
            success: `${APP_URL}/dashboard.html?audit_success=1&job_id=${job_id}`,
            failed: `${APP_URL}/dashboard.html?audit_cancelled=1`,
          },
        },
      },
    });

    const checkoutUrl = link.data?.attributes?.checkout_url;
    if (!checkoutUrl) throw new Error('No checkout URL returned');

    res.json({ url: checkoutUrl });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create audit payment session' });
  }
});

// ─── POST /api/payments/run-audit ─────────────────────────────────────────────
router.post('/run-audit', authenticateToken, async (req, res) => {
  if (req.user.role !== 'employer') return res.status(403).json({ error: 'Employers only' });
  const { job_id } = req.body;
  if (!job_id) return res.status(400).json({ error: 'job_id is required' });

  try {
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const job = await db.prepare('SELECT * FROM jobs WHERE id = ? AND employer_id = ?').get(job_id, req.user.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    if (user.employer_plan !== 'pro' && !job.ai_audit_unlocked) {
      return res.status(403).json({ error: 'Audit not purchased for this job' });
    }

    const thisMonth = new Date().toISOString().slice(0, 7);
    const sameMonth = user.ai_audit_month === thisMonth;
    const newUses = sameMonth ? (user.ai_audit_uses_month || 0) + 1 : 1;
    await db.prepare('UPDATE users SET ai_audit_uses_month = ?, ai_audit_month = ? WHERE id = ?').run(newUses, thisMonth, req.user.id);

    const applicants = await db.prepare(`
      SELECT u.id, u.full_name, u.skills, u.bio, u.professional_level, u.education_level,
             u.resume_file, u.ai_tier_recommendation, u.pre_screen_status,
             a.id as application_id, a.status
      FROM applications a
      JOIN users u ON u.id = a.freelancer_id
      WHERE a.job_id = ? AND a.status NOT IN ('rejected','archived')
    `).all(job_id);

    if (!applicants.length) return res.json({ message: 'No applicants to audit', results: [], upsell: newUses > 2 });

    const { analyzeAuditBatch } = require('../services/ai');
    const results = await analyzeAuditBatch(job, applicants);

    let matchCount = 0, mismatchCount = 0;
    for (const r of results) {
      if (r.verdict === 'MISMATCH') {
        await db.prepare("UPDATE applications SET status = 'archived', ai_mismatch_reason = ? WHERE id = ?").run(r.reason, r.application_id);
        mismatchCount++;
      } else {
        matchCount++;
      }
    }

    await db.prepare('UPDATE jobs SET ai_audit_completed_at = CURRENT_TIMESTAMP WHERE id = ?').run(job_id);
    const upsell = user.employer_plan !== 'pro' && newUses >= 2;
    res.json({ message: 'Audit complete', match: matchCount, mismatch: mismatchCount, results, upsell });
  } catch (err) {
    res.status(500).json({ error: 'Audit failed: ' + err.message });
  }
});

// ─── POST /api/payments/cancel ────────────────────────────────────────────────
// Marks subscription as non-renewing — access continues until expiry date
router.post('/cancel', authenticateToken, async (req, res) => {
  try {
    const user = await db.prepare('SELECT subscription_tier, subscription_expires_at FROM users WHERE id = ?').get(req.user.id);
    if (!user.subscription_tier || user.subscription_tier !== 'tier_1') {
      return res.status(400).json({ error: 'No active subscription found' });
    }
    await db.prepare('UPDATE users SET subscription_auto_renew = 0 WHERE id = ?').run(req.user.id);
    const expiryDate = user.subscription_expires_at
      ? new Date(user.subscription_expires_at).toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' })
      : 'your current billing period';
    res.json({ message: `Subscription cancelled. Your access remains active until ${expiryDate}.` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

// ─── POST /api/payments/webhook ───────────────────────────────────────────────
// Receive payment events from PayMongo
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {

  // Verify PayMongo signature
  const sigHeader = req.headers['paymongo-signature'];
  if (PM_WEBHOOK_SECRET && sigHeader) {
    try {
      const parts = {};
      sigHeader.split(',').forEach(part => {
        const [k, v] = part.split('=');
        parts[k.trim()] = v?.trim();
      });
      const timestamp = parts['t'];
      const rawBody = req.body.toString('utf8');
      const expected = crypto.createHmac('sha256', PM_WEBHOOK_SECRET).update(`${timestamp}.${rawBody}`).digest('hex');
      const provided = parts['te'] || parts['li']; // te = test env, li = live env
      if (expected !== provided) {
        console.error('[webhook] PayMongo signature mismatch');
        return res.status(400).send('Invalid signature');
      }
    } catch (e) {
      console.error('[webhook] Signature check error:', e.message);
      return res.status(400).send('Signature error');
    }
  }

  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch (e) {
    return res.status(400).send('Invalid JSON');
  }

  const eventType = payload?.data?.attributes?.type;
  const eventData = payload?.data?.attributes?.data;
  console.log('[PayMongo webhook]', eventType);

  try {
    if (eventType === 'link.payment.paid') {
      // Decode metadata from remarks: "plan|userId" or "plan|userId|jobId"
      const remarks = eventData?.attributes?.remarks || '';
      const [plan, userIdStr, jobIdStr] = remarks.split('|');
      const userId = parseInt(userIdStr);
      const jobId  = jobIdStr ? parseInt(jobIdStr) : null;

      if (!plan || !userId || isNaN(userId)) {
        console.error('[webhook] Could not parse remarks:', remarks);
        return res.json({ received: true });
      }

      const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      if (!user) {
        console.error('[webhook] User not found:', userId);
        return res.json({ received: true });
      }

      // ── Pay-per-post ─────────────────────────────────────────────────────────
      if (plan === 'pay_per_post') {
        await db.prepare(
          'UPDATE users SET post_credits = post_credits + 1, payment_method_added = 1, employer_plan = ? WHERE id = ?'
        ).run('starter', userId);
        console.log(`✅ Pay-per-post credit +1 for user ${userId}`);
      }

      // ── AI Audit ─────────────────────────────────────────────────────────────
      else if (plan === 'ai_audit' && jobId) {
        await db.prepare('UPDATE jobs SET ai_audit_unlocked = 1 WHERE id = ? AND employer_id = ?').run(jobId, userId);
        console.log(`✅ AI Audit unlocked: job ${jobId}`);
      }

      // ── Featured listing ──────────────────────────────────────────────────────
      else if (plan === 'featured_listing' && jobId) {
        const featuredUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        await db.prepare('UPDATE jobs SET featured_until = ? WHERE id = ? AND employer_id = ?').run(featuredUntil, jobId, userId);
        console.log(`⭐ Job ${jobId} featured until ${featuredUntil}`);
      }

      // ── Subscription plans ────────────────────────────────────────────────────
      else if (PLAN_DB_VALUE[plan]) {
        const dbPlan  = PLAN_DB_VALUE[plan];
        const days    = PLAN_DAYS[plan] || 30;

        // If they are on an active trial, extend from trial expiry. Otherwise from now.
        const baseDate =
          user.subscription_tier === 'tier_1' &&
          user.subscription_expires_at &&
          new Date(user.subscription_expires_at) > new Date()
            ? new Date(user.subscription_expires_at)
            : new Date();
        const newExpiry = new Date(baseDate.getTime() + days * 24 * 60 * 60 * 1000).toISOString();

        await db.prepare(`
          UPDATE users SET
            subscription_tier = 'tier_1',
            subscription_expires_at = ?,
            employer_plan = ?,
            payment_method_added = 1,
            subscription_auto_renew = 1,
            paymongo_payment_id = ?
          WHERE id = ?
        `).run(newExpiry, dbPlan, eventData?.id || `pm_${Date.now()}`, userId);

        console.log(`✅ Subscription: user ${userId} → ${dbPlan}, active until ${newExpiry}`);

        // First-ever payment: send welcome email + credit referrer
        const isFirstPayment = !user.paymongo_payment_id;
        if (isFirstPayment) {
          const docRow = await db.prepare('SELECT id FROM employer_documents WHERE employer_id = ? LIMIT 1').get(userId);
          sendEmail({ to: user.email, ...welcomeEmployerPostPaymentEmail(user.full_name, !!docRow) })
            .catch(err => console.error('Welcome email failed:', err.message));

          if (user.referred_by) {
            const referrer = await db.prepare(
              'SELECT id, subscription_expires_at, referral_credits FROM users WHERE referral_code = ?'
            ).get(user.referred_by);
            if (referrer) {
              const refBase = referrer.subscription_expires_at
                ? new Date(referrer.subscription_expires_at)
                : new Date();
              const refExpiry = new Date(refBase.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
              await db.prepare(
                'UPDATE users SET subscription_expires_at = ?, referral_credits = referral_credits + 1 WHERE id = ?'
              ).run(refExpiry, referrer.id);
              await db.prepare(
                "INSERT INTO notifications (user_id, type, title, body, data) VALUES (?, 'referral_credit', ?, ?, ?)"
              ).run(
                referrer.id,
                'Referral Bonus — 1 Month Free!',
                `${user.full_name} signed up using your referral link. You've earned 1 extra month on your subscription!`,
                JSON.stringify({ referred_user: user.full_name })
              );
              console.log(`🎁 Referral +30 days credited to user ${referrer.id}`);
            }
          }
        }
      } else {
        console.warn('[webhook] Unknown plan in remarks:', plan);
      }
    }
  } catch (err) {
    console.error('[webhook] Error processing event:', err.message);
  }

  res.json({ received: true });
});

module.exports = router;
