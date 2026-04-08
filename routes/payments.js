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

      // One-time checkout (pay-per-post) completed
      case 'checkout.session.completed': {
        const session = data;
        if (session.mode === 'payment' && session.metadata?.plan === 'pay_per_post') {
          const userId = session.metadata?.workbaseph_user_id;
          if (userId) {
            await db.prepare(
              'UPDATE users SET post_credits = post_credits + 1, payment_method_added = 1 WHERE id = ?'
            ).run(parseInt(userId));
            console.log(`✅ Pay-per-post credit added for user ${userId}`);
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
