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

// TRUE when an employer is on Starter (no active subscription) AND is NOT a
// grandfathered pre-restructure account. These employers get the new Starter
// rules: email-only (no in-app messaging / instant interview links) and a
// 30-day applicant-window lock. Existing employers (starter_legacy = TRUE) are
// exempt so the restructure never disrupts their current experience.
function starterGated(user) {
  return !!user
    && user.role === 'employer'
    && !isSubscriptionActive(user)
    && !user.starter_legacy;
}

module.exports = { isSubscriptionActive, starterGated };
