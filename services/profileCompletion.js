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

module.exports = { talentProfileCompletion, isReadyToApply, READY_THRESHOLD, COMPLETION_FIELDS };
