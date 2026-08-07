'use strict';

// Backend-side device driver. Each verb is a command sent to the paired host's
// agent over the hostCommands channel; the returned promise settles when the
// agent posts the result. Implements the subset of the runner's DeviceDriver
// contract the server-side navigator (services/sourcingNavigator.js) needs, so
// the navigator code is oblivious to the phone being a network hop away.
//
// The agent (runner in RUNNER_MODE=agent) maps each op back to its local
// AndroidDriver method — the shapes here MUST match what the agent executes:
//   openApp {pkg}   tap {x,y}   swipe {x1,y1,x2,y2,durationMs}   type {text}
//   home {}   dumpUi {} -> elements[]   getWindowSize {} -> {width,height}
//   keepAwake {}   wake {}

const commands = require('./hostCommands');

function makeRemoteDriver({ hostId, channel = commands, timeoutMs } = {}) {
  if (hostId == null) throw new Error('hostId is required');
  const call = (op, args) => channel.enqueue(hostId, { op, args }, { timeoutMs }).promise;
  return {
    hostId,
    openApp: (pkg) => call('openApp', { pkg }),
    tap: (x, y) => call('tap', { x, y }),
    swipe: (opts) => call('swipe', opts || {}),
    typeText: (text) => call('type', { text }),
    home: () => call('home', {}),
    dumpUi: () => call('dumpUi', {}),
    getWindowSize: () => call('getWindowSize', {}),
    keepAwake: () => call('keepAwake', {}),
    wake: () => call('wake', {}),
    close: async () => {},
  };
}

module.exports = { makeRemoteDriver };
