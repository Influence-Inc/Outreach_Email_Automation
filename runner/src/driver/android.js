'use strict';

// AndroidDriver — implements the DeviceDriver contract on a real Android phone
// through Appium's UiAutomator2 automation. The webdriverio dependency is an
// OPTIONAL dependency (see runner/package.json) so `npm install` succeeds on a
// developer machine that only wants the mock; instantiating this class requires
// the module to actually be present.
//
// This is a Phase-2 skeleton: the {screenshot, tap, swipe, typeText, openApp,
// home} verbs are wired to Appium's stable primitives so the navigator runs
// unchanged against a real phone. Session lifecycle + resilience polish (retries,
// stale-element recovery, live screen mirror) come in Phase 3.

const { DeviceDriver } = require('./base');
const { IG_ANDROID_PACKAGE } = require('../navigator/instagram');

class AndroidDriver extends DeviceDriver {
  constructor({ appiumUrl = 'http://127.0.0.1:4723', udid = null, remote } = {}) {
    super();
    if (!remote) {
      try { remote = require('webdriverio').remote; }
      catch (err) {
        throw new Error(
          `AndroidDriver requires the optional 'webdriverio' dependency. ` +
            `Install it with: npm install --workspace runner webdriverio  (or: cd runner && npm install webdriverio). ` +
            `Original error: ${err.message}`,
        );
      }
    }
    const u = new URL(appiumUrl);
    this._remote = remote;
    this._opts = {
      protocol: u.protocol.replace(':', ''),
      hostname: u.hostname,
      port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname === '/' ? '/wd/hub' : u.pathname,
      logLevel: 'warn',
      capabilities: {
        platformName: 'Android',
        'appium:automationName': 'UiAutomator2',
        'appium:appPackage': IG_ANDROID_PACKAGE,
        'appium:appActivity': 'com.instagram.mainactivity.MainActivity',
        'appium:noReset': true,
        ...(udid ? { 'appium:udid': udid } : {}),
      },
    };
    this.session = null;
  }

  async _ensureSession() {
    if (!this.session) this.session = await this._remote(this._opts);
    return this.session;
  }

  async screenshot() {
    const s = await this._ensureSession();
    const b64 = await s.takeScreenshot();
    return { data: Buffer.from(b64, 'base64'), mediaType: 'image/png' };
  }

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

  async typeText(text) {
    const s = await this._ensureSession();
    // UiAutomator2 exposes mobile:type via a script command that types into the
    // currently focused field, no element lookup required.
    await s.execute('mobile: type', { text });
  }

  async home() {
    const s = await this._ensureSession();
    await s.execute('mobile: pressKey', { keycode: 3 }); // KEYCODE_HOME
  }

  async openApp(pkg = IG_ANDROID_PACKAGE) {
    const s = await this._ensureSession();
    await s.execute('mobile: activateApp', { appId: pkg });
  }

  async close() {
    if (this.session) {
      try { await this.session.deleteSession(); } catch (_) { /* ignore */ }
      this.session = null;
    }
  }
}

module.exports = { AndroidDriver };
