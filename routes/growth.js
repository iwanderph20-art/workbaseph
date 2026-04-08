const express = require('express');
const router = express.Router();
const db = require('../database');
const { authenticateToken } = require('../middleware/auth');

// ── Philippine market salary benchmarks (mid-point estimates in USD/month for remote work)
const SALARY_BENCHMARKS = {
  'Web Developer': { min: 800, max: 2500, currency: 'USD', note: 'Remote, Philippines-based' },
  'Mobile Developer': { min: 900, max: 3000, currency: 'USD', note: 'Remote, Philippines-based' },
  'UI/UX Designer': { min: 600, max: 2000, currency: 'USD', note: 'Remote, Philippines-based' },
  'Graphic Designer': { min: 400, max: 1500, currency: 'USD', note: 'Remote, Philippines-based' },
  'Virtual Assistant': { min: 400, max: 1200, currency: 'USD', note: 'Remote, Philippines-based' },
  'Data Entry': { min: 300, max: 800, currency: 'USD', note: 'Remote, Philippines-based' },
  'Content Writer': { min: 400, max: 1500, currency: 'USD', note: 'Remote, Philippines-based' },
  'SEO Specialist': { min: 500, max: 1800, currency: 'USD', note: 'Remote, Philippines-based' },
  'Social Media Manager': { min: 400, max: 1500, currency: 'USD', note: 'Remote, Philippines-based' },
  'Video Editor': { min: 500, max: 2000, currency: 'USD', note: 'Remote, Philippines-based' },
  'Customer Service': { min: 350, max: 900, currency: 'USD', note: 'Remote, Philippines-based' },
  'Bookkeeper': { min: 500, max: 1500, currency: 'USD', note: 'Remote, Philippines-based' },
  'Digital Marketing': { min: 600, max: 2000, currency: 'USD', note: 'Remote, Philippines-based' },
  'Project Manager': { min: 900, max: 3000, currency: 'USD', note: 'Remote, Philippines-based' },
  'Data Analyst': { min: 700, max: 2500, currency: 'USD', note: 'Remote, Philippines-based' },
  'Copywriter': { min: 500, max: 2000, currency: 'USD', note: 'Remote, Philippines-based' },
  'IT Support': { min: 400, max: 1200, currency: 'USD', note: 'Remote, Philippines-based' },
};

// ── In-demand skills mapped to job categories
const SKILL_SUGGESTIONS = {
  'Web Developer': ['React', 'Next.js', 'Node.js', 'TypeScript', 'Tailwind CSS', 'PostgreSQL', 'REST APIs', 'AWS'],
  'Mobile Developer': ['React Native', 'Flutter', 'Swift', 'Kotlin', 'Firebase', 'App Store Optimization'],
  'UI/UX Designer': ['Figma', 'Prototyping', 'User Research', 'Design Systems', 'Accessibility', 'Framer'],
  'Graphic Designer': ['Adobe Illustrator', 'Adobe Photoshop', 'Canva', 'Brand Identity', 'Motion Graphics'],
  'Virtual Assistant': ['Calendar Management', 'Email Management', 'CRM', 'Data Entry', 'Research', 'Notion', 'Asana'],
  'Content Writer': ['SEO Writing', 'Copywriting', 'WordPress', 'Content Strategy', 'Blog Writing', 'Proofreading'],
  'SEO Specialist': ['Technical SEO', 'Google Analytics', 'Ahrefs', 'Link Building', 'On-Page SEO', 'Local SEO'],
  'Social Media Manager': ['Content Creation', 'Instagram', 'TikTok', 'Facebook Ads', 'Analytics', 'Community Management'],
  'Video Editor': ['Adobe Premiere Pro', 'After Effects', 'DaVinci Resolve', 'Color Grading', 'Motion Graphics'],
  'Data Analyst': ['Python', 'SQL', 'Power BI', 'Tableau', 'Excel', 'Data Visualization', 'Statistics'],
  'Digital Marketing': ['Google Ads', 'Facebook Ads', 'Email Marketing', 'Funnel Building', 'A/B Testing'],
  'Customer Service': ['Zendesk', 'Freshdesk', 'Live Chat', 'Email Support', 'CRM', 'Conflict Resolution'],
};

// ── Compute profile completeness score
function computeProfileScore(user) {
  const checks = [
    { field: 'full_name', label: 'Full name', weight: 10 },
    { field: 'bio', label: 'Bio / introduction', weight: 15 },
    { field: 'skills', label: 'Skills listed', weight: 20 },
    { field: 'location', label: 'Location', weight: 5 },
    { field: 'profile_pic', label: 'Profile photo', weight: 15 },
    { field: 'video_loom_link', label: 'Video introduction (Loom)', weight: 15 },
    { field: 'resume_file', label: 'Resume uploaded', weight: 10 },
    { field: 'hardware_specs', label: 'Hardware specs', weight: 5 },
    { field: 'speedtest_url', label: 'Internet speed test', weight: 5 },
  ];

  let score = 0;
  const missing = [];

  for (const c of checks) {
    if (user[c.field] && user[c.field].toString().trim()) {
      score += c.weight;
    } else {
      missing.push({ field: c.field, label: c.label, weight: c.weight });
    }
  }

  return { score: Math.min(score, 100), missing };
}

// ── GET /api/growth/dashboard ─────────────────────────────────────────────────
router.get('/dashboard', authenticateToken, async (req, res) => {
  if (req.user.role !== 'freelancer') {
    return res.status(403).json({ error: 'Freelancers only' });
  }

  try {
    const user = await db.prepare(`
      SELECT id, full_name, bio, skills, location, profile_pic, video_loom_link,
        resume_file, hardware_specs, speedtest_url, created_at
      FROM users WHERE id = ?
    `).get(req.user.id);

    // Profile score
    const { score: profileScore, missing } = computeProfileScore(user);

    // Application stats
    const appStats = await db.prepare(`
      SELECT
        COUNT(*) as total,
        COUNT(CASE WHEN a.status = 'pending' THEN 1 END) as pending,
        COUNT(CASE WHEN a.status = 'viewed' THEN 1 END) as viewed,
        COUNT(CASE WHEN a.status = 'shortlisted' THEN 1 END) as shortlisted,
        COUNT(CASE WHEN a.status = 'accepted' THEN 1 END) as accepted,
        COUNT(CASE WHEN a.status = 'rejected' THEN 1 END) as rejected
      FROM applications a WHERE a.freelancer_id = ?
    `).get(req.user.id);

    // Skill suggestions based on user's current skills
    const userSkills = (user.skills || '').toLowerCase();
    let suggestedSkills = [];
    let matchedRole = null;
    let salaryBenchmark = null;

    for (const [role, skills] of Object.entries(SKILL_SUGGESTIONS)) {
      const overlap = skills.filter(s => userSkills.includes(s.toLowerCase()));
      if (overlap.length > 0) {
        const missing = skills.filter(s => !userSkills.includes(s.toLowerCase())).slice(0, 5);
        if (!matchedRole || overlap.length > suggestedSkills.length) {
          matchedRole = role;
          suggestedSkills = missing;
          salaryBenchmark = SALARY_BENCHMARKS[role] || null;
        }
      }
    }

    // Fallback if no skills match
    if (!matchedRole) {
      suggestedSkills = ['Add your skills to get personalized recommendations'];
    }

    // In-demand jobs count by category (market signal)
    const inDemandCategories = await db.prepare(`
      SELECT category, COUNT(*) as count
      FROM jobs WHERE status = 'open'
      GROUP BY category ORDER BY count DESC LIMIT 5
    `).all();

    // Profile tips
    const tips = [];
    if (missing.length > 0) {
      missing.sort((a, b) => b.weight - a.weight);
      tips.push(...missing.slice(0, 3).map(m => `Add your ${m.label} (+${m.weight}% profile strength)`));
    }
    if (profileScore < 80) {
      tips.push('Profiles with 80%+ completeness get 3x more employer views');
    }
    if (!user.video_loom_link) {
      tips.push('Add a short Loom video introduction — employers love it');
    }

    res.json({
      profile_score: profileScore,
      missing_fields: missing,
      tips,
      matched_role: matchedRole,
      suggested_skills: suggestedSkills,
      salary_benchmark: salaryBenchmark,
      application_stats: appStats,
      in_demand_categories: inDemandCategories,
    });
  } catch (err) {
    console.error('[growth dashboard] error:', err.message);
    res.status(500).json({ error: 'Failed to load growth dashboard' });
  }
});

// ── GET /api/growth/salary-benchmarks ────────────────────────────────────────
router.get('/salary-benchmarks', async (req, res) => {
  const { role } = req.query;
  if (role && SALARY_BENCHMARKS[role]) {
    return res.json({ role, ...SALARY_BENCHMARKS[role] });
  }
  res.json(
    Object.entries(SALARY_BENCHMARKS).map(([r, data]) => ({ role: r, ...data }))
  );
});

module.exports = router;
