const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../database');
const { authenticateToken } = require('../middleware/auth');

// Upload dir for verification docs
const UPLOAD_ROOT = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'public', 'uploads');
const VERIFY_DIR = path.join(UPLOAD_ROOT, 'verify-docs');
if (!fs.existsSync(VERIFY_DIR)) fs.mkdirSync(VERIFY_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, VERIFY_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `employer-${req.user.id}-${Date.now()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.jpg', '.jpeg', '.png'];
    if (allowed.includes(path.extname(file.originalname).toLowerCase())) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, JPG, and PNG files are allowed'));
    }
  },
});

// ─── Compute trust score ──────────────────────────────────────────────────────
function computeTrustScore(user) {
  let score = 0;
  if (user.is_verified) score += 20;                      // email verified
  const isGeneric = /gmail|yahoo|hotmail|outlook/.test((user.email || '').toLowerCase());
  if (!isGeneric) score += 15;                            // company domain
  if (user.payment_method_added) score += 25;             // payment on file
  if (user.is_business_verified) score += 40;             // verified documents
  return Math.min(score, 100);
}

// ─── GET /api/employer-verification/status ────────────────────────────────────
router.get('/status', authenticateToken, async (req, res) => {
  if (req.user.role !== 'employer') return res.status(403).json({ error: 'Employers only' });

  try {
    const user = await db.prepare(
      'SELECT id, employer_type, trust_score, employer_verification_status, payment_method_added, is_business_verified, is_verified, email FROM users WHERE id = ?'
    ).get(req.user.id);

    const docs = await db.prepare(
      'SELECT id, doc_type, status, created_at FROM employer_documents WHERE employer_id = ? ORDER BY created_at DESC'
    ).all(req.user.id);

    const trust_score = computeTrustScore(user);
    await db.prepare('UPDATE users SET trust_score = ? WHERE id = ?').run(trust_score, user.id);

    const isGeneric = /gmail|yahoo|hotmail|outlook/.test((user.email || '').toLowerCase());
    const badges = [];
    if (user.is_verified) badges.push('Email Verified');
    if (user.payment_method_added) badges.push('Payment Method Added');
    if (user.is_business_verified) badges.push('Business Verified');

    res.json({
      employer_type: user.employer_type,
      trust_score,
      verification_status: user.employer_verification_status,
      payment_method_added: !!user.payment_method_added,
      is_business_verified: !!user.is_business_verified,
      email_type: isGeneric ? 'generic' : 'company',
      documents: docs,
      badges,
    });
  } catch (err) {
    console.error('[verify status] error:', err.message);
    res.status(500).json({ error: 'Failed to fetch verification status' });
  }
});

// ─── PUT /api/employer-verification/type ─────────────────────────────────────
// Called during/after registration to set employer_type
router.put('/type', authenticateToken, async (req, res) => {
  if (req.user.role !== 'employer') return res.status(403).json({ error: 'Employers only' });

  const { employer_type } = req.body;
  if (!['project_based', 'long_term'].includes(employer_type)) {
    return res.status(400).json({ error: 'employer_type must be project_based or long_term' });
  }

  try {
    await db.prepare('UPDATE users SET employer_type = ? WHERE id = ?').run(employer_type, req.user.id);

    // Set initial verification status based on type
    const status = employer_type === 'project_based' ? 'basic_verified' : 'pending_documents';
    await db.prepare('UPDATE users SET employer_verification_status = ? WHERE id = ?').run(status, req.user.id);

    const user = await db.prepare(
      'SELECT id, employer_type, trust_score, employer_verification_status, email FROM users WHERE id = ?'
    ).get(req.user.id);

    const trust_score = computeTrustScore(user);
    await db.prepare('UPDATE users SET trust_score = ? WHERE id = ?').run(trust_score, user.id);

    res.json({ employer_type, verification_status: status, trust_score });
  } catch (err) {
    console.error('[set type] error:', err.message);
    res.status(500).json({ error: 'Failed to update employer type' });
  }
});

// ─── POST /api/employer-verification/upload-doc ───────────────────────────────
router.post('/upload-doc', authenticateToken, upload.single('document'), async (req, res) => {
  if (req.user.role !== 'employer') return res.status(403).json({ error: 'Employers only' });

  const { doc_type } = req.body;
  const validTypes = ['business_registration', 'utility_bill', 'government_id'];
  if (!doc_type || !validTypes.includes(doc_type)) {
    return res.status(400).json({ error: 'doc_type must be business_registration, utility_bill, or government_id' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    const filePath = `/uploads/verify-docs/${req.file.filename}`;
    await db.prepare(
      'INSERT INTO employer_documents (employer_id, doc_type, file_path) VALUES (?, ?, ?)'
    ).run(req.user.id, doc_type, filePath);

    // Update status to under_review
    await db.prepare(
      "UPDATE users SET employer_verification_status = 'under_review' WHERE id = ?"
    ).run(req.user.id);

    res.json({ message: 'Document uploaded. Your account is under review.', file_path: filePath });
  } catch (err) {
    console.error('[upload doc] error:', err.message);
    res.status(500).json({ error: 'Failed to upload document' });
  }
});

// ─── POST /api/employer-verification/payment-added ───────────────────────────
// Called by Stripe webhook handler once a payment method is confirmed
router.post('/payment-added', authenticateToken, async (req, res) => {
  if (req.user.role !== 'employer') return res.status(403).json({ error: 'Employers only' });

  try {
    await db.prepare('UPDATE users SET payment_method_added = 1 WHERE id = ?').run(req.user.id);

    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const trust_score = computeTrustScore(user);
    await db.prepare('UPDATE users SET trust_score = ? WHERE id = ?').run(trust_score, user.id);

    res.json({ message: 'Payment method recorded', trust_score });
  } catch (err) {
    console.error('[payment-added] error:', err.message);
    res.status(500).json({ error: 'Failed to update payment status' });
  }
});

// ─── Admin: approve/reject employer documents ─────────────────────────────────
const { requireAdmin } = require('../middleware/auth');

router.get('/admin/pending', requireAdmin, async (req, res) => {
  try {
    const docs = await db.prepare(`
      SELECT ed.*, u.full_name, u.email, u.employer_type
      FROM employer_documents ed
      JOIN users u ON ed.employer_id = u.id
      WHERE ed.status = 'pending'
      ORDER BY ed.created_at ASC
    `).all();
    res.json(docs);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch pending documents' });
  }
});

router.post('/admin/review/:docId', requireAdmin, async (req, res) => {
  const { action, admin_notes } = req.body; // action: 'approve' | 'reject'
  if (!['approve', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'action must be approve or reject' });
  }

  try {
    const doc = await db.prepare('SELECT * FROM employer_documents WHERE id = ?').get(parseInt(req.params.docId));
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    const status = action === 'approve' ? 'approved' : 'rejected';
    await db.prepare(
      'UPDATE employer_documents SET status = ?, admin_notes = ?, reviewed_at = NOW() WHERE id = ?'
    ).run(status, admin_notes || '', doc.id);

    if (action === 'approve') {
      await db.prepare(
        "UPDATE users SET is_business_verified = 1, employer_verification_status = 'verified' WHERE id = ?"
      ).run(doc.employer_id);

      // Recalculate trust score
      const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(doc.employer_id);
      const trust_score = computeTrustScore(user);
      await db.prepare('UPDATE users SET trust_score = ? WHERE id = ?').run(trust_score, doc.employer_id);
    }

    res.json({ message: `Document ${action}d` });
  } catch (err) {
    console.error('[admin review doc] error:', err.message);
    res.status(500).json({ error: 'Failed to review document' });
  }
});

module.exports = router;
