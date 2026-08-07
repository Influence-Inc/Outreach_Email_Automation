'use strict';

// Anti-flag "humanizing" primitives. Automation that acts at a fixed cadence and
// taps the exact pixel center every time is trivially fingerprintable, so the
// navigators pace with jitter, tap slightly off-center, and only scout during
// human-plausible hours. Pure + injectable rng so it's fully unit-testable.

// Randomize a base delay by +/- `factor` (default ±40%). 0 base -> 0 (keeps tests
// with pacingMs:0 deterministic and instant).
function jitteredDelay(baseMs, rng = Math.random, factor = 0.4) {
  const b = Math.max(0, Number(baseMs) || 0);
  if (!b) return 0;
  const delta = (rng() * 2 - 1) * factor * b;
  return Math.max(0, Math.round(b + delta));
}

// Nudge a tap target by up to `px` in each axis so taps aren't pixel-perfect.
// px<=0 (the default) returns the point unchanged — so navigator unit tests that
// assert exact coordinates stay exact; production sets px>0.
function jitterTap(point, px = 0, rng = Math.random) {
  if (!point || !px) return point;
  const jx = Math.round((rng() * 2 - 1) * px);
  const jy = Math.round((rng() * 2 - 1) * px);
  return { x: point.x + jx, y: point.y + jy };
}

// Parse "8-23" (8am–11pm) or "22-6" (overnight) into { start, end }; anything
// else (empty/invalid) -> null meaning "always active".
function parseActiveHours(spec) {
  const m = String(spec == null ? '' : spec).match(/^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/);
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (start > 23 || end > 24) return null;
  return { start, end };
}

// Is `date` inside the active window? No window configured => always true.
function withinActiveHours(date = new Date(), spec) {
  const win = spec && typeof spec === 'object' ? spec : parseActiveHours(spec);
  if (!win) return true;
  const h = date.getHours();
  if (win.start === win.end) return true; // degenerate window = always
  if (win.start < win.end) return h >= win.start && h < win.end;
  return h >= win.start || h < win.end; // overnight (e.g. 22-6)
}

module.exports = { jitteredDelay, jitterTap, parseActiveHours, withinActiveHours };
