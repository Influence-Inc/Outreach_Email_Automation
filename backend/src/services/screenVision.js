'use strict';

// Server-side screen "vision" reader for creator sourcing.
//
// The paired host (runner) is being reduced to a thin pair of hands + eyes: it
// captures a screenshot AND the Android UI-element tree (`uiautomator dump`,
// parsed to a flat array by the runner) and POSTs both here. THIS module is the
// brain that turns those raw signals into the structured reading the Instagram
// Navigator consumes:
//
//   readScreen({ elements, width, height }) -> {
//     screen: 'search' | 'search_results' | 'profile' | 'reels_tab' | 'unknown',
//     targets: { searchTab?, searchBox?, back?, reelsTab?, 'result:<handle>'? },  // pixel coords
//     results?: string[],                     // @handles on a results screen
//     fullName?, followers?, bio?,            // profile header
//     reels?: [{ views, caption? }],          // reels tab overlays
//   }
//
// Why the element tree instead of pixel-guessing a vision model: `uiautomator`
// bounds are EXACT and deterministic, so taps land where they should instead of
// where a model estimated. Accessibility labels ("Search", "Reels", "Back") are
// far more stable across Instagram releases than resource-ids or coordinates.
//
// Everything here is a pure function of its inputs — no DB, no network, no model
// call — so the whole reader is unit-testable offline (see screenVision.test.js)
// and, once Phase 1 lands on a real device, the match signals below get
// calibrated against the actual tree without touching the navigator or driver.
//
// The `image` field is accepted by the route for forward-compatibility (a later
// phase can hand it to a vision model to enrich screens this reader marks
// 'unknown'); Phase 1 reads purely from the element tree.

const { parseCount } = require('./sourcingFilters');

// ── element helpers ─────────────────────────────────────────────────────────

function norm(s) {
  return String(s == null ? '' : s).trim().toLowerCase();
}

// resource-id comes as "com.instagram.android:id/search_edit_text" — the part
// after the slash is the stable-ish local name we match on.
function ridLocal(rid) {
  const s = String(rid || '');
  const i = s.indexOf('/');
  return (i >= 0 ? s.slice(i + 1) : s).toLowerCase();
}

// Pixel center of a node's bounds. The runner sends bounds as {x,y,w,h} in real
// device pixels, so the center is directly tappable — no normalization needed.
function center(b) {
  if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y)) return null;
  const w = Number.isFinite(b.w) ? b.w : 0;
  const h = Number.isFinite(b.h) ? b.h : 0;
  return { x: Math.round(b.x + w / 2), y: Math.round(b.y + h / 2) };
}

function isClickable(e) {
  return e && (e.clickable === true || e.clickable === 'true');
}

function labelOf(e) {
  return norm(e && (e.desc || e.text));
}

// text AND desc joined — matching on only one drops signal (e.g. a followers
// count node shows "84.2K" as text but "84,214 followers" as its description).
function textAndDesc(e) {
  return `${(e && e.text) || ''} ${(e && e.desc) || ''}`.trim();
}

// A username-ish token: letters/digits/dot/underscore, 2–30 chars, no spaces.
// Instagram handles fit this; display names (with spaces / capitals) do not, so
// this cleanly separates the @handle from the full name in a results row.
const HANDLE_RE = /^[a-z0-9](?:[a-z0-9._]{0,28}[a-z0-9])?$/;
function looksLikeHandle(s) {
  const t = String(s || '').trim().replace(/^@/, '');
  return HANDLE_RE.test(t.toLowerCase());
}

// A displayed count on its own: "45,000", "23.4K", "1.2M", "912". Excludes bare
// labels so we don't treat "Reels" or "Followers" as numbers.
const COUNT_RE = /^\d[\d.,]*\s*[kmb]?$/i;
function looksLikeCount(s) {
  return COUNT_RE.test(String(s || '').trim());
}

// ── signal matchers ─────────────────────────────────────────────────────────
// Each returns the FIRST element that matches any of its signals, scanned in
// priority order (resource-id first, then accessibility label). Kept as small
// data-driven predicate lists so a device-calibration pass only edits strings.

function findByRid(elements, names) {
  return elements.find((e) => names.some((n) => ridLocal(e.rid).includes(n))) || null;
}

function findByLabel(elements, names) {
  return (
    elements.find((e) => {
      const l = labelOf(e);
      return names.some((n) => l === n || l.includes(n));
    }) || null
  );
}

// Priority resolve: try resource-id signals, then label signals.
function resolveTarget(elements, { rids = [], labels = [] }) {
  return findByRid(elements, rids) || findByLabel(elements, labels) || null;
}

const SIGNALS = {
  searchTab: {
    rids: ['tab_icon_search', 'search_tab', 'feed_tab_search'],
    labels: ['search and explore', 'search'],
  },
  searchBox: {
    rids: ['action_bar_search_edit_text', 'search_edit_text', 'echo_text', 'search_box'],
    labels: ['search input', 'search for'],
  },
  back: {
    rids: ['action_bar_button_back', 'back_button', 'button_back'],
    labels: ['back', 'navigate up'],
  },
  reelsTab: {
    rids: ['profile_tab_icon_view_reels', 'row_profile_tab_reels', 'reels_tab'],
    labels: ['reels'],
  },
  // Full-screen reel player engagement buttons. 'like' matches both the Like and
  // Unlike states (same button); already-liked is detected separately so we never
  // un-like a reel.
  like: {
    rids: ['like_button', 'row_feed_button_like', 'reel_like_button', 'clips_like'],
    labels: ['like', 'unlike'],
  },
  save: {
    rids: ['save_button', 'feed_button_save', 'reel_save_button', 'clips_save'],
    labels: ['save', 'remove'],
  },
  share: {
    rids: ['share_button', 'feed_button_share', 'reel_share_button', 'clips_share'],
    labels: ['share', 'send'],
  },
};

// Instagram throws these when it thinks activity is automated — the cue to stop
// engaging immediately and back off.
const ACTION_BLOCK_RE =
  /action blocked|try again later|we restrict|temporarily blocked|restrict(?:ed)? (?:certain|some) activity|please wait a few (?:minutes|moments)/i;

// ── captured-data extractors ────────────────────────────────────────────────

function extractProfile(elements) {
  const out = { username: null, fullName: null, followers: null, bio: null };

  const title = findByRid(elements, ['action_bar_title', 'action_bar_large_title', 'title']);
  if (title && looksLikeHandle(title.text)) out.username = norm(title.text).replace(/^@/, '');

  const fullNameEl = findByRid(elements, ['profile_header_full_name', 'full_name']);
  if (fullNameEl && fullNameEl.text) out.fullName = String(fullNameEl.text).trim();

  const bioEl = findByRid(elements, ['profile_header_bio_text', 'profile_header_bio', 'bio_text']);
  if (bioEl && bioEl.text) out.bio = String(bioEl.text).trim();

  // Followers: an explicit count node by resource-id, else a "<n> followers"
  // label anywhere in the header.
  const followersEl = findByRid(elements, ['followers_count', 'row_profile_header_textview_followers_count']);
  if (followersEl) {
    out.followers = parseCount(followersEl.text || followersEl.desc);
  } else {
    const labelled = elements.find((e) => /followers?\b/i.test(textAndDesc(e)));
    if (labelled) out.followers = parseCount(labelled.text || labelled.desc);
  }
  return out;
}

// Reels tab: each reel thumbnail carries a view-count overlay. Collect the
// count-shaped text/desc nodes and parse them; gate on reels.length happens in
// the scoring rules, so returning only cleanly-read counts is correct.
function extractReels(elements) {
  const reels = [];
  for (const e of elements) {
    // "1.2M views" in a content-description, or a bare "1.2M" overlay text.
    const desc = String(e.desc || '');
    const m = desc.match(/([\d][\d.,]*\s*[kmb]?)\s*views?/i);
    if (m) {
      const v = parseCount(m[1]);
      if (Number.isFinite(v)) { reels.push({ views: v }); continue; }
    }
    if (looksLikeCount(e.text) && /reel|clip|video/i.test(ridLocal(e.rid) + ' ' + desc)) {
      const v = parseCount(e.text);
      if (Number.isFinite(v)) reels.push({ views: v });
    }
  }
  return reels;
}

// Search results: the ordered list of @handles, plus a tap target per handle.
// A results row surfaces the handle as a username-shaped text node; tapping it
// opens the profile. We keep first-seen order and de-dupe.
function extractResults(elements) {
  const results = [];
  const targets = {};
  for (const e of elements) {
    // The search field is an EditText whose typed text is handle-shaped — never
    // a result. And a bare count ("1.2m") can look like a handle, so require the
    // node to actually be a tappable username row (clickable, or a username rid).
    if (norm(e.cls).includes('edittext')) continue;
    const isUsernameRow = isClickable(e) || ridLocal(e.rid).includes('username');
    if (!isUsernameRow) continue;
    const raw = String(e.text || '').trim().replace(/^@/, '');
    if (!looksLikeHandle(raw)) continue;
    const handle = raw.toLowerCase();
    if (targets[`result:${handle}`]) continue;
    const c = center(e.bounds);
    if (!c) continue;
    results.push(handle);
    targets[`result:${handle}`] = c;
  }
  return { results, targets };
}

// Full-screen reel player: the reel's author handle, caption, and whether it's
// already liked/saved (so engagement never toggles the wrong way).
function extractFeed(elements) {
  const authorEl =
    findByRid(elements, ['reel_feed_username', 'clips_username', 'feed_username', 'author', 'username']) ||
    elements.find((e) => isClickable(e) && looksLikeHandle(e.text));
  const author = authorEl && looksLikeHandle(authorEl.text) ? norm(authorEl.text).replace(/^@/, '') : null;

  const captionEl = findByRid(elements, ['clips_caption', 'reel_caption', 'caption']);
  const caption = captionEl && captionEl.text ? String(captionEl.text).trim() : null;

  const alreadyLiked = elements.some((e) => labelOf(e) === 'unlike');
  const alreadySaved = elements.some((e) => labelOf(e) === 'remove' || ridLocal(e.rid).includes('saved'));

  return { author, caption, alreadyLiked, alreadySaved };
}

// ── screen classification ───────────────────────────────────────────────────
// Ordered most-specific first. Returns a coarse label the navigator branches on.

function classifyScreen(elements) {
  // Highest priority: an activity block means STOP engaging.
  if (elements.some((e) => ACTION_BLOCK_RE.test(textAndDesc(e)))) return 'action_blocked';

  // Full-screen reel player: like + share affordances plus a single reel author.
  const feed = extractFeed(elements);
  if (feed.author && resolveTarget(elements, SIGNALS.like) && resolveTarget(elements, SIGNALS.share)) {
    return 'reels_feed';
  }

  const hasReelOverlays = extractReels(elements).length >= 2;
  const reelsTabSelected = elements.some(
    (e) => labelOf(e) === 'reels' && (e.selected === true || e.selected === 'true'),
  );
  if (hasReelOverlays || reelsTabSelected) return 'reels_tab';

  const hasFollowers = elements.some((e) => /followers?\b/i.test(textAndDesc(e)));
  const hasProfileTabs = !!resolveTarget(elements, SIGNALS.reelsTab);
  if (hasFollowers && hasProfileTabs) return 'profile';

  const searchBox = resolveTarget(elements, SIGNALS.searchBox);
  const { results } = extractResults(elements);
  if (searchBox && results.length) return 'search_results';
  if (searchBox) return 'search';

  return 'unknown';
}

// ── public entry ────────────────────────────────────────────────────────────

// Turn the raw capture into the navigator's reading. `elements` is the parsed,
// flat UI tree from the runner; width/height are the device pixel size (kept for
// callers that want to sanity-check bounds, and echoed back).
function readScreen(input = {}) {
  const elements = Array.isArray(input.elements) ? input.elements : [];
  const screen = classifyScreen(elements);

  const targets = {};
  const add = (name, signal) => {
    const el = resolveTarget(elements, signal);
    const c = el && center(el.bounds);
    if (c) targets[name] = c;
  };
  // Always resolve navigation affordances when present — the navigator asks for
  // whichever it needs on the current screen and tolerates the rest missing.
  add('searchTab', SIGNALS.searchTab);
  add('searchBox', SIGNALS.searchBox);
  add('back', SIGNALS.back);
  add('reelsTab', SIGNALS.reelsTab);

  const reading = { screen, targets };

  if (screen === 'search_results') {
    const { results, targets: rt } = extractResults(elements);
    reading.results = results;
    Object.assign(targets, rt);
  } else if (screen === 'profile') {
    const p = extractProfile(elements);
    reading.fullName = p.fullName;
    reading.followers = p.followers;
    reading.bio = p.bio;
    if (p.username) reading.username = p.username;
  } else if (screen === 'reels_tab') {
    reading.reels = extractReels(elements);
  } else if (screen === 'reels_feed') {
    const feed = extractFeed(elements);
    reading.author = feed.author;
    reading.caption = feed.caption;
    reading.alreadyLiked = feed.alreadyLiked;
    reading.alreadySaved = feed.alreadySaved;
    add('like', SIGNALS.like);
    add('save', SIGNALS.save);
    add('share', SIGNALS.share);
  }

  return reading;
}

module.exports = {
  readScreen,
  classifyScreen,
  extractProfile,
  extractReels,
  extractResults,
  extractFeed,
  resolveTarget,
  center,
  looksLikeHandle,
  looksLikeCount,
  SIGNALS,
  ACTION_BLOCK_RE,
};
