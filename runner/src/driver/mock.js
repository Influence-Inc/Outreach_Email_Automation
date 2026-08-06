'use strict';

// MockDriver: replays a scripted sequence of "screens" through the DeviceDriver
// interface, so the whole navigator + runner main loop is exercisable in CI
// without any phone. Every tap/swipe/typeText is recorded; the caller reads back
// `history` to assert flow (in tests).
//
// The scripted screens live on `screens` as an array of { name, screenshot }.
// A MockScreenReader (see navigator/screenReader.js) matches `screen.name` to
// return structured data — that decoupling lets the navigator make the exact
// same tap-decisions a real Claude/OCR reader would, without any actual vision.

const { DeviceDriver } = require('./base');

class MockDriver extends DeviceDriver {
  constructor({ screens = [] } = {}) {
    super();
    this.screens = screens;
    this.history = [];
    this.idx = 0;
  }
  currentScreen() { return this.screens[this.idx] || null; }
  advance(step = 1) { this.idx = Math.min(this.idx + step, this.screens.length); }
  async screenshot() {
    const s = this.currentScreen();
    const data = s ? Buffer.from(String(s.name || '')) : Buffer.alloc(0);
    return { data, mediaType: 'image/png', screenName: s ? s.name : null };
  }
  async tap(x, y) { this.history.push({ op: 'tap', x, y, on: this.currentScreen()?.name }); this._maybeAdvanceOn('tap'); }
  async swipe(opts) { this.history.push({ op: 'swipe', ...opts, on: this.currentScreen()?.name }); this._maybeAdvanceOn('swipe'); }
  async typeText(text) { this.history.push({ op: 'type', text, on: this.currentScreen()?.name }); this._maybeAdvanceOn('type'); }
  async home() { this.history.push({ op: 'home' }); }
  async openApp(id) { this.history.push({ op: 'openApp', id }); this._maybeAdvanceOn('openApp'); }
  _maybeAdvanceOn(op) {
    // The current screen may declare `advanceOn: 'tap'|'swipe'|...` to script
    // the flow; unspecified stays put so a caller can capture from one screen
    // multiple times.
    const s = this.currentScreen();
    if (s && s.advanceOn === op) this.advance();
  }
}

module.exports = { MockDriver };
