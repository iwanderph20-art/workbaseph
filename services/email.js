const https = require('https');

// Uses Resend (resend.com) — free tier: 100 emails/day, 3,000/month
// Setup: add RESEND_API_KEY to Railway environment variables
// Domain verification: add Resend DNS records to Cloudflare for workbaseph.com
async function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    console.log('\n📧 [EMAIL NOT SENT — RESEND_API_KEY not set in environment]');
    console.log(`   To: ${to}`);
    console.log(`   Subject: ${subject}`);
    console.log('   → Add RESEND_API_KEY to Railway env vars to enable emails\n');
    return;
  }

  const body = JSON.stringify({
    from: 'WorkBase PH <admin@workbaseph.com>',
    to: [to],
    subject,
    html,
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`📧 Welcome email sent to ${to}`);
          resolve(JSON.parse(data));
        } else {
          console.error(`📧 Email failed [${res.statusCode}]: ${data}`);
          reject(new Error(`Resend API error ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function welcomeSpecialistEmail(name) {
  return {
    subject: `Welcome to WorkBase PH, ${name}! Your profile is your ticket to getting hired`,
    html: `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
  body{margin:0;padding:0;background:#f5f5f5;font-family:'Helvetica Neue',Arial,sans-serif}
  .wrapper{max-width:600px;margin:0 auto;background:#ffffff}
  .header{background:#0d2240;padding:40px 40px 32px;text-align:center}
  .wordmark{font-size:28px;font-weight:900;color:#fff;letter-spacing:-0.5px}
  .wordmark span{color:#f47c20}
  .tagline{color:rgba(255,255,255,0.6);font-size:13px;margin-top:6px;font-style:italic}
  .free-badge{display:inline-block;background:#1a8a7a;color:white;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:6px 16px;border-radius:9999px;margin-top:14px}
  .body{padding:40px}
  .greeting{font-size:22px;font-weight:700;color:#0d2240;margin-bottom:12px}
  .text{font-size:15px;color:#374151;line-height:1.7;margin-bottom:16px}
  .free-box{background:#e6f5f3;border-left:4px solid #1a8a7a;padding:16px 20px;border-radius:0 8px 8px 0;margin:24px 0}
  .free-box p{margin:0;font-size:15px;color:#0d2240;font-weight:700}
  .free-box span{font-weight:400;color:#374151}
  .highlight-box{background:#fdf0e8;border-left:4px solid #f47c20;padding:18px 22px;border-radius:0 8px 8px 0;margin:24px 0}
  .highlight-box p{margin:0;font-size:15px;color:#0d2240;line-height:1.65}
  .step{display:flex;gap:16px;margin-bottom:22px;align-items:flex-start}
  .step-num{background:#f47c20;color:#fff;font-weight:900;font-size:13px;min-width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;line-height:28px;text-align:center}
  .step h4{margin:0 0 4px;font-size:15px;color:#0d2240}
  .step p{margin:0;font-size:14px;color:#6b7280;line-height:1.55}
  .cta-block{text-align:center;margin:32px 0}
  .cta-btn{display:inline-block;background:#f47c20;color:#fff;font-weight:700;font-size:15px;padding:14px 36px;border-radius:9999px;text-decoration:none}
  .cta-btn-teal{display:inline-block;background:#1a8a7a;color:#fff;font-weight:700;font-size:15px;padding:14px 36px;border-radius:9999px;text-decoration:none;margin-top:10px}
  .divider{border:none;border-top:1px solid #e5e7eb;margin:32px 0}
  .footer-email{background:#f9fafb;border-top:1px solid #e5e7eb;padding:24px 40px;text-align:center}
  .footer-email p{font-size:12px;color:#9ca3af;margin:4px 0}
  .footer-email a{color:#f47c20;text-decoration:none}
</style>
</head>
<body>
<div class="wrapper">
  <div class="header">
    <div class="wordmark">Work<span>Base</span> PH</div>
    <div class="tagline">Job Matching, Reimagined.</div>
    <div class="free-badge">100% Free for Specialists</div>
  </div>

  <div class="body">
    <div class="greeting">Welcome, ${name}!</div>
    <p class="text">Thank you for signing up on WorkBase PH. We're thrilled to have you here. This is the platform where Filipino specialists get found by serious employers — without paying a single centavo in commissions.</p>

    <div class="free-box">
      <p>Zero commission. Always. <span>Every peso you earn goes directly to you. No cuts, no platform fees — ever. We earn from employers, not from you.</span></p>
    </div>

    <div class="highlight-box">
      <p><strong style="display:block;margin-bottom:6px">The more complete your profile, the higher your chances of getting picked by an employer.</strong>Employers on WorkBase PH browse specialist profiles directly — they look at your video, skills, speedtest, and setup before deciding who to reach out to. A complete profile is the difference between getting noticed and being skipped.</p>
    </div>

    <p class="text" style="font-weight:700;color:#0d2240;font-size:16px">Complete your profile now to stand out:</p>

    <div class="step">
      <div class="step-num">1</div>
      <div>
        <h4>Record your Get-to-Know-Me video</h4>
        <p>Use <strong>Loom</strong> or <strong>YouTube (unlisted)</strong>. Keep it under 3 minutes. Talk about who you are, how you work, and what you're great at. Be yourself — employers can tell when someone is genuine.</p>
      </div>
    </div>

    <div class="step">
      <div class="step-num">2</div>
      <div>
        <h4>Add your skills and availability</h4>
        <p>Employers search by skill. The more specific your skills list is, the more relevant jobs you appear in. Add your timezone, rate, and whether you're open to long-term or short-term work.</p>
      </div>
    </div>

    <div class="step">
      <div class="step-num">3</div>
      <div>
        <h4>Upload your Speedtest result link</h4>
        <p>Go to <strong>speedtest.net</strong>, run a test, then share the result link (not a screenshot). Employers hiring for remote work specifically look for this — it builds immediate trust.</p>
      </div>
    </div>

    <div class="step">
      <div class="step-num">4</div>
      <div>
        <h4>Take the Personality Assessment</h4>
        <p>20 quick questions that reveal your work style and communication strengths. This helps employers find candidates who fit how their team actually works — not just their requirements list.</p>
      </div>
    </div>

    <div class="cta-block">
      <a href="https://workbaseph.com/dashboard.html" class="cta-btn">Complete My Profile →</a><br/>
      <a href="https://workbaseph.com/assessment.html" class="cta-btn-teal">Take Personality Assessment →</a>
    </div>

    <hr class="divider"/>
    <p class="text" style="font-size:14px;color:#6b7280">Questions? Reply here or email <a href="mailto:admin@workbaseph.com" style="color:#f47c20">admin@workbaseph.com</a>. We read every message.</p>
    <p class="text" style="font-size:14px;color:#6b7280">Rooting for you, 🇵🇭<br/><strong style="color:#0d2240">The WorkBase PH Team</strong></p>
  </div>

  <div class="footer-email">
    <p><strong>WorkBase PH</strong> — Job Matching, Reimagined.</p>
    <p><a href="mailto:admin@workbaseph.com">admin@workbaseph.com</a> · <a href="https://workbaseph.com/terms.html">Terms</a> · <a href="https://workbaseph.com">workbaseph.com</a></p>
  </div>
</div>
</body>
</html>`,
  };
}

function newJobNotificationEmail(employer, job) {
  const budgetStr = job.budget_type === 'fixed'
    ? `$${job.budget_min}–$${job.budget_max} fixed`
    : `$${job.budget_min}–$${job.budget_max}/hr`;
  return {
    subject: `[New Job Posted] ${job.title} — ${employer.full_name}`,
    html: `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/><style>
  body{margin:0;padding:0;background:#f5f5f5;font-family:'Helvetica Neue',Arial,sans-serif}
  .wrapper{max-width:600px;margin:0 auto;background:#fff}
  .header{background:#0d2240;padding:28px 36px;display:flex;align-items:center;justify-content:space-between}
  .wordmark{font-size:22px;font-weight:900;color:#fff}.wordmark span{color:#f47c20}
  .badge{background:#f47c20;color:white;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:5px 14px;border-radius:9999px}
  .body{padding:32px 36px}
  .section-label{font-size:10px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:#9ca3af;margin:0 0 4px}
  .field-val{font-size:15px;color:#111827;font-weight:500;margin:0 0 20px;line-height:1.6}
  .desc-box{background:#f9fafb;border-left:4px solid #f47c20;padding:16px 20px;border-radius:0 8px 8px 0;margin-bottom:20px;font-size:14px;color:#374151;line-height:1.75;white-space:pre-wrap}
  .meta-row{display:flex;gap:24px;flex-wrap:wrap;margin-bottom:20px}
  .meta-item{background:#f3f4f6;border-radius:8px;padding:10px 16px;min-width:120px}
  .meta-item .lbl{font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#6b7280;margin-bottom:3px}
  .meta-item .val{font-size:14px;font-weight:700;color:#0d2240}
  .footer-email{background:#f9fafb;border-top:1px solid #e5e7eb;padding:20px 36px;text-align:center;font-size:12px;color:#9ca3af}
  .footer-email a{color:#f47c20;text-decoration:none}
</style></head>
<body>
<div class="wrapper">
  <div class="header">
    <div class="wordmark">Work<span>Base</span> PH</div>
    <div class="badge">New Job Posted</div>
  </div>
  <div class="body">
    <p style="font-size:15px;color:#374151;margin:0 0 24px">A new job has been posted on the platform. Details below:</p>

    <div class="section-label">Job Title</div>
    <div class="field-val">${job.title}</div>

    <div class="meta-row">
      <div class="meta-item"><div class="lbl">Category</div><div class="val">${job.category}</div></div>
      <div class="meta-item"><div class="lbl">Type</div><div class="val">${job.engagement_type === 'long_term' ? 'Long-Term' : 'Gig / Short-Term'}</div></div>
      <div class="meta-item"><div class="lbl">Budget</div><div class="val">${budgetStr}</div></div>
      <div class="meta-item"><div class="lbl">Location</div><div class="val">${job.location || 'Remote'}</div></div>
    </div>

    ${job.skills_required ? `<div class="section-label">Skills Required</div><div class="field-val">${job.skills_required}</div>` : ''}

    <div class="section-label">Job Description</div>
    <div class="desc-box">${job.description}</div>

    <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0"/>

    <div class="section-label">Employer</div>
    <div class="field-val">${employer.full_name} &lt;${employer.email}&gt;</div>

    <div style="font-size:13px;color:#6b7280">Posted on ${new Date().toLocaleDateString('en-PH',{weekday:'long',year:'numeric',month:'long',day:'numeric'})}</div>
  </div>
  <div class="footer-email">
    <p><strong>WorkBase PH Admin</strong> · <a href="https://workbaseph.com">workbaseph.com</a></p>
    <p>This is an internal notification. Do not forward.</p>
  </div>
</div>
</body>
</html>`,
  };
}

function welcomeEmployerEmail(name) {
  return {
    subject: `Welcome to WorkBase PH, ${name}! Let's find your perfect match 🎯`,
    html: `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
  body{margin:0;padding:0;background:#f5f5f5;font-family:'Helvetica Neue',Arial,sans-serif}
  .wrapper{max-width:600px;margin:0 auto;background:#ffffff}
  .header{background:#0d2240;padding:40px 40px 32px;text-align:center}
  .wordmark{font-size:28px;font-weight:900;color:#fff;letter-spacing:-0.5px}
  .wordmark span{color:#f47c20}
  .tagline{color:rgba(255,255,255,0.6);font-size:13px;margin-top:6px;font-style:italic}
  .body{padding:40px}
  .greeting{font-size:22px;font-weight:700;color:#0d2240;margin-bottom:12px}
  .text{font-size:15px;color:#374151;line-height:1.7;margin-bottom:16px}
  .highlight{background:#fdf0e8;border-left:4px solid #f47c20;padding:16px 20px;border-radius:0 8px 8px 0;margin:24px 0}
  .highlight p{margin:0;font-size:15px;color:#0d2240;font-weight:600}
  .feature{background:#f9fafb;border-radius:10px;padding:18px 20px;margin-bottom:14px}
  .feature h4{margin:0 0 5px;font-size:15px;color:#0d2240}
  .feature p{margin:0;font-size:14px;color:#6b7280;line-height:1.5}
  .cta-block{text-align:center;margin:32px 0}
  .cta-btn{display:inline-block;background:#0d2240;color:#fff;font-weight:700;font-size:15px;padding:14px 36px;border-radius:9999px;text-decoration:none}
  .divider{border:none;border-top:1px solid #e5e7eb;margin:32px 0}
  .footer-email{background:#f9fafb;border-top:1px solid #e5e7eb;padding:24px 40px;text-align:center}
  .footer-email p{font-size:12px;color:#9ca3af;margin:4px 0}
  .footer-email a{color:#f47c20;text-decoration:none}
</style>
</head>
<body>
<div class="wrapper">
  <div class="header">
    <div class="wordmark">Work<span>Base</span> PH</div>
    <div class="tagline">Job Matching, Reimagined.</div>
  </div>

  <div class="body">
    <div class="greeting">Welcome aboard, ${name}! 🎯</div>
    <p class="text">You've made a smart move. WorkBase PH isn't a job board — <strong>we're your hiring partner.</strong> Instead of sorting through hundreds of applications, we match you with pre-vetted Filipino specialists who fit your role, culture, and standards.</p>

    <div class="highlight">
      <p>👉 You don't search. You get matched. No noise. Just qualified talent.</p>
    </div>

    <div class="feature">
      <h4>🎬 See personality before the interview</h4>
      <p>Every specialist records a short video reel — you'll see their energy and communication style before scheduling a single call.</p>
    </div>
    <div class="feature">
      <h4>🧠 Personality-matched candidates</h4>
      <p>Specialists complete our work-style assessment so we can match them with employers who genuinely fit how they work.</p>
    </div>
    <div class="feature">
      <h4>✔ Pre-vetted, serious talent only</h4>
      <p>No ghost applicants. No resume padding. Our talent pool is curated and reviewed before anyone reaches your radar.</p>
    </div>

    <hr class="divider"/>

    <div style="background:#fdf0e8;border-left:4px solid #f47c20;padding:18px 20px;border-radius:0 8px 8px 0;margin:0 0 24px">
      <p style="margin:0 0 10px;font-size:15px;font-weight:700;color:#0d2240">One more step: Verify your account</p>
      <p style="margin:0 0 12px;font-size:14px;color:#374151;line-height:1.6">To protect our talent community, employer accounts require a quick verification. Simply <strong>reply to this email</strong> with a non-editable scan, photo, or electronic copy of one of the documents below.</p>

      <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#0d2240;text-transform:uppercase;letter-spacing:0.5px">If you're a Recruiter or staffing agency employee:</p>
      <ul style="margin:0 0 14px;padding-left:20px;font-size:13px;color:#374151;line-height:1.8">
        <li>A utility bill addressed to your company location</li>
        <li>A letter of employment from the staffing agency showing you are employed there</li>
        <li>Any document showing you receive a salary or pay as an employed recruiter</li>
      </ul>

      <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#0d2240;text-transform:uppercase;letter-spacing:0.5px">If you're a business owner or hiring manager:</p>
      <ul style="margin:0 0 14px;padding-left:20px;font-size:13px;color:#374151;line-height:1.8">
        <li>Utility bill (internet, electricity, water — addressed to your company)</li>
        <li>Business License or Articles of Incorporation</li>
        <li>Tax Permit or License</li>
        <li>Insurance document (e.g. Company Liability Insurance)</li>
        <li>Industry-specific license (e.g. Health Inspection, Real Estate Broker License)</li>
        <li>Lease or Franchise Agreement</li>
      </ul>

      <p style="margin:0;font-size:13px;color:#374151;line-height:1.6">Your document must include the <strong>company name and address</strong>. Once we receive it, we'll review your account and update you as soon as possible.</p>
    </div>

    <div class="cta-block">
      <a href="https://workbaseph.com/post-job.html" class="cta-btn">Post Your First Role →</a>
    </div>

    <hr class="divider"/>
    <p class="text" style="font-size:14px;color:#6b7280">Questions? Reply here or email <a href="mailto:admin@workbaseph.com" style="color:#f47c20">admin@workbaseph.com</a>.</p>
    <p class="text" style="font-size:14px;color:#6b7280">Here to make hiring easier, 🇵🇭<br/><strong style="color:#0d2240">The WorkBase PH Team</strong></p>
  </div>

  <div class="footer-email">
    <p><strong>WorkBase PH</strong> — Job Matching, Reimagined.</p>
    <p><a href="mailto:admin@workbaseph.com">admin@workbaseph.com</a> · <a href="https://workbaseph.com/terms.html">Terms</a> · <a href="https://workbaseph.com">workbaseph.com</a></p>
  </div>
</div>
</body>
</html>`,
  };
}

function eliteWelcomeEmail(name) {
  return {
    subject: `Welcome to the Elite: You've been selected for WorkBasePH Premium 🚀`,
    html: `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
  body{margin:0;padding:0;background:#f5f5f5;font-family:'Helvetica Neue',Arial,sans-serif}
  .wrapper{max-width:600px;margin:0 auto;background:#ffffff}
  .header{background:linear-gradient(135deg,#0d2240,#1a8a7a);padding:40px 40px 32px;text-align:center}
  .wordmark{font-size:28px;font-weight:900;color:#fff;letter-spacing:-0.5px}
  .wordmark span{color:#f47c20}
  .elite-badge{display:inline-block;background:rgba(255,255,255,0.2);color:white;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;padding:8px 20px;border-radius:9999px;margin-top:14px;border:1px solid rgba(255,255,255,0.4)}
  .body{padding:40px}
  .greeting{font-size:22px;font-weight:700;color:#0d2240;margin-bottom:12px}
  .text{font-size:15px;color:#374151;line-height:1.7;margin-bottom:16px}
  .highlight-box{background:linear-gradient(135deg,#e6f5f3,#fdf0e8);border-radius:12px;padding:24px;margin:24px 0;border:1px solid rgba(26,138,122,0.2)}
  .highlight-box h3{margin:0 0 16px;color:#0d2240;font-size:17px}
  .benefit{display:flex;gap:12px;margin-bottom:14px;align-items:flex-start}
  .benefit-icon{font-size:20px;flex-shrink:0}
  .benefit h4{margin:0 0 3px;font-size:14px;color:#0d2240;font-weight:700}
  .benefit p{margin:0;font-size:13px;color:#6b7280;line-height:1.5}
  .steps-box{background:#f9fafb;border-radius:12px;padding:24px;margin:24px 0}
  .steps-box h3{margin:0 0 16px;color:#0d2240;font-size:16px}
  .step{display:flex;gap:14px;margin-bottom:16px;align-items:flex-start}
  .step-num{background:#f47c20;color:#fff;font-weight:900;font-size:12px;min-width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0}
  .step p{margin:0;font-size:14px;color:#374151;line-height:1.55}
  .cta-block{text-align:center;margin:32px 0}
  .divider{border:none;border-top:1px solid #e5e7eb;margin:28px 0}
  .footer-email{background:#f9fafb;border-top:1px solid #e5e7eb;padding:24px 40px;text-align:center}
  .footer-email p{font-size:12px;color:#9ca3af;margin:4px 0}
  .footer-email a{color:#f47c20;text-decoration:none}
</style>
</head>
<body>
<div class="wrapper">
  <div class="header">
    <div class="wordmark">Work<span>Base</span> PH</div>
    <div class="elite-badge">⭐ Elite Talent Pool</div>
  </div>
  <div class="body">
    <div class="greeting">Hi ${name},</div>
    <p class="text">Great news — our team has reviewed your profile and video introduction, and we are officially moving you into the <strong>WorkBasePH Elite Talent Pool.</strong></p>
    <p class="text">You are no longer just a profile in a marketplace. You are now part of a curated group that we personally pitch to high-growth global companies looking for their next long-term partner.</p>

    <div class="highlight-box">
      <h3>What This Means for You:</h3>
      <div class="benefit">
        <div class="benefit-icon">🎯</div>
        <div>
          <h4>Exclusive Placements</h4>
          <p>You are now eligible for our "Done-For-You" roles, where clients pay a premium headhunting fee specifically to access talent at your level.</p>
        </div>
      </div>
      <div class="benefit">
        <div class="benefit-icon">💰</div>
        <div>
          <h4>Higher Earning Potential</h4>
          <p>We target employers who value quality over the "lowest bid."</p>
        </div>
      </div>
      <div class="benefit">
        <div class="benefit-icon">🤝</div>
        <div>
          <h4>Direct Advocacy</h4>
          <p>When a matching role opens up, our team acts as your agent, highlighting your technical readiness to the client before you even meet them.</p>
        </div>
      </div>
    </div>

    <div class="steps-box">
      <h3>Your Next Steps to Stay "Interview-Ready":</h3>
      <div class="step">
        <div class="step-num">1</div>
        <p><strong>Keep Your Specs Updated:</strong> If you upgrade your hardware or get a faster internet backup, update your profile immediately.</p>
      </div>
      <div class="step">
        <div class="step-num">2</div>
        <p><strong>Review the Success Guide:</strong> Watch this 2-minute clip on how to ace a high-ticket interview with a US CEO. <a href="https://workbaseph.com/success-guide" style="color:#f47c20">Watch here →</a></p>
      </div>
      <div class="step">
        <div class="step-num">3</div>
        <p><strong>Monitor Your Inbox:</strong> Unlike the standard marketplace, we will contact you directly via email or WhatsApp when a "Perfect Match" role opens.</p>
      </div>
    </div>

    <hr class="divider"/>
    <p class="text">We are thrilled to have you as a founding member of our Elite pool. Let's get to work!</p>
    <p class="text">Best regards,<br/><strong style="color:#0d2240">The WorkBasePH Onboarding Team</strong><br/><em style="color:#6b7280;font-size:13px">The Future of Remote Hiring</em></p>
  </div>
  <div class="footer-email">
    <p><strong>WorkBase PH</strong> — Job Matching, Reimagined.</p>
    <p><a href="mailto:admin@workbaseph.com">admin@workbaseph.com</a> · <a href="https://workbaseph.com">workbaseph.com</a></p>
  </div>
</div>
</body>
</html>`,
  };
}

function standardRetentionEmail(name, feedback) {
  return {
    subject: `Your WorkBasePH Profile — Next Steps to Strengthen It`,
    html: `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
  body{margin:0;padding:0;background:#f5f5f5;font-family:'Helvetica Neue',Arial,sans-serif}
  .wrapper{max-width:600px;margin:0 auto;background:#ffffff}
  .header{background:#0d2240;padding:40px 40px 32px;text-align:center}
  .wordmark{font-size:28px;font-weight:900;color:#fff;letter-spacing:-0.5px}
  .wordmark span{color:#f47c20}
  .body{padding:40px}
  .greeting{font-size:22px;font-weight:700;color:#0d2240;margin-bottom:12px}
  .text{font-size:15px;color:#374151;line-height:1.7;margin-bottom:16px}
  .feedback-box{background:#fff8f0;border-left:4px solid #f47c20;padding:20px;border-radius:0 8px 8px 0;margin:24px 0}
  .feedback-box h4{margin:0 0 8px;color:#0d2240;font-size:15px}
  .feedback-box p{margin:0;font-size:14px;color:#374151;line-height:1.6}
  .tip{display:flex;gap:12px;margin-bottom:16px;align-items:flex-start;background:#f9fafb;padding:16px;border-radius:8px}
  .tip-icon{font-size:20px;flex-shrink:0}
  .tip h4{margin:0 0 4px;font-size:14px;color:#0d2240;font-weight:700}
  .tip p{margin:0;font-size:13px;color:#6b7280;line-height:1.5}
  .cta-btn{display:inline-block;background:#f47c20;color:#fff;font-weight:700;font-size:15px;padding:14px 36px;border-radius:9999px;text-decoration:none}
  .cta-block{text-align:center;margin:32px 0}
  .footer-email{background:#f9fafb;border-top:1px solid #e5e7eb;padding:24px 40px;text-align:center}
  .footer-email p{font-size:12px;color:#9ca3af;margin:4px 0}
  .footer-email a{color:#f47c20;text-decoration:none}
</style>
</head>
<body>
<div class="wrapper">
  <div class="header">
    <div class="wordmark">Work<span>Base</span> PH</div>
  </div>
  <div class="body">
    <div class="greeting">Hi ${name},</div>
    <p class="text">Our team has reviewed your Elite Pool application. While your profile shows real potential, we'd like to see a few improvements before we move you to the Elite tier.</p>

    ${feedback ? `<div class="feedback-box"><h4>📝 Reviewer Feedback:</h4><p>${feedback}</p></div>` : ''}

    <p class="text" style="font-weight:700;color:#0d2240">Here's how to strengthen your application:</p>
    <div class="tip">
      <div class="tip-icon">🎥</div>
      <div><h4>Improve Your Video</h4><p>Make sure your video is clear, well-lit, and shows your personality. Speak naturally about your skills and experience. Aim for 1–3 minutes.</p></div>
    </div>
    <div class="tip">
      <div class="tip-icon">💻</div>
      <div><h4>Upgrade Your Hardware Specs</h4><p>Elite clients require a minimum of 16GB RAM and 25 Mbps internet. If you're close, now is the time to upgrade.</p></div>
    </div>
    <div class="tip">
      <div class="tip-icon">📸</div>
      <div><h4>Resubmit Your Speedtest</h4><p>Run a fresh test at speedtest.net and upload a clear screenshot showing your current speeds.</p></div>
    </div>

    <p class="text">You remain fully active on the <strong>Standard Marketplace</strong> and employers on our platform can still find and contact you. Keep building your profile!</p>

    <div class="cta-block">
      <a href="https://workbaseph.com/talent-profile.html" class="cta-btn">Update My Profile →</a>
    </div>
    <p class="text" style="font-size:14px;color:#6b7280">Questions? Reply to this email — we read every message.</p>
    <p class="text" style="font-size:14px;color:#6b7280">Rooting for you, 🇵🇭<br/><strong style="color:#0d2240">The WorkBasePH Team</strong></p>
  </div>
  <div class="footer-email">
    <p><strong>WorkBase PH</strong> — Job Matching, Reimagined.</p>
    <p><a href="mailto:admin@workbaseph.com">admin@workbaseph.com</a> · <a href="https://workbaseph.com">workbaseph.com</a></p>
  </div>
</div>
</body>
</html>`,
  };
}

function underReviewEmail(name) {
  return {
    subject: `WorkBase PH — Your Application is Under Review`,
    html: `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
  body{margin:0;padding:0;background:#f5f5f5;font-family:'Helvetica Neue',Arial,sans-serif}
  .wrapper{max-width:600px;margin:0 auto;background:#ffffff}
  .header{background:#0d2240;padding:40px 40px 32px;text-align:center}
  .wordmark{font-size:28px;font-weight:900;color:#fff;letter-spacing:-0.5px}
  .wordmark span{color:#f47c20}
  .status-badge{display:inline-block;background:rgba(244,124,32,0.15);color:#f47c20;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;padding:7px 18px;border-radius:9999px;margin-top:14px;border:1px solid rgba(244,124,32,0.3)}
  .body{padding:40px}
  .heading{font-size:22px;font-weight:800;color:#0d2240;margin-bottom:10px}
  .text{font-size:15px;color:#374151;line-height:1.75;margin-bottom:16px}
  .review-box{background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:24px;margin:24px 0}
  .review-box h3{margin:0 0 14px;color:#0d2240;font-size:15px;font-weight:700}
  .step{display:flex;gap:14px;align-items:flex-start;margin-bottom:14px}
  .step-dot{width:8px;height:8px;border-radius:50%;background:#f47c20;margin-top:6px;flex-shrink:0}
  .step p{margin:0;font-size:14px;color:#374151;line-height:1.6}
  .timeline-box{background:#fdf0e8;border-left:4px solid #f47c20;padding:16px 20px;border-radius:0 8px 8px 0;margin:24px 0}
  .timeline-box p{margin:0;font-size:14px;color:#0d2240;line-height:1.7}
  .divider{border:none;border-top:1px solid #e5e7eb;margin:28px 0}
  .footer-email{background:#f9fafb;border-top:1px solid #e5e7eb;padding:24px 40px;text-align:center}
  .footer-email p{font-size:12px;color:#9ca3af;margin:4px 0}
  .footer-email a{color:#f47c20;text-decoration:none}
</style>
</head>
<body>
<div class="wrapper">
  <div class="header">
    <div class="wordmark">Work<span>Base</span> PH</div>
    <div class="status-badge">Status: Under Review</div>
  </div>
  <div class="body">
    <div class="heading">Hi ${name}, we received your application.</div>
    <p class="text">Thank you for signing up on WorkBase PH. Your account has been created and your application is now in our review queue.</p>

    <div class="review-box">
      <h3>What our team is reviewing:</h3>
      <div class="step"><div class="step-dot"></div><p><strong>Video Introduction</strong> — We assess communication clarity, personality fit, and professionalism.</p></div>
      <div class="step"><div class="step-dot"></div><p><strong>Hardware Specifications</strong> — We verify your workstation meets the minimum standards for client-facing remote work.</p></div>
      <div class="step"><div class="step-dot"></div><p><strong>Internet Speed &amp; Reliability</strong> — We confirm your connection is stable enough for consistent client work.</p></div>
      <div class="step"><div class="step-dot"></div><p><strong>Overall Profile Completeness</strong> — A stronger profile gets reviewed and matched faster.</p></div>
    </div>

    <div class="timeline-box">
      <p><strong>What to expect next:</strong> Our team typically completes profile reviews within 2–3 business days. You will receive an email the moment a decision is made — whether you are cleared for the Standard Marketplace or selected for our Elite Talent Pool.</p>
    </div>

    <p class="text">In the meantime, you can log back in to complete or update your profile. The more complete your profile is when we review it, the better your chances of being matched quickly.</p>

    <hr class="divider"/>
    <p class="text" style="font-size:14px;color:#6b7280">Questions? Reply to this email or contact us at <a href="mailto:admin@workbaseph.com" style="color:#f47c20">admin@workbaseph.com</a>.</p>
    <p class="text" style="font-size:14px;color:#6b7280">Talk soon,<br/><strong style="color:#0d2240">The WorkBase PH Team</strong></p>
  </div>
  <div class="footer-email">
    <p><strong>WorkBase PH</strong> — Job Matching, Reimagined.</p>
    <p><a href="mailto:admin@workbaseph.com">admin@workbaseph.com</a> · <a href="https://workbaseph.com/terms.html">Terms</a> · <a href="https://workbaseph.com">workbaseph.com</a></p>
  </div>
</div>
</body>
</html>`,
  };
}

function welcomeEmployerPostPaymentEmail(name, hasDoc = false) {
  const badgeText = hasDoc ? 'Payment Confirmed' : 'Action Required';
  const badgeBg   = hasDoc ? '#1a8a7a' : '#f47c20';

  const bodyContent = hasDoc ? `
    <div class="heading">Congratulations, ${name}!</div>
    <p class="text">Your payment has been confirmed and your verification document is on file. Your WorkBase PH Employer account is <strong>fully active</strong> — you can start posting jobs and reviewing our verified specialist pool right now.</p>

    <div class="checklist">
      <h3>Getting Started — Your Onboarding Checklist:</h3>
      <div class="check-item">
        <div class="check-num">1</div>
        <p><strong>Post your first job</strong> — Describe the role, the budget, and the skills you need. Verified specialists will start applying right away.</p>
      </div>
      <div class="check-item">
        <div class="check-num">2</div>
        <p><strong>Browse talent directly</strong> — Go to the Browse Talent tab in your dashboard to view specialist profiles, videos, and Speedtest results before they even apply.</p>
      </div>
      <div class="check-item">
        <div class="check-num">3</div>
        <p><strong>Review applicants fast</strong> — Each job post shows all applications organized by date. Click any applicant to see their full profile.</p>
      </div>
    </div>

    <div class="cta-block">
      <a href="https://workbaseph.com/post-job.html" class="cta-btn">Post Your First Job →</a>
    </div>` : `
    <div class="heading">Welcome aboard, ${name}!</div>
    <p class="text">Your payment has been confirmed and your account is active. To complete your setup and get full access to our talent pool, <strong>please verify your account by uploading a document</strong>.</p>

    <div style="background:#fff8f0;border-left:4px solid #f47c20;padding:18px 22px;border-radius:0 8px 8px 0;margin:24px 0">
      <p style="margin:0 0 12px;font-size:15px;font-weight:700;color:#0d2240">One step left: Upload a verification document</p>
      <p style="margin:0 0 14px;font-size:14px;color:#374151;line-height:1.6">Log in to your dashboard, go to <strong>My Profile</strong>, and upload one of the following:</p>
      <ul style="margin:0;padding-left:20px;font-size:13px;color:#374151;line-height:2">
        <li>Utility bill (internet, electricity, or water — addressed to your company)</li>
        <li>Business Registration or Articles of Incorporation</li>
        <li>Government-issued business permit or tax permit</li>
        <li>Any official document showing your company name and address</li>
      </ul>
      <p style="margin:12px 0 0;font-size:13px;color:#374151">Once submitted, our team will review and verify your account within 1–2 business days.</p>
    </div>

    <div class="cta-block">
      <a href="https://workbaseph.com/dashboard.html" class="cta-btn">Go to Dashboard → Upload Document</a>
    </div>`;

  return {
    subject: hasDoc
      ? `Congratulations, ${name} — Your WorkBase PH account is fully active!`
      : `Welcome to WorkBase PH, ${name} — Please verify your account`,
    html: `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
  body{margin:0;padding:0;background:#f5f5f5;font-family:'Helvetica Neue',Arial,sans-serif}
  .wrapper{max-width:600px;margin:0 auto;background:#ffffff}
  .header{background:#0d2240;padding:40px 40px 32px;text-align:center}
  .wordmark{font-size:28px;font-weight:900;color:#fff;letter-spacing:-0.5px}
  .wordmark span{color:#f47c20}
  .confirm-badge{display:inline-block;color:white;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;padding:7px 18px;border-radius:9999px;margin-top:14px;background:${badgeBg}}
  .body{padding:40px}
  .heading{font-size:22px;font-weight:800;color:#0d2240;margin-bottom:10px}
  .text{font-size:15px;color:#374151;line-height:1.75;margin-bottom:16px}
  .checklist{background:#f9fafb;border-radius:12px;padding:24px;margin:24px 0}
  .checklist h3{margin:0 0 16px;color:#0d2240;font-size:15px;font-weight:700}
  .check-item{display:flex;gap:12px;align-items:flex-start;margin-bottom:13px}
  .check-num{background:#f47c20;color:#fff;font-weight:900;font-size:12px;min-width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0}
  .check-item p{margin:0;font-size:14px;color:#374151;line-height:1.6}
  .check-item strong{color:#0d2240}
  .cta-block{text-align:center;margin:32px 0}
  .cta-btn{display:inline-block;background:#f47c20;color:#fff;font-weight:700;font-size:15px;padding:14px 36px;border-radius:9999px;text-decoration:none}
  .divider{border:none;border-top:1px solid #e5e7eb;margin:28px 0}
  .footer-email{background:#f9fafb;border-top:1px solid #e5e7eb;padding:24px 40px;text-align:center}
  .footer-email p{font-size:12px;color:#9ca3af;margin:4px 0}
  .footer-email a{color:#f47c20;text-decoration:none}
</style>
</head>
<body>
<div class="wrapper">
  <div class="header">
    <div class="wordmark">Work<span>Base</span> PH</div>
    <div class="confirm-badge">${badgeText}</div>
  </div>
  <div class="body">
    ${bodyContent}
    <hr class="divider"/>
    <p class="text" style="font-size:14px;color:#6b7280">Questions? Reply to this email or reach us at <a href="mailto:admin@workbaseph.com" style="color:#f47c20">admin@workbaseph.com</a>.</p>
    <p class="text" style="font-size:14px;color:#6b7280">Here to make hiring easier,<br/><strong style="color:#0d2240">The WorkBase PH Team</strong></p>
  </div>
  <div class="footer-email">
    <p><strong>WorkBase PH</strong> — Job Matching, Reimagined.</p>
    <p><a href="mailto:admin@workbaseph.com">admin@workbaseph.com</a> · <a href="https://workbaseph.com/terms.html">Terms</a> · <a href="https://workbaseph.com">workbaseph.com</a></p>
  </div>
</div>
</body>
</html>`,
  };
}

function eliteHeadhuntingEmail(name) {
  return {
    subject: `WorkBase PH — Your Elite Headhunting Request Has Been Received`,
    html: `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
  body{margin:0;padding:0;background:#f5f5f5;font-family:'Helvetica Neue',Arial,sans-serif}
  .wrapper{max-width:600px;margin:0 auto;background:#ffffff}
  .header{background:linear-gradient(135deg,#0d2240,#1a8a7a);padding:40px 40px 32px;text-align:center}
  .wordmark{font-size:28px;font-weight:900;color:#fff;letter-spacing:-0.5px}
  .wordmark span{color:#f47c20}
  .elite-badge{display:inline-block;background:rgba(255,255,255,0.15);color:white;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;padding:7px 18px;border-radius:9999px;margin-top:14px;border:1px solid rgba(255,255,255,0.3)}
  .body{padding:40px}
  .heading{font-size:22px;font-weight:800;color:#0d2240;margin-bottom:10px}
  .text{font-size:15px;color:#374151;line-height:1.75;margin-bottom:16px}
  .info-box{background:#f9fafb;border-left:4px solid #1a8a7a;padding:20px 24px;border-radius:0 10px 10px 0;margin:24px 0}
  .info-box p{margin:0;font-size:14px;color:#374151;line-height:1.7}
  .info-box strong{color:#0d2240}
  .what-next{background:#fdf0e8;border-radius:12px;padding:24px;margin:24px 0}
  .what-next h3{margin:0 0 14px;color:#0d2240;font-size:15px;font-weight:700}
  .step{display:flex;gap:12px;align-items:flex-start;margin-bottom:12px}
  .step-dot{width:6px;height:6px;border-radius:50%;background:#f47c20;margin-top:7px;flex-shrink:0}
  .step p{margin:0;font-size:14px;color:#374151;line-height:1.6}
  .divider{border:none;border-top:1px solid #e5e7eb;margin:28px 0}
  .footer-email{background:#f9fafb;border-top:1px solid #e5e7eb;padding:24px 40px;text-align:center}
  .footer-email p{font-size:12px;color:#9ca3af;margin:4px 0}
  .footer-email a{color:#f47c20;text-decoration:none}
</style>
</head>
<body>
<div class="wrapper">
  <div class="header">
    <div class="wordmark">Work<span>Base</span> PH</div>
    <div class="elite-badge">Elite Headhunting</div>
  </div>
  <div class="body">
    <div class="heading">Hi ${name}, your request is in our hands.</div>
    <p class="text">Thank you for selecting the Elite Headhunting service. This is our highest-touch offering and we take it seriously.</p>

    <div class="info-box">
      <p><strong>A Talent Success Manager has been notified</strong> and will reach out to you within <strong>24 hours</strong> to begin your custom talent search. We will personally review candidates against your specific requirements before presenting anyone to you.</p>
    </div>

    <div class="what-next">
      <h3>What happens next:</h3>
      <div class="step"><div class="step-dot"></div><p>Your Talent Success Manager will email or call to gather your detailed requirements — tech stack, culture fit, working hours, and budget range.</p></div>
      <div class="step"><div class="step-dot"></div><p>We hand-screen our Elite Talent Pool to identify the strongest matches specifically for your role.</p></div>
      <div class="step"><div class="step-dot"></div><p>You receive a curated shortlist of 3–5 candidates with video introductions, full profiles, and our internal recommendation notes.</p></div>
      <div class="step"><div class="step-dot"></div><p>You decide who to interview. We coordinate the scheduling and introductions.</p></div>
    </div>

    <p class="text">If you have any urgent requirements or details you want us to know before our outreach, reply directly to this email.</p>

    <hr class="divider"/>
    <p class="text" style="font-size:14px;color:#6b7280">Direct line: <a href="mailto:admin@workbaseph.com" style="color:#f47c20">admin@workbaseph.com</a></p>
    <p class="text" style="font-size:14px;color:#6b7280">We will be in touch shortly,<br/><strong style="color:#0d2240">The WorkBase PH Talent Team</strong></p>
  </div>
  <div class="footer-email">
    <p><strong>WorkBase PH</strong> — Job Matching, Reimagined.</p>
    <p><a href="mailto:admin@workbaseph.com">admin@workbaseph.com</a> · <a href="https://workbaseph.com">workbaseph.com</a></p>
  </div>
</div>
</body>
</html>`,
  };
}

function standardApprovalEmail(name) {
  return {
    subject: `WorkBase PH — You've Been Approved for the Standard Marketplace`,
    html: `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
  body{margin:0;padding:0;background:#f5f5f5;font-family:'Helvetica Neue',Arial,sans-serif}
  .wrapper{max-width:600px;margin:0 auto;background:#ffffff}
  .header{background:#0d2240;padding:40px 40px 32px;text-align:center}
  .wordmark{font-size:28px;font-weight:900;color:#fff;letter-spacing:-0.5px}
  .wordmark span{color:#f47c20}
  .approved-badge{display:inline-block;background:#1a8a7a;color:white;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;padding:7px 18px;border-radius:9999px;margin-top:14px}
  .body{padding:40px}
  .heading{font-size:22px;font-weight:800;color:#0d2240;margin-bottom:10px}
  .text{font-size:15px;color:#374151;line-height:1.75;margin-bottom:16px}
  .approved-box{background:#e6f5f3;border-radius:12px;padding:24px;margin:24px 0;border:1px solid rgba(26,138,122,0.2)}
  .approved-box h3{margin:0 0 12px;color:#0d2240;font-size:16px;font-weight:700}
  .approved-box p{margin:0;font-size:14px;color:#374151;line-height:1.7}
  .step{display:flex;gap:14px;margin-bottom:16px;align-items:flex-start}
  .step-num{background:#f47c20;color:#fff;font-weight:900;font-size:12px;min-width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0}
  .step p{margin:0;font-size:14px;color:#374151;line-height:1.55}
  .cta-block{text-align:center;margin:32px 0}
  .cta-btn{display:inline-block;background:#f47c20;color:#fff;font-weight:700;font-size:15px;padding:14px 36px;border-radius:9999px;text-decoration:none}
  .divider{border:none;border-top:1px solid #e5e7eb;margin:28px 0}
  .footer-email{background:#f9fafb;border-top:1px solid #e5e7eb;padding:24px 40px;text-align:center}
  .footer-email p{font-size:12px;color:#9ca3af;margin:4px 0}
  .footer-email a{color:#f47c20;text-decoration:none}
</style>
</head>
<body>
<div class="wrapper">
  <div class="header">
    <div class="wordmark">Work<span>Base</span> PH</div>
    <div class="approved-badge">Approved — Standard Marketplace</div>
  </div>
  <div class="body">
    <div class="heading">Congratulations, ${name}!</div>
    <p class="text">Your WorkBase PH profile has been reviewed and approved. You are now active on the <strong>Standard Marketplace</strong> and visible to employers on the platform.</p>

    <div class="approved-box">
      <h3>What this means:</h3>
      <p>Employers with an active subscription can now find your profile, view your video introduction, and reach out to you directly. You don't need to apply — employers come to you.</p>
    </div>

    <p class="text" style="font-weight:700;color:#0d2240">Keep your profile strong:</p>
    <div class="step">
      <div class="step-num">1</div>
      <p><strong>Keep your specs updated</strong> — If you upgrade your hardware or improve your internet speed, update your profile immediately.</p>
    </div>
    <div class="step">
      <div class="step-num">2</div>
      <p><strong>Monitor your inbox</strong> — Employer inquiries and match notifications will come via email. Check regularly.</p>
    </div>
    <div class="step">
      <div class="step-num">3</div>
      <p><strong>Aim for the Elite Pool</strong> — Strengthen your video, upgrade your hardware, and update your speedtest. Elite candidates get access to premium, higher-paying roles.</p>
    </div>

    <div class="cta-block">
      <a href="https://workbaseph.com/dashboard.html" class="cta-btn">Go to My Dashboard</a>
    </div>

    <hr class="divider"/>
    <p class="text" style="font-size:14px;color:#6b7280">Questions? Email us at <a href="mailto:admin@workbaseph.com" style="color:#f47c20">admin@workbaseph.com</a>.</p>
    <p class="text" style="font-size:14px;color:#6b7280">Welcome to the marketplace,<br/><strong style="color:#0d2240">The WorkBase PH Team</strong></p>
  </div>
  <div class="footer-email">
    <p><strong>WorkBase PH</strong> — Job Matching, Reimagined.</p>
    <p><a href="mailto:admin@workbaseph.com">admin@workbaseph.com</a> · <a href="https://workbaseph.com/terms.html">Terms</a> · <a href="https://workbaseph.com">workbaseph.com</a></p>
  </div>
</div>
</body>
</html>`,
  };
}

function requestReuploadEmail(name, items, customMessage) {
  const itemLabels = {
    resume: 'Resume / CV (PDF)',
    specs_image: 'System Specifications Screenshot (RAM, CPU)',
    speedtest_image: 'Internet Speed Test Screenshot',
    video: 'Video Introduction (Loom or YouTube link)',
  };

  const itemList = (items && items.length > 0)
    ? items.map(i => `<li>${itemLabels[i] || i}</li>`).join('')
    : '<li>Please log in to your dashboard to review and complete your profile submission.</li>';

  return {
    subject: `WorkBase PH — Action Required: Please Re-submit Your Application Materials`,
    html: `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
  body{margin:0;padding:0;background:#f5f5f5;font-family:'Helvetica Neue',Arial,sans-serif}
  .wrapper{max-width:600px;margin:0 auto;background:#ffffff}
  .header{background:#0d2240;padding:40px 40px 32px;text-align:center}
  .wordmark{font-size:28px;font-weight:900;color:#fff;letter-spacing:-0.5px}
  .wordmark span{color:#f47c20}
  .action-badge{display:inline-block;background:rgba(244,124,32,0.15);color:#f47c20;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;padding:7px 18px;border-radius:9999px;margin-top:14px;border:1px solid rgba(244,124,32,0.3)}
  .body{padding:40px}
  .heading{font-size:22px;font-weight:800;color:#0d2240;margin-bottom:10px}
  .text{font-size:15px;color:#374151;line-height:1.75;margin-bottom:16px}
  .items-box{background:#fff8f0;border-left:4px solid #f47c20;padding:20px 24px;border-radius:0 10px 10px 0;margin:24px 0}
  .items-box h3{margin:0 0 12px;color:#0d2240;font-size:15px;font-weight:700}
  .items-box ul{margin:0;padding-left:1.2rem;font-size:14px;color:#374151;line-height:2}
  .custom-msg{background:#f9fafb;border-radius:10px;padding:18px 20px;margin:24px 0;font-size:14px;color:#374151;line-height:1.7;border:1px solid #e5e7eb}
  .cta-block{text-align:center;margin:32px 0}
  .cta-btn{display:inline-block;background:#f47c20;color:#fff;font-weight:700;font-size:15px;padding:14px 36px;border-radius:9999px;text-decoration:none}
  .divider{border:none;border-top:1px solid #e5e7eb;margin:28px 0}
  .footer-email{background:#f9fafb;border-top:1px solid #e5e7eb;padding:24px 40px;text-align:center}
  .footer-email p{font-size:12px;color:#9ca3af;margin:4px 0}
  .footer-email a{color:#f47c20;text-decoration:none}
</style>
</head>
<body>
<div class="wrapper">
  <div class="header">
    <div class="wordmark">Work<span>Base</span> PH</div>
    <div class="action-badge">Action Required</div>
  </div>
  <div class="body">
    <div class="heading">Hi ${name}, we need a bit more from you.</div>
    <p class="text">Our team has reviewed your application and needs you to re-submit or update the following items before we can proceed with your review.</p>

    <div class="items-box">
      <h3>Please re-upload the following:</h3>
      <ul>${itemList}</ul>
    </div>

    ${customMessage ? `<div class="custom-msg"><strong style="color:#0d2240;display:block;margin-bottom:6px">Additional note from our team:</strong>${customMessage}</div>` : ''}

    <p class="text">Log in to your WorkBase PH dashboard and update the relevant sections in your profile. Once you re-submit, our team will be notified and will continue your review.</p>

    <div class="cta-block">
      <a href="https://workbaseph.com/dashboard.html" class="cta-btn">Go to My Profile</a>
    </div>

    <hr class="divider"/>
    <p class="text" style="font-size:14px;color:#6b7280">Questions? Email us at <a href="mailto:admin@workbaseph.com" style="color:#f47c20">admin@workbaseph.com</a>.</p>
    <p class="text" style="font-size:14px;color:#6b7280">Thank you for your patience,<br/><strong style="color:#0d2240">The WorkBase PH Review Team</strong></p>
  </div>
  <div class="footer-email">
    <p><strong>WorkBase PH</strong> — Job Matching, Reimagined.</p>
    <p><a href="mailto:admin@workbaseph.com">admin@workbaseph.com</a> · <a href="https://workbaseph.com/terms.html">Terms</a> · <a href="https://workbaseph.com">workbaseph.com</a></p>
  </div>
</div>
</body>
</html>`,
  };
}

// ── Interview invite email sent to the candidate ──────────────────────────────
function interviewInviteEmail(talentName, employerName, slot1, slot2, timezone, message) {
  const fmt = (iso, tz) => {
    try {
      return new Date(iso).toLocaleString('en-PH', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZone: tz || 'Asia/Manila',
      });
    } catch { return new Date(iso).toLocaleString(); }
  };
  const s1 = fmt(slot1, timezone);
  const s2 = fmt(slot2, timezone);
  return {
    subject: `Congratulations! You have an interview invite from ${employerName}`,
    html: `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
  body{margin:0;padding:0;background:#f5f5f5;font-family:'Helvetica Neue',Arial,sans-serif}
  .wrap{max-width:600px;margin:32px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)}
  .header{background:#0d2240;padding:36px 40px;text-align:center}
  .logo{font-size:22px;font-weight:900;color:white;letter-spacing:-0.5px}
  .logo span{color:#f47c20}
  .body{padding:40px}
  .congrats{font-size:28px;font-weight:900;color:#0d2240;margin:0 0 8px}
  .sub{font-size:16px;color:#6b7280;margin:0 0 28px;line-height:1.5}
  .slots{background:#f8fafc;border-radius:12px;padding:24px;margin:24px 0}
  .slot-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#9ca3af;margin-bottom:6px}
  .slot-val{font-size:15px;font-weight:700;color:#0d2240}
  .msg-box{background:#fff7ed;border-left:4px solid #f47c20;border-radius:0 8px 8px 0;padding:16px 20px;margin:20px 0;font-size:14px;color:#374151;line-height:1.65}
  .cta{display:block;width:fit-content;margin:28px auto 0;background:#f47c20;color:white;font-size:15px;font-weight:700;padding:14px 36px;border-radius:10px;text-decoration:none;text-align:center}
  .footer{background:#f8fafc;padding:24px 40px;text-align:center;font-size:12px;color:#9ca3af;border-top:1px solid #e5e7eb}
</style>
</head>
<body>
<div class="wrap">
  <div class="header">
    <div class="logo">Work<span>Base</span> PH</div>
  </div>
  <div class="body">
    <div class="congrats">Congratulations, ${talentName}!</div>
    <p class="sub">You've received an interview invitation from <strong style="color:#0d2240">${employerName}</strong>. This is a great step — they want to meet you!</p>

    <div class="slots">
      <div class="slot-label">Option 1</div>
      <div class="slot-val">${s1}</div>
      <div style="height:16px"></div>
      <div class="slot-label">Option 2</div>
      <div class="slot-val">${s2}</div>
      <div style="margin-top:12px;font-size:12px;color:#6b7280">Timezone: ${timezone || 'Asia/Manila'}</div>
    </div>

    ${message ? `<div class="msg-box"><strong style="display:block;margin-bottom:4px;color:#0d2240">Message from ${employerName}:</strong>${message.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>` : ''}

    <p style="font-size:14px;color:#6b7280;line-height:1.65">Log in to your WorkBase PH account to confirm one of the time slots. Once you confirm, a video meeting link will be automatically generated for both of you.</p>

    <a href="https://workbaseph.com/dashboard.html" class="cta">Confirm My Interview Slot →</a>
  </div>
  <div class="footer">
    WorkBase PH · Connecting Filipino talent with global employers<br/>
    You're receiving this because you have an active profile on WorkBase PH.
  </div>
</div>
</body>
</html>`,
  };
}

// ── Interview cancelled email sent to the candidate ───────────────────────────
function interviewCancelledEmail(talentName, employerName, reason) {
  return {
    subject: `Your interview with ${employerName} has been cancelled`,
    html: `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
  body{margin:0;padding:0;background:#f5f5f5;font-family:'Helvetica Neue',Arial,sans-serif}
  .wrap{max-width:600px;margin:32px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)}
  .header{background:#0d2240;padding:36px 40px;text-align:center}
  .logo{font-size:22px;font-weight:900;color:white;letter-spacing:-0.5px}
  .logo span{color:#f47c20}
  .body{padding:40px}
  .title{font-size:24px;font-weight:900;color:#0d2240;margin:0 0 8px}
  .reason-box{background:#fef2f2;border-left:4px solid #dc2626;border-radius:0 8px 8px 0;padding:16px 20px;margin:20px 0;font-size:14px;color:#374151;line-height:1.65}
  .cta{display:block;width:fit-content;margin:28px auto 0;background:#f47c20;color:white;font-size:15px;font-weight:700;padding:14px 36px;border-radius:10px;text-decoration:none;text-align:center}
  .footer{background:#f8fafc;padding:24px 40px;text-align:center;font-size:12px;color:#9ca3af;border-top:1px solid #e5e7eb}
</style>
</head>
<body>
<div class="wrap">
  <div class="header"><div class="logo">Work<span>Base</span> PH</div></div>
  <div class="body">
    <div class="title">Interview Cancelled</div>
    <p style="font-size:14px;color:#6b7280;line-height:1.65;margin:0 0 16px">Hi ${talentName}, we're sorry to let you know that <strong style="color:#0d2240">${employerName}</strong> has cancelled your upcoming interview.</p>
    <div class="reason-box"><strong style="display:block;margin-bottom:4px;color:#0d2240">Reason provided:</strong>${reason.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
    <p style="font-size:14px;color:#6b7280;line-height:1.65">Don't be discouraged — keep your profile strong and updated. Our team will continue matching you with relevant employers on WorkBase PH.</p>
    <a href="https://workbaseph.com/dashboard.html" class="cta">View My Dashboard →</a>
  </div>
  <div class="footer">WorkBase PH · Connecting Filipino talent with global employers</div>
</div>
</body>
</html>`,
  };
}

// ── Interview rescheduled email sent to the candidate ─────────────────────────
function interviewRescheduledEmail(talentName, employerName, slot1, slot2, timezone, message) {
  const fmt = (iso, tz) => {
    try {
      return new Date(iso).toLocaleString('en-PH', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZone: tz || 'Asia/Manila',
      });
    } catch { return new Date(iso).toLocaleString(); }
  };
  const s1 = fmt(slot1, timezone);
  const s2 = fmt(slot2, timezone);
  return {
    subject: `Interview rescheduled — new time options from ${employerName}`,
    html: `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
  body{margin:0;padding:0;background:#f5f5f5;font-family:'Helvetica Neue',Arial,sans-serif}
  .wrap{max-width:600px;margin:32px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)}
  .header{background:#0d2240;padding:36px 40px;text-align:center}
  .logo{font-size:22px;font-weight:900;color:white;letter-spacing:-0.5px}
  .logo span{color:#f47c20}
  .body{padding:40px}
  .title{font-size:24px;font-weight:900;color:#0d2240;margin:0 0 8px}
  .slots{background:#f8fafc;border-radius:12px;padding:24px;margin:24px 0}
  .slot-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#9ca3af;margin-bottom:6px}
  .slot-val{font-size:15px;font-weight:700;color:#0d2240}
  .msg-box{background:#fff7ed;border-left:4px solid #f47c20;border-radius:0 8px 8px 0;padding:16px 20px;margin:20px 0;font-size:14px;color:#374151;line-height:1.65}
  .cta{display:block;width:fit-content;margin:28px auto 0;background:#f47c20;color:white;font-size:15px;font-weight:700;padding:14px 36px;border-radius:10px;text-decoration:none;text-align:center}
  .footer{background:#f8fafc;padding:24px 40px;text-align:center;font-size:12px;color:#9ca3af;border-top:1px solid #e5e7eb}
</style>
</head>
<body>
<div class="wrap">
  <div class="header"><div class="logo">Work<span>Base</span> PH</div></div>
  <div class="body">
    <div class="title">Interview Rescheduled</div>
    <p style="font-size:14px;color:#6b7280;line-height:1.65;margin:0 0 4px">Hi ${talentName}, <strong style="color:#0d2240">${employerName}</strong> has proposed new interview time options. Please log in to your dashboard to confirm one.</p>
    <div class="slots">
      <div class="slot-label">New Option 1</div>
      <div class="slot-val">${s1}</div>
      <div style="height:16px"></div>
      <div class="slot-label">New Option 2</div>
      <div class="slot-val">${s2}</div>
      <div style="margin-top:12px;font-size:12px;color:#6b7280">Timezone: ${timezone || 'Asia/Manila'}</div>
    </div>
    ${message ? `<div class="msg-box"><strong style="display:block;margin-bottom:4px;color:#0d2240">Message from ${employerName}:</strong>${message.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>` : ''}
    <a href="https://workbaseph.com/dashboard.html" class="cta">Confirm My New Slot →</a>
  </div>
  <div class="footer">WorkBase PH · Connecting Filipino talent with global employers</div>
</div>
</body>
</html>`,
  };
}

// ── Direct message notification email ─────────────────────────────────────────
function newMessageEmail(recipientName, senderName, messagePreview) {
  return {
    subject: `New message from ${senderName} on WorkBase PH`,
    html: `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
  body{margin:0;padding:0;background:#f5f5f5;font-family:'Helvetica Neue',Arial,sans-serif}
  .wrap{max-width:600px;margin:32px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)}
  .header{background:#0d2240;padding:32px 40px;text-align:center}
  .logo{font-size:22px;font-weight:900;color:white;letter-spacing:-0.5px}
  .logo span{color:#f47c20}
  .body{padding:40px}
  .title{font-size:22px;font-weight:900;color:#0d2240;margin:0 0 8px}
  .preview{background:#f8fafc;border-radius:10px;padding:20px;margin:20px 0;font-size:15px;color:#374151;line-height:1.65;border-left:4px solid #0d2240}
  .cta{display:block;width:fit-content;margin:24px auto 0;background:#f47c20;color:white;font-size:15px;font-weight:700;padding:14px 36px;border-radius:10px;text-decoration:none}
  .footer{background:#f8fafc;padding:24px 40px;text-align:center;font-size:12px;color:#9ca3af;border-top:1px solid #e5e7eb}
</style>
</head>
<body>
<div class="wrap">
  <div class="header"><div class="logo">Work<span>Base</span> PH</div></div>
  <div class="body">
    <div class="title">You have a new message</div>
    <p style="font-size:14px;color:#6b7280;margin:0 0 16px">Hi ${recipientName}, <strong style="color:#0d2240">${senderName}</strong> sent you a message on WorkBase PH.</p>
    <div class="preview">"${messagePreview.slice(0,200)}${messagePreview.length>200?'…':''}"</div>
    <a href="https://workbaseph.com/dashboard.html" class="cta">Read &amp; Reply →</a>
  </div>
  <div class="footer">WorkBase PH · Connecting Filipino talent with global employers</div>
</div>
</body>
</html>`,
  };
}

// ── New job match notification email sent to the talent ────────────────────────
function jobMatchEmail(talentName, jobTitle, category, description) {
  const preview = (description || '').slice(0, 200).replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return {
    subject: `New Job Match: ${jobTitle} — Check it out on WorkBase PH`,
    html: `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
  body{margin:0;padding:0;background:#f5f5f5;font-family:'Helvetica Neue',Arial,sans-serif}
  .wrap{max-width:600px;margin:32px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)}
  .header{background:#0d2240;padding:36px 40px;text-align:center}
  .logo{font-size:22px;font-weight:900;color:white;letter-spacing:-0.5px}
  .logo span{color:#f47c20}
  .body{padding:40px}
  .title{font-size:26px;font-weight:900;color:#0d2240;margin:0 0 6px}
  .cat{display:inline-block;background:#e6f5f3;color:#1a8a7a;font-size:12px;font-weight:700;padding:3px 10px;border-radius:99px;margin-bottom:20px}
  .preview{background:#f8fafc;border-radius:10px;padding:20px;margin:20px 0;font-size:14px;color:#374151;line-height:1.65;border-left:4px solid #0d2240}
  .cta{display:block;width:fit-content;margin:28px auto 0;background:#f47c20;color:white;font-size:15px;font-weight:700;padding:14px 36px;border-radius:10px;text-decoration:none;text-align:center}
  .footer{background:#f8fafc;padding:24px 40px;text-align:center;font-size:12px;color:#9ca3af;border-top:1px solid #e5e7eb}
</style>
</head>
<body>
<div class="wrap">
  <div class="header"><div class="logo">Work<span>Base</span> PH</div></div>
  <div class="body">
    <div class="title">New Job Match, ${talentName}!</div>
    <div class="cat">${category || 'New Opportunity'}</div>
    <p style="font-size:15px;color:#374151;margin:0 0 4px">Our team matched your profile to a new role:</p>
    <p style="font-size:20px;font-weight:800;color:#0d2240;margin:6px 0 16px">${jobTitle}</p>
    ${preview ? `<div class="preview">${preview}${(description||'').length > 200 ? '…' : ''}</div>` : ''}
    <p style="font-size:14px;color:#6b7280;line-height:1.65">Log in to your WorkBase PH dashboard, go to <strong style="color:#0d2240">Job Matches</strong>, and apply with your cover letter if you're interested.</p>
    <a href="https://workbaseph.com/dashboard.html" class="cta">View &amp; Apply →</a>
  </div>
  <div class="footer">WorkBase PH · Connecting Filipino talent with global employers<br/>You're receiving this because your profile matched a job opening.</div>
</div>
</body>
</html>`,
  };
}

function dripD1Email(name) {
  return {
    subject: `${name}, your WorkBase PH profile is waiting to be completed`,
    html: `<!DOCTYPE html><html><head><meta charset="UTF-8"/><style>
      body{margin:0;padding:0;background:#f5f5f5;font-family:'Helvetica Neue',Arial,sans-serif}
      .wrapper{max-width:600px;margin:0 auto;background:#fff}
      .header{background:#0d2240;padding:36px 40px;text-align:center}
      .wordmark{font-size:26px;font-weight:900;color:#fff}.wordmark span{color:#f47c20}
      .body{padding:36px 40px}
      .h2{font-size:20px;font-weight:800;color:#0d2240;margin-bottom:10px}
      .text{font-size:15px;color:#374151;line-height:1.7;margin-bottom:14px}
      .box{background:#fdf0e8;border-left:4px solid #f47c20;padding:16px 20px;border-radius:0 8px 8px 0;margin:20px 0}
      .step{display:flex;gap:14px;margin-bottom:18px;align-items:flex-start}
      .snum{background:#f47c20;color:#fff;font-weight:900;font-size:12px;min-width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0}
      .step h4{margin:0 0 3px;font-size:14px;color:#0d2240}.step p{margin:0;font-size:13px;color:#6b7280}
      .cta{text-align:center;margin:28px 0}
      .btn{display:inline-block;background:#f47c20;color:#fff;font-weight:700;font-size:15px;padding:13px 32px;border-radius:9999px;text-decoration:none}
      .footer{background:#f9fafb;border-top:1px solid #e5e7eb;padding:20px 40px;text-align:center}
      .footer p{font-size:12px;color:#9ca3af;margin:3px 0}
    </style></head><body><div class="wrapper">
      <div class="header"><div class="wordmark">Work<span>Base</span> PH</div></div>
      <div class="body">
        <div class="h2">Hi ${name} — your profile needs a little more love 👋</div>
        <p class="text">You signed up on WorkBase PH yesterday — great first step! But employers can only discover you once your profile is complete. Here are the three things that matter most:</p>
        <div class="step"><div class="snum">1</div><div><h4>Record a short video intro</h4><p>Use Loom or Vocaroo. Even 60 seconds explaining who you are and how you work makes a huge difference. Employers watch videos before they read resumes.</p></div></div>
        <div class="step"><div class="snum">2</div><div><h4>Upload your resume &amp; system specs</h4><p>Employers filter by these. No resume = no match. No specs = they skip you for remote roles requiring tech setup transparency.</p></div></div>
        <div class="step"><div class="snum">3</div><div><h4>Complete your skills &amp; availability</h4><p>Our matching engine uses these to surface your profile for relevant jobs. More specific = more relevant matches.</p></div></div>
        <div class="box"><p style="margin:0;font-size:14px;color:#0d2240"><strong>Did you know?</strong> Profiles with a video intro get <strong>3x more employer views</strong> than profiles without one.</p></div>
        <div class="cta"><a href="https://workbaseph.com/dashboard.html" class="btn">Complete My Profile Now →</a></div>
      </div>
      <div class="footer"><p>WorkBase PH · No fees. Ever.</p><p style="font-size:11px">You received this because you signed up at workbaseph.com</p></div>
    </div></body></html>`
  };
}

function dripD3Email(name) {
  return {
    subject: `${name}, 3 things stopping employers from finding you`,
    html: `<!DOCTYPE html><html><head><meta charset="UTF-8"/><style>
      body{margin:0;padding:0;background:#f5f5f5;font-family:'Helvetica Neue',Arial,sans-serif}
      .wrapper{max-width:600px;margin:0 auto;background:#fff}
      .header{background:#0d2240;padding:36px 40px;text-align:center}
      .wordmark{font-size:26px;font-weight:900;color:#fff}.wordmark span{color:#f47c20}
      .body{padding:36px 40px}
      .h2{font-size:20px;font-weight:800;color:#0d2240;margin-bottom:10px}
      .text{font-size:15px;color:#374151;line-height:1.7;margin-bottom:14px}
      .warning{background:#fef2f2;border-left:4px solid #dc2626;padding:16px 20px;border-radius:0 8px 8px 0;margin:20px 0}
      .item{display:flex;align-items:center;gap:12px;padding:12px 16px;background:#f9fafb;border-radius:8px;margin-bottom:10px;border:1px solid #e5e7eb}
      .item-icon{font-size:20px;flex-shrink:0}
      .item-text h4{margin:0 0 2px;font-size:14px;color:#0d2240}.item-text p{margin:0;font-size:12px;color:#6b7280}
      .cta{text-align:center;margin:28px 0}
      .btn{display:inline-block;background:#f47c20;color:#fff;font-weight:700;font-size:15px;padding:13px 32px;border-radius:9999px;text-decoration:none}
      .footer{background:#f9fafb;border-top:1px solid #e5e7eb;padding:20px 40px;text-align:center}
      .footer p{font-size:12px;color:#9ca3af;margin:3px 0}
    </style></head><body><div class="wrapper">
      <div class="header"><div class="wordmark">Work<span>Base</span> PH</div></div>
      <div class="body">
        <div class="h2">Employers are searching — but they can't find you yet</div>
        <p class="text">Hi ${name}, it's been 3 days since you joined WorkBase PH. Our system shows your profile is still incomplete, which means you're currently invisible to employers browsing talent. Here's what's likely missing:</p>
        <div class="warning"><p style="margin:0;font-size:14px;color:#991b1b"><strong>⚠ Incomplete profiles are excluded from employer search results.</strong> Finish your profile to start appearing in matches.</p></div>
        <div class="item"><div class="item-icon">🎬</div><div class="item-text"><h4>Video or Audio Introduction</h4><p>The single biggest factor in employer interest. Add a Loom or Vocaroo link.</p></div></div>
        <div class="item"><div class="item-icon">📄</div><div class="item-text"><h4>Resume &amp; System Specs</h4><p>Required documents for most employer matches. Upload both to unlock full visibility.</p></div></div>
        <div class="item"><div class="item-icon">⚡</div><div class="item-text"><h4>Skills &amp; Availability</h4><p>The matching engine can't route relevant jobs to you without these filled in.</p></div></div>
        <div class="cta"><a href="https://workbaseph.com/dashboard.html" class="btn">Finish My Profile →</a></div>
        <p style="text-align:center;font-size:13px;color:#6b7280">Takes less than 10 minutes. No cost — ever.</p>
      </div>
      <div class="footer"><p>WorkBase PH · workbaseph.com</p></div>
    </div></body></html>`
  };
}

function dripD7Email(name) {
  return {
    subject: `Last nudge, ${name} — don't let this opportunity slip`,
    html: `<!DOCTYPE html><html><head><meta charset="UTF-8"/><style>
      body{margin:0;padding:0;background:#f5f5f5;font-family:'Helvetica Neue',Arial,sans-serif}
      .wrapper{max-width:600px;margin:0 auto;background:#fff}
      .header{background:linear-gradient(135deg,#0d2240,#1a3a5c);padding:36px 40px;text-align:center}
      .wordmark{font-size:26px;font-weight:900;color:#fff}.wordmark span{color:#f47c20}
      .body{padding:36px 40px}
      .h2{font-size:20px;font-weight:800;color:#0d2240;margin-bottom:10px}
      .text{font-size:15px;color:#374151;line-height:1.7;margin-bottom:14px}
      .stat-row{display:flex;gap:16px;margin:24px 0}
      .stat{flex:1;background:#0d2240;border-radius:10px;padding:16px;text-align:center}
      .stat-num{font-size:28px;font-weight:900;color:#f47c20}
      .stat-lbl{font-size:11px;color:rgba(255,255,255,0.6);margin-top:4px;text-transform:uppercase;letter-spacing:0.5px}
      .cta{text-align:center;margin:28px 0}
      .btn{display:inline-block;background:linear-gradient(135deg,#f47c20,#e8641a);color:#fff;font-weight:700;font-size:15px;padding:14px 36px;border-radius:9999px;text-decoration:none;box-shadow:0 4px 16px rgba(244,124,32,0.35)}
      .footer{background:#f9fafb;border-top:1px solid #e5e7eb;padding:20px 40px;text-align:center}
      .footer p{font-size:12px;color:#9ca3af;margin:3px 0}
    </style></head><body><div class="wrapper">
      <div class="header"><div class="wordmark">Work<span>Base</span> PH</div></div>
      <div class="body">
        <div class="h2">${name}, this is our last nudge 🙏</div>
        <p class="text">A week ago you joined WorkBase PH. Employers are actively browsing and posting roles right now — but an incomplete profile means you're not in the running. We'd hate for you to miss out.</p>
        <div class="stat-row">
          <div class="stat"><div class="stat-num">1,200+</div><div class="stat-lbl">Active Specialists</div></div>
          <div class="stat"><div class="stat-num">₱0</div><div class="stat-lbl">Platform Fees Ever</div></div>
          <div class="stat"><div class="stat-num">100%</div><div class="stat-lbl">You Keep Earnings</div></div>
        </div>
        <p class="text">Your profile is your ticket. Employers can see your video, your setup, your personality — before they even reach out. It takes 10 minutes. It costs nothing. And it could change your career.</p>
        <div class="cta"><a href="https://workbaseph.com/dashboard.html" class="btn">Complete My Profile — It's Free →</a></div>
        <p style="text-align:center;font-size:12px;color:#9ca3af;margin-top:8px">No commission. No membership. No hidden charges.</p>
      </div>
      <div class="footer"><p>WorkBase PH · workbaseph.com</p><p style="font-size:11px">You signed up at workbaseph.com. <a href="https://workbaseph.com/unsubscribe" style="color:#9ca3af">Unsubscribe</a></p></div>
    </div></body></html>`
  };
}

module.exports = { sendEmail, welcomeSpecialistEmail, welcomeEmployerEmail, eliteWelcomeEmail, standardRetentionEmail, underReviewEmail, welcomeEmployerPostPaymentEmail, eliteHeadhuntingEmail, standardApprovalEmail, requestReuploadEmail, newJobNotificationEmail, interviewInviteEmail, interviewCancelledEmail, interviewRescheduledEmail, newMessageEmail, jobMatchEmail, dripD1Email, dripD3Email, dripD7Email };
