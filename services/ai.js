/**
 * AI Analysis Service — WorkBase PH
 * Uses Claude claude-opus-4-5 Vision to analyze talent application screenshots and
 * generate tier recommendations. Requires ANTHROPIC_API_KEY env var.
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const db = require('../database');

// ── Claude API caller ──────────────────────────────────────────────────────────
async function callClaude(messages, maxTokens = 600) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set — add it to Railway environment variables');
  }

  const body = JSON.stringify({
    model: 'claude-opus-4-5',
    max_tokens: maxTokens,
    messages,
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`Claude API error ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Image helpers ──────────────────────────────────────────────────────────────
function imageToBase64(relPath) {
  if (!relPath) return null;
  const abs = path.join(__dirname, '..', 'public', relPath.replace(/^\//, ''));
  if (!fs.existsSync(abs)) return null;
  return fs.readFileSync(abs).toString('base64');
}

function mediaType(filePath) {
  const ext = path.extname(filePath || '').toLowerCase();
  return { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' }[ext] || 'image/png';
}

function jsonFromText(text) {
  try {
    const clean = text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');
    return JSON.parse(clean);
  } catch {
    // Try to find JSON object in the text
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { /* fall through */ }
    }
    return null;
  }
}

// ── Image analyzers ────────────────────────────────────────────────────────────
async function analyzeSpecsImage(imagePath) {
  const b64 = imageToBase64(imagePath);
  if (!b64) return { ram_gb: null, cpu: null };

  const res = await callClaude([{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: mediaType(imagePath), data: b64 } },
      { type: 'text', text: 'This is a system specifications screenshot (About This Mac, Windows System Info, or similar). Extract ONLY the total installed RAM in GB and the CPU/processor model name. Respond with ONLY a valid JSON object, nothing else: {"ram_gb": <integer or null>, "cpu": "<string or null>"}' },
    ],
  }]);

  return jsonFromText(res.content[0].text) || { ram_gb: null, cpu: null };
}

async function analyzeSpeedtestImage(imagePath) {
  const b64 = imageToBase64(imagePath);
  if (!b64) return { download_mbps: null, upload_mbps: null };

  const res = await callClaude([{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: mediaType(imagePath), data: b64 } },
      { type: 'text', text: 'This is an internet speed test result screenshot (speedtest.net or similar). Extract ONLY the download speed and upload speed in Mbps as numbers. Respond with ONLY a valid JSON object, nothing else: {"download_mbps": <number or null>, "upload_mbps": <number or null>}' },
    ],
  }]);

  return jsonFromText(res.content[0].text) || { download_mbps: null, upload_mbps: null };
}

async function generateTierRecommendation(candidate, specs, speed) {
  const ramDisplay  = specs.ram_gb  ? `${specs.ram_gb}GB` : 'Unknown';
  const downDisplay = speed.download_mbps ? `${speed.download_mbps} Mbps` : 'Unknown';
  const upDisplay   = speed.upload_mbps   ? `${speed.upload_mbps} Mbps`  : 'Unknown';

  const prompt = `You are a remote talent recruitment specialist for WorkBase PH, a high-end talent platform.

Candidate profile:
- Name: ${candidate.full_name}
- Skills: ${candidate.skills || 'Not listed'}
- Bio: ${candidate.bio || 'Not provided'}
- Location: ${candidate.location || 'Philippines'}
- Video Reel: ${candidate.video_loom_link ? 'Submitted (' + candidate.video_loom_link + ')' : 'Not submitted'}
- RAM: ${ramDisplay}
- CPU: ${specs.cpu || 'Unknown'}
- Download Speed: ${downDisplay}
- Upload Speed: ${upDisplay}
- Resume: ${candidate.resume_file ? 'Submitted' : 'Not submitted'}

Tier rules:
- ELITE: 32GB+ RAM, 100+ Mbps download, video submitted, resume submitted, specialized skills
- STANDARD: Meets minimums (16GB RAM, 20 Mbps download) — may have basic setup or generalist profile
- Minimum requirements: 16GB RAM, 20 Mbps download speed, valid video link (loom.com or youtube.com)

Respond ONLY with a valid JSON object, nothing else:
{
  "tier": "ELITE" or "STANDARD",
  "justification": "One sentence explaining the tier placement",
  "strengths": ["up to 3 key strengths"],
  "flags": ["any concerns, missing items, or below-threshold specs"]
}`;

  const res = await callClaude([{ role: 'user', content: prompt }], 800);
  return jsonFromText(res.content[0].text) || {
    tier: 'STANDARD',
    justification: 'Manual review required — AI analysis incomplete.',
    strengths: [],
    flags: ['AI analysis did not return structured data'],
  };
}

// ── Main entry point ───────────────────────────────────────────────────────────
async function analyzeApplication(userId) {
  const candidate = await db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!candidate) return;

  console.log(`[AI] Analyzing application for ${candidate.full_name} (ID: ${userId})`);

  let specs = { ram_gb: null, cpu: null };
  let speed = { download_mbps: null, upload_mbps: null };
  let tier  = { tier: 'STANDARD', justification: 'Manual review required.', strengths: [], flags: [] };

  try {
    if (candidate.specs_image)      specs = await analyzeSpecsImage(candidate.specs_image);
    if (candidate.speedtest_image)  speed = await analyzeSpeedtestImage(candidate.speedtest_image);
    tier = await generateTierRecommendation(candidate, specs, speed);
    console.log(`[AI] Result — RAM: ${specs.ram_gb}GB | Down: ${speed.download_mbps}Mbps | Tier: ${tier.tier}`);
  } catch (err) {
    console.error(`[AI] Analysis error for user ${userId}:`, err.message);
    tier.flags.push('AI analysis error: ' + err.message);
  }

  // Determine pre-screen status
  const hasSpecs  = specs.ram_gb !== null;
  const hasSpeed  = speed.download_mbps !== null;
  const ramOk     = hasSpecs  ? specs.ram_gb >= 16 : false;
  const speedOk   = hasSpeed  ? speed.download_mbps >= 20 : false;
  const videoOk   = candidate.video_loom_link &&
    (candidate.video_loom_link.includes('loom.com') ||
     candidate.video_loom_link.includes('youtube.com') ||
     candidate.video_loom_link.includes('youtu.be'));

  let preScreenStatus = 'pending';
  if (hasSpecs && hasSpeed) {
    preScreenStatus = (ramOk && speedOk && videoOk) ? 'ready_for_approval' : 'pending_correction';
  }

  await db.prepare(`
    UPDATE users SET
      detected_ram              = ?,
      detected_cpu              = ?,
      detected_speed_down       = ?,
      detected_speed_up         = ?,
      ai_tier_recommendation    = ?,
      ai_summary                = ?,
      pre_screen_status         = ?,
      updated_at                = NOW()
    WHERE id = ?
  `).run(
    specs.ram_gb  ? `${specs.ram_gb}GB`            : '',
    specs.cpu     || '',
    speed.download_mbps ? `${speed.download_mbps} Mbps` : '',
    speed.upload_mbps   ? `${speed.upload_mbps} Mbps`   : '',
    tier.tier || 'STANDARD',
    JSON.stringify({ justification: tier.justification, strengths: tier.strengths || [], flags: tier.flags || [] }),
    preScreenStatus,
    userId,
  );

  console.log(`[AI] Done — user ${userId} pre_screen_status: ${preScreenStatus}`);
}

module.exports = { analyzeApplication };
