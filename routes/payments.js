const express = require('express');
const router = express.Router();
const db = require('../database');
const { authenticateToken } = require('../middleware/auth');

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const PRICE_ID = process.env.STRIPE_PRICE_ID; // $100/month price created in Stripe dashboard
const APP_URL = process.env.APP_URL || 'https://workbaseph.com';

// ─── POST /api/payments/create-checkout ──────────────────────────────────────
// Creates a Stripe Checkout Session for the $100/month Tier 1 subscription.
// The employer is redirected to Stripe's hosted payment page.
router.post('/create-checkout', authenticateToken, async (req, res) => {
  if (req.user.role !== 'employer') {
    return res.status(403).json({ error: 'Only employers can subscribe' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

  // If already subscribed and active, don't create a new session
  if (user.subscription_tier === 'tier_1' && user.subscription_expires_at) {
    const expires = new Date(user.subscription_expires_at);
    if (expires > new Date()) {
      return res.status(400).json({ error: 'You already have an active subscription' });
    }
  }

  try {
    // Reuse existing Stripe customer or create a new one
    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: user.full_name,
        metadata: { workbaseph_user_id: String(user.id) },
      });
      customerId = customer.id;
      db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customerId, user.id);
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: PRICE_ID, quantity: 1 }],
      mode: 'subscription',
      success_url: `${APP_URL}/payment-success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_URL}/pricing.html?cancelled=1`,
      metadata: { workbaseph_user_id: String(user.id) },
      subscription_data: {
        metadata: { workbaseph_user_id: String(user.id) },
      },
    });

    res.json({ url: session.url, session_id: session.id });
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    res.status(500).json({ error: 'Failed to create payment session' });
  }
});

// ─── GET /api/payments/status ─────────────────────────────────────────────────
// Returns the current user's subscription status.
router.get('/status', authenticateToken, (req, res) => {
  const user = db.prepare('SELECT subscription_tier, subscription_expires_at FROM users WHERE id = ?').get(req.user.id);
  const isActive = user.subscription_tier === 'tier_1'
    && user.subscription_expires_at
    && new Date(user.subscription_expires_at) > new Date();

  res.json({
    tier: user.subscription_tier,
    active: isActive,
    expires_at: user.subscription_expires_at,
  });
});

// ─── POST /api/payments/cancel ────────────────────────────────────────────────
// Cancels the Stripe subscription at period end (user keeps access till expiry).
router.post('/cancel', authenticateToken, async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user.stripe_subscription_id) {
    return res.status(400).json({ error: 'No active subscription found' });
  }

  try {
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
// Register this URL in Stripe dashboard: https://workbaseph.com/api/payments/webhook
router.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature invalid:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const data = event.data.object;

  switch (event.type) {

    // Payment succeeded → activate subscription
    case 'invoice.payment_succeeded': {
      const subId = data.subscription;
      const customerId = data.customer;
      const periodEnd = new Date(data.lines.data[0]?.period?.end * 1000).toISOString();

      db.prepare(`
        UPDATE users SET
          subscription_tier = 'tier_1',
          subscription_expires_at = ?,
          stripe_subscription_id = ?
        WHERE stripe_customer_id = ?
      `).run(periodEnd, subId, customerId);

      console.log(`✅ Subscription activated for Stripe customer ${customerId} until ${periodEnd}`);
      break;
    }

    // Payment failed → downgrade to free
    case 'invoice.payment_failed': {
      const customerId = data.customer;
      db.prepare(`
        UPDATE users SET subscription_tier = 'free', subscription_expires_at = NULL
        WHERE stripe_customer_id = ?
      `).run(customerId);
      console.log(`❌ Payment failed for Stripe customer ${customerId} — downgraded to free`);
      break;
    }

    // Subscription cancelled or expired
    case 'customer.subscription.deleted': {
      const customerId = data.customer;
      db.prepare(`
        UPDATE users SET subscription_tier = 'free', stripe_subscription_id = NULL, subscription_expires_at = NULL
        WHERE stripe_customer_id = ?
      `).run(customerId);
      console.log(`🔴 Subscription cancelled for Stripe customer ${customerId}`);
      break;
    }
  }

  res.json({ received: true });
});

module.exports = router;
