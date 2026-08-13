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

// Prioritized variant: try each rid signal in ORDER, returning the first element
// whose rid contains it. Prevents a broad name (e.g. 'author') from matching a
// container that appears earlier in the tree than the specific element we want.
function findByRidPriority(elements, names) {
  for (const n of names) {
    const e = elements.find((el) => ridLocal(el.rid).includes(n));
    if (e) return e;
  }
  return null;
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
    // Real IG (2024+): the search entry on the home screen is a bottom-bar edit
    // text; on a SERP page it becomes the "tap to edit query" affordance in the
    // journey header. Kept alongside the older rids for backward-compat.
    rids: [
      'bottom_bar_search_edit_text', 'bottom_search_layout',
      'serp_journey_header_edit_tap_target',
      'action_bar_search_edit_text', 'search_edit_text', 'echo_text', 'search_box',
    ],
    labels: ['search input', 'search for'],
  },
  back: {
    rids: [
      'serp_journey_header_back_button',
      'action_bar_button_back', 'back_button', 'button_back',
    ],
    labels: ['back', 'navigate up'],
  },
  reelsTab: {
    // Real IG uses a single `profile_tab_icon_view` per tab (Grid | Reels | Photos-of-you)
    // — the one with content-desc="Reels" is what we want. The `labels: ['reels']`
    // matcher below catches it via the content-desc; the rids here stay as extras.
    rids: [
      'profile_tab_icon_view', 'profile_tab_icon_view_reels', 'row_profile_tab_reels', 'reels_tab',
    ],
    labels: ['reels'],
  },
  // The REELS chip on the search results page — a different control from the
  // profile's Reels sub-tab above, and the one that turns a keyword query into
  // content results. Without tapping it IG answers a keyword with ACCOUNTS whose
  // handle matched the string, which is not what the keyword was asking for.
  searchReelsTab: {
    rids: [
      'serp_tab_reels', 'search_tab_reels', 'serp_journey_header_tab_reels',
      'tab_bar_reels', 'clips_tab',
    ],
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
    // The "send to a friend" button in a reel — direct_share_button on current
    // IG. NOT the multi-step Repost, which is a separate control.
    rids: ['direct_share_button', 'share_button', 'feed_button_share', 'reel_share_button', 'clips_share'],
    labels: ['share', 'send'],
  },
  // The tap target that opens a reel's creator profile from the full-screen reel
  // player. Enables the reels-first search flow (search → tap a reel → open the
  // author profile) that current IG surfaces by default for keyword queries.
  authorProfile: {
    rids: ['clips_author_info_component', 'clips_author_username', 'clips_author_profile_pic'],
    labels: [],
  },
};

// Instagram throws these when it thinks activity is automated — the cue to stop
// engaging immediately and back off.
const ACTION_BLOCK_RE =
  /action blocked|try again later|we restrict|temporarily blocked|restrict(?:ed)? (?:certain|some) activity|please wait a few (?:minutes|moments)/i;

// ── captured-data extractors ────────────────────────────────────────────────

function extractProfile(elements) {
  const out = { username: null, fullName: null, followers: null, bio: null, category: null };

  const title = findByRid(elements, ['action_bar_title', 'action_bar_large_title', 'title']);
  if (title && looksLikeHandle(title.text)) out.username = norm(title.text).replace(/^@/, '');

  // Real IG (2024+) rid is `profile_header_full_name_above_vanity`; older/synthetic
  // fixtures use `profile_header_full_name`. Both work.
  const fullNameEl = findByRid(elements, [
    'profile_header_full_name_above_vanity', 'profile_header_full_name', 'full_name',
  ]);
  if (fullNameEl && fullNameEl.text) out.fullName = String(fullNameEl.text).trim();

  // Business/category chip that sits just above the bio on many profiles.
  const catEl = findByRid(elements, ['profile_header_business_category']);
  if (catEl && catEl.text) out.category = String(catEl.text).trim();

  // Bio has no resource-id on current IG; it's a plain TextView, usually
  // multi-line, sitting inside the profile header. Prefer a rid'd bio (older
  // fixtures), then the "no-rid, multi-line" TextView within the header y-band.
  const bioEl = findByRid(elements, ['profile_header_bio_text', 'profile_header_bio', 'bio_text']);
  if (bioEl && bioEl.text) {
    out.bio = String(bioEl.text).trim();
  } else {
    const header = findByRid(elements, ['profile_header_container']);
    const headerTop = header && header.bounds ? header.bounds.y : 0;
    const headerBot = header && header.bounds ? header.bounds.y + header.bounds.h : Infinity;
    const bio = elements.find(
      (e) =>
        !e.rid &&
        /textview/i.test(String(e.cls || '')) &&
        e.text && (e.text.includes('\n') || e.text.includes('@')) &&
        e.bounds && e.bounds.y >= headerTop && e.bounds.y <= headerBot,
    );
    if (bio) out.bio = String(bio.text).trim();
  }

  // Followers: prefer the explicit count node; else parse the accessibility
  // description like "19.5Kfollowers" (real IG glues the count + label);
  // else fall back to a "<n> followers" label anywhere in the header.
  const followersEl = findByRid(elements, [
    'profile_header_familiar_followers_value',
    'followers_count',
    'row_profile_header_textview_followers_count',
  ]);
  if (followersEl && (followersEl.text || followersEl.desc)) {
    out.followers = parseCount(followersEl.text || followersEl.desc);
  } else {
    const stacked = findByRid(elements, ['profile_header_followers_stacked_familiar']);
    const stackedDesc = stacked && stacked.desc;
    if (stackedDesc) {
      const m = stackedDesc.match(/([\d][\d.,]*\s*[kmb]?)\s*followers?/i);
      if (m) out.followers = parseCount(m[1]);
    }
    if (out.followers == null) {
      const labelled = elements.find((e) => /followers?\b/i.test(textAndDesc(e)));
      if (labelled) out.followers = parseCount(labelled.text || labelled.desc);
    }
  }
  return out;
}

// Tappable reel cells on a profile's Reels grid, in grid order.
//
// Separate from extractReels (which reads the view counts): to hand a reel's
// VIDEO to the Gemini judge the navigator has to open one, and that needs a
// coordinate. Cells are matched on the clip/reel hint in their resource-id or
// content-desc, then ordered top-to-bottom, left-to-right so `reelCell:0` is
// the creator's most recent reel.
function extractReelCells(elements) {
  const CELL_HINT = /clips_grid|reel_item|clip_thumbnail|media_thumbnail|grid_card_layout_container/i;
  const cells = [];
  for (const e of elements) {
    if (!isClickable(e)) continue;
    const hint = `${ridLocal(e.rid)} ${norm(e.desc)}`;
    if (!CELL_HINT.test(ridLocal(e.rid)) && !/^reel\b/i.test(String(e.desc || '').trim())) continue;
    if (!CELL_HINT.test(hint) && !/^reel\b/i.test(String(e.desc || '').trim())) continue;
    const c = center(e.bounds);
    if (!c) continue;
    cells.push({ y: e.bounds.y, x: e.bounds.x, point: c });
  }
  cells.sort((a, b) => (a.y - b.y) || (a.x - b.x));

  const targets = {};
  cells.forEach((cell, i) => { targets[`reelCell:${i}`] = cell.point; });
  return { count: cells.length, targets };
}

// Reels tab: each reel thumbnail carries a view-count overlay. Collect the
// count-shaped text/desc nodes and parse them; gate on reels.length happens in
// the scoring rules, so returning only cleanly-read counts is correct.
function extractReels(elements) {
  const reels = [];
  // Only look at elements whose rid or desc hints at "reel/clip/video" — this
  // is what keeps like_count / comment_count / save_count texts (also on the
  // reel-feed screen and shaped like numbers) from being mistaken for views.
  const REEL_HINT = /reel|clip|video|play_count|preview_clip_play_count/i;
  // Real IG desc patterns are either "View Count 1.2M" or "1.2M views" — this
  // regex accepts both; the number cannot end in a period (so "42943. View
  // likes" from the like_count desc no longer sneaks in).
  const VIEWS_RE =
    /view\s*count[^\d]{0,3}(\d[\d,]*(?:\.\d+)?\s*[kmb]?)\b|(\d[\d,]*(?:\.\d+)?\s*[kmb]?)\s+views?\b/i;
  for (const e of elements) {
    const desc = String(e.desc || '');
    if (!REEL_HINT.test(ridLocal(e.rid) + ' ' + desc)) continue;
    // 1) counts embedded in the desc: "Reel by X. View Count 2.4M. Double tap..."
    const m = desc.match(VIEWS_RE);
    if (m) {
      const v = parseCount(m[1] || m[2]);
      if (Number.isFinite(v)) { reels.push({ views: v }); continue; }
    }
    // 2) bare count in the text of a reel/clip overlay (preview_clip_play_count).
    if (looksLikeCount(e.text)) {
      const v = parseCount(e.text);
      if (Number.isFinite(v)) reels.push({ views: v });
    }
  }
  // Dedupe: on current IG a reel's view count often appears twice — once inside
  // the parent container's content-desc ("...View Count 17K...") and again as
  // the bare-text of the inner preview_clip_play_count overlay. Keep first-seen.
  // Small risk of losing a genuine twin count; a reel is one of many signals.
  const seen = new Set();
  return reels.filter((r) => {
    if (seen.has(r.views)) return false;
    seen.add(r.views);
    return true;
  });
}

// Search results: on the "Accounts" chip, IG shows rows carrying a handle-shaped
// text; on the "For you" chip, IG shows a REEL grid where each card's author
// name lives only in the content-desc ("Reel by <Author Name> at row X, col Y").
// Extract each: `results` (handles you can tap into a profile) + `reelResults`
// (reel-card tap targets whose author is a display name, not a handle).
function extractReelResults(elements) {
  const reelResults = [];
  const targets = {};
  for (const e of elements) {
    if (!isClickable(e)) continue;
    if (!/grid_card_layout_container/.test(ridLocal(e.rid))) continue;
    const m = String(e.desc || '').match(/^\s*Reel by\s+(.+?)\s+at row\s+\d+,\s*column\s+\d+/i);
    if (!m) continue;
    const author = m[1].trim();
    const c = center(e.bounds);
    if (!c) continue;
    const idx = reelResults.length;
    reelResults.push({ index: idx, author });
    targets[`reelResult:${idx}`] = c;
  }
  return { reelResults, targets };
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
  // Priority match: try the specific author-username rid FIRST so a container
  // like `clips_author_info_component` (empty text, matches broader 'author')
  // doesn't win over the actual username field.
  const authorEl =
    findByRidPriority(elements, ['clips_author_username', 'reel_feed_username', 'clips_username', 'feed_username']) ||
    elements.find((e) => isClickable(e) && looksLikeHandle(e.text));
  const author = authorEl && looksLikeHandle(authorEl.text) ? norm(authorEl.text).replace(/^@/, '') : null;

  // Caption: current IG's caption text lives in a nested content-desc on an
  // anonymous ViewGroup INSIDE clips_caption_component, not on the .text of the
  // component itself. Prefer .text if present (old fixtures / other builds);
  // otherwise find the desc-bearing element within the caption's y-band.
  const captionEl = findByRid(elements, ['clips_caption', 'reel_caption', 'caption']);
  let caption = null;
  if (captionEl) {
    if (captionEl.text) {
      caption = String(captionEl.text).trim();
    } else if (captionEl.bounds) {
      const { y, h } = captionEl.bounds;
      const inner = elements.find(
        (e) =>
          e !== captionEl && e.desc && e.bounds &&
          e.bounds.y >= y && e.bounds.y + e.bounds.h <= y + h + 10,
      );
      if (inner && inner.desc) caption = String(inner.desc).trim();
    }
  }

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

  // Profile — dominant over reels_tab: if the action bar shows a handle AND we
  // see the profile header container, this is a profile (even when the Reels
  // sub-tab is active and reel view overlays are visible; we still want the
  // header data extracted). Falls back to the older followers+tabs heuristic
  // so the synthetic test fixtures continue to pass.
  const title = findByRid(elements, ['action_bar_title', 'action_bar_large_title', 'title']);
  const hasProfileContainer = !!findByRid(elements, ['profile_header_container']);
  if (title && looksLikeHandle(title.text) && hasProfileContainer) return 'profile';
  const hasFollowers = elements.some((e) => /followers?\b/i.test(textAndDesc(e)));
  const hasProfileTabs = !!resolveTarget(elements, SIGNALS.reelsTab);
  if (hasFollowers && hasProfileTabs) return 'profile';

  // Search results (SERP): IG's dedicated results page has a `serp_journey_header_*`
  // frame regardless of which chip (For you / Accounts / Audio / Tags) is active.
  // Classify here BEFORE reels_tab, otherwise the "For you" reels grid would
  // steal the classification via its preview_clip_play_count overlays.
  const hasSerpHeader = !!findByRid(elements, ['serp_journey_header_container', 'serp_journey_header_query_text']);
  if (hasSerpHeader) return 'search_results';

  const hasReelOverlays = extractReels(elements).length >= 2;
  const reelsTabSelected = elements.some(
    (e) => labelOf(e) === 'reels' && (e.selected === true || e.selected === 'true'),
  );
  if (hasReelOverlays || reelsTabSelected) return 'reels_tab';

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
  if (screen === 'search_results') add('searchReelsTab', SIGNALS.searchReelsTab);

  const reading = { screen, targets };

  if (screen === 'search_results') {
    const { results, targets: rt } = extractResults(elements);
    reading.results = results;
    Object.assign(targets, rt);
    // Also expose the reel-grid cards (the "For you" chip on the SERP): each
    // carries the display name of an author whose reel is shown. Tapping opens
    // the reel — where the @handle becomes readable via the reels_feed reader.
    const { reelResults, targets: rrt } = extractReelResults(elements);
    if (reelResults.length) {
      reading.reelResults = reelResults;
      Object.assign(targets, rrt);
    }
  } else if (screen === 'profile') {
    const p = extractProfile(elements);
    reading.fullName = p.fullName;
    reading.followers = p.followers;
    reading.bio = p.bio;
    reading.category = p.category || null;
    if (p.username) reading.username = p.username;
    // A profile with the Reels sub-tab active shows reel view overlays too —
    // surface them so the navigator gets one hop's worth of scoring data for
    // free (Rule 2/4/5 don't require a separate reels_tab visit in that case).
    const reels = extractReels(elements);
    if (reels.length) reading.reels = reels;
    const cells = extractReelCells(elements);
    if (cells.count) {
      reading.reelCells = cells.count;
      Object.assign(targets, cells.targets);
    }
  } else if (screen === 'reels_tab') {
    reading.reels = extractReels(elements);
    const cells = extractReelCells(elements);
    if (cells.count) {
      reading.reelCells = cells.count;
      Object.assign(targets, cells.targets);
    }
  } else if (screen === 'reels_feed') {
    const feed = extractFeed(elements);
    reading.author = feed.author;
    reading.caption = feed.caption;
    reading.alreadyLiked = feed.alreadyLiked;
    reading.alreadySaved = feed.alreadySaved;
    add('like', SIGNALS.like);
    add('save', SIGNALS.save);
    add('share', SIGNALS.share);
    add('authorProfile', SIGNALS.authorProfile);
  }

  return reading;
}

module.exports = {
  readScreen,
  classifyScreen,
  extractProfile,
  extractReels,
  extractResults,
  extractReelResults,
  extractFeed,
  resolveTarget,
  findByRidPriority,
  center,
  looksLikeHandle,
  looksLikeCount,
  SIGNALS,
  ACTION_BLOCK_RE,
};
