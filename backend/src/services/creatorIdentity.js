'use strict';

// Shared creator-identity helpers used by outbound sync clients (Creator-DB,
// campaign dashboard) so every integration resolves the same @handle for a
// given creator.

const { parseUsername } = require('./igScraper');

// Instagram URL path segments that are NOT a profile handle (post/reel/etc.),
// so we never sync one of these as the creator's @handle.
const IG_NON_HANDLE = new Set(['p', 'reel', 'reels', 'explore', 'stories', 'tv', 's']);

// Resolve the creator's Instagram handle. Prefer the extracted username, but
// fall back to parsing it out of instagram_url (which is always set on an
// Outreach creator) so downstream services always get the handle.
function resolveHandle(d, creator) {
  let handle = (d && d.instagramUsername) || creator.instagram_username || null;
  if (!handle && creator.instagram_url) {
    const parsed = parseUsername(creator.instagram_url);
    if (parsed && !IG_NON_HANDLE.has(parsed.toLowerCase())) handle = parsed;
  }
  handle = String(handle || '')
    .replace(/^@/, '')
    .trim();
  return handle || undefined;
}

module.exports = { resolveHandle };
