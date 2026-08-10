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
  assert.ok(r.reels && r.reels.length >= 6, 'reels grid surfaced under active Reels sub-tab');
  assert.ok(r.reels.some((x) => x.views === 2400000), 'reel view counts parsed (2.4M)');
  assert.ok(r.targets.back && r.targets.reelsTab, 'nav + Reels-tab targets present');
});
