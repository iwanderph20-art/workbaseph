// Validates a talent's video/audio introduction link.
//
// Talents paste a free-text URL into video_loom_link and the admin profile page turns
// it straight into a "Listen to Introduction" button. Nothing checked it, so a typo, a
// dead link, or a link to some unrelated site sent admins somewhere random.
//
// Two independent checks:
//   classifyIntroLink(url) — structural: is it a URL, and does it point at a host we
//                            recognise as video/audio hosting? (no network)
//   checkIntroLinkLive(url) — liveness: does it actually resolve? (network)

const ALLOWED_HOSTS = [
  { re: /(^|\.)loom\.com$/i,            label: 'Loom' },
  { re: /(^|\.)youtube\.com$/i,         label: 'YouTube' },
  { re: /(^|\.)youtu\.be$/i,            label: 'YouTube' },
  { re: /(^|\.)vocaroo\.com$/i,         label: 'Vocaroo' },
  { re: /(^|\.)voca\.ro$/i,             label: 'Vocaroo' },
  { re: /(^|\.)drive\.google\.com$/i,   label: 'Google Drive' },
  { re: /(^|\.)docs\.google\.com$/i,    label: 'Google Drive' },
  { re: /(^|\.)dropbox\.com$/i,         label: 'Dropbox' },
  { re: /(^|\.)streamable\.com$/i,      label: 'Streamable' },
  { re: /(^|\.)vimeo\.com$/i,           label: 'Vimeo' },
  { re: /(^|\.)soundcloud\.com$/i,      label: 'SoundCloud' },
  { re: /(^|\.)onedrive\.live\.com$/i,  label: 'OneDrive' },
  { re: /(^|\.)1drv\.ms$/i,             label: 'OneDrive' },
  { re: /(^|\.)veed\.io$/i,             label: 'VEED' },
  { re: /(^|\.)clipchamp\.com$/i,       label: 'Clipchamp' },
];

// A link straight to a media file is fine wherever it's hosted.
const MEDIA_EXT = /\.(mp3|wav|ogg|m4a|aac|flac|mp4|webm|mov|m4v)(\?|$)/i;

function classifyIntroLink(raw) {
  const url = String(raw || '').trim();
  if (!url) return { ok: false, code: 'missing', reason: 'No introduction link on the profile' };

  let u;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, code: 'malformed', reason: 'This is not a valid link', value: url };
  }
  if (!/^https?:$/.test(u.protocol)) {
    return { ok: false, code: 'malformed', reason: 'Link must start with http:// or https://', value: url, host: u.host };
  }
  if (MEDIA_EXT.test(u.pathname)) {
    return { ok: true, code: 'media', label: 'Direct audio/video file', host: u.host, value: url };
  }
  const hit = ALLOWED_HOSTS.find(a => a.re.test(u.hostname));
  if (hit) return { ok: true, code: 'known', label: hit.label, host: u.host, value: url };

  return {
    ok: false,
    code: 'unknown_host',
    reason: `Points to ${u.host}, which isn't a recognised video or audio host`,
    value: url,
    host: u.host,
  };
}

// Does the link actually resolve? Follows redirects; 4xx/5xx or a network error = broken.
async function checkIntroLinkLive(url, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WorkBasePH-LinkCheck/1.0)' },
    });
    return { reachable: res.status < 400, status: res.status, finalUrl: res.url };
  } catch (err) {
    return { reachable: false, status: 0, error: err.name === 'AbortError' ? 'timed out' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { classifyIntroLink, checkIntroLinkLive, ALLOWED_HOSTS };
