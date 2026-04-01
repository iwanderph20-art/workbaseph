========================================
  WORKBASEPH — Setup & Run Guide
========================================

REQUIREMENTS:
  - Node.js v18+ (download at https://nodejs.org)
  - npm (comes with Node.js)

QUICK START:
  1. Open a terminal and navigate to this folder:
       cd workbaseph

  2. Install dependencies:
       npm install

  3. Start the server:
       npm start

  4. Open your browser and go to:
       http://localhost:3000

DEMO ACCOUNTS (auto-seeded on first run):
  Employer:   employer@demo.com  / demo1234
  Freelancer: freelancer@demo.com / demo1234

PAGES:
  /              -> Landing Page
  /login.html    -> Login
  /signup.html   -> Sign Up (employer or freelancer)
  /jobs.html     -> Browse Jobs
  /post-job.html -> Post a Job (employers only)
  /dashboard.html -> User Dashboard

API ENDPOINTS:
  POST /api/auth/register      - Register new user
  POST /api/auth/login         - Login
  GET  /api/auth/me            - Get current user (auth required)
  PUT  /api/auth/profile       - Update profile (auth required)
  GET  /api/jobs               - List jobs (with filters)
  GET  /api/jobs/:id           - Get single job
  POST /api/jobs               - Post a job (employer only)
  POST /api/jobs/:id/apply     - Apply for job (freelancer only)
  GET  /api/jobs/employer/my-jobs          - Employer's jobs
  GET  /api/jobs/freelancer/my-applications - Freelancer's applications

TECH STACK:
  Backend:  Node.js + Express
  Database: SQLite (via better-sqlite3, auto-created on first run)
  Auth:     JWT tokens + bcrypt
  Frontend: Vanilla HTML/CSS/JavaScript

COLOR PALETTE:
  Primary Red: #8B1A1A
  Black:       #1a1a1a
  White:       #ffffff

For production deployment, set the JWT_SECRET environment variable:
  JWT_SECRET=your-secret-key node server.js

WorkBasePH © 2026 — "Where Skills Are Verified, Not Claimed."
========================================
