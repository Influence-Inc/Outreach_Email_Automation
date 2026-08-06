'use strict';

// Turn a raw runner exception into a compact, actionable diagnostic. Called
// from the top-level catch in src/index.js — instead of dumping a raw stack
// trace we tell the operator exactly what to do next.
//
// New failure modes get added as we hit them for real; the fallback is a plain
// message so we never SWALLOW an unexpected error.

// Ordered patterns — the first match wins, so put more specific ones first.
//
// Android-only, driven directly over adb — every failure mode here is
// adb-shaped: the binary missing, no device, wrong device picked, the screen
// being locked, etc. There is no Appium/WebDriverAgent layer to diagnose.
const PATTERNS = [
  {
    match: /spawn adb ENOENT|'adb' not in PATH/i,
    reason: "The 'adb' command was not found on this host.",
    fix:
      "install Android platform tools (macOS: 'brew install android-platform-tools', " +
      "Ubuntu: 'sudo apt install android-tools-adb', Windows: install Android SDK Platform Tools) " +
      'and make sure it is on PATH.',
  },
  {
    match: /no devices\/emulators found|error: no devices\/?/i,
    reason: 'adb sees no phone attached.',
    fix: 'plug the phone in via USB and enable Developer options → USB debugging',
  },
  {
    match: /more than one device\/emulator/i,
    reason: 'adb sees more than one phone/emulator and does not know which to use.',
    fix: "run 'adb devices' to list them, then set RUNNER_DEVICE_UDID=<serial>",
  },
  {
    match: /device\s+offline/i,
    reason: 'adb sees the phone but it is in the "offline" state.',
    fix: 'unplug and replug the USB cable, or reboot the phone',
  },
  {
    match: /connect ECONNREFUSED/i,
    reason: 'A network connection was refused.',
    fix: 'check the backend URL (RUNNER_BACKEND_URL) is correct and reachable',
  },
  {
    match: /screen.{0,20}locked/i,
    reason: 'The phone screen is locked, so a screenshot/tap could not go through.',
    fix: 'unlock the phone and disable auto-lock during the run',
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
      'step 6.',
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
