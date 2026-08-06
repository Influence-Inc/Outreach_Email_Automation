'use strict';

// A minimal Instagram-flow fixture used when RUNNER_DRIVER=mock. Pairs a
// MockDriver with a MockScreenReader so the navigator walks the same steps it
// would against a real phone — open search, type a keyword, open one profile,
// read its recent reels, go back — but every "screenshot" is really a canned
// name mapped to a canned reading. Yields exactly ONE candidate so a smoke run
// exercises the whole capture → ingest → score → add-to-campaign pipeline
// end to end without any hardware.
//
// This module exists so the same paths a paired-host runner takes are
// reachable from `npm start` with no Appium and no phone.

const { MockDriver } = require('./driver/mock');
const { MockScreenReader } = require('./navigator/screenReader');

// One profile ("mock.coach") with 12 solidly-passing reels, tagged with the
// caption keyword the smoke-test config uses so keyword niche-match holds even
// without Claude configured. Feel free to tweak numbers when you need to
// exercise a specific gate.
function buildSmokeFixture() {
  const reels = Array(12).fill({ views: 120000, caption: 'gym day' });
  const screens = [
    { name: 'home', advanceOn: 'tap' },
    { name: 'search-empty', advanceOn: 'tap' },
    { name: 'search-focused', advanceOn: 'type' },
    { name: 'search-typed', advanceOn: 'tap' },
    { name: 'profile', advanceOn: 'tap' },
    { name: 'reels', advanceOn: 'tap' },
    { name: 'back-to-results', advanceOn: 'tap' },
    { name: 'home-again' },
  ];
  const readings = {
    home: { targets: { searchTab: { x: 100, y: 900 } } },
    'search-empty': { targets: { searchBox: { x: 200, y: 80 } } },
    'search-focused': { targets: { searchBox: { x: 200, y: 80 } } },
    'search-typed': {
      results: ['mock.coach'],
      targets: {
        'result:mock.coach': { x: 200, y: 220 },
        back: { x: 30, y: 90 },
      },
    },
    profile: {
      fullName: 'Mock Coach',
      followers: 84000,
      bio: 'mock fitness coach — smoke fixture',
      targets: { reelsTab: { x: 400, y: 500 }, back: { x: 30, y: 90 } },
    },
    reels: { reels, targets: { back: { x: 30, y: 90 } } },
    'back-to-results': {
      results: [],
      targets: { back: { x: 30, y: 90 } },
    },
    'home-again': { targets: { searchTab: { x: 100, y: 900 } } },
  };
  return {
    driver: new MockDriver({ screens }),
    reader: new MockScreenReader(readings),
  };
}

module.exports = { buildSmokeFixture };
