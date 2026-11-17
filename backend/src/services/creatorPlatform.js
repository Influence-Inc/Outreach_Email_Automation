// Which social platform a creator's profile URL points at, and the canonical
// profile URL + handle we store for it.
//
// Deal Studio started Instagram-only, so the creators table keeps the profile
// URL in `instagram_url` and the handle in `instagram_username` for every
// platform; `creators.platform` ('instagram' | 'tiktok' | 'youtube') says which
// site those point at. The Chrome extension scrapes each platform the same way
// (open the profile, read name / email / bio / recent video views, PATCH the
// row), so everything downstream of the scrape is platform-agnostic.

const PLATFORMS = ['instagram', 'tiktok', 'youtube'];

const IG_RESERVED = new Set(['reels', 'reel', 'p', 'tv', 'explore', 'stories', 'accounts', 'direct']);
const YT_RESERVED = new Set(['watch', 'shorts', 'results', 'feed', 'playlist', 'embed', 'live', 'hashtag', 'redirect']);

function toUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  try {
    return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
}

function hostOf(u) {
  return u.hostname.toLowerCase().replace(/^(www|m|mobile)\./, '');
}

// Platform of a profile URL, or null when it isn't one we scrape.
function detectPlatform(raw) {
  const u = toUrl(raw);
  if (!u) return null;
  const host = hostOf(u);
  if (host === 'instagram.com' || host.endsWith('.instagram.com')) return 'instagram';
  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) return 'tiktok';
  if (host === 'youtube.com' || host.endsWith('.youtube.com')) return 'youtube';
  return null;
}

// { platform, username, url } for a profile URL, or null when the URL isn't a
// creator profile on a supported platform. `username` is the handle without a
// leading "@" (for a YouTube /channel/UC… URL, the channel id); `url` is the
// canonical profile URL the row is stored (and deduped) under.
function parseProfileUrl(raw) {
  const platform = detectPlatform(raw);
  if (!platform) return null;
  const u = toUrl(raw);
  const parts = u.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p));

  if (platform === 'instagram') {
    const h = parts[0];
    if (!h || IG_RESERVED.has(h.toLowerCase())) return null;
    return { platform, username: h, url: `https://www.instagram.com/${h}/` };
  }

  if (platform === 'tiktok') {
    // https://www.tiktok.com/@handle[/video/123]
    const seg = parts.find((p) => p.startsWith('@'));
    const h = seg ? seg.slice(1) : null;
    if (!h) return null;
    return { platform, username: h, url: `https://www.tiktok.com/@${h}` };
  }

  // YouTube: /@handle, /channel/UC…, /c/name, /user/name.
  const first = parts[0];
  if (!first) return null;
  if (first.startsWith('@') && first.length > 1) {
    const h = first.slice(1);
    return { platform, username: h, url: `https://www.youtube.com/@${h}` };
  }
  if (['channel', 'c', 'user'].includes(first.toLowerCase()) && parts[1]) {
    return { platform, username: parts[1], url: `https://www.youtube.com/${first.toLowerCase()}/${parts[1]}` };
  }
  if (YT_RESERVED.has(first.toLowerCase())) return null;
  // Legacy vanity URL: youtube.com/name
  return { platform, username: first, url: `https://www.youtube.com/c/${first}` };
}

function platformOf(row) {
  const p = row && row.platform;
  if (p && PLATFORMS.includes(p)) return p;
  return (row && detectPlatform(row.instagram_url)) || 'instagram';
}

const PLATFORM_LABELS = { instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube' };

module.exports = { PLATFORMS, PLATFORM_LABELS, detectPlatform, parseProfileUrl, platformOf };
