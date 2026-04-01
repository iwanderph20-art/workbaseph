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
      <a href="signup.html" class="btn btn-primary btn-sm">Sign Up Free</a>
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
  return `
    <div class="job-card" onclick="window.location='jobs.html?id=${job.id}'" style="cursor:pointer">
      <div class="job-card-header">
        <div>
          <div class="job-card-title">${escHtml(job.title)}</div>
          <div class="job-card-company">
            ${escHtml(job.employer_name || 'Employer')}
            ${job.employer_verified ? '<span class="verified-badge">✓ Verified</span>' : ''}
          </div>
        </div>
        <span class="tag">${escHtml(job.category)}</span>
      </div>
      <div class="job-tags">${skillTags(job.skills_required)}</div>
      <div class="job-meta">
        <span>📍 ${escHtml(job.location || 'Remote')}</span>
        <span>⏱ ${timeAgo(job.created_at)}</span>
        ${job.application_count != null ? `<span>👥 ${job.application_count} applicant${job.application_count !== 1 ? 's' : ''}</span>` : ''}
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:0.25rem">
        <span class="job-budget">${formatBudget(job)}</span>
        <a href="jobs.html?id=${job.id}" class="btn btn-primary btn-sm" onclick="event.stopPropagation()">View Job</a>
      </div>
    </div>
  `;
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
