const nodemailer = require('nodemailer');

// Transporter — configure via Railway env vars:
// SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
// Falls back to console logging if not configured (dev mode)
function createTransporter() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) {
    return null; // no SMTP configured
  }
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

async function sendEmail({ to, subject, html }) {
  const transporter = createTransporter();
  if (!transporter) {
    // Dev fallback — log the email instead of crashing
    console.log(`\n📧 [EMAIL — not sent, no SMTP configured]`);
    console.log(`   To: ${to}`);
    console.log(`   Subject: ${subject}\n`);
    return;
  }
  await transporter.sendMail({
    from: `"WorkBase PH" <${process.env.SMTP_USER}>`,
    to,
    subject,
    html,
  });
}

// ─── Templates ────────────────────────────────────────────────────────────────

function welcomeFreelancerEmail(name) {
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
  .header-wordmark{font-size:28px;font-weight:900;color:#ffffff;letter-spacing:-0.5px}
  .header-wordmark span{color:#f47c20}
  .header-tagline{color:rgba(255,255,255,0.65);font-size:13px;margin-top:6px;font-style:italic}
  .body{padding:40px}
  .greeting{font-size:22px;font-weight:700;color:#0d2240;margin-bottom:12px}
  .text{font-size:15px;color:#374151;line-height:1.7;margin-bottom:16px}
  .highlight{background:#fdf0e8;border-left:4px solid #f47c20;padding:16px 20px;border-radius:0 8px 8px 0;margin:24px 0}
  .highlight p{margin:0;font-size:15px;color:#0d2240;font-weight:600}
  .step{display:flex;gap:16px;margin-bottom:20px;align-items:flex-start}
  .step-num{background:#f47c20;color:#fff;font-weight:900;font-size:14px;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;min-width:28px;text-align:center;line-height:28px}
  .step-body h4{margin:0 0 4px;font-size:15px;color:#0d2240}
  .step-body p{margin:0;font-size:14px;color:#6b7280;line-height:1.5}
  .cta-block{text-align:center;margin:32px 0}
  .cta-btn{display:inline-block;background:#f47c20;color:#ffffff;font-weight:700;font-size:16px;padding:14px 36px;border-radius:9999px;text-decoration:none;letter-spacing:0.2px}
  .divider{border:none;border-top:1px solid #e5e7eb;margin:32px 0}
  .personality-box{background:#e6f5f3;border-radius:12px;padding:24px;margin:24px 0}
  .personality-box h3{color:#1a8a7a;font-size:17px;margin:0 0 10px}
  .personality-box p{font-size:14px;color:#374151;margin:0;line-height:1.6}
  .footer{background:#f9fafb;border-top:1px solid #e5e7eb;padding:24px 40px;text-align:center}
  .footer p{font-size:12px;color:#9ca3af;margin:4px 0}
  .footer a{color:#f47c20;text-decoration:none}
</style>
</head>
<body>
<div class="wrapper">

  <div class="header">
    <div class="header-wordmark">Work<span>Base</span> PH</div>
    <div class="header-tagline">Job Matching, Reimagined.</div>
  </div>

  <div class="body">
    <div class="greeting">Welcome, ${name}! 👋</div>
    <p class="text">You've just joined a platform that believes <strong>your personality is your superpower.</strong> WorkBase PH is not a job board — we're a matchmaking platform built to connect the right people with the right opportunities.</p>

    <div class="highlight">
      <p>🎬 Stand out from thousands of applicants. Build your profile and let employers see the real you — before the first interview.</p>
    </div>

    <p class="text" style="font-weight:700;color:#0d2240;font-size:16px">Here's how to get matched faster:</p>

    <div class="step">
      <div class="step-num">1</div>
      <div class="step-body">
        <h4>Record your 5–10 minute video reel</h4>
        <p>Use <strong>Loom</strong> (loom.com) or <strong>YouTube</strong> (unlisted link) to record yourself. Talk about who you are, your skills, how you work, and what you're looking for. Be natural — authenticity wins.</p>
      </div>
    </div>

    <div class="step">
      <div class="step-num">2</div>
      <div class="step-body">
        <h4>Add your video link to your profile</h4>
        <p>Paste your Loom or YouTube link in your dashboard under "Video Profile." This is what employers see first — make it count.</p>
      </div>
    </div>

    <div class="step">
      <div class="step-num">3</div>
      <div class="step-body">
        <h4>Complete your Personality Assessment</h4>
        <p>Answer 20 quick questions so we can match you with employers who fit your working style, communication preference, and personality type.</p>
      </div>
    </div>

    <div class="step">
      <div class="step-num">4</div>
      <div class="step-body">
        <h4>Fill in your skills & availability</h4>
        <p>Add your specializations, rate, timezone, and whether you're open to long-term roles or short-term gigs.</p>
      </div>
    </div>

    <div class="personality-box">
      <h3>🧠 Why the Personality Assessment matters</h3>
      <p>Employers on WorkBase PH aren't just hiring for skills — they're hiring for fit. Our assessment helps surface your communication style, work ethic, and collaboration strengths so we can match you with employers who will genuinely appreciate how you work.</p>
    </div>

    <div class="cta-block">
      <a href="https://workbaseph.com/assessment.html" class="cta-btn">Take Your Personality Assessment →</a>
    </div>

    <hr class="divider"/>

    <p class="text" style="font-size:14px;color:#6b7280">Questions? Reply to this email or reach us at <a href="mailto:contact@workbaseph.com" style="color:#f47c20">contact@workbaseph.com</a>. We're a small, passionate team and we actually read every message.</p>

    <p class="text" style="font-size:14px;color:#6b7280">To a better match, 🇵🇭<br/><strong style="color:#0d2240">The WorkBase PH Team</strong></p>
  </div>

  <div class="footer">
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
  .header-wordmark{font-size:28px;font-weight:900;color:#ffffff;letter-spacing:-0.5px}
  .header-wordmark span{color:#f47c20}
  .header-tagline{color:rgba(255,255,255,0.65);font-size:13px;margin-top:6px;font-style:italic}
  .body{padding:40px}
  .greeting{font-size:22px;font-weight:700;color:#0d2240;margin-bottom:12px}
  .text{font-size:15px;color:#374151;line-height:1.7;margin-bottom:16px}
  .highlight{background:#fdf0e8;border-left:4px solid #f47c20;padding:16px 20px;border-radius:0 8px 8px 0;margin:24px 0}
  .highlight p{margin:0;font-size:15px;color:#0d2240;font-weight:600}
  .feature{background:#f9fafb;border-radius:12px;padding:20px;margin-bottom:16px}
  .feature h4{margin:0 0 6px;font-size:15px;color:#0d2240;display:flex;gap:8px;align-items:center}
  .feature p{margin:0;font-size:14px;color:#6b7280;line-height:1.5}
  .comparison{display:table;width:100%;border-collapse:collapse;margin:24px 0}
  .col-old{background:#f3f4f6;border-radius:12px 0 0 12px;padding:20px;display:table-cell;width:50%;vertical-align:top}
  .col-new{background:#0d2240;border-radius:0 12px 12px 0;padding:20px;display:table-cell;width:50%;vertical-align:top}
  .col-old h4{color:#9ca3af;font-size:11px;letter-spacing:1px;text-transform:uppercase;margin:0 0 12px}
  .col-new h4{color:#f47c20;font-size:11px;letter-spacing:1px;text-transform:uppercase;margin:0 0 12px}
  .col-old li{font-size:13px;color:#6b7280;margin-bottom:8px;list-style:none;display:flex;gap:6px}
  .col-new li{font-size:13px;color:rgba(255,255,255,0.85);margin-bottom:8px;list-style:none;display:flex;gap:6px}
  .cta-block{text-align:center;margin:32px 0}
  .cta-btn{display:inline-block;background:#0d2240;color:#ffffff;font-weight:700;font-size:16px;padding:14px 36px;border-radius:9999px;text-decoration:none;letter-spacing:0.2px}
  .divider{border:none;border-top:1px solid #e5e7eb;margin:32px 0}
  .footer{background:#f9fafb;border-top:1px solid #e5e7eb;padding:24px 40px;text-align:center}
  .footer p{font-size:12px;color:#9ca3af;margin:4px 0}
  .footer a{color:#f47c20;text-decoration:none}
</style>
</head>
<body>
<div class="wrapper">

  <div class="header">
    <div class="header-wordmark">Work<span>Base</span> PH</div>
    <div class="header-tagline">Job Matching, Reimagined.</div>
  </div>

  <div class="body">
    <div class="greeting">Welcome aboard, ${name}! 🎯</div>
    <p class="text">You've made a smart move. WorkBase PH isn't another job board — <strong>we're your hiring partner.</strong> Instead of sorting through hundreds of generic applications, we match you directly with pre-vetted Filipino talent who fit your role, your culture, and your standards.</p>

    <div class="highlight">
      <p>👉 You don't search. You get matched. No noise. Just qualified talent.</p>
    </div>

    <p class="text" style="font-weight:700;color:#0d2240;font-size:16px">Here's how WorkBase PH works for you:</p>

    <div class="feature">
      <h4>🎬 See talent before you interview</h4>
      <p>Every freelancer on WorkBase PH records a 5–10 minute video reel. You'll see their energy, communication style, and personality before scheduling a single call. Skip the awkward first 10 minutes of a Zoom — you'll already know if they're "the one."</p>
    </div>

    <div class="feature">
      <h4>🧠 Personality-matched candidates only</h4>
      <p>Our freelancers complete a personality assessment so we understand their work style, communication preferences, and strengths. We use this to match them with employers who will genuinely appreciate how they work.</p>
    </div>

    <div class="feature">
      <h4>✔ Pre-vetted, serious talent</h4>
      <p>No ghost applicants. No resume padding. Our talent pool is curated — every freelancer has been reviewed and approved before appearing on your radar.</p>
    </div>

    <table class="comparison">
      <tr>
        <td class="col-old">
          <h4>Old Way</h4>
          <ul style="padding:0;margin:0">
            <li><span style="color:#d1d5db">—</span> Post a job</li>
            <li><span style="color:#d1d5db">—</span> Wait days</li>
            <li><span style="color:#d1d5db">—</span> Sort 100+ applications</li>
            <li><span style="color:#d1d5db">—</span> Schedule dozens of interviews</li>
          </ul>
        </td>
        <td class="col-new">
          <h4>WorkBase PH Way</h4>
          <ul style="padding:0;margin:0">
            <li><span style="color:#1a8a7a">✔</span> Tell us your needs</li>
            <li><span style="color:#1a8a7a">✔</span> We vet and evaluate talent</li>
            <li><span style="color:#1a8a7a">✔</span> Receive matched candidates</li>
            <li><span style="color:#1a8a7a">✔</span> Hire with confidence</li>
          </ul>
        </td>
      </tr>
    </table>

    <div class="cta-block">
      <a href="https://workbaseph.com/post-job.html" class="cta-btn">Post Your First Role →</a>
    </div>

    <hr class="divider"/>

    <p class="text" style="font-size:14px;color:#6b7280">Need help or have questions about how the matching process works? Reply to this email or reach us at <a href="mailto:contact@workbaseph.com" style="color:#f47c20">contact@workbaseph.com</a>.</p>

    <p class="text" style="font-size:14px;color:#6b7280">Here to make hiring easier, 🇵🇭<br/><strong style="color:#0d2240">The WorkBase PH Team</strong></p>
  </div>

  <div class="footer">
    <p><strong>WorkBase PH</strong> — Job Matching, Reimagined.</p>
    <p><a href="mailto:contact@workbaseph.com">contact@workbaseph.com</a> · <a href="https://workbaseph.com/terms.html">Terms</a> · <a href="https://workbaseph.com">workbaseph.com</a></p>
  </div>

</div>
</body>
</html>`,
  };
}

module.exports = { sendEmail, welcomeFreelancerEmail, welcomeEmployerEmail };
