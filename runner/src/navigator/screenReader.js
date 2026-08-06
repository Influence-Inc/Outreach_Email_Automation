'use strict';

// Turns a screenshot (as returned by DeviceDriver.screenshot) into the structured
// data the navigator needs to make decisions:
//   read({ data }) -> { screen, targets, ... }
//
// `screen` is a coarse label ('search' | 'results' | 'profile' | 'reels_tab' | ...)
// `targets` maps semantic names to on-screen coordinates: { searchBox, back, reelsTab, ... }
// Result may also carry captured data (@handle, followers, bio, reels[]).
//
// In production this delegates to a vision model (Claude via services/claudeClient
// on the backend, or a local OCR). In tests we inject `MockScreenReader` that maps
// the mock-driver's `screenName` back to a canned reading — the navigator never
// knows which one it's talking to.

class ScreenReader {
  async read(_shot) { throw new Error('not implemented'); }
}

// Test-only: reads the mock driver's screenshot metadata (screenName encoded in
// the screenshot's data) and returns whatever the fixture attached under that
// name in the `readings` map.
class MockScreenReader extends ScreenReader {
  constructor(readings) {
    super();
    this.readings = readings || {};
  }
  async read(shot) {
    const name = (shot && shot.screenName) || (shot && shot.data && shot.data.toString('utf8')) || '';
    const r = this.readings[name];
    if (!r) return { screen: 'unknown', targets: {} };
    return { screen: name, targets: {}, ...r };
  }
}

module.exports = { ScreenReader, MockScreenReader };
