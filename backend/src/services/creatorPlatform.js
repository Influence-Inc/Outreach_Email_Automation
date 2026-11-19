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

// Platforms the extension can send DMs on.
const DM_PLATFORMS = ['instagram', 'tiktok'];

// Where a creator without an email gets DM'd: { platform, username, url,
// via }, or null when there's nowhere to send one.
//   • Instagram / TikTok creator → their own profile (via = null).
//   • YouTube creator (YouTube has no DMs) → the Instagram account their
//     channel links to (preferred: it gets a Priority DM), else the linked
//     TikTok account (via = 'youtube'). The links come from the extension's
//     channel scrape (creators.bio_links: header + About panel + description).
function dmTargetFor(row) {
  if (!row) return null;
  const platform = platformOf(row);
  if (DM_PLATFORMS.includes(platform)) {
    if (!row.instagram_username && !row.instagram_url) return null;
    const own = parseProfileUrl(row.instagram_url);
    return {
      platform,
      username: row.instagram_username || (own && own.username) || null,
      url: row.instagram_url || (own && own.url) || null,
      via: null,
    };
  }
  if (platform !== 'youtube' || !Array.isArray(row.bio_links)) return null;
  const linked = row.bio_links
    .map((l) => parseProfileUrl(typeof l === 'string' ? l : l && l.url))
    .filter((p) => p && DM_PLATFORMS.includes(p.platform));
  const pick = linked.find((p) => p.platform === 'instagram') || linked.find((p) => p.platform === 'tiktok');
  return pick ? { ...pick, via: 'youtube' } : null;
}

// SQL condition: a YouTube row (alias prefix `p`, e.g. 'cr.') whose scraped
// links include an Instagram or TikTok profile — i.e. dmTargetFor() finds a
// target — and none of whose linked accounts is already in the campaign as
// its own creator row (the DM queue skips those: that row reaches them). The
// JS above is the exact check; this mirrors it for the campaign's "N to DM"
// count so the button number matches what the queue sends.
function linkedSocialSql(p = '') {
  return `(${p}platform = 'youtube' AND jsonb_typeof(${p}bio_links) = 'array' AND EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(${p}bio_links) AS l(url)
     WHERE l.url ~* '^https?://([a-z]+\\.)?(instagram\\.com/[A-Za-z0-9._]+/?($|[?#])|tiktok\\.com/@)'
       AND l.url !~* 'instagram\\.com/(p|reel|reels|tv|explore|stories|accounts|direct)/?($|[?#])'
  ) AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(${p}bio_links) AS l(url), creators o
     WHERE o.campaign_id = ${p}campaign_id AND o.id <> ${p}id AND o.status <> 'duplicate'
       AND (
         (o.platform = 'instagram' AND LOWER(o.instagram_username) = LOWER(substring(l.url from 'instagram\\.com/([A-Za-z0-9._]+)')))
         OR (o.platform = 'tiktok' AND LOWER(o.instagram_username) = LOWER(substring(l.url from 'tiktok\\.com/@([A-Za-z0-9._]+)')))
       )
  ))`;
}

module.exports = {
  PLATFORMS, PLATFORM_LABELS, DM_PLATFORMS, detectPlatform, parseProfileUrl, platformOf, dmTargetFor, linkedSocialSql,
};
