const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const { sendAdminReply } = require('../services/chatThread');
const db = require('../database');

const VALID_STATUSES = ['inquired', 'engaged', 'won', 'canceled'];

// GET /api/admin-leads?status=&service=&search= — list leads for the pipeline board
router.get('/', requireAdmin, async (req, res) => {
  const { status, service, search } = req.query;
  let where = 'WHERE 1=1';
  const params = [];
  if (status && status !== 'all') { where += ' AND l.status = ?'; params.push(status); }
  if (service && service !== 'all') { where += ' AND l.service = ?'; params.push(service); }
  if (search) { where += ' AND (l.name ILIKE ? OR l.email ILIKE ?)'; params.push(`%${search}%`, `%${search}%`); }

  const leads = await db.prepare(`
    SELECT l.*,
      (SELECT message FROM chat_messages cm WHERE l.source = 'chat' AND cm.request_id = l.source_id ORDER BY cm.id DESC LIMIT 1) AS last_message,
      (SELECT sender  FROM chat_messages cm WHERE l.source = 'chat' AND cm.request_id = l.source_id ORDER BY cm.id DESC LIMIT 1) AS last_sender,
      (SELECT COUNT(*)::int FROM chat_messages cm WHERE l.source = 'chat' AND cm.request_id = l.source_id) AS message_count
    FROM leads l
    ${where}
    ORDER BY l.created_at DESC
  `).all(...params);

  res.json({ ok: true, leads });
});

// GET /api/admin-leads/insights — simple aggregate numbers for the top-of-page cards
router.get('/insights', requireAdmin, async (req, res) => {
  const totalRow = await db.prepare('SELECT COUNT(*)::int AS c FROM leads').get();
  const byStatus = await db.prepare('SELECT status, COUNT(*)::int AS c FROM leads GROUP BY status').all();
  const byService = await db.prepare('SELECT service, COUNT(*)::int AS c FROM leads GROUP BY service').all();
  const last7 = await db.prepare("SELECT COUNT(*)::int AS c FROM leads WHERE created_at > NOW() - INTERVAL '7 days'").get();

  // Chat threads whose most recent message is from the visitor — i.e. still waiting on us.
  const awaiting = await db.prepare(`
    SELECT COUNT(*)::int AS c FROM leads l
    WHERE l.source = 'chat' AND l.status NOT IN ('won', 'canceled') AND (
      SELECT sender FROM chat_messages cm WHERE cm.request_id = l.source_id ORDER BY cm.id DESC LIMIT 1
    ) = 'visitor'
  `).get();

  const statusCounts = { inquired: 0, engaged: 0, won: 0, canceled: 0 };
  byStatus.forEach(r => { statusCounts[r.status] = r.c; });
  const serviceCounts = {};
  byService.forEach(r => { serviceCounts[r.service] = r.c; });

  const decided = statusCounts.won + statusCounts.canceled;
  const conversionRate = decided > 0 ? Math.round((statusCounts.won / decided) * 100) : null;

  res.json({
    ok: true,
    total: totalRow.c,
    statusCounts,
    serviceCounts,
    last7: last7.c,
    awaitingReply: awaiting.c,
    conversionRate,
  });
});

// GET /api/admin-leads/:id — full detail (intake fields, or the chat thread)
router.get('/:id', requireAdmin, async (req, res) => {
  const lead = await db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found.' });

  let detail = null;
  let thread = null;

  if (lead.source === 'founder_intake') {
    detail = await db.prepare('SELECT * FROM founder_service_intake WHERE id = ?').get(lead.source_id);
  } else if (lead.source === 'dfy_intake') {
    detail = await db.prepare('SELECT * FROM done_for_you_hiring_intake WHERE id = ?').get(lead.source_id);
  } else if (lead.source === 'chat') {
    thread = await db.prepare(
      'SELECT id, sender, message, created_at FROM chat_messages WHERE request_id = ? ORDER BY id ASC'
    ).all(lead.source_id);
  }

  res.json({ ok: true, lead, detail, thread });
});

// PATCH /api/admin-leads/:id/status — move a lead between pipeline stages
router.patch('/:id/status', requireAdmin, async (req, res) => {
  const { status } = req.body;
  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Invalid status.' });
  }
  const result = await db.prepare('UPDATE leads SET status = ?, updated_at = NOW() WHERE id = ?').run(status, req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Lead not found.' });
  res.json({ ok: true });
});

// PATCH /api/admin-leads/:id/notes — shared internal note + optional follow-up date,
// visible to all admins (not per-person) since it just lives on the lead row.
router.patch('/:id/notes', requireAdmin, async (req, res) => {
  const notes = String(req.body.notes || '').slice(0, 4000);
  let followUpAt = req.body.followUpAt;
  if (followUpAt && !/^\d{4}-\d{2}-\d{2}$/.test(followUpAt)) {
    return res.status(400).json({ error: 'Invalid follow-up date.' });
  }
  followUpAt = followUpAt || null;

  const result = await db.prepare(
    'UPDATE leads SET notes = ?, follow_up_at = ?, updated_at = NOW() WHERE id = ?'
  ).run(notes, followUpAt, req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Lead not found.' });
  res.json({ ok: true });
});

// POST /api/admin-leads/:id/reply — reply to a chat-sourced lead's conversation
router.post('/:id/reply', requireAdmin, async (req, res) => {
  const lead = await db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found.' });
  if (lead.source !== 'chat') return res.status(400).json({ error: 'This lead has no conversation to reply to.' });

  const chatRow = await db.prepare('SELECT * FROM chat_requests WHERE id = ?').get(lead.source_id);
  if (!chatRow) return res.status(404).json({ error: 'Conversation not found.' });

  const text = String(req.body.message || '').trim().slice(0, 4000);
  if (!text) return res.status(400).json({ error: 'Message is empty.' });

  try {
    await sendAdminReply(chatRow, text);
    res.json({ ok: true });
  } catch (err) {
    console.error('Admin lead reply error:', err.message);
    res.status(500).json({ error: 'Something went wrong — please try again.' });
  }
});

module.exports = router;
