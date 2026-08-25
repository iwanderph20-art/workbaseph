// ── Plan-access helpers ──────────────────────────────────────────────────────
// Shared gate logic for the 2026-07 plan restructure. Keeps the "is this employer
// a subscriber?" and "is this employer subject to the new Starter restrictions?"
// checks in one place so routes don't drift.

// Active paid subscription (Essential/Pro, incl. legacy 'growth' alias).
function isSubscriptionActive(user) {
  return !!user
    && user.subscription_tier === 'tier_1'
    && user.subscription_expires_at
    && new Date(user.subscription_expires_at) > new Date();
}

// 2026-08 restructure: All-Access ($29 one-time) is the sole plan and now INCLUDES
// in-app messaging and instant video (interview) links — the two features this gate
// used to withhold. The gate is therefore retired: no employer is feature-gated.
// Kept as an always-false function so callers in routes/messages.js and
// routes/interviews.js keep working without edits; delete once those callers drop it.
function starterGated(user) {
  return false;
}

module.exports = { isSubscriptionActive, starterGated };
