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

module.exports = { sendEmail, welcomeSpecialistEmail, welcomeEmployerEmail, eliteWelcomeEmail, standardRetentionEmail, underReviewEmail, welcomeEmployerPostPaymentEmail, eliteHeadhuntingEmail, standardApprovalEmail, requestReuploadEmail };
