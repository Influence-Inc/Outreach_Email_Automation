'use strict';

// IosDriver — implements the DeviceDriver contract on a real iPhone through
// Appium's XCUITest driver + WebDriverAgent (Apple's sanctioned test agent).
//
// The AndroidDriver counterpart lives next to this file; the two are deliberately
// symmetrical so the same {screenshot, tap, swipe, typeText, openApp, home}
// contract lets the navigator + main loop run unchanged against either phone.
//
// The iOS host MUST be a Mac (Xcode is required to build/sign WDA), and the WDA
// signature has to be refreshed periodically — see runner/README.md for the
// full one-time setup.
//
// The webdriverio dependency is an OPTIONAL dependency (see runner/package.json)
// so `npm install` succeeds on a developer machine that only wants the mock;
// instantiating this class requires the module to actually be present.

const { DeviceDriver } = require('./base');
const { IG_IOS_BUNDLE } = require('../navigator/instagram');

class IosDriver extends DeviceDriver {
  constructor({
    appiumUrl = 'http://127.0.0.1:4723',
    udid = null,
    deviceName = null,
    xcodeOrgId = null,
    xcodeSigningId = 'iPhone Developer',
    remote,
  } = {}) {
    super();
    if (!remote) {
      try { remote = require('webdriverio').remote; }
      catch (err) {
        throw new Error(
          `IosDriver requires the optional 'webdriverio' dependency. ` +
            `Install it with: cd runner && npm install webdriverio. ` +
            `Original error: ${err.message}`,
        );
      }
    }
    const u = new URL(appiumUrl);
    this._remote = remote;
    // iOS capabilities are a strict superset of Android's for our purposes:
    // xcodeOrgId + xcodeSigningId tell Appium's XCUITest driver how to (re)sign
    // WebDriverAgent when it launches on the phone. deviceName is what shows up
    // in Xcode's device list. udid pins us to a specific iPhone when several
    // are paired to the Mac.
    this._opts = {
      protocol: u.protocol.replace(':', ''),
      hostname: u.hostname,
      port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname === '/' ? '/wd/hub' : u.pathname,
      logLevel: 'warn',
      capabilities: {
        platformName: 'iOS',
        'appium:automationName': 'XCUITest',
        'appium:bundleId': IG_IOS_BUNDLE,
        'appium:noReset': true,
        ...(udid ? { 'appium:udid': udid } : {}),
        ...(deviceName ? { 'appium:deviceName': deviceName } : {}),
        ...(xcodeOrgId ? { 'appium:xcodeOrgId': xcodeOrgId } : {}),
        ...(xcodeSigningId ? { 'appium:xcodeSigningId': xcodeSigningId } : {}),
      },
    };
    this.session = null;
  }

  async _ensureSession() {
    if (!this.session) this.session = await this._remote(this._opts);
    return this.session;
  }

  // takeScreenshot is a W3C-standard endpoint and behaves identically to Android:
  // returns a base64 PNG.
  async screenshot() {
    const s = await this._ensureSession();
    const b64 = await s.takeScreenshot();
    return { data: Buffer.from(b64, 'base64'), mediaType: 'image/png' };
  }

  // Pointer actions are the W3C standard, so the exact sequence works on iOS too
  // — this is what lets the shared navigator drive both phones without knowing
  // which one it's on.
  async tap(x, y) {
    const s = await this._ensureSession();
    await s.performActions([{
      type: 'pointer', id: 'finger', parameters: { pointerType: 'touch' },
      actions: [
        { type: 'pointerMove', duration: 0, x, y },
        { type: 'pointerDown', button: 0 },
        { type: 'pause', duration: 60 },
        { type: 'pointerUp', button: 0 },
      ],
    }]);
    await s.releaseActions();
  }

  async swipe({ x1, y1, x2, y2, durationMs = 200 }) {
    const s = await this._ensureSession();
    await s.performActions([{
      type: 'pointer', id: 'finger', parameters: { pointerType: 'touch' },
      actions: [
        { type: 'pointerMove', duration: 0, x: x1, y: y1 },
        { type: 'pointerDown', button: 0 },
        { type: 'pointerMove', duration: durationMs, x: x2, y: y2 },
        { type: 'pointerUp', button: 0 },
      ],
    }]);
    await s.releaseActions();
  }

  // XCUITest's `mobile: type` types into whichever field currently has focus, so
  // the caller (the navigator) taps the search box first and this just puts
  // characters in — identical shape to the Android driver.
  async typeText(text) {
    const s = await this._ensureSession();
    await s.execute('mobile: type', { text });
  }

  // iOS doesn't have a "home key"; XCUITest exposes `mobile: pressButton` for
  // hardware buttons — 'home' is a valid button on devices with one and a
  // safe no-op on notch/Face-ID devices where XCUITest emulates the gesture.
  async home() {
    const s = await this._ensureSession();
    await s.execute('mobile: pressButton', { name: 'home' });
  }

  async openApp(bundleId = IG_IOS_BUNDLE) {
    const s = await this._ensureSession();
    await s.execute('mobile: launchApp', { bundleId });
  }

  async close() {
    if (this.session) {
      try { await this.session.deleteSession(); } catch (_) { /* ignore */ }
      this.session = null;
    }
  }

  // Device pixel size for the live mirror's click normalization (see the
  // AndroidDriver counterpart for context).
  async getWindowSize() {
    const s = await this._ensureSession();
    const r = await s.getWindowSize();
    return { width: r && r.width, height: r && r.height };
  }
}

module.exports = { IosDriver };
