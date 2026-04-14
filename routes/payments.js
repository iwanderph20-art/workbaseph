const express = require('express');
const router = express.Router();
const db = require('../database');
const { authenticateToken } = require('../middleware/auth');

const { sendEmail, welcomeEmployerPostPaymentEmail } = require('../services/email');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const PRICE_ID = process.env.STRIPE_PRICE_ID;
const APP_URL = process.env.APP_URL || 'https://workbaseph.com';
// Pay-per-post: $15 one-time; Subscription: $59/month
const PAY_PER_POST_PRICE = process.env.STRIPE_PPP_PRICE_ID;   // one-time $15 price in Stripe
const SUBSCRIPTION_PRICE = process.env.STRIPE_PRICE_ID;        // $59/mo subscription
const AI_AUDIT_PRICE = process.env.STRIPE_AI_AUDIT_PRICE_ID;  // one-time $15 AI audit

// ─── POST /api/payments/create-checkout ──────────────────────────────────────
// plan: 'subscription' ($59/mo) | 'pay_per_post' ($15 one-time)
router.post('/create-checkout', authenticateToken, async (req, res) => {
  if (req.user.role !== 'employer') {
    return res.status(403).json({ error: 'Only employers can purchase plans' });
  }

  const { plan = 'subscription' } = req.body;
  if (!['subscription', 'pay_per_post'].includes(plan)) {
    return res.status(400).json({ error: 'plan must be subscription or pay_per_post' });
  }

  try {
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

    if (plan === 'subscription' && user.subscription_tier === 'tier_1' && user.subscription_expires_at) {
      const expires = new Date(user.subscription_expires_at);
      if (expires > new Date()) {
        return res.status(400).json({ error: 'You already have an active subscription' });
      }
    }

    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: user.full_name,
        metadata: { workbaseph_user_id: String(user.id) },
      });
      customerId = customer.id;
      await db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customerId, user.id);
    }

    if (plan === 'pay_per_post') {
      // One-time payment for 1 job post credit
      const priceId = PAY_PER_POST_PRICE;
      if (!priceId) {
        return res.status(500).json({ error: 'Pay-per-post pricing not configured. Set STRIPE_PPP_PRICE_ID.' });
      }
      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        payment_method_types: ['card'],
        line_items: [{ price: priceId, quantity: 1 }],
        mode: 'payment',
        success_url: `${APP_URL}/payment-success.html?session_id={CHECKOUT_SESSION_ID}&plan=pay_per_post`,
        cancel_url: `${APP_URL}/pricing.html?cancelled=1`,
        metadata: { workbaseph_user_id: String(user.id), plan: 'pay_per_post' },
      });
      return res.json({ url: session.url, session_id: session.id, plan: 'pay_per_post' });
    }

    // Subscription ($59/month)
    if (!SUBSCRIPTION_PRICE) {
      return res.status(500).json({ error: 'Subscription pricing not configured. Set STRIPE_PRICE_ID.' });
    }
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: SUBSCRIPTION_PRICE, quantity: 1 }],
      mode: 'subscription',
      success_url: `${APP_URL}/payment-success.html?session_id={CHECKOUT_SESSION_ID}&plan=subscription`,
      cancel_url: `${APP_URL}/pricing.html?cancelled=1`,
      metadata: { workbaseph_user_id: String(user.id), plan: 'subscription' },
      subscription_data: {
        metadata: { workbaseph_user_id: String(user.id) },
      },
    });

    res.json({ url: session.url, session_id: session.id, plan: 'subscription' });
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    res.status(500).json({ error: 'Failed to create payment session' });
  }
});

// ─── GET /api/payments/status ─────────────────────────────────────────────────
router.get('/status', authenticateToken, async (req, res) => {
  try {
    const user = await db.prepare('SELECT subscription_tier, subscription_expires_at FROM users WHERE id = ?').get(req.user.id);
    const isActive = user.subscription_tier === 'tier_1'
      && user.subscription_expires_at
      && new Date(user.subscription_expires_at) > new Date();

    res.json({
      tier: user.subscription_tier,
      active: isActive,
      expires_at: user.subscription_expires_at,
    });
  } catch (err) {
    console.error('[payment status] error:', err.message);
    res.status(500).json({ error: 'Failed to fetch status' });
  }
});

// ─── POST /api/payments/create-audit-checkout ────────────────────────────────
// Starts a $15 one-time Stripe checkout for AI Candidate Audit on a specific job
router.post('/create-audit-checkout', authenticateToken, async (req, res) => {
  if (req.user.role !== 'employer') {
    return res.status(403).json({ error: 'Only employers can purchase AI audits' });
  }
  const { job_id } = req.body;
  if (!job_id) return res.status(400).json({ error: 'job_id is required' });

  try {
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

    // Pro plan gets unlimited audits — no payment needed
    if (user.employer_plan === 'pro') {
      return res.json({ skip_payment: true, message: 'Pro plan — audit unlocked automatically' });
    }

    if (!AI_AUDIT_PRICE) {
      return res.status(500).json({ error: 'AI Audit pricing not configured. Set STRIPE_AI_AUDIT_PRICE_ID.' });
    }

    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: user.full_name,
        metadata: { workbaseph_user_id: String(user.id) },
      });
      customerId = customer.id;
      await db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customerId, user.id);
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: AI_AUDIT_PRICE, quantity: 1 }],
      mode: 'payment',
      success_url: `${APP_URL}/dashboard.html?audit_success=1&job_id=${job_id}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_URL}/dashboard.html?audit_cancelled=1`,
      metadata: { workbaseph_user_id: String(user.id), plan: 'ai_audit', job_id: String(job_id) },
    });

    return res.json({ url: session.url, session_id: session.id });
  } catch (err) {
    console.error('AI Audit checkout error:', err.message);
    res.status(500).json({ error: 'Failed to create audit payment session' });
  }
});

// ─── POST /api/payments/run-audit ─────────────────────────────────────────────
// Called after payment succeeds; marks job as audit-unlocked and triggers AI analysis
router.post('/run-audit', authenticateToken, async (req, res) => {
  if (req.user.role !== 'employer') {
    return res.status(403).json({ error: 'Employers only' });
  }
  const { job_id } = req.body;
  if (!job_id) return res.status(400).json({ error: 'job_id is required' });

  try {
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const job = await db.prepare('SELECT * FROM jobs WHERE id = ? AND employer_id = ?').get(job_id, req.user.id);
    if (!job) return res.status(404).json({ error: 'Job not found or not yours' });

    // Check audit is unlocked (paid or Pro)
    if (user.employer_plan !== 'pro' && !job.ai_audit_unlocked) {
      return res.status(403).json({ error: 'Audit not purchased for this job' });
    }

    // Track monthly usage for upsell trigger
    const thisMonth = new Date().toISOString().slice(0, 7); // "2026-04"
    const sameMonth = user.ai_audit_month === thisMonth;
    const newUses = sameMonth ? (user.ai_audit_uses_month || 0) + 1 : 1;
    await db.prepare(
      'UPDATE users SET ai_audit_uses_month = ?, ai_audit_month = ? WHERE id = ?'
    ).run(newUses, thisMonth, req.user.id);

    // Get applicants for this job
    const applicants = await db.prepare(`
      SELECT u.id, u.full_name, u.skills, u.ai_tier_recommendation, u.pre_screen_status,
             a.id as application_id, a.status
      FROM applications a
      JOIN users u ON u.id = a.talent_id
      WHERE a.job_id = ? AND a.status NOT IN ('rejected','archived')
    `).all(job_id);

    if (!applicants.length) {
      return res.json({ message: 'No applicants to audit', results: [], upsell: newUses > 2 });
    }

    // AI analysis via Claude — batch analyze against JD
    const { analyzeAuditBatch } = require('../services/ai');
    const results = await analyzeAuditBatch(job, applicants);

    // Archive mismatches
    let matchCount = 0, mismatchCount = 0;
    for (const r of results) {
      if (r.verdict === 'MISMATCH') {
        await db.prepare(
          "UPDATE applications SET status = 'archived', ai_mismatch_reason = ? WHERE id = ?"
        ).run(r.reason, r.application_id);
        mismatchCount++;
      } else {
        matchCount++;
      }
    }

    // Mark audit complete
    await db.prepare(
      'UPDATE jobs SET ai_audit_completed_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(job_id);

    const upsell = user.employer_plan !== 'pro' && newUses >= 2;
    res.json({ message: 'Audit complete', match: matchCount, mismatch: mismatchCount, results, upsell });
  } catch (err) {
    console.error('[run-audit] error:', err.message);
    res.status(500).json({ error: 'Audit failed: ' + err.message });
  }
});

// ─── POST /api/payments/cancel ────────────────────────────────────────────────
router.post('/cancel', authenticateToken, async (req, res) => {
  try {
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!user.stripe_subscription_id) {
      return res.status(400).json({ error: 'No active subscription found' });
    }

    await stripe.subscriptions.update(user.stripe_subscription_id, {
      cancel_at_period_end: true,
    });
    res.json({ message: 'Subscription will cancel at end of current billing period' });
  } catch (err) {
    console.error('Stripe cancel error:', err.message);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

// ─── POST /api/payments/webhook ───────────────────────────────────────────────
// Stripe sends events here. MUST use raw body (not JSON-parsed).
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature invalid:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const data = event.data.object;

  try {
    switch (event.type) {

      // One-time checkout (pay-per-post or ai_audit) completed
      case 'checkout.session.completed': {
        const session = data;
        if (session.mode === 'payment') {
          const userId = session.metadata?.workbaseph_user_id;
          const plan = session.metadata?.plan;

          if (plan === 'pay_per_post' && userId) {
            await db.prepare(
              'UPDATE users SET post_credits = post_credits + 1, payment_method_added = 1 WHERE id = ?'
            ).run(parseInt(userId));
            console.log(`✅ Pay-per-post credit added for user ${userId}`);
          }

          if (plan === 'ai_audit' && userId && session.metadata?.job_id) {
            const jobId = parseInt(session.metadata.job_id);
            await db.prepare(
              'UPDATE jobs SET ai_audit_unlocked = 1 WHERE id = ? AND employer_id = ?'
            ).run(jobId, parseInt(userId));
            console.log(`✅ AI Audit unlocked for job ${jobId} by user ${userId}`);
          }
        }
        break;
      }

      // Payment succeeded → activate subscription
      case 'invoice.payment_succeeded': {
        const subId = data.subscription;
        const customerId = data.customer;
        const periodEnd = new Date(data.lines.data[0]?.period?.end * 1000).toISOString();

        await db.prepare(`
          UPDATE users SET
            subscription_tier = 'tier_1',
            subscription_expires_at = ?,
            stripe_subscription_id = ?,
            payment_method_added = 1
          WHERE stripe_customer_id = ?
        `).run(periodEnd, subId, customerId);

        console.log(`✅ Subscription activated for Stripe customer ${customerId} until ${periodEnd}`);

        if (data.billing_reason === 'subscription_create') {
          const employer = await db.prepare('SELECT email, full_name FROM users WHERE stripe_customer_id = ?').get(customerId);
          if (employer) {
            sendEmail({ to: employer.email, ...welcomeEmployerPostPaymentEmail(employer.full_name) })
              .catch(err => console.error('Employer welcome email failed:', err.message));
          }
        }
        break;
      }

      // Payment failed → downgrade to free
      case 'invoice.payment_failed': {
        const customerId = data.customer;
        await db.prepare(`
          UPDATE users SET subscription_tier = 'free', subscription_expires_at = NULL
          WHERE stripe_customer_id = ?
        `).run(customerId);
        console.log(`❌ Payment failed for Stripe customer ${customerId} — downgraded to free`);
        break;
      }

      // Subscription cancelled or expired
      case 'customer.subscription.deleted': {
        const customerId = data.customer;
        await db.prepare(`
          UPDATE users SET subscription_tier = 'free', stripe_subscription_id = NULL, subscription_expires_at = NULL
          WHERE stripe_customer_id = ?
        `).run(customerId);
        console.log(`🔴 Subscription cancelled for Stripe customer ${customerId}`);
        break;
      }
    }
  } catch (err) {
    console.error('[webhook] DB error:', err.message);
  }

  res.json({ received: true });
});

module.exports = router;
