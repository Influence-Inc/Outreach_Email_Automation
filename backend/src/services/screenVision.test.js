'use strict';

// Run with: npm test  (node --test)
//
// Two layers of fixtures:
//   1. Synthetic node-arrays that exercise each classification / extractor path.
//   2. Real Instagram `uiautomator dump` XML from a paired device (in
//      __fixtures__/), so a live-IG UI change that breaks calibration fails a
//      test loudly instead of silently returning `screen: unknown` in prod.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const sv = require('./screenVision');
const { parseUiXml } = require('../../../runner/src/driver/android');
const FIX = (name) => parseUiXml(fs.readFileSync(path.join(__dirname, '__fixtures__', name), 'utf8'));

const bounds = (x, y, w, h) => ({ x, y, w, h });

test('classifies an empty search screen and locates the search box', () => {
  const elements = [
    {
      rid: 'com.instagram.android:id/action_bar_search_edit_text',
      cls: 'android.widget.EditText',
      text: '',
      desc: 'Search input',
      clickable: true,
      bounds: bounds(60, 100, 900, 80),
    },
  ];
  const r = sv.readScreen({ elements, width: 1080, height: 2400 });
  assert.strictEqual(r.screen, 'search');
  assert.deepStrictEqual(r.targets.searchBox, { x: 510, y: 140 });
});

test('reads a search-results screen: ordered handles + a tap target per row', () => {
  const elements = [
    {
      rid: 'com.instagram.android:id/action_bar_search_edit_text',
      cls: 'android.widget.EditText',
      text: 'home gym',
      desc: 'Search input',
      clickable: true,
      bounds: bounds(60, 100, 900, 80),
    },
    {
      rid: 'com.instagram.android:id/row_search_user_username',
      cls: 'android.widget.TextView',
      text: 'home.fit.mia',
      clickable: true,
      bounds: bounds(100, 200, 400, 60),
    },
    {
      rid: 'com.instagram.android:id/row_search_user_username',
      cls: 'android.widget.TextView',
      text: 'garage.gains',
      clickable: true,
      bounds: bounds(100, 280, 400, 60),
    },
    {
      rid: 'com.instagram.android:id/action_bar_button_back',
      desc: 'Back',
      clickable: true,
      bounds: bounds(10, 100, 60, 60),
    },
  ];
  const r = sv.readScreen({ elements });
  assert.strictEqual(r.screen, 'search_results');
  assert.deepStrictEqual(r.results, ['home.fit.mia', 'garage.gains']);
  assert.deepStrictEqual(r.targets['result:home.fit.mia'], { x: 300, y: 230 });
  assert.deepStrictEqual(r.targets.back, { x: 40, y: 130 });
});

test('does not mistake a display name (spaces/capitals) for a handle', () => {
  const elements = [
    {
      rid: 'com.instagram.android:id/action_bar_search_edit_text',
      cls: 'android.widget.EditText',
      text: 'x',
      desc: 'Search input',
      clickable: true,
      bounds: bounds(60, 100, 900, 80),
    },
    {
      rid: 'com.instagram.android:id/row_search_user_fullname',
      cls: 'android.widget.TextView',
      text: 'Mia Fitness Coach',
      bounds: bounds(100, 200, 400, 40),
    },
    {
      rid: 'com.instagram.android:id/row_search_user_username',
      cls: 'android.widget.TextView',
      text: 'home.fit.mia',
      clickable: true,
      bounds: bounds(100, 240, 400, 40),
    },
  ];
  const r = sv.readScreen({ elements });
  assert.deepStrictEqual(r.results, ['home.fit.mia']);
});

test('reads a profile header: username, full name, followers, bio + reels tab', () => {
  const elements = [
    { rid: 'com.instagram.android:id/action_bar_title', cls: 'android.widget.TextView', text: 'home.fit.mia', bounds: bounds(200, 40, 300, 50) },
    { rid: 'com.instagram.android:id/profile_header_full_name', cls: 'android.widget.TextView', text: 'Mia Fit', bounds: bounds(60, 300, 400, 50) },
    { rid: 'com.instagram.android:id/row_profile_header_textview_followers_count', cls: 'android.widget.TextView', text: '84.2K', desc: '84,214 followers', bounds: bounds(300, 400, 120, 40) },
    { rid: 'com.instagram.android:id/profile_header_bio_text', cls: 'android.widget.TextView', text: 'home fitness coach', bounds: bounds(60, 460, 600, 60) },
    { rid: 'com.instagram.android:id/profile_tab_icon_view_reels', desc: 'Reels', clickable: true, bounds: bounds(360, 560, 120, 80) },
    { rid: 'com.instagram.android:id/action_bar_button_back', desc: 'Back', clickable: true, bounds: bounds(10, 40, 60, 60) },
  ];
  const r = sv.readScreen({ elements });
  assert.strictEqual(r.screen, 'profile');
  assert.strictEqual(r.username, 'home.fit.mia');
  assert.strictEqual(r.fullName, 'Mia Fit');
  assert.strictEqual(r.followers, 84200);
  assert.strictEqual(r.bio, 'home fitness coach');
  assert.deepStrictEqual(r.targets.reelsTab, { x: 420, y: 600 });
});

test('reads reel view counts off the reels tab (desc "N views" + bare overlay)', () => {
  const elements = [
    { rid: 'com.instagram.android:id/clips_video_thumbnail_view', desc: 'Reel by home.fit.mia. 120K views.', bounds: bounds(0, 200, 360, 640) },
    { rid: 'com.instagram.android:id/clips_video_thumbnail_view', desc: 'Reel by home.fit.mia. 98.4K views.', bounds: bounds(360, 200, 360, 640) },
    { rid: 'com.instagram.android:id/clips_view_count', cls: 'android.widget.TextView', text: '45,000', desc: '', bounds: bounds(740, 780, 80, 30) },
    { rid: 'com.instagram.android:id/action_bar_button_back', desc: 'Back', clickable: true, bounds: bounds(10, 40, 60, 60) },
  ];
  const r = sv.readScreen({ elements });
  assert.strictEqual(r.screen, 'reels_tab');
  assert.deepStrictEqual(r.reels.map((x) => x.views), [120000, 98400, 45000]);
});

test('reads a full-screen reel: author, caption, engagement targets', () => {
  const elements = [
    { rid: 'com.instagram.android:id/clips_username', cls: 'android.widget.TextView', text: 'home.fit.mia', clickable: true, bounds: bounds(60, 1800, 300, 50) },
    { rid: 'com.instagram.android:id/clips_caption', cls: 'android.widget.TextView', text: 'home gym day', bounds: bounds(60, 1860, 900, 80) },
    { rid: 'com.instagram.android:id/like_button', desc: 'Like', clickable: true, bounds: bounds(1000, 1000, 60, 60) },
    { rid: 'com.instagram.android:id/save_button', desc: 'Save', clickable: true, bounds: bounds(1000, 1200, 60, 60) },
    { rid: 'com.instagram.android:id/share_button', desc: 'Share', clickable: true, bounds: bounds(1000, 1100, 60, 60) },
  ];
  const r = sv.readScreen({ elements });
  assert.strictEqual(r.screen, 'reels_feed');
  assert.strictEqual(r.author, 'home.fit.mia');
  assert.strictEqual(r.caption, 'home gym day');
  assert.deepStrictEqual(r.targets.like, { x: 1030, y: 1030 });
  assert.deepStrictEqual(r.targets.save, { x: 1030, y: 1230 });
  assert.strictEqual(r.alreadyLiked, false);
});

test('detects an already-liked reel (Unlike) so engagement never toggles it off', () => {
  const elements = [
    { rid: 'com.instagram.android:id/clips_username', text: 'joe', clickable: true, bounds: bounds(60, 1800, 200, 50) },
    { rid: 'com.instagram.android:id/like_button', desc: 'Unlike', clickable: true, bounds: bounds(1000, 1000, 60, 60) },
    { rid: 'com.instagram.android:id/share_button', desc: 'Share', clickable: true, bounds: bounds(1000, 1100, 60, 60) },
  ];
  const r = sv.readScreen({ elements });
  assert.strictEqual(r.screen, 'reels_feed');
  assert.strictEqual(r.alreadyLiked, true);
});

test('classifies an Instagram action-block screen (stop engaging)', () => {
  const elements = [
    { cls: 'android.widget.TextView', text: 'Action Blocked', bounds: bounds(100, 100, 800, 60) },
    { cls: 'android.widget.TextView', text: 'We restrict certain activity to protect our community', bounds: bounds(100, 200, 800, 120) },
  ];
  assert.strictEqual(sv.readScreen({ elements }).screen, 'action_blocked');
});

test('unknown screen when nothing matches, with empty targets', () => {
  const r = sv.readScreen({ elements: [{ cls: 'android.view.View', text: '', bounds: bounds(0, 0, 10, 10) }] });
  assert.strictEqual(r.screen, 'unknown');
  assert.deepStrictEqual(r.targets, {});
});

test('readScreen tolerates missing/invalid input', () => {
  assert.strictEqual(sv.readScreen().screen, 'unknown');
  assert.strictEqual(sv.readScreen({ elements: 'nope' }).screen, 'unknown');
});

test('center() computes the pixel midpoint of a bounds box', () => {
  assert.deepStrictEqual(sv.center(bounds(100, 200, 400, 60)), { x: 300, y: 230 });
  assert.strictEqual(sv.center(null), null);
});

test('looksLikeHandle accepts IG handles, rejects names and empties', () => {
  assert.ok(sv.looksLikeHandle('home.fit.mia'));
  assert.ok(sv.looksLikeHandle('@garage_gains'));
  assert.ok(!sv.looksLikeHandle('Mia Fit'));
  assert.ok(!sv.looksLikeHandle(''));
});

// --- Real IG fixtures (locked against future SIGNALS drift) -----------------
// Each was captured from a real device on 2026-08-10 with `adb shell uiautomator
// dump` and lives in __fixtures__/. If Instagram changes the UI enough to break
// these, this file fails — pointing to exactly which reading regressed.

test('real IG SERP for "homegym" -> search_results with reel-grid cards', () => {
  const r = sv.readScreen({ elements: FIX('screen1-results.xml') });
  assert.strictEqual(r.screen, 'search_results');
  assert.ok(r.targets.back, 'has SERP back button target');
  assert.ok(r.targets.searchBox, 'has search-box (edit query) target');
  assert.ok(Array.isArray(r.reelResults) && r.reelResults.length >= 6, 'extracted reel cards');
  assert.deepStrictEqual(r.reelResults[0], { index: 0, author: 'Amar Mujkanovic' });
  assert.ok(r.targets['reelResult:0'], 'per-card tap target');
});

test('real IG profile (Reels sub-tab active) -> profile with full header + reels', () => {
  const r = sv.readScreen({ elements: FIX('screen2-profile.xml') });
  assert.strictEqual(r.screen, 'profile');
  assert.strictEqual(r.username, 'amarmujkanovicc');
  assert.strictEqual(r.fullName, 'Amar Mujkanovic');
  assert.strictEqual(r.followers, 19500);      // parsed from content-desc="19.5Kfollowers"
  assert.strictEqual(r.category, 'Fitness Model');
  assert.match(r.bio, /dfyne\.official athlete/);
  // 6 unique reel view counts on this profile (the deduper drops the twin
  // parent-desc + child-text copies real IG emits for each reel).
  assert.deepStrictEqual(
    r.reels.map((x) => x.views),
    [8706, 17000, 7093, 212000, 2400000, 481000],
  );
  assert.ok(r.targets.back && r.targets.reelsTab, 'nav + Reels-tab targets present');
});

test('real IG full-screen reel -> reels_feed with author, caption, engagement targets', () => {
  const r = sv.readScreen({ elements: FIX('screen4-reel-feed.xml') });
  assert.strictEqual(r.screen, 'reels_feed');
  assert.strictEqual(r.author, 'katrina_pahomova');
  // Caption lives in a nested content-desc on current IG (empty on the caption node itself).
  assert.match(r.caption, /Your hook decides/);
  assert.strictEqual(r.alreadyLiked, false);
  assert.strictEqual(r.alreadySaved, false);
  assert.ok(r.targets.like, 'like button target');
  assert.ok(r.targets.save, 'save button target');
  assert.ok(r.targets.share, 'share (direct_share_button) target');
  assert.ok(r.targets.authorProfile, 'authorProfile target for opening the creator profile from a reel');
  // NEW: the like_count / comment_count / save_count texts must NOT leak into reels.
  assert.strictEqual(r.reels, undefined);
});

// ── telling the three "Reels" controls apart ────────────────────────────────
//
// Instagram labels three separate controls "Reels". Picking whichever matched
// first is what kept landing the scout on the wrong screen, so label alone must
// never decide: the label, where it sits, and which screen we are on all have
// to agree.

const H = 2400;
const W = 1080;

function el(over = {}) {
  return {
    rid: '', cls: 'android.widget.Button', text: '', desc: '',
    clickable: true, selected: false, bounds: { x: 0, y: 0, w: 100, h: 60 },
    ...over,
  };
}

// The row of five icons at the very bottom of the screen.
function bottomNav() {
  return [
    el({ desc: 'Home', bounds: { x: 40, y: 2260, w: 100, h: 100 } }),
    el({ desc: 'Search', bounds: { x: 250, y: 2260, w: 100, h: 100 } }),
    el({ desc: 'Reels', rid: 'com.instagram.android:id/tab_icon_clips', bounds: { x: 460, y: 2260, w: 100, h: 100 } }),
    el({ desc: 'Shop', bounds: { x: 670, y: 2260, w: 100, h: 100 } }),
    el({ desc: 'Profile', bounds: { x: 880, y: 2260, w: 100, h: 100 } }),
  ];
}

test('the bottom-nav Reels button is found by where it sits, not its id', () => {
  const r = sv.readScreen({ elements: bottomNav(), width: W, height: H });
  assert.ok(r.targets.reelsNavTab, 'found the bottom-nav Reels');
  assert.ok(r.targets.reelsNavTab.y > H * 0.88, 'and it is in the nav band');
});

// A profile's sub-tabs carry ids like clips_tab too — matching that id anywhere
// on screen would pick the wrong control.
test('a profile Reels sub-tab is never mistaken for the bottom-nav button', () => {
  const elements = [
    el({ rid: 'com.instagram.android:id/action_bar_title', text: 'mia.codes', clickable: false, bounds: { x: 300, y: 90, w: 400, h: 60 } }),
    el({ rid: 'com.instagram.android:id/profile_header_container', clickable: false, bounds: { x: 0, y: 160, w: W, h: 500 } }),
    el({ desc: '84,000 followers', clickable: false, bounds: { x: 100, y: 400, w: 300, h: 60 } }),
    // mid-screen tab row, above the post grid
    el({ desc: 'Grid', rid: 'com.instagram.android:id/profile_tab_icon_view', bounds: { x: 200, y: 900, w: 120, h: 90 } }),
    el({ desc: 'Reels', rid: 'com.instagram.android:id/profile_tab_icon_view', bounds: { x: 480, y: 900, w: 120, h: 90 } }),
  ];
  const r = sv.readScreen({ elements, width: W, height: H });

  assert.ok(r.targets.reelsTab, 'the profile sub-tab resolved');
  assert.ok(r.targets.reelsTab.y < H * 0.85, 'mid-screen, not the nav bar');
  assert.strictEqual(r.targets.reelsNavTab, undefined, 'no bottom-nav button on this screen');
});

test('the profile Reels sub-tab does not resolve when we are not on a profile', () => {
  // Same mid-screen "Reels" label, but the screen is a reel player.
  const elements = [
    el({ rid: 'com.instagram.android:id/clips_author_username', text: 'mia.codes', bounds: { x: 60, y: 1800, w: 300, h: 60 } }),
    el({ desc: 'Like', rid: 'com.instagram.android:id/like_button', bounds: { x: 980, y: 1500, w: 80, h: 80 } }),
    el({ desc: 'Share', rid: 'com.instagram.android:id/direct_share_button', bounds: { x: 980, y: 1700, w: 80, h: 80 } }),
    el({ desc: 'Reels', bounds: { x: 480, y: 900, w: 120, h: 90 } }),
  ];
  const r = sv.readScreen({ elements, width: W, height: H });

  assert.strictEqual(r.screen, 'reels_feed');
  assert.strictEqual(r.targets.reelsTab, undefined, 'a stray "Reels" label is not a profile tab');
});

// The search filter row: Reels sits beside Accounts / Audio / Tags / Places.
function searchResults(extraRow = []) {
  return [
    el({ rid: 'com.instagram.android:id/action_bar_search_edit_text', text: 'iphone photos', clickable: false, bounds: { x: 100, y: 100, w: 800, h: 80 } }),
    el({ text: 'Top', bounds: { x: 40, y: 260, w: 120, h: 80 } }),
    el({ text: 'Accounts', bounds: { x: 200, y: 260, w: 160, h: 80 } }),
    el({ text: 'Audio', bounds: { x: 400, y: 260, w: 120, h: 80 } }),
    el({ text: 'Reels', rid: 'com.instagram.android:id/serp_tab_reels', bounds: { x: 560, y: 260, w: 120, h: 80 } }),
    el({ text: 'Tags', bounds: { x: 720, y: 260, w: 120, h: 80 } }),
    ...extraRow,
    el({ text: 'mia.codes', clickable: true, bounds: { x: 60, y: 500, w: 400, h: 90 } }),
  ];
}

test('the search results Reels filter resolves on a results page', () => {
  const r = sv.readScreen({ elements: searchResults(), width: W, height: H });

  assert.strictEqual(r.screen, 'search_results');
  assert.ok(r.targets.searchReelsTab, 'found the results filter');
  assert.ok(r.targets.searchReelsTab.y < H * 0.35, 'in the top strip');
});

// Explore is a general-interest surface — creators from it have nothing to do
// with the keyword, so a row offering Explore is the wrong row.
test('a filter row containing Explore is rejected as the wrong row', () => {
  const elements = [
    el({ rid: 'com.instagram.android:id/action_bar_search_edit_text', text: 'iphone photos', clickable: false, bounds: { x: 100, y: 100, w: 800, h: 80 } }),
    el({ text: 'Explore', bounds: { x: 40, y: 260, w: 160, h: 80 } }),
    el({ text: 'Reels', bounds: { x: 240, y: 260, w: 120, h: 80 } }),
    el({ text: 'mia.codes', clickable: true, bounds: { x: 60, y: 500, w: 400, h: 90 } }),
  ];
  const r = sv.readScreen({ elements, width: W, height: H });

  assert.strictEqual(r.targets.searchReelsTab, undefined, 'an Explore row is never the source');
});

test('Explore is never exposed as a target at all', () => {
  const r = sv.readScreen({ elements: searchResults(), width: W, height: H });
  assert.strictEqual(r.targets.exploreTab, undefined);
});

test('the search filter does not resolve away from a results page', () => {
  // The bottom nav alone: a "Reels" label exists, but no results page.
  const r = sv.readScreen({ elements: bottomNav(), width: W, height: H });
  assert.strictEqual(r.targets.searchReelsTab, undefined);
});

// All three labels present at once — the case that used to pick whichever came
// first in the tree.
test('with all three on screen each resolves to its own control', () => {
  const elements = [...searchResults(), ...bottomNav()];
  const r = sv.readScreen({ elements, width: W, height: H });

  assert.ok(r.targets.searchReelsTab, 'results filter');
  assert.ok(r.targets.reelsNavTab, 'bottom nav');
  assert.notStrictEqual(
    r.targets.searchReelsTab.y, r.targets.reelsNavTab.y,
    'they are different controls, not the same element twice',
  );
  assert.ok(r.targets.searchReelsTab.y < H * 0.35);
  assert.ok(r.targets.reelsNavTab.y > H * 0.88);
});

// ── interruptions and ads (§9) ──────────────────────────────────────────────

const node = (over = {}) => ({ rid: '', text: '', desc: '', clickable: false, bounds: { x: 0, y: 0, w: 100, h: 50 }, ...over });

// A sheet swallows the next tap wherever it appears, so it is read on every
// screen rather than being a screen of its own.
test('a modal sheet is reported with somewhere to tap', () => {
  const r = sv.readScreen({
    elements: [
      node({ rid: 'com.instagram.android:id/dialog_container' }),
      node({ text: 'Turn on notifications' }),
      node({ text: 'Turn on', clickable: true, bounds: { x: 100, y: 1700, w: 400, h: 100 } }),
      node({ text: 'Not now', clickable: true, bounds: { x: 100, y: 1850, w: 400, h: 100 } }),
    ],
    width: 1080,
    height: 2400,
  });

  assert.strictEqual(r.dialog.label, 'not now');
  assert.deepStrictEqual(r.targets.dismissDialog, { x: 300, y: 1900 });
});

// "Turn on", "Allow" and "Save" agree to the thing the sheet is asking for.
test('the agreeing button is never the one offered', () => {
  const r = sv.readScreen({
    elements: [
      node({ rid: 'bottom_sheet_container' }),
      node({ desc: 'Allow', clickable: true, bounds: { x: 0, y: 1700, w: 200, h: 80 } }),
      node({ desc: 'Not now', clickable: true, bounds: { x: 0, y: 1800, w: 200, h: 80 } }),
    ],
    width: 1080,
    height: 2400,
  });
  assert.strictEqual(r.dialog.label, 'not now');
});

// "Try again" on an error sheet just repeats whatever failed.
test('a retry button is not treated as a way out', () => {
  const r = sv.readScreen({
    elements: [
      node({ rid: 'dialog_container' }),
      node({ text: 'Something went wrong' }),
      node({ text: 'Try again', clickable: true, bounds: { x: 0, y: 1700, w: 200, h: 80 } }),
    ],
    width: 1080,
    height: 2400,
  });
  assert.ok(!r.dialog, 'no dismiss control, so nothing to report');
});

// "Close" appears in plenty of ordinary chrome — a lone one is not a sheet.
test('an ordinary close button is not mistaken for a sheet', () => {
  const r = sv.readScreen({
    elements: [
      node({ rid: 'search_edit_text', clickable: true }),
      node({ desc: 'Close', clickable: true, bounds: { x: 0, y: 100, w: 80, h: 80 } }),
    ],
    width: 1080,
    height: 2400,
  });
  assert.ok(!r.dialog);
});

// An ad, not a creator: opening the account behind it sources a competitor.
test('a sponsored reel is flagged on the feed reading', () => {
  const r = sv.readScreen({
    elements: [
      node({ rid: 'clips_author_username', text: 'somebrand', clickable: true }),
      node({ rid: 'like_button', desc: 'Like', clickable: true }),
      node({ rid: 'direct_share_button', desc: 'Share', clickable: true }),
      node({ text: 'Sponsored' }),
    ],
    width: 1080,
    height: 2400,
  });

  assert.strictEqual(r.screen, 'reels_feed');
  assert.strictEqual(r.sponsored, true);
});

test('a paid partnership is flagged too', () => {
  const r = sv.readScreen({
    elements: [
      node({ rid: 'clips_author_username', text: 'realcreator', clickable: true }),
      node({ rid: 'like_button', desc: 'Like', clickable: true }),
      node({ rid: 'direct_share_button', desc: 'Share', clickable: true }),
      node({ rid: 'paid_partnership_label', text: 'Paid partnership' }),
    ],
    width: 1080,
    height: 2400,
  });
  assert.strictEqual(r.sponsored, true);
});

// A creator saying "not sponsored" in their caption is a creator talking.
test('the word sponsored inside a caption is not an ad label', () => {
  const r = sv.readScreen({
    elements: [
      node({ rid: 'clips_author_username', text: 'honestreviews', clickable: true }),
      node({ rid: 'like_button', desc: 'Like', clickable: true }),
      node({ rid: 'direct_share_button', desc: 'Share', clickable: true }),
      node({ rid: 'clips_caption', text: 'this is not sponsored, I bought it myself' }),
    ],
    width: 1080,
    height: 2400,
  });
  assert.strictEqual(r.sponsored, false);
});

// ── the profile's three tabs share one rid ───────────────────────────────────

// Real IG gives Grid | Reels | Tagged the SAME `profile_tab_icon_view` rid, so
// matching that rid returned whichever came first in the tree — the POSTS grid.
// Post thumbnails carry no view count, which is how live runs reported
// "only 0 reels (need 6)" for creators whose Reels grid was full.
test('the profile Reels tab is found by desc, not by the shared rid', () => {
  const tabs = [
    node({ rid: 'com.instagram.android:id/profile_tab_icon_view', desc: 'Grid', clickable: true, bounds: { x: 100, y: 900, w: 100, h: 100 } }),
    node({ rid: 'com.instagram.android:id/profile_tab_icon_view', desc: 'Reels', clickable: true, bounds: { x: 400, y: 900, w: 100, h: 100 } }),
    node({ rid: 'com.instagram.android:id/profile_tab_icon_view', desc: 'Tagged', clickable: true, bounds: { x: 700, y: 900, w: 100, h: 100 } }),
  ];
  const found = sv.resolveTarget(tabs, sv.SIGNALS.reelsTab);
  assert.strictEqual(found.desc, 'Reels', 'the middle tab, not the first one in the tree');
});

// A substring match on 'reels' would also hit these.
test('a longer desc containing "reels" is not the Reels tab', () => {
  const found = sv.resolveTarget(
    [node({ rid: 'profile_tab_icon_view', desc: 'Reels and clips you shared', clickable: true })],
    sv.SIGNALS.reelsTab,
  );
  assert.strictEqual(found, null);
});

// Current IG's results strip is `For you | Accounts | Audio | Tags` — no Reels
// tab exists, so "For you" is the content tab to aim at.
test('the search results content tab matches "For you"', () => {
  const strip = [
    node({ desc: 'For you', clickable: true, bounds: { x: 100, y: 300, w: 100, h: 60 } }),
    node({ desc: 'Accounts', clickable: true, bounds: { x: 300, y: 300, w: 100, h: 60 } }),
    node({ desc: 'Audio', clickable: true, bounds: { x: 500, y: 300, w: 100, h: 60 } }),
  ];
  const found = sv.resolveTarget(strip, sv.SIGNALS.searchReelsTab);
  assert.strictEqual(found.desc, 'For you');
});

// ── the search-results content tab (the Audio-drift fix) ────────────────────

const serpNode = (over = {}) => node({ bounds: { x: 0, y: 200, w: 200, h: 80 }, ...over });

// IG remembers the last-used tab, so the reader must report which tab is active
// AND expose the For you tab so the navigator can switch back.
test('the reader reports the active search tab and the For you tab', () => {
  const strip = [
    node({ rid: 'serp_journey_header_container', bounds: { x: 0, y: 100, w: 1080, h: 60 } }),
    serpNode({ desc: 'For you', clickable: true, bounds: { x: 40, y: 200, w: 160, h: 70 } }),
    serpNode({ desc: 'Accounts', clickable: true, bounds: { x: 220, y: 200, w: 160, h: 70 } }),
    serpNode({ desc: 'Audio', selected: true, clickable: true, bounds: { x: 400, y: 200, w: 160, h: 70 } }),
    serpNode({ desc: 'Tags', clickable: true, bounds: { x: 580, y: 200, w: 160, h: 70 } }),
  ];
  const r = sv.readScreen({ elements: strip, width: 1080, height: 2400 });

  assert.strictEqual(r.screen, 'search_results');
  assert.strictEqual(r.activeTab, 'audio', 'the Audio tab is the selected one');
  assert.deepStrictEqual(r.targets.forYouTab, { x: 120, y: 235 }, 'and For you is tappable');
});

test('a search sitting on For you reports it as active', () => {
  const strip = [
    node({ rid: 'serp_journey_header_container', bounds: { x: 0, y: 100, w: 1080, h: 60 } }),
    serpNode({ desc: 'For you', selected: true, clickable: true, bounds: { x: 40, y: 200, w: 160, h: 70 } }),
    serpNode({ desc: 'Audio', clickable: true, bounds: { x: 400, y: 200, w: 160, h: 70 } }),
  ];
  const r = sv.readScreen({ elements: strip, width: 1080, height: 2400 });
  assert.strictEqual(r.activeTab, 'for you');
});

// The tab is only a tab in the strip at the top of the page — a stray "For you"
// label lower down (a section header) is not it.
test('the For you tab is only matched in the top strip', () => {
  const el = sv.findForYouTab(
    [node({ desc: 'For you', bounds: { x: 40, y: 1800, w: 160, h: 70 } })],
    2400,
    'search_results',
  );
  assert.strictEqual(el, null);
});

test('the For you tab matches by resource-id too', () => {
  const el = sv.findForYouTab(
    [node({ rid: 'com.instagram.android:id/serp_tab_for_you', bounds: { x: 40, y: 200, w: 160, h: 70 } })],
    2400,
    'search_results',
  );
  assert.ok(el, 'found by rid');
});

// Older builds called it "Top" — still the reel-content tab.
test('the older "Top" label is treated as For you', () => {
  const el = sv.findForYouTab(
    [node({ desc: 'Top', bounds: { x: 40, y: 200, w: 160, h: 70 } })],
    2400,
    'search_results',
  );
  assert.ok(el);
});
