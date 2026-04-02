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
    from: 'WorkBase PH <contact@workbaseph.com>',
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
    subject: `Welcome to WorkBase PH, ${name}! 🎉 Let's build your profile`,
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
    <div class="greeting">Welcome, ${name}! 👋</div>
    <p class="text">You just joined a platform that leads with personality over paperwork. WorkBase PH matches serious employers with the right specialists — and we do it differently.</p>

    <div class="free-box">
      <p>💸 We never take a commission. <span>Every peso you earn goes directly to you. No cuts, no platform fees — ever. We earn from employers, not from you.</span></p>
    </div>

    <p class="text" style="font-weight:700;color:#0d2240;font-size:16px">Complete your profile to get matched faster:</p>

    <div class="step">
      <div class="step-num">1</div>
      <div>
        <h4>Record your personality video</h4>
        <p>Use <strong>Loom</strong> or <strong>YouTube (unlisted)</strong> to record a 5–10 minute reel. Talk about who you are, how you work, and what you're great at. Be real — authenticity wins. If you're camera-shy, a voice recording over your work samples works too!</p>
      </div>
    </div>

    <div class="step">
      <div class="step-num">2</div>
      <div>
        <h4>Take your Personality Assessment</h4>
        <p>20 quick questions to reveal your work style, communication strengths, and best-fit employer type. This is what makes our matching smarter than a job board.</p>
      </div>
    </div>

    <div class="step">
      <div class="step-num">3</div>
      <div>
        <h4>Upload your internet speed &amp; workspace photo</h4>
        <p>Run a quick test at <strong>speedtest.net</strong> and screenshot the result. Add an optional photo of your workspace. These small details build big trust with employers.</p>
      </div>
    </div>

    <div class="step">
      <div class="step-num">4</div>
      <div>
        <h4>Add your skills &amp; availability</h4>
        <p>Tell employers what you specialize in, your timezone, your rate, and whether you're open to long-term roles or short-term gigs.</p>
      </div>
    </div>

    <div class="cta-block">
      <a href="https://workbaseph.com/talent-profile.html" class="cta-btn">Build My Profile →</a><br/>
      <a href="https://workbaseph.com/assessment.html" class="cta-btn-teal">Take Personality Assessment →</a>
    </div>

    <hr class="divider"/>
    <p class="text" style="font-size:14px;color:#6b7280">Questions? Reply here or email <a href="mailto:contact@workbaseph.com" style="color:#f47c20">contact@workbaseph.com</a>. We read every message.</p>
    <p class="text" style="font-size:14px;color:#6b7280">To a better match, 🇵🇭<br/><strong style="color:#0d2240">The WorkBase PH Team</strong></p>
  </div>

  <div class="footer-email">
    <p><strong>WorkBase PH</strong> — Job Matching, Reimagined.</p>
    <p><a href="mailto:contact@workbaseph.com">contact@workbaseph.com</a> · <a href="https://workbaseph.com/terms.html">Terms</a> · <a href="https://workbaseph.com">workbaseph.com</a></p>
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
    <p class="text" style="font-size:14px;color:#6b7280">Questions? Reply here or email <a href="mailto:contact@workbaseph.com" style="color:#f47c20">contact@workbaseph.com</a>.</p>
    <p class="text" style="font-size:14px;color:#6b7280">Here to make hiring easier, 🇵🇭<br/><strong style="color:#0d2240">The WorkBase PH Team</strong></p>
  </div>

  <div class="footer-email">
    <p><strong>WorkBase PH</strong> — Job Matching, Reimagined.</p>
    <p><a href="mailto:contact@workbaseph.com">contact@workbaseph.com</a> · <a href="https://workbaseph.com/terms.html">Terms</a> · <a href="https://workbaseph.com">workbaseph.com</a></p>
  </div>
</div>
</body>
</html>`,
  };
}

module.exports = { sendEmail, welcomeSpecialistEmail, welcomeEmployerEmail };
