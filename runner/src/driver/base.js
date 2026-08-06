'use strict';

// DeviceDriver contract: the minimal shared surface every phone driver exposes.
// Deliberately tiny so the SAME navigator code runs against a mock or the real
// Android driver (adb only — see driver/android.js). Android-only by design;
// see runner/README.md for why iOS isn't supported here.
//
// A driver must implement:
//   screenshot() -> { data: Buffer, mediaType: 'image/png' }
//   tap(x, y)    -> void
//   swipe({ x1, y1, x2, y2, durationMs }) -> void
//   typeText(text) -> void
//   home()       -> void
//   openApp(bundleId | packageName) -> void
//   close()      -> void
//
// All methods return promises. Coordinates are in device pixels. Nothing here
// touches the network or knows anything about Instagram — that lives in
// navigator/.

class DeviceDriver {
  async screenshot() { throw new Error('not implemented'); }
  async tap(_x, _y) { throw new Error('not implemented'); }
  async swipe(_opts) { throw new Error('not implemented'); }
  async typeText(_text) { throw new Error('not implemented'); }
  async home() { throw new Error('not implemented'); }
  async openApp(_id) { throw new Error('not implemented'); }
  async close() { /* optional */ }
}

module.exports = { DeviceDriver };
