/**
 * One-off: create the PayPal Product + 4 recurring Billing Plans for WorkBase PH.
 *
 * Each plan has a 5-day free trial ($0), then auto-renews at the regular price
 * until the subscriber cancels — the model used by routes/payments.js.
 *
 * Run once:
 *   PAYPAL_CLIENT_ID=xxx PAYPAL_CLIENT_SECRET=yyy PAYPAL_MODE=live node create-paypal-plans.js
 *
 * (Or add PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET / PAYPAL_MODE to .env and just
 *  `node create-paypal-plans.js` — dotenv is loaded if present.)
 *
 * It prints the 4 plan IDs in copy-paste env-var format for Railway.
 */
try { require('dotenv').config(); } catch (_) {}
const https = require('https');

const MODE = (process.env.PAYPAL_MODE || 'live').toLowerCase();
const HOST = MODE === 'sandbox' ? 'api-m.sandbox.paypal.com' : 'api-m.paypal.com';
const CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;

// Prices (USD). Override via env if you ever change pricing.
const PRICES = {
  essential:        process.env.PP_AMOUNT_ESSENTIAL        || '49.00',
  essential_annual: process.env.PP_AMOUNT_ESSENTIAL_ANNUAL || '490.00',
  pro:              process.env.PP_AMOUNT_PRO              || '79.00',
  pro_annual:       process.env.PP_AMOUNT_PRO_ANNUAL       || '790.00',
};

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('\n❌ Missing PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET.');
  console.error('   Set them as env vars (or in .env) and run again.\n');
  process.exit(1);
}

function token() {
  const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const body = 'grant_type=client_credentials';
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: HOST, path: '/v1/oauth2/token', method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { const j = JSON.parse(d); j.access_token ? resolve(j.access_token) : reject(new Error(j.error_description || 'auth failed')); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

function api(tok, method, path, payload) {
  const body = payload ? JSON.stringify(payload) : null;
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: HOST, path, method,
      headers: {
        Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', Accept: 'application/json',
        'PayPal-Request-Id': `wb-${path}-${Date.now()}`,
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { const j = d ? JSON.parse(d) : {}; res.statusCode >= 400 ? reject(new Error(j.message || `HTTP ${res.statusCode}: ${d}`)) : resolve(j); }
        catch (e) { reject(new Error('Bad response: ' + d)); }
      });
    });
    req.on('error', reject); if (body) req.write(body); req.end();
  });
}

function planBody(productId, name, price, unit) {
  // No trial cycle — the 5-day free trial is handled on our side (no card required).
  // PayPal only bills the immediate, recurring price once the user subscribes.
  return {
    product_id: productId,
    name,
    status: 'ACTIVE',
    billing_cycles: [
      {
        frequency: { interval_unit: unit, interval_count: 1 },
        tenure_type: 'REGULAR', sequence: 1, total_cycles: 0, // 0 = until cancelled
        pricing_scheme: { fixed_price: { value: price, currency_code: 'USD' } },
      },
    ],
    payment_preferences: {
      auto_bill_outstanding: true,
      setup_fee: { value: '0', currency_code: 'USD' },
      setup_fee_failure_action: 'CONTINUE',
      payment_failure_threshold: 3,
    },
  };
}

(async () => {
  console.log(`\n🔗 PayPal mode: ${MODE.toUpperCase()} (${HOST})\n`);
  const tok = await token();

  console.log('Creating product…');
  const product = await api(tok, 'POST', '/v1/catalog/products', {
    name: 'WorkBase PH Employer Plan',
    description: 'Employer subscription for the WorkBase PH hiring marketplace',
    type: 'SERVICE',
    category: 'SOFTWARE',
  });
  console.log(`  ✓ product ${product.id}\n`);

  const specs = [
    ['PAYPAL_PLAN_ESSENTIAL',        'WorkBase PH — Essential (Monthly)', PRICES.essential,        'MONTH'],
    ['PAYPAL_PLAN_ESSENTIAL_ANNUAL', 'WorkBase PH — Essential (Annual)',  PRICES.essential_annual, 'YEAR'],
    ['PAYPAL_PLAN_PRO',              'WorkBase PH — Pro (Monthly)',       PRICES.pro,              'MONTH'],
    ['PAYPAL_PLAN_PRO_ANNUAL',       'WorkBase PH — Pro (Annual)',        PRICES.pro_annual,       'YEAR'],
  ];

  const out = [];
  for (const [envVar, name, price, unit] of specs) {
    console.log(`Creating plan: ${name} ($${price}/${unit === 'MONTH' ? 'mo' : 'yr'}, 5-day trial)…`);
    const plan = await api(tok, 'POST', '/v1/billing/plans', planBody(product.id, name, price, unit));
    console.log(`  ✓ ${plan.id}`);
    out.push([envVar, plan.id]);
  }

  console.log('\n════════════════════════════════════════════════════════════');
  console.log(' DONE. Add these to your Railway env vars (Variables tab):\n');
  for (const [k, v] of out) console.log(`  ${k}=${v}`);
  console.log('\n════════════════════════════════════════════════════════════\n');
})().catch(err => { console.error('\n❌ Error:', err.message, '\n'); process.exit(1); });
