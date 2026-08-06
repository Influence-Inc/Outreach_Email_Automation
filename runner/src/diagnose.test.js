'use strict';

// Locks the diagnose() pattern → { reason, fix } mapping so a raw Appium /
// webdriverio / backend error surfaces as a compact, actionable line instead
// of a stack trace. Add a fixture per new failure mode we hit for real.

const test = require('node:test');
const assert = require('node:assert');
const { diagnose, printDiagnostic } = require('./diagnose');

const cases = [
  { in: new Error("Cannot find module 'webdriverio'"), reason: /optional dependency/ },
  { in: new Error("Could not find a driver for automationName 'UiAutomator2'"), reason: /UiAutomator2/ },
  { in: new Error("Could not find a driver for automationName 'XCUITest'"), reason: /XCUITest/ },
  { in: new Error('fetch failed on http://127.0.0.1:4723'), reason: /Appium server is not running/ },
  { in: new Error('screen is locked'), reason: /screen is locked/i },
  { in: new Error('Instrumentation process failed to start'), reason: /Appium.*UiAutomator2 helper/ },
  { in: new Error('adb device shows unauthorized state'), reason: /unauthorized/i },
  { in: new Error('POST /api/sourcing/runs/1/candidates -> HTTP 401 Unauthorized'), reason: /Backend rejected/ },
  { in: new Error('not implemented'), reason: /vision reader is not implemented/ },
];

for (const c of cases) {
  test(`diagnose maps: "${c.in.message.slice(0, 40)}…" → ${c.reason}`, () => {
    const d = diagnose(c.in);
    assert.ok(d, 'should recognize this failure mode');
    assert.match(d.reason, c.reason);
    assert.ok(d.fix && d.fix.length, 'must include a fix line');
  });
}

test('diagnose returns null on an unknown error', () => {
  assert.strictEqual(diagnose(new Error('completely novel')), null);
});

test('printDiagnostic writes a structured block on known errors', () => {
  const lines = [];
  const fake = { error: (...a) => lines.push(a.join(' ')) };
  printDiagnostic(new Error('screen is locked'), fake);
  const text = lines.join('\n');
  assert.match(text, /FATAL/);
  assert.match(text, /cause:.*screen is locked/i);
  assert.match(text, /fix:.*unlock the phone/i);
});

test('printDiagnostic falls back to raw stack on unknown errors', () => {
  const lines = [];
  const fake = { error: (...a) => lines.push(a.join(' ')) };
  const err = new Error('completely novel bug');
  printDiagnostic(err, fake);
  const text = lines.join('\n');
  assert.match(text, /unexpected error/);
  assert.match(text, /completely novel bug/);
});
