// Floating chat widget for logged-in employers — appears on any page that loads this
// script, as long as the visitor is logged in as an employer (checked directly off
// localStorage, so this works even on pages that don't load js/app.js). Reuses the
// same anonymous chat_requests/chat_messages backend as the founder-services.html /
// done-for-you-hiring.html / services.html marketing-page widget (routes/chatRequest.js)
// — no backend changes — but skips the name/email intro step since we already know
// who's asking, and uses its own localStorage key so the two widgets never collide on
// a page that happened to load both.
(function () {
  function getEmployer() {
    var token = localStorage.getItem('wb_token');
    if (!token) return null;
    try {
      var user = JSON.parse(localStorage.getItem('wb_user') || 'null');
      if (user && user.role === 'employer') return user;
    } catch (e) {}
    return null;
  }

  var employer = getEmployer();
  if (!employer) return; // not logged in as an employer on this page — do nothing

  var SESSION_KEY = 'wbph_employer_chat_session';
  var pollTimer = null;
  var lastMsgId = 0;

  function getSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { return null; }
  }
  function setSession(session) {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch (e) {}
  }

  var css = ''
    + '.ecw-wrap{position:fixed;right:22px;bottom:22px;z-index:999;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}'
    + '.ecw-btn{position:relative;width:60px;height:60px;border-radius:50%;border:none;cursor:pointer;background:linear-gradient(135deg,#f47c20,#1a8a7a);color:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 10px 28px rgba(13,34,64,0.35);animation:ecwFloat 2.6s ease-in-out infinite;}'
    + '.ecw-btn:hover{animation-play-state:paused;transform:translateY(-2px);}'
    + '.ecw-btn svg{width:26px;height:26px;position:relative;z-index:1;}'
    + '.ecw-ring{position:absolute;inset:-6px;border-radius:50%;border:2px solid rgba(244,124,32,0.45);animation:ecwPulse 2.2s ease-out infinite;}'
    + '@keyframes ecwFloat{0%,100%{transform:translateY(0);}50%{transform:translateY(-8px);}}'
    + '@keyframes ecwPulse{0%{transform:scale(0.9);opacity:0.8;}100%{transform:scale(1.5);opacity:0;}}'
    + '.ecw-panel{position:absolute;bottom:74px;right:0;width:320px;max-width:calc(100vw - 44px);background:#fff;border-radius:16px;box-shadow:0 20px 50px rgba(13,34,64,0.28);overflow:hidden;border:1px solid rgba(13,34,64,0.08);display:flex;flex-direction:column;}'
    + '.ecw-header{background:#0d2240;padding:1rem 1.1rem;display:flex;align-items:flex-start;justify-content:space-between;gap:0.75rem;flex-shrink:0;}'
    + '.ecw-title{color:#fff;font-weight:800;font-size:0.92rem;margin-bottom:0.2rem;}'
    + '.ecw-sub{color:rgba(255,255,255,0.55);font-size:0.75rem;}'
    + '.ecw-close{background:none;border:none;color:rgba(255,255,255,0.6);font-size:1.3rem;line-height:1;cursor:pointer;padding:0;}'
    + '.ecw-close:hover{color:#fff;}'
    + '.ecw-form{padding:1rem 1.1rem 1.15rem;display:flex;flex-direction:column;gap:0.6rem;}'
    + '.ecw-form textarea{font-family:inherit;font-size:0.85rem;padding:0.6rem 0.75rem;border-radius:9px;border:1px solid rgba(13,34,64,0.15);resize:none;color:#111827;}'
    + '.ecw-form textarea:focus{outline:none;border-color:#f47c20;}'
    + '.ecw-submit{background:#f47c20;color:#fff;font-weight:800;font-size:0.85rem;border:none;padding:0.65rem;border-radius:9px;cursor:pointer;}'
    + '.ecw-submit:hover{background:#e06d16;}'
    + '.ecw-submit:disabled{opacity:0.6;cursor:default;}'
    + '.ecw-msg{font-size:0.78rem;margin-top:-0.2rem;color:#6b7280;}'
    + '.ecw-msg.error{color:#dc2626;}'
    + '.ecw-messages{flex:1;overflow-y:auto;padding:1rem 1.1rem;display:flex;flex-direction:column;gap:0.55rem;min-height:200px;max-height:320px;}'
    + '.ecw-bubble{max-width:82%;padding:0.55rem 0.8rem;border-radius:14px;font-size:0.83rem;line-height:1.5;word-wrap:break-word;white-space:pre-wrap;}'
    + '.ecw-bubble.visitor{align-self:flex-end;background:#f47c20;color:#fff;border-bottom-right-radius:4px;}'
    + '.ecw-bubble.admin{align-self:flex-start;background:#f3f4f6;color:#111827;border-bottom-left-radius:4px;}'
    + '.ecw-reply-row{display:flex;gap:0.5rem;padding:0.75rem 0.9rem;border-top:1px solid rgba(13,34,64,0.08);flex-shrink:0;}'
    + '.ecw-reply-row input{flex:1;font-family:inherit;font-size:0.85rem;padding:0.55rem 0.75rem;border-radius:99px;border:1px solid rgba(13,34,64,0.15);color:#111827;}'
    + '.ecw-reply-row input:focus{outline:none;border-color:#f47c20;}'
    + '.ecw-reply-send{background:#f47c20;color:#fff;border:none;width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;}'
    + '.ecw-reply-send:hover{background:#e06d16;}'
    + '@media (max-width:480px){.ecw-wrap{right:14px;bottom:14px;}.ecw-panel{right:-8px;}}';
  var styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  var wrap = document.createElement('div');
  wrap.className = 'ecw-wrap';
  wrap.innerHTML =
    '<div id="ecwPanel" class="ecw-panel" style="display:none;">' +
      '<div class="ecw-header">' +
        '<div><div class="ecw-title">Need help?</div><div class="ecw-sub">A WorkBase PH support agent will reply here.</div></div>' +
        '<button type="button" class="ecw-close" aria-label="Close chat" id="ecwCloseBtn">&times;</button>' +
      '</div>' +
      '<div id="ecwIntro">' +
        '<form id="ecwForm" class="ecw-form">' +
          '<textarea id="ecwConcern" placeholder="What can we help you with?" required rows="3"></textarea>' +
          '<button type="submit" class="ecw-submit">Send</button>' +
          '<div id="ecwMsg" class="ecw-msg"></div>' +
        '</form>' +
      '</div>' +
      '<div id="ecwThread" style="display:none;flex-direction:column;min-height:0;">' +
        '<div id="ecwMessages" class="ecw-messages"></div>' +
        '<form id="ecwReplyForm" class="ecw-reply-row">' +
          '<input type="text" id="ecwReplyInput" placeholder="Type a message…" autocomplete="off" />' +
          '<button type="submit" class="ecw-reply-send" aria-label="Send"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/></svg></button>' +
        '</form>' +
      '</div>' +
    '</div>' +
    '<button type="button" id="ecwBtn" class="ecw-btn" aria-label="Chat with WorkBase PH support">' +
      '<span class="ecw-ring"></span>' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>' +
    '</button>';

  function ready() {
    document.body.appendChild(wrap);

    // dashboard.html shows a fixed bottom tab bar on mobile (#mobileTabBar) that
    // sits at bottom:0 too — without this the chat bubble floats on top of its
    // last tab (Billing). Lift the bubble above it whenever that bar is visible.
    function clearBottomNav() {
      var nav = document.getElementById('mobileTabBar');
      if (nav && nav.offsetHeight > 0) {
        wrap.style.bottom = (nav.offsetHeight + 14) + 'px';
      } else {
        wrap.style.bottom = '';
      }
    }
    clearBottomNav();
    window.addEventListener('resize', clearBottomNav);
    window.addEventListener('orientationchange', clearBottomNav);
    // dashboard.html fills #mobileTabBar's innerHTML asynchronously (after auth
    // loads), which can happen after this script's own DOMContentLoaded handler —
    // watch for that so the bubble still lifts once the bar actually has content.
    var navEl = document.getElementById('mobileTabBar');
    if (navEl && window.MutationObserver) {
      new MutationObserver(clearBottomNav).observe(navEl, { childList: true });
    }

    var panel = document.getElementById('ecwPanel');
    var introEl = document.getElementById('ecwIntro');
    var threadEl = document.getElementById('ecwThread');
    var messagesEl = document.getElementById('ecwMessages');

    function showThread() {
      introEl.style.display = 'none';
      threadEl.style.display = 'flex';
    }
    function renderMessage(sender, text) {
      var bubble = document.createElement('div');
      bubble.className = 'ecw-bubble ' + (sender === 'admin' ? 'admin' : 'visitor');
      bubble.textContent = text;
      messagesEl.appendChild(bubble);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    function loadHistory(session, reset) {
      if (reset) { messagesEl.innerHTML = ''; lastMsgId = 0; }
      return fetch('/api/chat-request/' + session.id + '/messages?token=' + encodeURIComponent(session.token) + '&after=' + lastMsgId + '&viewer=visitor')
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (data.ok && data.messages) {
            data.messages.forEach(function (m) {
              renderMessage(m.sender, m.message);
              if (m.id > lastMsgId) lastMsgId = m.id;
            });
          }
        })
        .catch(function () {}); // silent — next poll retries
    }
    function startPolling(session) {
      stopPolling();
      pollTimer = setInterval(function () { loadHistory(session, false); }, 4000);
    }
    function stopPolling() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }
    function toggle(force) {
      var isOpen = panel.style.display === 'flex';
      var show = force !== undefined ? force : !isOpen;
      panel.style.display = show ? 'flex' : 'none';
      if (show) {
        var session = getSession();
        if (session && session.id && session.token) {
          showThread();
          loadHistory(session, true);
          startPolling(session);
        }
      } else {
        stopPolling();
      }
    }

    document.getElementById('ecwBtn').addEventListener('click', function () { toggle(); });
    document.getElementById('ecwCloseBtn').addEventListener('click', function () { toggle(false); });
    document.addEventListener('click', function (e) {
      if (panel.style.display === 'flex' && !wrap.contains(e.target)) toggle(false);
    });

    var existing = getSession();
    if (existing && existing.id && existing.token) showThread();

    document.getElementById('ecwForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = e.target.querySelector('.ecw-submit');
      var msgEl = document.getElementById('ecwMsg');
      var concern = document.getElementById('ecwConcern').value.trim();
      if (!concern) {
        msgEl.textContent = 'Please type a quick note first.';
        msgEl.className = 'ecw-msg error';
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Sending...';
      fetch('/api/chat-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: employer.full_name || '',
          email: employer.email || '',
          concern: concern,
          page: 'Employer — ' + (document.title || location.pathname),
        }),
      })
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (data.ok) {
            var session = { id: data.id, token: data.token };
            setSession(session);
            showThread();
            return loadHistory(session, true).then(function () { startPolling(session); });
          }
          msgEl.textContent = data.error || 'Something went wrong — please try again.';
          msgEl.className = 'ecw-msg error';
          btn.disabled = false;
          btn.textContent = 'Send';
        })
        .catch(function () {
          msgEl.textContent = 'Something went wrong — please try again.';
          msgEl.className = 'ecw-msg error';
          btn.disabled = false;
          btn.textContent = 'Send';
        });
    });

    document.getElementById('ecwReplyForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var input = document.getElementById('ecwReplyInput');
      var text = input.value.trim();
      if (!text) return;
      var session = getSession();
      if (!session) return;
      input.value = '';
      input.disabled = true;
      fetch('/api/chat-request/' + session.id + '/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: session.token, message: text }),
      })
        .then(function () { return loadHistory(session, false); })
        .catch(function () {}) // the poll loop will retry
        .then(function () { input.disabled = false; input.focus(); });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ready);
  } else {
    ready();
  }
})();
