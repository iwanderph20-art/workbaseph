const express = require('express');
const router = express.Router();
const https = require('https');
const crypto = require('crypto');
const db = require('../database');
const { authenticateToken } = require('../middleware/auth');
const { sendEmail, adminSignupNotificationEmail } = require('../services/email');

// ── Admin "new employer signup" report ────────────────────────────────────────
// Sent once, when an employer FINISHES signup by picking a plan — not at registration,
// where the plan isn't known yet and the report would always read "awaiting selection".
// admin_signup_notified_at guarantees it only ever goes out once per employer.
async function notifyAdminOfEmployerSignup(userId, planLabel) {
  try {
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user || user.role !== 'employer') return;
    if (user.admin_signup_notified_at) return;              // already reported
    if (user.admin_role) return;                            // don't report admins

    // Stamp first so two near-simultaneous calls can't both send.
    const stamped = await db.prepare(
      'UPDATE users SET admin_signup_notified_at = NOW() WHERE id = ? AND admin_signup_notified_at IS NULL'
    ).run(userId);
    if (!stamped?.changes) return;

    let referredBy = null;
    if (user.referred_by) {
      const ref = await db.prepare('SELECT full_name FROM users WHERE referral_code = ?').get(user.referred_by);
      referredBy = ref?.full_name || null;
    }
    const adminEmail = process.env.ADMIN_NOTIFY_EMAIL || 'admin@workbaseph.com';
    await sendEmail({ to: adminEmail, ...adminSignupNotificationEmail(user, referredBy, planLabel) });
    console.log(`📨 Admin notified: employer signup complete — ${user.email} (${planLabel})`);
  } catch (err) {
    console.error('[admin employer signup notify]', err.message);
  }
}

const APP_URL = process.env.APP_URL || 'https://workbaseph.com';
const PAYPAL_HOST = process.env.PAYPAL_MODE === 'sandbox'
  ? 'api-m.sandbox.paypal.com'
  : 'api-m.paypal.com';

// ── USD amounts (override via env vars) ───────────────────────────────────────
// 2026-08 single-plan model: one-time All-Access ($29) plus two optional add-ons.
// Subscriptions (Essential/Pro) are retired — no recurring plans remain.
const AMOUNTS = {
  pay_per_post:     process.env.PP_AMOUNT_PAY_PER_POST    || '29.00',
  ai_audit:         process.env.PP_AMOUNT_AI_AUDIT         || '15.00',
  featured_listing: process.env.PP_AMOUNT_FEATURED         || '15.00',
};

const PLAN_DESCRIPTIONS = {
  pay_per_post:     'WorkBase PH — All-Access (job post)',
  ai_audit:         'WorkBase PH — AI Applicant Audit',
  featured_listing: 'WorkBase PH — Featured Job Listing (7 days)',
};

const PLAN_LABELS = {
  pay_per_post:     'All-Access — One-Time ($29)',
  ai_audit:         'AI Candidate Audit Add-on ($15)',
  featured_listing: 'Featured Listing — 7 days ($15)',
};

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
  // Always record the payment for admin visibility
  const amount = amountPaid || AMOUNTS[plan] || '0.00';
  await db.prepare(
    'INSERT INTO payment_records (user_id, plan, plan_label, amount_usd, paypal_order_id, job_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(userId, plan, PLAN_LABELS[plan] || plan, amount, paymentId || null, jobId || null).catch(err => {
    console.error('Failed to record payment:', err.message);
  });

  // A plan purchase means signup is finished — report it to admin once, naming the plan.
  // Add-ons (ai_audit, featured_listing) aren't signup completion, so they don't trigger it.
  if (plan === 'pay_per_post') {
    notifyAdminOfEmployerSignup(userId, PLAN_LABELS[plan] || plan).catch(() => {});
  }

  if (plan === 'pay_per_post') {
    await db.prepare(
      'UPDATE users SET post_credits = post_credits + 1, payment_method_added = 1, employer_plan = ? WHERE id = ?'
    ).run('starter', userId);
    console.log(`✅ Pay-per-post credit +1 for user ${userId}`);
    // If this $29 was to unlock/reactivate a specific expired post, reopen it now with a fresh
    // 30-day window (spending the credit just added) so its locked applicants become visible.
    if (jobId) {
      const job = await db.prepare('SELECT id FROM jobs WHERE id = ? AND employer_id = ?').get(jobId, userId);
      if (job) {
        await db.prepare(
          "UPDATE jobs SET status = 'open', auto_paused = 0, expires_at = NOW() + INTERVAL '30 days', expiry_reminder_sent = 0, updated_at = NOW() WHERE id = ? AND employer_id = ?"
        ).run(jobId, userId);
        await db.prepare('UPDATE users SET post_credits = post_credits - 1 WHERE id = ? AND post_credits > 0').run(userId);
        console.log(`✅ Reopened job ${jobId} via $29 unlock (fresh 30-day window)`);
      }
    }
  } else if (plan === 'ai_audit' && jobId) {
    await db.prepare('UPDATE jobs SET ai_audit_unlocked = 1 WHERE id = ? AND employer_id = ?').run(jobId, userId);
    console.log(`✅ AI Audit unlocked: job ${jobId}`);
  } else if (plan === 'featured_listing' && jobId) {
    const featuredUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await db.prepare('UPDATE jobs SET featured_until = ? WHERE id = ? AND employer_id = ?').run(featuredUntil, jobId, userId);
    console.log(`⭐ Job ${jobId} featured until ${featuredUntil}`);
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
// 2026-08 single-plan model: All-Access ($29 one-time) is the only purchasable plan.
router.post('/create-checkout', authenticateToken, async (req, res) => {
  if (req.user.role !== 'employer') return res.status(403).json({ error: 'Only employers can purchase plans' });

  const { plan = 'pay_per_post', job_id } = req.body;
  // Optional: this $29 is to reactivate/unlock a specific expired post (not just buy a floating
  // credit). Carried through PayPal via custom_id + return_url so capture reopens the right post.
  const reopenJobId = job_id ? parseInt(job_id) : null;
  if (plan !== 'pay_per_post') return res.status(400).json({ error: 'Invalid plan' });

  try {
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

    // ── One-time payment: pay-per-post credits ────────────────────────────────
    const order = await ppRequest('POST', '/v2/checkout/orders', {
      intent: 'CAPTURE',
      purchase_units: [{
        amount: { currency_code: 'USD', value: AMOUNTS[plan] },
        description: PLAN_DESCRIPTIONS[plan],
        custom_id: `${plan}|${user.id}|${reopenJobId || ''}`,
      }],
      application_context: {
        return_url: `${APP_URL}/payment-success.html?plan=${plan}${reopenJobId ? `&job_id=${reopenJobId}` : ''}`,
        cancel_url: `${APP_URL}/dashboard.html?tab=billing&cancelled=1`,
        brand_name: 'WorkBase PH',
        user_action: 'PAY_NOW',
        shipping_preference: 'NO_SHIPPING',
      },
    });

    const approvalLink = order.links?.find(l => l.rel === 'approve');
    if (!approvalLink) throw new Error('No approval URL returned from PayPal');

    res.json({ url: approvalLink.href });
  } catch (err) {
    console.error('[create-checkout]', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Failed to create payment session', code: err.code });
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

    await activatePayment(plan, userId, resolvedJobId, user, captureResource?.id || order_id, captureResource?.amount?.value);
    res.json({ success: true, plan });
  } catch (err) {
    console.error('[capture-order]', err.message);
    res.status(500).json({ error: err.message || 'Failed to capture payment' });
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

// ─── POST /api/payments/create-audit-checkout ─────────────────────────────────
router.post('/create-audit-checkout', authenticateToken, async (req, res) => {
  if (req.user.role !== 'employer') return res.status(403).json({ error: 'Employers only' });
  const { job_id } = req.body;
  if (!job_id) return res.status(400).json({ error: 'job_id is required' });

  try {
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

    const thisMonth = new Date().toISOString().slice(0, 7);
    // Single-plan model (2026-08): the AI Candidate Audit is a $15 per-post add-on for
    // everyone — it must be unlocked (paid) for this job before it can run.
    if (!job.ai_audit_unlocked) {
      return res.status(403).json({ error: 'Audit not purchased for this job' });
    }

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
    const upsell = newUses >= 2;
    res.json({ message: 'Audit complete', match: matchCount, mismatch: mismatchCount, results, upsell });
  } catch (err) {
    res.status(500).json({ error: 'Audit failed: ' + err.message });
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
    // One-time payments only (All-Access $29, AI audit, featured listing).
    // Subscriptions are retired, so recurring BILLING.SUBSCRIPTION / PAYMENT.SALE
    // events are no longer handled.
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

      await activatePayment(plan, userId, jobId, user, capture.id, capture.amount?.value);
    }
  } catch (err) {
    console.error('[webhook] Error processing event:', err.message);
  }

  res.json({ received: true });
});

module.exports = router;
