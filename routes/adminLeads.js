const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { requireServicesAccess } = require('../middleware/auth');
const { sendAdminReply } = require('../services/chatThread');
const { uploadFile } = require('../services/storage');
const db = require('../database');

const VALID_STATUSES = ['inquired', 'engaged', 'won', 'canceled'];
const VALID_FORM_CATEGORIES = ['client', 'talent', 'general'];

const ALLOWED_FILE = /^(application\/pdf|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document|image\/(jpeg|jpg|png|webp|heic|heif))$/i;
const ALLOWED_FILE_EXT = /\.(pdf|docx|jpe?g|png|webp|heic|heif)$/i;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    cb(null, ALLOWED_FILE.test(file.mimetype) || ALLOWED_FILE_EXT.test(file.originalname));
  },
});

// GET /api/admin-leads?status=&service=&search= — list leads for the pipeline board
router.get('/', requireServicesAccess, async (req, res) => {
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
router.get('/insights', requireServicesAccess, async (req, res) => {
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

// GET /api/admin-leads/forms — list standard forms (registered before /:id so
// Express doesn't treat "forms" as an :id value)
router.get('/forms', requireServicesAccess, async (req, res) => {
  const forms = await db.prepare('SELECT * FROM admin_forms ORDER BY created_at DESC').all();
  res.json({ ok: true, forms });
});

// GET /api/admin-leads/accounting/summary — revenue summary + won leads + reimbursements
router.get('/accounting/summary', requireServicesAccess, async (req, res) => {
  const totalRow = await db.prepare("SELECT COALESCE(SUM(amount), 0)::float AS total FROM leads WHERE status = 'won'").get();
  const byService = await db.prepare(
    "SELECT service, COALESCE(SUM(amount), 0)::float AS total, COUNT(*)::int AS c FROM leads WHERE status = 'won' GROUP BY service"
  ).all();
  const wonLeads = await db.prepare(
    "SELECT id, name, email, service, amount, updated_at FROM leads WHERE status = 'won' ORDER BY updated_at DESC"
  ).all();
  const reimbursements = await db.prepare('SELECT * FROM reimbursements ORDER BY created_at DESC').all();

  res.json({ ok: true, totalRevenue: totalRow.total, byService, wonLeads, reimbursements });
});

// GET /api/admin-leads/talents — read-only talent directory for services_admin accounts,
// who have no other way to see talent data (they can't reach admin.html's own talent
// routes at all — see requireServicesAccess). Deliberately its own query against `users`,
// not a call into routes/admin.js, so this stays fully isolated from the marketplace admin
// panel. Note: this codebase has two different profile-completeness formulas — the "All
// Talent" tab's aggregate panel uses one (services/profileCompletion.js, weights to 105),
// and the "Job Triage" tab uses a different inline one (weights to 100). This replicates
// the Job Triage formula specifically, since that's what was asked for.
router.get('/talents', requireServicesAccess, async (req, res) => {
  const talents = await db.prepare(`
    SELECT id, full_name, email, profile_pic, job_title, talent_status, skills, bio, location,
           video_loom_link, resume_file, created_at,
           (
             CASE WHEN profile_pic IS NOT NULL AND profile_pic != '' THEN 10 ELSE 0 END +
             CASE WHEN bio IS NOT NULL AND bio != '' THEN 10 ELSE 0 END +
             CASE WHEN skills IS NOT NULL AND skills != '' AND skills != '[]' THEN 10 ELSE 0 END +
             CASE WHEN location IS NOT NULL AND location != '' THEN 5 ELSE 0 END +
             CASE WHEN video_loom_link IS NOT NULL AND video_loom_link != '' THEN 20 ELSE 0 END +
             CASE WHEN resume_file IS NOT NULL AND resume_file != '' THEN 15 ELSE 0 END +
             CASE WHEN (hardware_specs IS NOT NULL AND hardware_specs != '') OR (specs_image IS NOT NULL AND specs_image != '') THEN 10 ELSE 0 END +
             CASE WHEN (speedtest_url IS NOT NULL AND speedtest_url != '') OR (speedtest_image IS NOT NULL AND speedtest_image != '') THEN 5 ELSE 0 END +
             CASE WHEN personality_type IS NOT NULL AND personality_type != '' THEN 5 ELSE 0 END
           ) AS profile_score
    FROM users
    WHERE role = 'freelancer' AND COALESCE(talent_status, '') != 'denied'
    ORDER BY created_at DESC
  `).all();
  res.json({ ok: true, talents });
});

// GET /api/admin-leads/:id — full detail (intake fields, or the chat thread)
router.get('/:id', requireServicesAccess, async (req, res) => {
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

// PATCH /api/admin-leads/:id/status — move a lead between pipeline stages.
// `amount` is optional and only meaningful for "won" (what the client actually
// paid) — pricing is quoted per-client for these two services, so this is a
// manual figure for now rather than pulled from a real payment processor.
router.patch('/:id/status', requireServicesAccess, async (req, res) => {
  const { status } = req.body;
  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Invalid status.' });
  }
  let amount = req.body.amount;
  if (amount !== undefined && amount !== null && amount !== '') {
    amount = Number(amount);
    if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: 'Invalid amount.' });
  } else {
    amount = undefined;
  }

  const result = amount !== undefined
    ? await db.prepare('UPDATE leads SET status = ?, amount = ?, updated_at = NOW() WHERE id = ?').run(status, amount, req.params.id)
    : await db.prepare('UPDATE leads SET status = ?, updated_at = NOW() WHERE id = ?').run(status, req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Lead not found.' });
  res.json({ ok: true });
});

// PATCH /api/admin-leads/:id/notes — shared internal note + optional follow-up date,
// visible to all admins (not per-person) since it just lives on the lead row.
router.patch('/:id/notes', requireServicesAccess, async (req, res) => {
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
router.post('/:id/reply', requireServicesAccess, async (req, res) => {
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

// ── Forms ────────────────────────────────────────────────────────────────────
// POST /api/admin-leads/forms — upload a new standard form
router.post('/forms', requireServicesAccess, upload.single('file'), async (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 200);
  const category = VALID_FORM_CATEGORIES.includes(req.body.category) ? req.body.category : 'general';
  if (!title) return res.status(400).json({ error: 'A title is required.' });
  if (!req.file) return res.status(400).json({ error: 'A file is required.' });

  try {
    const ext = path.extname(req.file.originalname) || '';
    const key = `admin-forms/${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    const fileUrl = await uploadFile(req.file.buffer, key, req.file.mimetype);
    const inserted = await db.prepare(
      'INSERT INTO admin_forms (title, category, file_url, file_name, uploaded_by) VALUES (?, ?, ?, ?, ?)'
    ).run(title, category, fileUrl, req.file.originalname, req.user.email);
    res.status(201).json({ ok: true, id: inserted.lastInsertRowid });
  } catch (err) {
    console.error('Form upload error:', err.message);
    res.status(500).json({ error: 'Failed to upload form.' });
  }
});

// DELETE /api/admin-leads/forms/:id
router.delete('/forms/:id', requireServicesAccess, async (req, res) => {
  const result = await db.prepare('DELETE FROM admin_forms WHERE id = ?').run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Form not found.' });
  res.json({ ok: true });
});

// ── Accounting ───────────────────────────────────────────────────────────────
// POST /api/admin-leads/reimbursements — upload a receipt/invoice with a short note
router.post('/reimbursements', requireServicesAccess, upload.single('file'), async (req, res) => {
  const note = String(req.body.note || '').trim().slice(0, 500);
  if (!note) return res.status(400).json({ error: 'A short note about what this is for is required.' });
  if (!req.file) return res.status(400).json({ error: 'A receipt or invoice file is required.' });

  try {
    const ext = path.extname(req.file.originalname) || '';
    const key = `reimbursements/${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    const fileUrl = await uploadFile(req.file.buffer, key, req.file.mimetype);
    const inserted = await db.prepare(
      'INSERT INTO reimbursements (note, file_url, file_name, uploaded_by) VALUES (?, ?, ?, ?)'
    ).run(note, fileUrl, req.file.originalname, req.user.email);
    res.status(201).json({ ok: true, id: inserted.lastInsertRowid });
  } catch (err) {
    console.error('Reimbursement upload error:', err.message);
    res.status(500).json({ error: 'Failed to upload receipt.' });
  }
});

module.exports = router;
