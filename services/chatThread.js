// Shared logic between the public token-gated chat routes (routes/chatRequest.js,
// used by the visitor widget + chat-reply.html) and the authenticated admin routes
// (routes/adminLeads.js, used by public/admin-leads.html) — so both surfaces send
// admin replies through the exact same presence-check/notification-email/lead-status
// behavior instead of two copies that could drift apart.
const { sendEmail } = require('./email');
const db = require('../database');

const SITE_URL = 'https://www.workbaseph.com';
const PAGE_URLS = {
  'Launch Startup Services': `${SITE_URL}/founder-services.html`,
  'Done-For-You Hiring': `${SITE_URL}/done-for-you-hiring.html`,
};
// If the visitor hasn't polled in this long, assume the chat is closed/gone and email them instead.
const PRESENCE_WINDOW_MS = 15000;

const escape = (s) => String(s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function wrapEmail({ badgeColor, badgeText, bodyHtml }) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Helvetica Neue',Arial,sans-serif">
<div style="max-width:600px;margin:0 auto;background:#fff;border-top:6px solid ${badgeColor}">
  <div style="background:${badgeColor};padding:20px 40px;text-align:center">
    <div style="display:inline-block;padding:5px 16px;background:rgba(255,255,255,0.2);border-radius:99px;color:#fff;font-size:12px;font-weight:900;letter-spacing:1px;text-transform:uppercase">${badgeText}</div>
  </div>
  <div style="padding:32px 40px">${bodyHtml}</div>
  <div style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:20px 40px;text-align:center">
    <p style="font-size:12px;color:#9ca3af;margin:0">WorkBase PH &middot; admin@workbaseph.com</p>
  </div>
</div>
</body>
</html>`;
}

// Fire-and-forget — lead tracking must never block the actual visitor-facing flow
// (intake confirmation, chat thread) if it fails.
async function createLead({ source, sourceId, service, name, email, summary }) {
  try {
    await db.prepare(
      'INSERT INTO leads (source, source_id, service, name, email, summary) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(source, sourceId, service || '', name || '', email, String(summary || '').slice(0, 300));
  } catch (err) {
    console.error('Lead creation error:', err.message);
  }
}

// Inserts an admin chat message, auto-engages the linked lead, and — if the visitor
// isn't actively polling the thread right now — emails them the reply directly.
// `chatRow` is a chat_requests row (id, name, email, page, token, last_seen_at).
async function sendAdminReply(chatRow, text) {
  await db.prepare(
    'INSERT INTO chat_messages (request_id, sender, message) VALUES (?, ?, ?)'
  ).run(chatRow.id, 'admin', text);

  db.prepare(
    "UPDATE leads SET status = 'engaged', updated_at = NOW() WHERE source = 'chat' AND source_id = ? AND status = 'inquired'"
  ).run(chatRow.id).catch(() => {});

  const lastSeenMs = chatRow.last_seen_at ? new Date(chatRow.last_seen_at).getTime() : 0;
  const isPresent = Date.now() - lastSeenMs < PRESENCE_WINDOW_MS;
  if (isPresent) return;

  try {
    const displayName = chatRow.name && chatRow.name.trim() ? chatRow.name.trim() : 'there';
    const pageUrl = PAGE_URLS[chatRow.page] || SITE_URL;
    const html = wrapEmail({
      badgeColor: '#1a8a7a',
      badgeText: '💬 New Reply From WorkBase PH',
      bodyHtml: `
        <p style="margin:0 0 16px;font-size:15px;color:#374151">Hi ${escape(displayName)}, we replied to your chat:</p>
        <div style="padding:14px 18px;background:#f0faf9;border-left:3px solid #1a8a7a;border-radius:0 8px 8px 0;font-size:14px;color:#111827;line-height:1.7;white-space:pre-wrap;margin-bottom:20px">${escape(text)}</div>
        <p style="margin:0 0 20px;font-size:13px;color:#6b7280">You can reply directly to this email and we'll pick it up from there, or head back to the page to keep chatting live.</p>
        <div style="text-align:center">
          <a href="${pageUrl}" style="display:inline-block;background:#1a8a7a;color:#fff;font-weight:800;font-size:14px;padding:12px 28px;border-radius:99px;text-decoration:none">Back to WorkBase PH &rarr;</a>
        </div>`,
    });

    await sendEmail({
      to: chatRow.email,
      replyTo: 'hello@workbaseph.com',
      subject: `WorkBase PH replied to your message`,
      html,
    });
  } catch (err) {
    console.error('Chat reply notification email error:', err.message);
  }
}

module.exports = { SITE_URL, PAGE_URLS, PRESENCE_WINDOW_MS, escape, wrapEmail, createLead, sendAdminReply };
