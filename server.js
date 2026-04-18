const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Upload root: persisted volume on Railway (/data/uploads), or public/uploads locally
const UPLOAD_ROOT = process.env.UPLOAD_DIR || path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(UPLOAD_ROOT)) fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

// Middleware
app.use(cors());

// Stripe webhook MUST receive raw body — register BEFORE express.json()
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve uploaded files from the persisted volume at /uploads/*
app.use('/uploads', express.static(UPLOAD_ROOT));

// Serve static files — HTML files must not be cached by CDN so deploys take effect immediately
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/jobs', require('./routes/jobs'));
app.use('/api/contact', require('./routes/contact'));
app.use('/api/talent', require('./routes/talent'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/hitpay', require('./routes/hitpay'));
app.use('/api/payments', require('./routes/hitpay')); // /api/payments/hitpay-checkout
app.use('/api/uploads', require('./routes/uploads'));
app.use('/api/employer-verification', require('./routes/employer-verification'));
app.use('/api/community', require('./routes/community'));
app.use('/api/growth', require('./routes/growth'));
app.use('/api/interviews', require('./routes/interviews'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/tracking', require('./routes/tracking'));
app.use('/api/triage', require('./routes/triage'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/pipeline', require('./routes/pipeline'));
app.use('/api/reviews', require('./routes/reviews'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'WorkBasePH API is running', version: '1.0.0' });
});

// Catch-all: serve index.html for SPA-like navigation
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🚀 WorkBasePH Server running at http://localhost:${PORT}`);
  console.log(`📄 API available at http://localhost:${PORT}/api`);
  console.log(`\nDemo accounts:`);
  console.log(`  Employer: employer@demo.com / demo1234`);
  console.log(`  Freelancer: freelancer@demo.com / demo1234\n`);
});

// ── Profile completion drip email scheduler ───────────────────────────────────
const { sendEmail, dripD1Email, dripD3Email, dripD7Email, interviewReminderEmail } = require('./services/email');
const db = require('./database');

async function runDripScheduler() {
  try {
    // Day 1 — sent 24h after signup if profile incomplete
    const d1 = await db.prepare(`
      SELECT id, full_name, email FROM users
      WHERE role = 'freelancer'
        AND drip_d1_sent = 0
        AND created_at < NOW() - INTERVAL '24 hours'
        AND created_at > NOW() - INTERVAL '72 hours'
        AND (video_loom_link IS NULL OR video_loom_link = ''
             OR resume_file IS NULL OR resume_file = ''
             OR skills IS NULL OR skills = '')
      LIMIT 50
    `).all();
    for (const u of d1) {
      await sendEmail({ to: u.email, ...dripD1Email(u.full_name) }).catch(() => {});
      await db.prepare('UPDATE users SET drip_d1_sent = 1 WHERE id = ?').run(u.id);
      console.log(`[drip D1] Sent to ${u.email}`);
    }

    // Day 3
    const d3 = await db.prepare(`
      SELECT id, full_name, email FROM users
      WHERE role = 'freelancer'
        AND drip_d3_sent = 0
        AND created_at < NOW() - INTERVAL '72 hours'
        AND created_at > NOW() - INTERVAL '168 hours'
        AND (video_loom_link IS NULL OR video_loom_link = ''
             OR resume_file IS NULL OR resume_file = ''
             OR skills IS NULL OR skills = '')
      LIMIT 50
    `).all();
    for (const u of d3) {
      await sendEmail({ to: u.email, ...dripD3Email(u.full_name) }).catch(() => {});
      await db.prepare('UPDATE users SET drip_d3_sent = 1 WHERE id = ?').run(u.id);
      console.log(`[drip D3] Sent to ${u.email}`);
    }

    // Day 7
    const d7 = await db.prepare(`
      SELECT id, full_name, email FROM users
      WHERE role = 'freelancer'
        AND drip_d7_sent = 0
        AND created_at < NOW() - INTERVAL '168 hours'
        AND (video_loom_link IS NULL OR video_loom_link = ''
             OR resume_file IS NULL OR resume_file = ''
             OR skills IS NULL OR skills = '')
      LIMIT 50
    `).all();
    for (const u of d7) {
      await sendEmail({ to: u.email, ...dripD7Email(u.full_name) }).catch(() => {});
      await db.prepare('UPDATE users SET drip_d7_sent = 1 WHERE id = ?').run(u.id);
      console.log(`[drip D7] Sent to ${u.email}`);
    }
  } catch (err) {
    console.error('[drip scheduler] error:', err.message);
  }
}

// Run every hour
setInterval(runDripScheduler, 60 * 60 * 1000);
// Also run once 30s after startup (to catch any missed drips on redeploy)
setTimeout(runDripScheduler, 30000);
console.log('📬 Drip email scheduler started');

// ── Interview day-of reminder scheduler ──────────────────────────────────────
const { pool: reminderPool } = require('./database');

async function runInterviewReminderScheduler() {
  try {
    // Find accepted interviews happening today (within next 24h) where reminder not yet sent
    const { rows: interviews } = await reminderPool.query(`
      SELECT ir.id, ir.employer_id, ir.talent_id, ir.selected_slot, ir.jitsi_link,
             ir.employer_timezone,
             eu.full_name AS employer_name, eu.email AS employer_email,
             tu.full_name AS talent_name, tu.email AS talent_email
      FROM interview_requests ir
      JOIN users eu ON eu.id = ir.employer_id
      JOIN users tu ON tu.id = ir.talent_id
      WHERE ir.status = 'accepted'
        AND ir.interview_reminder_sent = 0
        AND (
          (ir.selected_slot = 'slot1' AND ir.slot1 BETWEEN NOW() AND NOW() + INTERVAL '24 hours')
          OR
          (ir.selected_slot = 'slot2' AND ir.slot2 BETWEEN NOW() AND NOW() + INTERVAL '24 hours')
        )
    `);

    for (const iv of interviews) {
      const slotCol = iv.selected_slot === 'slot1' ? 'slot1' : 'slot2';
      // Get the actual timestamp value
      const { rows: slotRow } = await reminderPool.query(
        `SELECT ${slotCol} AS slot_time FROM interview_requests WHERE id = $1`, [iv.id]
      );
      const confirmedTime = new Date(slotRow[0].slot_time).toLocaleString('en-PH', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZone: iv.employer_timezone || 'Asia/Manila'
      });

      // Send to talent
      if (iv.talent_email) {
        sendEmail({
          to: iv.talent_email,
          ...interviewReminderEmail(iv.talent_name, iv.employer_name, confirmedTime, iv.jitsi_link, 'talent')
        }).catch(err => console.error('[interview reminder → talent]', err.message));
      }
      // Send to employer
      if (iv.employer_email) {
        sendEmail({
          to: iv.employer_email,
          ...interviewReminderEmail(iv.employer_name, iv.talent_name, confirmedTime, iv.jitsi_link, 'employer')
        }).catch(err => console.error('[interview reminder → employer]', err.message));
      }

      // Mark reminder sent
      await reminderPool.query(
        'UPDATE interview_requests SET interview_reminder_sent = 1 WHERE id = $1', [iv.id]
      );
      console.log(`[interview reminder] Sent for interview #${iv.id} at ${confirmedTime}`);
    }
  } catch (err) {
    console.error('[interview reminder scheduler]', err.message);
  }
}

// Run every hour
setInterval(runInterviewReminderScheduler, 60 * 60 * 1000);
setTimeout(runInterviewReminderScheduler, 45000); // 45s after startup
console.log('📅 Interview reminder scheduler started');
