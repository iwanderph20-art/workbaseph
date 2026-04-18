const express = require('express');
const router = express.Router();
const db = require('../database');
const { authenticateToken } = require('../middleware/auth');

const { sendEmail, welcomeEmployerPostPaymentEmail } = require('../services/email');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const APP_URL = process.env.APP_URL || 'https://workbaseph.com';

// ── Stripe Price IDs (set these in Railway environment variables) ──────────────
const PRICES = {
  pay_per_post:      process.env.STRIPE_PPP_PRICE_ID,           // $15 one-time
  essential:         process.env.STRIPE_ESSENTIAL_PRICE_ID,      // $29/mo
  essential_annual:  process.env.STRIPE_ESSENTIAL_ANNUAL_PRICE_ID, // $290/yr
  growth:            process.env.STRIPE_PRICE_ID,                // $59/mo
  growth_annual:     process.env.STRIPE_GROWTH_ANNUAL_PRICE_ID,  // $590/yr
  pro:               process.env.STRIPE_PRO_PRICE_ID,            // $129/mo
  pro_annual:        process.env.STRIPE_PRO_ANNUAL_PRICE_ID,     // $1290/yr
  ai_audit:          process.env.STRIPE_AI_AUDIT_PRICE_ID,       // $15 one-time
  featured_listing:  process.env.STRIPE_FEATURED_PRICE_ID,       // $15 one-time
};

// Plans that get a 7-day free trial (first subscription only)
const TRIAL_PLANS = ['essential', 'essential_annual', 'growth', 'growth_annual', 'pro', 'pro_annual'];

// Map plan key → employer_plan value stored in DB
const PLAN_DB_VALUE = {
  essential: 'essential', essential_annual: 'essential',
  growth: 'growth', growth_annual: 'growth',
  pro: 'pro', pro_annual: 'pro',
};

// ─── GET /api/payments/referral-info ──────────────────────────────────────────
// Returns employer's referral code + how many signups they've referred
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
// plan: 'pay_per_post' | 'essential' | 'essential_annual' | 'growth' | 'growth_annual' | 'pro' | 'pro_annual'
router.post('/create-checkout', authenticateToken, async (req, res) => {
  if (req.user.role !== 'employer') {
    return res.status(403).json({ error: 'Only employers can purchase plans' });
  }

  const { plan = 'growth' } = req.body;
  const validPlans = ['pay_per_post', 'essential', 'essential_annual', 'growth', 'growth_annual', 'pro', 'pro_annual'];
  if (!validPlans.includes(plan)) {
    return res.status(400).json({ error: 'Invalid plan' });
  }

  const priceId = PRICES[plan];
  if (!priceId) {
    return res.status(500).json({ error: `Pricing for "${plan}" not configured. Set STRIPE_${plan.toUpperCase()}_PRICE_ID in Railway env vars.` });
  }

  try {
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

    // Block duplicate active subscriptions
    if (plan !== 'pay_per_post') {
      if (user.subscription_tier === 'tier_1' && user.subscription_expires_at && new Date(user.subscription_expires_at) > new Date()) {
        return res.status(400).json({ error: 'You already have an active subscription. Manage it from your billing tab.' });
      }
    }

    // Get or create Stripe customer
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

    // ── Pay-per-post (one-time $15) ───────────────────────────────────────────
    if (plan === 'pay_per_post') {
      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        payment_method_types: ['card'],
        line_items: [{ price: priceId, quantity: 1 }],
        mode: 'payment',
        success_url: `${APP_URL}/payment-success.html?session_id={CHECKOUT_SESSION_ID}&plan=pay_per_post`,
        cancel_url: `${APP_URL}/dashboard.html?tab=billing&cancelled=1`,
        metadata: { workbaseph_user_id: String(user.id), plan: 'pay_per_post' },
      });
      return res.json({ url: session.url });
    }

    // ── Subscription plans (Essential / Growth / Pro, monthly or annual) ──────
    const isAnnual = plan.includes('annual');
    const dbPlan = PLAN_DB_VALUE[plan];

    // Determine if this employer is eligible for a free trial
    // (never had a subscription before — subscription_tier was never tier_1)
    const hasHadTrial = user.subscription_tier === 'tier_1' || user.stripe_subscription_id;
    const trialDays = (!hasHadTrial && TRIAL_PLANS.includes(plan)) ? 7 : 0;

    const sessionParams = {
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      success_url: `${APP_URL}/payment-success.html?session_id={CHECKOUT_SESSION_ID}&plan=${plan}`,
      cancel_url: `${APP_URL}/dashboard.html?tab=billing&cancelled=1`,
      metadata: { workbaseph_user_id: String(user.id), plan },
      subscription_data: {
        metadata: { workbaseph_user_id: String(user.id), plan, db_plan: dbPlan },
      },
    };

    if (trialDays > 0) {
      sessionParams.subscription_data.trial_period_days = trialDays;
    }

    // Apply referral credit: if they were referred, add extra 30 days via coupon
    if (user.referred_by && !hasHadTrial) {
      try {
        // Create a one-time coupon for a 30-day free extension
        const coupon = await stripe.coupons.create({
          duration: 'once',
          duration_in_months: 1,
          percent_off: 100,
          name: 'Referral Bonus — 1 Month Free',
          metadata: { workbaseph_referral: user.referred_by },
        });
        sessionParams.discounts = [{ coupon: coupon.id }];
      } catch (ce) {
        console.error('[referral coupon]', ce.message);
      }
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    res.json({ url: session.url, trial_days: trialDays });
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    res.status(500).json({ error: 'Failed to create payment session' });
  }
});

// ─── POST /api/payments/create-featured-checkout ──────────────────────────────
// Boost a job post to featured status for 7 days — $15 one-time
router.post('/create-featured-checkout', authenticateToken, async (req, res) => {
  if (req.user.role !== 'employer') {
    return res.status(403).json({ error: 'Employers only' });
  }
  const { job_id } = req.body;
  if (!job_id) return res.status(400).json({ error: 'job_id is required' });

  const priceId = PRICES.featured_listing;
  if (!priceId) {
    return res.status(500).json({ error: 'Featured listing pricing not configured. Set STRIPE_FEATURED_PRICE_ID.' });
  }

  try {
    const job = await db.prepare('SELECT id, title FROM jobs WHERE id = ? AND employer_id = ?').get(parseInt(job_id), req.user.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const user = await db.prepare('SELECT stripe_customer_id, email, full_name FROM users WHERE id = ?').get(req.user.id);
    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email, name: user.full_name, metadata: { workbaseph_user_id: String(req.user.id) } });
      customerId = customer.id;
      await db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customerId, req.user.id);
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'payment',
      success_url: `${APP_URL}/dashboard.html?featured_success=1&job_id=${job_id}`,
      cancel_url: `${APP_URL}/dashboard.html?tab=myJobs`,
      metadata: { workbaseph_user_id: String(req.user.id), plan: 'featured_listing', job_id: String(job_id) },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('[featured checkout]', err.message);
    res.status(500).json({ error: 'Failed to create featured listing checkout' });
  }
});

// ─── GET /api/payments/status ─────────────────────────────────────────────────
router.get('/status', authenticateToken, async (req, res) => {
  try {
    const user = await db.prepare('SELECT subscription_tier, subscription_expires_at, employer_plan FROM users WHERE id = ?').get(req.user.id);
    const isActive = user.subscription_tier === 'tier_1'
      && user.subscription_expires_at
      && new Date(user.subscription_expires_at) > new Date();
    res.json({ tier: user.subscription_tier, active: isActive, expires_at: user.subscription_expires_at, plan: user.employer_plan });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch status' });
  }
});

// ─── POST /api/payments/create-audit-checkout ────────────────────────────────
router.post('/create-audit-checkout', authenticateToken, async (req, res) => {
  if (req.user.role !== 'employer') return res.status(403).json({ error: 'Employers only' });
  const { job_id } = req.body;
  if (!job_id) return res.status(400).json({ error: 'job_id is required' });

  try {
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (user.employer_plan === 'pro') {
      return res.json({ skip_payment: true, message: 'Pro plan — audit unlocked automatically' });
    }

    const priceId = PRICES.ai_audit;
    if (!priceId) return res.status(500).json({ error: 'AI Audit pricing not configured. Set STRIPE_AI_AUDIT_PRICE_ID.' });

    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email, name: user.full_name, metadata: { workbaseph_user_id: String(user.id) } });
      customerId = customer.id;
      await db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customerId, user.id);
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'payment',
      success_url: `${APP_URL}/dashboard.html?audit_success=1&job_id=${job_id}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_URL}/dashboard.html?audit_cancelled=1`,
      metadata: { workbaseph_user_id: String(user.id), plan: 'ai_audit', job_id: String(job_id) },
    });
    return res.json({ url: session.url });
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
      } else { matchCount++; }
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
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!user.stripe_subscription_id) return res.status(400).json({ error: 'No active subscription found' });
    await stripe.subscriptions.update(user.stripe_subscription_id, { cancel_at_period_end: true });
    res.json({ message: 'Subscription will cancel at end of current billing period' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

// ─── POST /api/payments/webhook ───────────────────────────────────────────────
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

      // One-time OR subscription checkout completed
      case 'checkout.session.completed': {
        const session = data;
        const userId = session.metadata?.workbaseph_user_id;
        const plan = session.metadata?.plan;

        if (session.mode === 'payment') {
          // Pay-per-post: add 1 post credit
          if (plan === 'pay_per_post' && userId) {
            await db.prepare('UPDATE users SET post_credits = post_credits + 1, payment_method_added = 1, employer_plan = ? WHERE id = ?')
              .run('starter', parseInt(userId));
          }

          // AI Audit: unlock for specific job
          if (plan === 'ai_audit' && userId && session.metadata?.job_id) {
            await db.prepare('UPDATE jobs SET ai_audit_unlocked = 1 WHERE id = ? AND employer_id = ?')
              .run(parseInt(session.metadata.job_id), parseInt(userId));
          }

          // Featured listing: set featured_until to 7 days from now
          if (plan === 'featured_listing' && userId && session.metadata?.job_id) {
            const featuredUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
            await db.prepare('UPDATE jobs SET featured_until = ? WHERE id = ? AND employer_id = ?')
              .run(featuredUntil, parseInt(session.metadata.job_id), parseInt(userId));
            console.log(`⭐ Job ${session.metadata.job_id} featured until ${featuredUntil}`);
          }
        }

        // Subscription checkout: store which plan was chosen
        if (session.mode === 'subscription' && userId && plan) {
          const dbPlan = PLAN_DB_VALUE[plan] || 'growth';
          await db.prepare('UPDATE users SET employer_plan = ?, payment_method_added = 1 WHERE id = ?')
            .run(dbPlan, parseInt(userId));
          console.log(`✅ Plan set to '${dbPlan}' for user ${userId}`);
        }
        break;
      }

      // Subscription payment succeeded → activate tier_1
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

        // On first subscription: send welcome email + credit the referrer
        if (data.billing_reason === 'subscription_create') {
          const employer = await db.prepare('SELECT id, email, full_name, referred_by FROM users WHERE stripe_customer_id = ?').get(customerId);
          if (employer) {
            // Send welcome email
            const docRow = await db.prepare('SELECT id FROM employer_documents WHERE employer_id = ? LIMIT 1').get(employer.id);
            sendEmail({ to: employer.email, ...welcomeEmployerPostPaymentEmail(employer.full_name, !!docRow) })
              .catch(err => console.error('Employer welcome email failed:', err.message));

            // Referral credit: give referrer +1 month (30 days) on their subscription
            if (employer.referred_by) {
              const referrer = await db.prepare('SELECT id, email, full_name, subscription_expires_at, referral_credits FROM users WHERE referral_code = ?').get(employer.referred_by);
              if (referrer) {
                // Extend referrer's subscription by 30 days
                const newExpiry = referrer.subscription_expires_at
                  ? new Date(new Date(referrer.subscription_expires_at).getTime() + 30 * 24 * 60 * 60 * 1000).toISOString()
                  : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
                await db.prepare('UPDATE users SET subscription_expires_at = ?, referral_credits = referral_credits + 1 WHERE id = ?')
                  .run(newExpiry, referrer.id);
                // Notify referrer
                await db.prepare("INSERT INTO notifications (user_id, type, title, body, data) VALUES (?, 'referral_credit', ?, ?, ?)")
                  .run(referrer.id,
                    'Referral Bonus — 1 Month Free!',
                    `${employer.full_name} signed up using your referral link. You've earned 1 extra month on your subscription!`,
                    JSON.stringify({ referred_user: employer.full_name })
                  );
                console.log(`🎁 Referral credit: +30 days for user ${referrer.id} (referred ${employer.full_name})`);
              }
            }
          }
        }
        break;
      }

      // Payment failed → downgrade
      case 'invoice.payment_failed': {
        const customerId = data.customer;
        await db.prepare(`UPDATE users SET subscription_tier = 'free', subscription_expires_at = NULL WHERE stripe_customer_id = ?`).run(customerId);
        console.log(`❌ Payment failed for ${customerId} — downgraded`);
        break;
      }

      // Subscription cancelled
      case 'customer.subscription.deleted': {
        const customerId = data.customer;
        await db.prepare(`UPDATE users SET subscription_tier = 'free', stripe_subscription_id = NULL, subscription_expires_at = NULL WHERE stripe_customer_id = ?`).run(customerId);
        console.log(`🔴 Subscription cancelled for ${customerId}`);
        break;
      }
    }
  } catch (err) {
    console.error('[webhook] DB error:', err.message);
  }

  res.json({ received: true });
});

module.exports = router;
