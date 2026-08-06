'use strict';

// Runs the Instagram Navigator against MockDriver + MockScreenReader, verifying
// that a canned "phone flow" yields the expected candidate records without any
// real phone, Appium, or vision model.
//
// Run with: cd runner && npm test

const test = require('node:test');
const assert = require('node:assert');
const { MockDriver } = require('../driver/mock');
const { MockScreenReader } = require('./screenReader');
const { scoutCandidates } = require('./instagram');

// A minimal canned screen sequence that walks: home -> search tab -> typed
// results -> profile A (Reels view) -> back -> profile B -> back.
function buildFixture() {
  // Screens advance in the order the navigator hits them:
  //   home -> [tap searchTab] -> search-empty -> [tap searchBox] -> search-focused
  //   -> [typeText 'gym'] -> search-typed (results) -> [tap coach.a] -> profile-A
  //   -> [tap reelsTab] -> reels-A -> [tap back] -> back-to-results -> [tap coach.b]
  //   -> profile-B -> [tap reelsTab] -> reels-B -> [tap back] -> back-to-results-2
  //   -> [tap back] -> home-again
  const screens = [
    { name: 'home', advanceOn: 'tap' },
    { name: 'search-empty', advanceOn: 'tap' },
    { name: 'search-focused', advanceOn: 'type' },
    { name: 'search-typed', advanceOn: 'tap' },
    { name: 'profile-A', advanceOn: 'tap' },
    { name: 'reels-A', advanceOn: 'tap' },
    { name: 'back-from-A', advanceOn: 'tap' },
    { name: 'profile-B', advanceOn: 'tap' },
    { name: 'reels-B', advanceOn: 'tap' },
    { name: 'back-from-B', advanceOn: 'tap' },
    { name: 'home-again' },
  ];
  const readings = {
    home: { screen: 'home', targets: { searchTab: { x: 100, y: 900 } } },
    'search-empty': { screen: 'search', targets: { searchBox: { x: 200, y: 80 } } },
    'search-focused': { screen: 'search', targets: { searchBox: { x: 200, y: 80 } } },
    'search-typed': {
      screen: 'results',
      targets: {
        'result:coach.a': { x: 200, y: 200 },
        'result:coach.b': { x: 200, y: 300 },
        back: { x: 30, y: 90 },
      },
      results: ['coach.a', 'coach.b'],
    },
    'profile-A': {
      screen: 'profile',
      fullName: 'Coach A',
      followers: 84000,
      bio: 'fitness coach',
      targets: { reelsTab: { x: 400, y: 500 }, back: { x: 30, y: 90 } },
    },
    'reels-A': {
      screen: 'reels_tab',
      reels: Array(12).fill({ views: 120000, caption: 'gym day' }),
      targets: { back: { x: 30, y: 90 } },
    },
    'back-from-A': {
      screen: 'results',
      targets: {
        'result:coach.a': { x: 200, y: 200 },
        'result:coach.b': { x: 200, y: 300 },
        back: { x: 30, y: 90 },
      },
      results: ['coach.a', 'coach.b'],
    },
    'profile-B': {
      screen: 'profile',
      fullName: 'Coach B',
      followers: 41000,
      bio: 'home workouts',
      targets: { reelsTab: { x: 400, y: 500 }, back: { x: 30, y: 90 } },
    },
    'reels-B': {
      screen: 'reels_tab',
      reels: Array(12).fill({ views: 60000, caption: 'workout' }),
      targets: { back: { x: 30, y: 90 } },
    },
    'back-from-B': {
      screen: 'results',
      targets: { back: { x: 30, y: 90 } },
      results: [],
    },
    'home-again': { screen: 'home', targets: { searchTab: { x: 100, y: 900 } } },
  };
  return { screens, readings };
}

test('scoutCandidates walks the mock flow and yields captured profiles', async () => {
  const { screens, readings } = buildFixture();
  const driver = new MockDriver({ screens });
  const reader = new MockScreenReader(readings);

  const out = [];
  for await (const cand of scoutCandidates({
    driver,
    reader,
    config: { pacingMs: 0 },
    opts: { keywords: ['gym'], max: 2 },
  })) {
    out.push(cand);
  }

  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].username, 'coach.a');
  assert.strictEqual(out[0].followers, 84000);
  assert.strictEqual(out[0].reels.length, 12);
  assert.strictEqual(out[1].username, 'coach.b');
  // The navigator opens the app + performs at least one tap and one typeText.
  assert.ok(driver.history.some((h) => h.op === 'openApp'));
  assert.ok(driver.history.some((h) => h.op === 'tap'));
  assert.ok(driver.history.some((h) => h.op === 'type' && h.text === 'gym'));
});

test('scoutCandidates stops early when max is reached', async () => {
  const { screens, readings } = buildFixture();
  const driver = new MockDriver({ screens });
  const reader = new MockScreenReader(readings);
  const out = [];
  for await (const cand of scoutCandidates({
    driver,
    reader,
    config: { pacingMs: 0 },
    opts: { keywords: ['gym'], max: 1 },
  })) {
    out.push(cand);
  }
  assert.strictEqual(out.length, 1);
});
