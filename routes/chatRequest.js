const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { sendEmail } = require('../services/email');
const { escape, wrapEmail, createLead, sendAdminReply, SITE_URL } = require('../services/chatThread');
const db = require('../database');

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const AUTO_REPLY = "Thanks — someone from our team will be with you shortly. Feel free to add more details below while you wait.";

// The employer widget (public/js/employer-chat-widget.js) tags its page label with
// this prefix — see there for the exact string. Founder Services / Done-For-You
// Hiring / Services marketing-page widgets never do, so this cleanly separates the
// two audiences without a schema change.
function isEmployerChat(page) {
  return typeof page === 'string' && page.indexOf('Employer — ') === 0;
}
function chatRecipients(page) {
  return isEmployerChat(page)
    ? { to: 'admin@workbaseph.com', cc: undefined }
    : { to: 'hello@workbaseph.com', cc: ['support@workbaseph.com', 'admin@workbaseph.com'] };
}

async function loadRequest(id, token) {
  if (!id || !token) return null;
  const row = await db.prepare('SELECT * FROM chat_requests WHERE id = ?').get(id);
  if (!row || row.token !== token) return null;
  return row;
}

// POST /api/chat-request — starts a new chat thread with the visitor's first message
router.post('/', async (req, res) => {
  const { name, email, concern, page } = req.body;

  if (!email || !concern) {
    return res.status(400).json({ error: 'Email and a short note are required.' });
  }
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'Invalid email address.' });
  }

  const displayName = name && name.trim() ? name.trim() : 'Someone';
  const pageLabel = escape(page || 'WorkBase PH');
  const token = crypto.randomBytes(20).toString('hex');
  let id;

  try {
    const inserted = await db.prepare(
      'INSERT INTO chat_requests (name, email, page, concern, token) VALUES (?, ?, ?, ?, ?)'
    ).run(name || '', email, page || '', concern, token);
    id = inserted.lastInsertRowid;

    await db.prepare(
      'INSERT INTO chat_messages (request_id, sender, message) VALUES (?, ?, ?)'
    ).run(id, 'visitor', concern);
    await db.prepare(
      'INSERT INTO chat_messages (request_id, sender, message) VALUES (?, ?, ?)'
    ).run(id, 'admin', AUTO_REPLY);
  } catch (err) {
    console.error('Chat request DB error:', err.message);
    return res.status(500).json({ error: 'Something went wrong — please try again.' });
  }

  createLead({ source: 'chat', sourceId: id, service: page, name, email, summary: concern });

  try {
    const replyLink = `${SITE_URL}/chat-reply.html?id=${id}&token=${token}`;
    const html = wrapEmail({
      badgeColor: '#dc2626',
      badgeText: 'Chat Request',
      bodyHtml: `
        <table style="width:100%;border-collapse:collapse;font-size:14px;color:#374151">
          <tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;color:#6b7280;width:130px;vertical-align:top">From</td><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;font-weight:600;color:#0d2240">${escape(displayName)}</td></tr>
          <tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;color:#6b7280;vertical-align:top">Email</td><td style="padding:10px 0;border-bottom:1px solid #f3f4f6"><a href="mailto:${escape(email)}" style="color:#dc2626;font-weight:600">${escape(email)}</a></td></tr>
          <tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;color:#6b7280;vertical-align:top">Page</td><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;font-weight:600;color:#0d2240">${pageLabel}</td></tr>
          <tr><td style="padding:10px 0;color:#6b7280;vertical-align:top">Message</td><td style="padding:10px 0;line-height:1.7;white-space:pre-wrap">${escape(concern)}</td></tr>
        </table>
        <div style="margin-top:24px;text-align:center">
          <a href="${replyLink}" style="display:inline-block;background:#dc2626;color:#fff;font-weight:800;font-size:14px;padding:12px 28px;border-radius:99px;text-decoration:none">Reply in Chat &rarr;</a>
        </div>
        <div style="margin-top:20px;padding:16px 20px;background:#fef2f2;border-left:3px solid #dc2626;border-radius:0 8px 8px 0;font-size:13px;color:#374151">
          This visitor is waiting live in the chat widget. Click "Reply in Chat" to answer them there in real time, or just hit Reply on this email — it goes straight to <strong style="color:#0d2240">${escape(displayName)}</strong>'s inbox (${escape(email)}).
        </div>`,
    });

    await sendEmail({
      ...chatRecipients(page),
      replyTo: email,
      subject: `Chat Request from ${displayName} (${pageLabel})`,
      html,
    });
  } catch (err) {
    console.error('Chat request email error:', err.message);
  }

  console.log(`💬 New chat thread #${id} from ${displayName} <${email}> — ${pageLabel}`);
  res.json({ ok: true, id, token });
});

// GET /api/chat-request/:id/messages?token=...&after=<messageId>&viewer=visitor|admin — poll/fetch a thread
router.get('/:id/messages', async (req, res) => {
  const chatRow = await loadRequest(req.params.id, req.query.token);
  if (!chatRow) return res.status(403).json({ error: 'Invalid or expired chat link.' });

  // Only the visitor's own widget polling counts as "still watching the chat" —
  // this powers the presence check in sendAdminReply().
  if (req.query.viewer !== 'admin') {
    db.prepare('UPDATE chat_requests SET last_seen_at = NOW() WHERE id = ?').run(chatRow.id).catch(() => {});
  }

  const afterId = parseInt(req.query.after, 10) || 0;
  const messages = await db.prepare(
    'SELECT id, sender, message, created_at FROM chat_messages WHERE request_id = ? AND id > ? ORDER BY id ASC'
  ).all(chatRow.id, afterId);

  res.json({ ok: true, messages, name: chatRow.name, email: chatRow.email, page: chatRow.page });
});

// POST /api/chat-request/:id/message — visitor sends a follow-up message
router.post('/:id/message', async (req, res) => {
  const chatRow = await loadRequest(req.params.id, req.body.token);
  if (!chatRow) return res.status(403).json({ error: 'Invalid or expired chat link.' });

  const text = String(req.body.message || '').trim().slice(0, 2000);
  if (!text) return res.status(400).json({ error: 'Message is empty.' });

  try {
    await db.prepare(
      'INSERT INTO chat_messages (request_id, sender, message) VALUES (?, ?, ?)'
    ).run(chatRow.id, 'visitor', text);
  } catch (err) {
    console.error('Chat message error:', err.message);
    return res.status(500).json({ error: 'Something went wrong — please try again.' });
  }

  try {
    const displayName = chatRow.name && chatRow.name.trim() ? chatRow.name.trim() : 'Someone';
    const pageLabel = escape(chatRow.page || 'WorkBase PH');
    const replyLink = `${SITE_URL}/chat-reply.html?id=${chatRow.id}&token=${chatRow.token}`;
    const html = wrapEmail({
      badgeColor: '#0d2240',
      badgeText: '💬 New Chat Message',
      bodyHtml: `
        <p style="margin:0 0 16px;font-size:14px;color:#374151"><strong style="color:#0d2240">${escape(displayName)}</strong> sent another message on ${pageLabel}:</p>
        <div style="padding:14px 18px;background:#f9fafb;border-radius:10px;font-size:14px;color:#111827;line-height:1.7;white-space:pre-wrap;margin-bottom:20px">${escape(text)}</div>
        <div style="text-align:center">
          <a href="${replyLink}" style="display:inline-block;background:#0d2240;color:#fff;font-weight:800;font-size:14px;padding:12px 28px;border-radius:99px;text-decoration:none">Reply in Chat &rarr;</a>
        </div>`,
    });

    await sendEmail({
      ...chatRecipients(chatRow.page),
      replyTo: chatRow.email,
      subject: `💬 [Chat] New message from ${displayName} (${pageLabel})`,
      html,
    });
  } catch (err) {
    console.error('Chat follow-up email error:', err.message);
  }

  res.json({ ok: true });
});

// POST /api/chat-request/:id/reply — admin (via chat-reply.html) sends a reply
router.post('/:id/reply', async (req, res) => {
  const chatRow = await loadRequest(req.params.id, req.body.token);
  if (!chatRow) return res.status(403).json({ error: 'Invalid or expired chat link.' });

  const text = String(req.body.message || '').trim().slice(0, 4000);
  if (!text) return res.status(400).json({ error: 'Message is empty.' });

  try {
    await sendAdminReply(chatRow, text);
    res.json({ ok: true });
  } catch (err) {
    console.error('Chat reply error:', err.message);
    res.status(500).json({ error: 'Something went wrong — please try again.' });
  }
});

module.exports = router;
