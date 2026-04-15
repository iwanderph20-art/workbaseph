const express = require('express');
const router = express.Router();
const https = require('https');
const crypto = require('crypto');
const db = require('../database');
const { authenticateToken } = require('../middleware/auth');
const { sendEmail, welcomeEmployerPostPaymentEmail } = require('../services/email');

const HITPAY_API_KEY  = process.env.HITPAY_API_KEY;   // Set in Railway env vars
const HITPAY_SALT     = process.env.HITPAY_SALT;       // Webhook validation salt from HitPay dashboard
const HITPAY_BASE_URL = process.env.HITPAY_BASE_URL || 'https://api.hit-pay.com/v1';
const APP_URL         = process.env.APP_URL || 'https://workbaseph.com';

// Plan definitions (amounts in USD, currency configurable)
const PLANS = {
  starter: { amount: '15.00',  currency: 'USD', label: 'Starter Plan — $15 (1 Job Post)',   mode: 'one_time',     months: null },
  growth:  { amount: '59.00',  currency: 'USD', label: 'Growth Plan — $59/month',            mode: 'subscription', months: 1    },
  pro:     { amount: '149.00', currency: 'USD', label: 'Pro Plan — $149/month',              mode: 'subscription', months: 1    },
};

// ─── Helper: call HitPay API ─────────────────────────────────────────────────
function hitpayRequest(path, body) {
  return new Promise((resolve, reject) => {
    if (!HITPAY_API_KEY) {
      return reject(new Error('HITPAY_API_KEY not configured in environment variables.'));
    }
    const payload = JSON.stringify(body);
    const options = {
      hostname: HITPAY_BASE_URL.replace('https://', '').split('/')[0],
      path: '/v1' + path,
      method: 'POST',
      headers: {
        'X-BUSINESS-API-KEY': HITPAY_API_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
          else reject(new Error(parsed.message || `HitPay error ${res.statusCode}`));
        } catch {
          reject(new Error('Invalid HitPay response'));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ─── POST /api/payments/hitpay-checkout ──────────────────────────────────────
// Create a HitPay payment request for a given plan
router.post('/hitpay-checkout', authenticateToken, async (req, res) => {
  if (req.user.role !== 'employer') {
    return res.status(403).json({ error: 'Only employers can purchase plans' });
  }
  const { plan } = req.body;
  if (!PLANS[plan]) {
    return res.status(400).json({ error: 'Invalid plan. Choose starter, growth, or pro.' });
  }

  try {
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const planDef = PLANS[plan];

    if (!HITPAY_API_KEY) {
      // HitPay not configured yet — inform user and log
      console.warn('[HitPay] HITPAY_API_KEY not set. Payment cannot be processed.');
      return res.status(503).json({
        error: 'Online payment is being set up. Please contact admin@workbaseph.com to activate your plan manually.',
        code: 'HITPAY_NOT_CONFIGURED',
      });
    }

    // Create HitPay payment request
    const paymentRequest = await hitpayRequest('/payment-requests', {
      amount: planDef.amount,
      currency: planDef.currency,
      email: user.email,
      name: user.full_name,
      purpose: planDef.label,
      reference_number: `workbaseph-${user.id}-${plan}-${Date.now()}`,
      redirect_url: `${APP_URL}/dashboard.html?payment=success&plan=${plan}`,
      webhook: `${APP_URL}/api/hitpay/webhook`,
      allow_repeated_payments: false,
    });

    // Store the payment request reference so we can match the webhook
    await db.prepare(
      'INSERT OR IGNORE INTO hitpay_requests (user_id, plan, reference, payment_request_id, status, created_at) VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)'
    ).run(user.id, plan, paymentRequest.reference_number, paymentRequest.id, 'pending').catch(() => {});

    res.json({ url: paymentRequest.url, reference: paymentRequest.reference_number });
  } catch (err) {
    console.error('[HitPay checkout] error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to create payment link' });
  }
});

// ─── POST /api/hitpay/webhook ─────────────────────────────────────────────────
// HitPay posts here after a payment completes or fails
router.post('/webhook', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const {
      payment_id, payment_request_id, phone, amount, currency, status,
      reference_number, hmac,
    } = req.body;

    // Validate HMAC signature if salt is configured
    if (HITPAY_SALT) {
      const fields = [payment_id, payment_request_id, phone, amount, currency, status, reference_number]
        .map(v => v || '')
        .join('');
      const expectedHmac = crypto.createHmac('sha256', HITPAY_SALT).update(fields).digest('hex');
      if (hmac !== expectedHmac) {
        console.warn('[HitPay webhook] HMAC mismatch — ignoring');
        return res.status(401).send('Invalid signature');
      }
    }

    if (status !== 'completed') {
      console.log(`[HitPay webhook] payment ${payment_id} status: ${status} — ignoring`);
      return res.sendStatus(200);
    }

    // Parse reference to get user_id and plan: workbaseph-{userId}-{plan}-{ts}
    const parts = (reference_number || '').split('-');
    // Format: workbaseph-{userId}-{plan}-{timestamp}
    const userId = parseInt(parts[1]);
    const plan   = parts[2]; // starter | growth | pro

    if (!userId || !PLANS[plan]) {
      console.error('[HitPay webhook] could not parse reference:', reference_number);
      return res.sendStatus(200);
    }

    // Activate employer account
    const now = new Date();
    if (plan === 'starter') {
      // Add 1 post credit
      await db.prepare('UPDATE users SET employer_plan = ?, post_credits = COALESCE(post_credits,0) + 1 WHERE id = ?')
        .run('starter', userId);
    } else {
      // Growth or Pro: set subscription for 1 month
      const expires = new Date(now);
      expires.setMonth(expires.getMonth() + 1);
      await db.prepare(
        'UPDATE users SET employer_plan = ?, subscription_tier = ?, subscription_expires_at = ? WHERE id = ?'
      ).run(plan, 'tier_1', expires.toISOString(), userId);
    }

    // Mark payment request as completed
    await db.prepare(
      'UPDATE hitpay_requests SET status = ? WHERE reference = ?'
    ).run('completed', reference_number).catch(() => {});

    // Send post-payment welcome email
    const employer = await db.prepare('SELECT email, full_name FROM users WHERE id = ?').get(userId);
    if (employer) {
      const docRow = await db.prepare('SELECT id FROM employer_documents WHERE employer_id = ? LIMIT 1').get(userId);
      sendEmail({ to: employer.email, ...welcomeEmployerPostPaymentEmail(employer.full_name, !!docRow) })
        .catch(err => console.error('[HitPay webhook] welcome email failed:', err.message));
    }

    console.log(`[HitPay webhook] activated ${plan} plan for user ${userId}`);
    res.sendStatus(200);
  } catch (err) {
    console.error('[HitPay webhook] error:', err.message);
    res.sendStatus(500);
  }
});

module.exports = router;
