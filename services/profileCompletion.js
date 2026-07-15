// Single source of truth for "is a talent's profile complete enough?"
// Used by:
//   • Job Triage (admin) — to flag/annotate incomplete profiles
//   • bulk-push — to pick which email an invited talent receives
//   • job apply — to gate applications until the profile is complete
//
// Mirrors the 10 fields the admin triage UI checks. A profile is considered
// "ready to apply" once at least READY_THRESHOLD percent of these are filled.
const COMPLETION_FIELDS = [
  'full_name', 'bio', 'skills', 'profile_pic', 'resume_file',
  'video_loom_link', 'hourly_rate_range', 'weekly_availability',
  'professional_level', 'equipment',
];

const READY_THRESHOLD = 60; // percent — matches admin triage's "incomplete < 60%"

function talentProfileCompletion(user) {
  if (!user) return 0;
  const filled = COMPLETION_FIELDS.filter(f => user[f] && String(user[f]).trim()).length;
  return Math.round((filled / COMPLETION_FIELDS.length) * 100);
}

function isReadyToApply(user) {
  return talentProfileCompletion(user) >= READY_THRESHOLD;
}

// ── Weighted 0–100 profile score (the number talents actually see) ────────────
// This is the score on the talent dashboard's completion banner and stat card.
// KEEP IN SYNC with calcProfileCompletion() in public/dashboard.html.
// Distinct from talentProfileCompletion() above, which is the coarser 10-field
// check that gates job applications at READY_THRESHOLD (60%).
const PROFILE_SCORE_FIELDS = [
  { key: 'profile_pic',        weight: 10, label: 'Profile photo' },
  { key: 'bio',                weight: 10, label: 'Short bio' },
  { key: 'skills',             weight: 10, label: 'Skills' },
  { key: 'location',           weight: 5,  label: 'Location' },
  { key: 'video_loom_link',    weight: 20, label: 'Video or audio intro' },
  { key: 'resume_file',        weight: 15, label: 'Resume' },
  { key: 'specs_image',        weight: 10, label: 'Computer specs' },
  { key: 'speedtest_image',    weight: 5,  label: 'Internet speed test' },
  { key: 'hourly_rate_range',  weight: 5,  label: 'Expected rate' },
  { key: 'professional_level', weight: 5,  label: 'Experience level' },
  { key: 'personality_type',   weight: 5,  label: 'Assessment' },
];

// At/above this score we send the talent's profile to matched employers.
const SEND_THRESHOLD = 80;

const _filled = (user, key) => !!(user && user[key] && String(user[key]).trim());

function talentProfileScore(user) {
  if (!user) return 0;
  return PROFILE_SCORE_FIELDS.reduce((n, f) => n + (_filled(user, f.key) ? f.weight : 0), 0);
}

// Missing items, biggest win first — so we can tell a talent exactly what to add.
function missingProfileItems(user) {
  return PROFILE_SCORE_FIELDS
    .filter(f => !_filled(user, f.key))
    .sort((a, b) => b.weight - a.weight);
}

module.exports = {
  talentProfileCompletion, isReadyToApply, READY_THRESHOLD, COMPLETION_FIELDS,
  talentProfileScore, missingProfileItems, PROFILE_SCORE_FIELDS, SEND_THRESHOLD,
};
