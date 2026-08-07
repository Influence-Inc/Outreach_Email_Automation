'use strict';

// RealScreenReader — the runner-side half of the server-side vision reader.
//
// The paired host is a thin pair of hands + eyes: this reader captures the
// current screen's UI-element tree (via the driver's `dumpUi`) plus the device
// pixel size, and asks the Deal Studio backend to INTERPRET them into the
// navigator's reading ({screen, targets, results, profile fields, reels}). All
// interpretation logic lives on the backend (services/screenVision.js), so the
// host never needs a code update when scouting logic changes — that's the whole
// point of "the backend takes over the phone".
//
// Replaces the abstract `ScreenReader` stub (which threw `not implemented`) for
// real Android runs. On any failure it degrades to `screen: 'unknown'` so the
// navigator falls back to a hardware Back / a human take-over via the live
// mirror, instead of crashing the whole standing run.

const { ScreenReader } = require('../navigator/screenReader');

class RealScreenReader extends ScreenReader {
  constructor({ driver, backend, logger = console } = {}) {
    super();
    if (!driver || typeof driver.dumpUi !== 'function') {
      throw new Error('RealScreenReader requires a driver with dumpUi()');
    }
    if (!backend || typeof backend.readScreen !== 'function') {
      throw new Error('RealScreenReader requires a backend with readScreen()');
    }
    this.driver = driver;
    this.backend = backend;
    this.logger = logger;
    this._dims = null; // device size is constant for a run — cache it.
  }

  async _dimensions() {
    if (this._dims) return this._dims;
    try {
      const size = this.driver.getWindowSize ? await this.driver.getWindowSize() : null;
      if (size && size.width) this._dims = size;
    } catch (_) {
      /* fall through to unknown dims */
    }
    return this._dims || { width: null, height: null };
  }

  // The navigator passes the screenshot it just captured; Phase 1 interpretation
  // is element-tree based so we don't need the pixels here, but the signature is
  // kept so the navigator stays agnostic to which reader it's talking to.
  async read(_shot) {
    try {
      const elements = await this.driver.dumpUi();
      const { width, height } = await this._dimensions();
      const reading = await this.backend.readScreen({ elements, width, height });
      if (reading && typeof reading === 'object') {
        return { targets: {}, ...reading };
      }
    } catch (err) {
      const write = this.logger.warn || this.logger.log;
      write.call(this.logger, '[screen-reader]', (err && err.message) || String(err));
    }
    return { screen: 'unknown', targets: {} };
  }
}

module.exports = { RealScreenReader };
