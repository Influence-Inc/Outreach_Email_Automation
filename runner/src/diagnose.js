'use strict';

// Turn a raw runner exception into a compact, actionable diagnostic. Called
// from the top-level catch in src/index.js — instead of dumping a webdriverio
// stack trace we tell the operator exactly what to do next.
//
// New failure modes get added as we hit them for real; the fallback is a plain
// message so we never SWALLOW an unexpected error.

// Ordered patterns — the first match wins, so put more specific ones first.
const PATTERNS = [
  {
    match: /Cannot find module 'webdriverio'/i,
    reason: "The 'webdriverio' optional dependency is not installed.",
    fix: "cd runner && npm install webdriverio",
  },
  {
    match: /Could not find a driver for automationName 'UiAutomator2'/i,
    reason: 'Appium is running but the UiAutomator2 driver is missing.',
    fix: 'appium driver install uiautomator2',
  },
  {
    match: /Could not find a driver for automationName 'XCUITest'/i,
    reason: 'Appium is running but the XCUITest driver is missing.',
    fix: 'appium driver install xcuitest',
  },
  {
    match: /(ECONNREFUSED|fetch failed).*(4723|127\.0\.0\.1)/i,
    reason: 'Appium server is not running on the configured URL.',
    fix: "start Appium in another terminal: 'appium --base-path /wd/hub'",
  },
  {
    match: /connect ECONNREFUSED/i,
    reason: 'A network connection was refused.',
    fix: 'check the backend URL (RUNNER_BACKEND_URL) or the Appium URL (RUNNER_APPIUM_URL)',
  },
  {
    match: /screen is locked/i,
    reason: 'The phone screen is locked; Appium cannot take a screenshot.',
    fix: 'unlock the phone and disable auto-lock during the run',
  },
  {
    match: /Instrumentation process.*(is not running|failed to start)/i,
    reason: "Appium's UiAutomator2 helper on the phone is stuck.",
    fix: 'adb uninstall io.appium.uiautomator2.server && retry (the driver will reinstall it)',
  },
  {
    match: /(WebDriverAgent.*not.*installed|WebDriverAgentRunner.*failed|xcodebuild)/i,
    reason: 'iOS WebDriverAgent is missing or has an expired signing certificate.',
    fix:
      'rebuild + resign WDA against your phone (see runner/README.md iOS section); ' +
      'signing must be refreshed ~weekly on a free Apple ID',
  },
  {
    match: /\b(?:adb|device)\b.{0,80}\bunauthorized\b|\bunauthorized\b.{0,80}\b(?:adb|device)\b/i,
    reason: 'ADB device is unauthorized — the phone has not accepted this host.',
    fix: "on the phone: tap Allow on the 'Allow USB debugging?' prompt",
  },
  {
    match: /HTTP 401/i,
    reason: 'Backend rejected the per-host token (401).',
    fix:
      'mint a fresh token from the Scout Creators page (or verify RUNNER_HOST_TOKEN is set); ' +
      'if the host was revoked, mint a new one',
  },
  {
    match: /not implemented/i,
    reason:
      'The vision reader is not implemented for real drivers yet. This is expected on the ' +
      'first live Track D run — the plan is to build it against real IG screenshots.',
    fix:
      'capture one screenshot per navigator screen (search results, profile, reels tab) with ' +
      "'adb exec-out screencap -p > screen-N.png' and share them; see runner/PHASE_D_CHECKLIST.md " +
      'step 8.',
  },
];

// Return { reason, fix } if a pattern matches, else null.
function diagnose(err) {
  const msg = String((err && err.message) || err || '');
  const stack = String((err && err.stack) || '');
  const hay = msg + '\n' + stack;
  for (const p of PATTERNS) {
    if (p.match.test(hay)) return { reason: p.reason, fix: p.fix, raw: msg };
  }
  return null;
}

// Print a compact, structured error block. Exported so index.js can render it
// with `stderr = console.error`; tests can pass their own logger.
function printDiagnostic(err, logger = console) {
  const d = diagnose(err);
  const write = logger.error ? logger.error.bind(logger) : logger.log.bind(logger);
  write('[runner] FATAL — the run did not start / did not complete cleanly.');
  if (d) {
    write('[runner] cause:   ' + d.reason);
    write('[runner] fix:     ' + d.fix);
    write('[runner] raw msg: ' + d.raw);
  } else {
    write('[runner] unexpected error, raw stack follows:');
    write(String((err && err.stack) || err));
  }
}

module.exports = { diagnose, printDiagnostic };
