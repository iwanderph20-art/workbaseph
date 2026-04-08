/* =============================================
   WORKBASEPH — Shared JS Utilities
   ============================================= */

const API = '/api';

// === AUTH HELPERS ===
const Auth = {
  getToken: () => localStorage.getItem('wb_token'),
  getUser: () => {
    const u = localStorage.getItem('wb_user');
    try { return u ? JSON.parse(u) : null; } catch { return null; }
  },
  setSession: (token, user) => {
    localStorage.setItem('wb_token', token);
    localStorage.setItem('wb_user', JSON.stringify(user));
  },
  clear: () => {
    localStorage.removeItem('wb_token');
    localStorage.removeItem('wb_user');
  },
  isLoggedIn: () => !!localStorage.getItem('wb_token'),
  isEmployer: () => {
    const u = Auth.getUser();
    return u && u.role === 'employer';
  },
  isFreelancer: () => {
    const u = Auth.getUser();
    return u && u.role === 'freelancer';
  }
};

// === API HELPERS ===
async function apiFetch(endpoint, options = {}) {
  const token = Auth.getToken();
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(API + endpoint, { ...options, headers });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) throw { status: res.status, message: data.error || 'Request failed' };
  return data;
}

// === UI HELPERS ===
function showAlert(container, message, type = 'error') {
  const icons = { error: '✕', success: '✓', info: 'ℹ' };
  container.innerHTML = `<div class="alert alert-${type}"><span>${icons[type]}</span> ${message}</div>`;
  container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function setLoading(btn, loading, text = '') {
  btn.disabled = loading;
  btn.innerHTML = loading
    ? `<span class="spinner" style="width:18px;height:18px;border-width:2.5px;margin:0"></span> Loading…`
    : text || btn.dataset.text || btn.textContent;
  if (!loading && !btn.dataset.text) btn.dataset.text = text;
}

function formatBudget(job) {
  const fmt = n => '₱' + Number(n).toLocaleString();
  if (job.budget_type === 'hourly') return `${fmt(job.budget_min)}–${fmt(job.budget_max)}/hr`;
  return `${fmt(job.budget_min)}–${fmt(job.budget_max)}`;
}

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });
}

function skillTags(skills) {
  if (!skills) return '';
  return skills.split(',').filter(Boolean).slice(0, 4)
    .map(s => `<span class="tag tag-dark">${s.trim()}</span>`).join('');
}

// === NAVBAR: update based on auth state ===
function updateNavbar() {
  const user = Auth.getUser();
  const navActions = document.getElementById('navActions');
  if (!navActions) return;

  if (user) {
    navActions.innerHTML = `
      <a href="dashboard.html" class="btn btn-outline btn-sm">Dashboard</a>
      <div class="nav-avatar" title="${user.full_name}" onclick="window.location='dashboard.html'">
        ${user.full_name.charAt(0).toUpperCase()}
      </div>
    `;
  } else {
    navActions.innerHTML = `
      <a href="login.html" class="btn btn-outline btn-sm">Log In</a>
      <a href="signup.html" class="btn btn-primary btn-sm">Get Started</a>
    `;
  }
}

// === MOBILE NAV ===
function initMobileNav() {
  const hamburger = document.getElementById('hamburger');
  const navLinks = document.getElementById('navLinks');
  if (!hamburger || !navLinks) return;
  hamburger.addEventListener('click', () => {
    const open = navLinks.style.display === 'flex';
    navLinks.style.display = open ? '' : 'flex';
    navLinks.style.flexDirection = 'column';
    navLinks.style.position = 'absolute';
    navLinks.style.top = '73px';
    navLinks.style.left = '0';
    navLinks.style.right = '0';
    navLinks.style.background = 'white';
    navLinks.style.padding = '1rem 2rem';
    navLinks.style.boxShadow = '0 8px 24px rgba(0,0,0,0.1)';
    navLinks.style.zIndex = '999';
    if (open) navLinks.removeAttribute('style');
  });
}

// === JOB CARD RENDERER ===
function renderJobCard(job) {
  const engBadge = job.engagement_type === 'gig'
    ? '<span class="tag" style="background:rgba(244,124,32,0.12);color:#c2410c;font-size:.72rem">⚡ Gig</span>'
    : '<span class="tag tag-navy" style="font-size:.72rem">🏢 Long-Term</span>';

  // PIPELINE / REAL badge
  const isPipeline = job.job_type === 'PIPELINE';
  const jobTypeBadge = isPipeline
    ? '<span style="display:inline-flex;align-items:center;gap:0.3rem;font-size:0.7rem;font-weight:700;color:#7c3aed;background:#ede9fe;padding:0.18rem 0.55rem;border-radius:99px;letter-spacing:0.3px">Hiring Soon</span>'
    : '';

  // Employer trust badge
  const trustBadges = [];
  if (job.is_business_verified) trustBadges.push('<span style="font-size:0.7rem;font-weight:700;color:#065f46;background:#d1fae5;padding:0.15rem 0.5rem;border-radius:99px">Verified Employer</span>');
  else if (job.employer_verified) trustBadges.push('<span style="font-size:0.7rem;font-weight:700;color:var(--teal);background:var(--teal-light);padding:0.15rem 0.5rem;border-radius:99px">Email Verified</span>');
  const trustRow = trustBadges.length ? `<div style="display:flex;gap:0.4rem;flex-wrap:wrap;margin-bottom:0.5rem">${trustBadges.join('')}</div>` : '';

  // Pipeline disclaimer
  const disclaimer = isPipeline
    ? '<div style="font-size:0.75rem;color:#7c3aed;background:#f5f3ff;border-radius:6px;padding:0.4rem 0.65rem;margin-bottom:0.6rem;border-left:3px solid #7c3aed">This opportunity is part of our upcoming client pipeline.</div>'
    : '';

  return `
    <div class="job-card" onclick="window.location='jobs.html?id=${job.id}'" style="cursor:pointer${isPipeline ? ';border-color:#c4b5fd' : ''}">
      <div class="job-card-header">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:0.45rem;flex-wrap:wrap;margin-bottom:0.2rem">
            <div class="job-card-title" style="margin:0">${escHtml(job.title)}</div>
            ${jobTypeBadge}
          </div>
          <div class="job-card-company">
            ${escHtml(job.employer_name || 'Employer')}
          </div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:0.35rem;flex-shrink:0">
          <span class="tag">${escHtml(job.category)}</span>
          ${engBadge}
        </div>
      </div>
      ${trustRow}
      ${disclaimer}
      <div class="job-tags">${skillTags(job.skills_required)}</div>
      <div class="job-meta">
        <span>📍 ${escHtml(job.location || 'Remote')}</span>
        <span>⏱ ${timeAgo(job.created_at)}</span>
        ${job.application_count != null ? `<span>👥 ${job.application_count} applied</span>` : ''}
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:0.25rem;gap:0.5rem">
        <span class="job-budget">${formatBudget(job)}</span>
        <a href="jobs.html?id=${job.id}" class="btn btn-primary btn-sm" onclick="event.stopPropagation()">View Job</a>
      </div>
    </div>
  `;
}

// === APPLICATION STATUS BADGE ===
function appStatusBadge(status) {
  const map = {
    pending:     { label: 'Applied',      color: '#6b7280', bg: '#f3f4f6' },
    viewed:      { label: 'Seen',         color: '#0369a1', bg: '#e0f2fe' },
    shortlisted: { label: 'Shortlisted',  color: '#065f46', bg: '#d1fae5' },
    accepted:    { label: 'Accepted',     color: '#15803d', bg: '#dcfce7' },
    rejected:    { label: 'Rejected',     color: '#b91c1c', bg: '#fee2e2' },
  };
  const s = map[status] || map.pending;
  return `<span style="font-size:0.72rem;font-weight:700;color:${s.color};background:${s.bg};padding:0.2rem 0.6rem;border-radius:99px">${s.label}</span>`;
}

function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// === INIT ON EVERY PAGE ===
document.addEventListener('DOMContentLoaded', () => {
  updateNavbar();
  initMobileNav();
  // Mark active nav link
  const current = location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav-links a').forEach(a => {
    if (a.getAttribute('href') === current) a.classList.add('active');
  });
});
