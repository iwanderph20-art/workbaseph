const express = require('express');
const router = express.Router();
const https = require('https');
const crypto = require('crypto');
const db = require('../database');
const { authenticateToken } = require('../middleware/auth');
const { sendEmail, welcomeEmployerPostPaymentEmail, adminPaymentConfirmedEmail } = require('../services/email');

const APP_URL = process.env.APP_URL || 'https://workbaseph.com';
const PAYPAL_HOST = process.env.PAYPAL_MODE === 'sandbox'
  ? 'api-m.sandbox.paypal.com'
  : 'api-m.paypal.com';

// ── USD amounts (override via env vars) ───────────────────────────────────────
const AMOUNTS = {
  pay_per_post:     process.env.PP_AMOUNT_PAY_PER_POST    || '15.00',
  essential:        process.env.PP_AMOUNT_ESSENTIAL        || '49.00',
  essential_annual: process.env.PP_AMOUNT_ESSENTIAL_ANNUAL || '490.00',
  pro:              process.env.PP_AMOUNT_PRO              || '79.00',
  pro_annual:       process.env.PP_AMOUNT_PRO_ANNUAL       || '790.00',
  ai_audit:         process.env.PP_AMOUNT_AI_AUDIT         || '15.00',
  featured_listing: process.env.PP_AMOUNT_FEATURED         || '15.00',
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

const PLAN_DAYS = {
  essential: 30, essential_annual: 365,
  pro: 30,       pro_annual: 365,
};

const PLAN_DB_VALUE = {
  essential: 'essential', essential_annual: 'essential',
  pro: 'pro',             pro_annual: 'pro',
};

const SUBSCRIPTION_PLANS = Object.keys(PLAN_DAYS);

// ── PayPal OAuth token ─────────────────────────────────────────────────────────
async function getPayPalToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET not set');
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  return new Promise((resolve, reject) => {
    const payload = 'grant_type=client_credentials';
    const req = https.request({
      hostname: PAYPAL_HOST,
      path: '/v1/oauth2/token',
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.access_token) resolve(json.access_token);
          else reject(new Error('Failed to get PayPal access token'));
        } catch (e) {
          reject(new Error('Invalid PayPal auth response'));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── PayPal API helper ──────────────────────────────────────────────────────────
async function ppRequest(method, path, body) {
  const token = await getPayPalToken();
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: PAYPAL_HOST,
      path,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'PayPal-Request-Id': crypto.randomUUID(),
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try {
          const json = data ? JSON.parse(data) : {};
          if (res.statusCode >= 400) {
            reject(new Error(json.message || `PayPal error ${res.statusCode}`));
          } else {
            resolve(json);
          }
        } catch (e) {
          reject(new Error('Invalid PayPal response'));
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Shared payment activation logic ───────────────────────────────────────────
async function activatePayment(plan, userId, jobId, user, paymentId, amountPaid) {
  if (plan === 'pay_per_post') {
    await db.prepare(
      'UPDATE users SET post_credits = post_credits + 1, payment_method_added = 1, employer_plan = ? WHERE id = ?'
    ).run('starter', userId);
    console.log(`✅ Pay-per-post credit +1 for user ${userId}`);
  } else if (plan === 'ai_audit' && jobId) {
    await db.prepare('UPDATE jobs SET ai_audit_unlocked = 1 WHERE id = ? AND employer_id = ?').run(jobId, userId);
    console.log(`✅ AI Audit unlocked: job ${jobId}`);
  } else if (plan === 'featured_listing' && jobId) {
    const featuredUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await db.prepare('UPDATE jobs SET featured_until = ? WHERE id = ? AND employer_id = ?').run(featuredUntil, jobId, userId);
    console.log(`⭐ Job ${jobId} featured until ${featuredUntil}`);
  } else if (PLAN_DB_VALUE[plan]) {
    const dbPlan = PLAN_DB_VALUE[plan];
    const days = PLAN_DAYS[plan] || 30;
    const baseDate =
      user.subscription_tier === 'tier_1' &&
      user.subscription_expires_at &&
      new Date(user.subscription_expires_at) > new Date()
        ? new Date(user.subscription_expires_at)
        : new Date();
    const newExpiry = new Date(baseDate.getTime() + days * 24 * 60 * 60 * 1000).toISOString();

    const isFirstPayment = !user.paypal_order_id && !user.paymongo_payment_id;

    await db.prepare(`
      UPDATE users SET
        subscription_tier = 'tier_1',
        subscription_expires_at = ?,
        employer_plan = ?,
        payment_method_added = 1,
        subscription_auto_renew = 1,
        paypal_order_id = ?
      WHERE id = ?
    `).run(newExpiry, dbPlan, paymentId, userId);

    console.log(`✅ Subscription: user ${userId} → ${dbPlan}, active until ${newExpiry}`);

    const adminEmail = process.env.ADMIN_NOTIFY_EMAIL || 'admin@workbaseph.com';
    sendEmail({ to: adminEmail, ...adminPaymentConfirmedEmail(user, plan, amountPaid) })
      .catch(err => console.error('Admin payment notification failed:', err.message));

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
  }
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

    // Block same-plan repurchase for paid subscribers; allow switching to a different plan
    if (plan !== 'pay_per_post') {
      const hasPaidSub =
        user.subscription_tier === 'tier_1' &&
        user.subscription_expires_at &&
        new Date(user.subscription_expires_at) > new Date() &&
        (user.paypal_order_id || user.paymongo_payment_id);
      if (hasPaidSub) {
        const norm = p => (p || '').replace('_annual', '').replace('growth', 'essential');
        if (norm(plan) === norm(user.employer_plan)) {
          return res.status(400).json({ error: 'You already have an active subscription for this plan. Manage it from your billing tab.' });
        }
        // Different plan — allow the switch; new period starts after current expiry
      }
    }

    // Grant 7-day trial immediately for first-time subscribers
    const isTrialEligible = SUBSCRIPTION_PLANS.includes(plan)
      && !user.paypal_order_id && !user.paymongo_payment_id
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

    const order = await ppRequest('POST', '/v2/checkout/orders', {
      intent: 'CAPTURE',
      purchase_units: [{
        amount: { currency_code: 'USD', value: AMOUNTS[plan] },
        description: PLAN_DESCRIPTIONS[plan],
        custom_id: `${plan}|${user.id}`,
      }],
      application_context: {
        return_url: `${APP_URL}/payment-success.html?plan=${plan}`,
        cancel_url: `${APP_URL}/dashboard.html?tab=billing&cancelled=1`,
        brand_name: 'WorkBase PH',
        user_action: 'PAY_NOW',
        shipping_preference: 'NO_SHIPPING',
      },
    });

    const approvalLink = order.links?.find(l => l.rel === 'approve');
    if (!approvalLink) throw new Error('No approval URL returned from PayPal');

    res.json({ url: approvalLink.href, trial_days: trialDays });
  } catch (err) {
    console.error('[create-checkout]', err.message);
    res.status(500).json({ error: err.message || 'Failed to create payment session' });
  }
});

// ─── POST /api/payments/capture-order ────────────────────────────────────────
// Called from payment-success.html after PayPal redirects back with ?token=
router.post('/capture-order', authenticateToken, async (req, res) => {
  const { order_id, job_id } = req.body;
  if (!order_id) return res.status(400).json({ error: 'order_id required' });

  try {
    const capture = await ppRequest('POST', `/v2/checkout/orders/${order_id}/capture`, {});

    if (capture.status !== 'COMPLETED') {
      return res.status(400).json({ error: 'Payment not completed' });
    }

    const captureResource = capture.purchase_units?.[0]?.payments?.captures?.[0];
    const customId = captureResource?.custom_id || capture.purchase_units?.[0]?.custom_id || '';
    const [plan, userIdStr, jobIdFromCustom] = customId.split('|');
    const userId = parseInt(userIdStr);
    const resolvedJobId = job_id ? parseInt(job_id) : (jobIdFromCustom ? parseInt(jobIdFromCustom) : null);

    if (!plan || isNaN(userId)) {
      return res.status(400).json({ error: 'Could not parse order metadata' });
    }

    if (userId !== req.user.id) {
      return res.status(403).json({ error: 'Order does not belong to this account' });
    }

    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Idempotency: skip if already processed
    if (PLAN_DB_VALUE[plan] && user.paypal_order_id === captureResource?.id) {
      return res.json({ success: true, plan, already_processed: true });
    }

    await activatePayment(plan, userId, resolvedJobId, user, captureResource?.id || order_id, captureResource?.amount?.value);
    res.json({ success: true, plan });
  } catch (err) {
    console.error('[capture-order]', err.message);
    res.status(500).json({ error: err.message || 'Failed to capture payment' });
  }
});

// ─── POST /api/payments/start-trial ──────────────────────────────────────────
router.post('/start-trial', authenticateToken, async (req, res) => {
  if (req.user.role !== 'employer') return res.status(403).json({ error: 'Only employers can start a trial' });

  const { plan = 'essential' } = req.body;
  const trialPlans = ['essential', 'essential_annual', 'pro', 'pro_annual'];
  if (!trialPlans.includes(plan)) return res.status(400).json({ error: 'Starter plan does not have a free trial' });

  try {
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

    if (user.paypal_order_id || user.paymongo_payment_id) {
      return res.status(400).json({ error: 'Trial already used. Please select a paid plan.' });
    }
    if (user.subscription_tier === 'tier_1' && user.subscription_expires_at && new Date(user.subscription_expires_at) > new Date()) {
      return res.status(400).json({ error: 'You already have an active subscription.' });
    }

    const dbPlan = PLAN_DB_VALUE[plan] || 'essential';
    const trialExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    await db.prepare(
      `UPDATE users SET subscription_tier = 'tier_1', subscription_expires_at = ?, employer_plan = ? WHERE id = ?`
    ).run(trialExpiry, dbPlan, user.id);

    console.log(`🎁 7-day trial started: user ${user.id} (${dbPlan}) until ${trialExpiry}`);
    res.json({ success: true, trial_expires: trialExpiry, plan: dbPlan });
  } catch (err) {
    console.error('[start-trial]', err.message);
    res.status(500).json({ error: 'Failed to start trial' });
  }
});

// ─── POST /api/payments/create-featured-checkout ─────────────────────────────
router.post('/create-featured-checkout', authenticateToken, async (req, res) => {
  if (req.user.role !== 'employer') return res.status(403).json({ error: 'Employers only' });
  const { job_id } = req.body;
  if (!job_id) return res.status(400).json({ error: 'job_id is required' });

  try {
    const job = await db.prepare('SELECT id, title FROM jobs WHERE id = ? AND employer_id = ?').get(parseInt(job_id), req.user.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const order = await ppRequest('POST', '/v2/checkout/orders', {
      intent: 'CAPTURE',
      purchase_units: [{
        amount: { currency_code: 'USD', value: AMOUNTS.featured_listing },
        description: `WorkBase PH — Featured Listing: "${job.title}" (7 days)`,
        custom_id: `featured_listing|${req.user.id}|${job_id}`,
      }],
      application_context: {
        return_url: `${APP_URL}/payment-success.html?plan=featured_listing&job_id=${job_id}`,
        cancel_url: `${APP_URL}/dashboard.html?tab=myJobs`,
        brand_name: 'WorkBase PH',
        user_action: 'PAY_NOW',
        shipping_preference: 'NO_SHIPPING',
      },
    });

    const approvalLink = order.links?.find(l => l.rel === 'approve');
    if (!approvalLink) throw new Error('No approval URL returned from PayPal');

    res.json({ url: approvalLink.href });
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

    const order = await ppRequest('POST', '/v2/checkout/orders', {
      intent: 'CAPTURE',
      purchase_units: [{
        amount: { currency_code: 'USD', value: AMOUNTS.ai_audit },
        description: PLAN_DESCRIPTIONS.ai_audit,
        custom_id: `ai_audit|${req.user.id}|${job_id}`,
      }],
      application_context: {
        return_url: `${APP_URL}/payment-success.html?plan=ai_audit&job_id=${job_id}`,
        cancel_url: `${APP_URL}/dashboard.html?audit_cancelled=1`,
        brand_name: 'WorkBase PH',
        user_action: 'PAY_NOW',
        shipping_preference: 'NO_SHIPPING',
      },
    });

    const approvalLink = order.links?.find(l => l.rel === 'approve');
    if (!approvalLink) throw new Error('No approval URL returned from PayPal');

    res.json({ url: approvalLink.href });
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
// Receive payment events from PayPal (PAYMENT.CAPTURE.COMPLETED)
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;

  if (webhookId) {
    try {
      const rawBody = req.body.toString('utf8');
      const verification = await ppRequest('POST', '/v1/notifications/verify-webhook-signature', {
        transmission_id:   req.headers['paypal-transmission-id'],
        transmission_time: req.headers['paypal-transmission-time'],
        cert_url:          req.headers['paypal-cert-url'],
        auth_algo:         req.headers['paypal-auth-algo'],
        transmission_sig:  req.headers['paypal-transmission-sig'],
        webhook_id:        webhookId,
        webhook_event:     JSON.parse(rawBody),
      });
      if (verification.verification_status !== 'SUCCESS') {
        console.error('[webhook] PayPal signature verification failed');
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

  const eventType = payload?.event_type;
  console.log('[PayPal webhook]', eventType);

  try {
    if (eventType === 'PAYMENT.CAPTURE.COMPLETED') {
      const capture = payload.resource;
      const customId = capture?.custom_id || '';
      const [plan, userIdStr, jobIdStr] = customId.split('|');
      const userId = parseInt(userIdStr);
      const jobId  = jobIdStr ? parseInt(jobIdStr) : null;

      if (!plan || !userId || isNaN(userId)) {
        console.error('[webhook] Could not parse custom_id:', customId);
        return res.json({ received: true });
      }

      const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      if (!user) {
        console.error('[webhook] User not found:', userId);
        return res.json({ received: true });
      }

      // Skip if already activated via capture-order endpoint (idempotency)
      if (PLAN_DB_VALUE[plan] && user.paypal_order_id === capture.id) {
        console.log('[webhook] Already processed, skipping');
        return res.json({ received: true });
      }

      await activatePayment(plan, userId, jobId, user, capture.id, capture.amount?.value);
    }
  } catch (err) {
    console.error('[webhook] Error processing event:', err.message);
  }

  res.json({ received: true });
});

module.exports = router;
