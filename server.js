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
app.use('/api/uploads', require('./routes/uploads'));
app.use('/api/employer-verification', require('./routes/employer-verification'));
app.use('/api/community', require('./routes/community'));
app.use('/api/growth', require('./routes/growth'));
app.use('/api/interviews', require('./routes/interviews'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/tracking', require('./routes/tracking'));

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
