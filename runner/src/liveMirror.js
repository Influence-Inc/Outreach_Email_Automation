'use strict';

// Live-mirror + take-over loop. Runs alongside the main scouting loop when the
// operator wants the dashboard to see the phone in real time (SOURCING_LIVE_MIRROR
// enabled on the backend + a paired host).
//
// Two responsibilities:
//   1. Every `frameIntervalMs`, capture a screenshot and upload it to the backend
//      as base64. The backend keeps the LATEST frame per host (in-memory).
//   2. Every `controlIntervalMs`, pull queued admin control instructions from the
//      backend and execute them on the driver so a human can tap/swipe/type on
//      the phone through the dashboard.
//
// Both loops are best-effort: any single failure is logged and the loop keeps
// going. Kept in its own module so it never gates the main scouting loop —
// disabling the live mirror simply means this coroutine isn't started.

function nowMs() { return Date.now(); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function captureAndUpload({ driver, backend, hostId, log }) {
  try {
    const shot = await driver.screenshot();
    if (!shot || !shot.data || !shot.data.length) return;
    // width/height are optional — they let the dashboard normalize an admin
    // click back to real device pixels. The Appium drivers expose them via
    // getWindowSize (best-effort; if it fails we still upload the frame).
    let dims = { width: null, height: null };
    if (driver.getWindowSize) {
      try { dims = await driver.getWindowSize(); }
      catch (err) { log('getWindowSize failed:', err.message); }
    }
    await backend.publishFrame(hostId, {
      dataBase64: shot.data.toString('base64'),
      mediaType: shot.mediaType || 'image/png',
      width: dims.width, height: dims.height,
    });
  } catch (err) {
    log('publishFrame failed:', err.message);
  }
}

async function executeOp({ driver, op }) {
  switch (op.op) {
    case 'tap': return driver.tap(Number(op.x), Number(op.y));
    case 'swipe': return driver.swipe({
      x1: Number(op.x1), y1: Number(op.y1),
      x2: Number(op.x2), y2: Number(op.y2),
      durationMs: Number(op.durationMs || 200),
    });
    case 'type': return driver.typeText(String(op.text || ''));
    case 'home': return driver.home();
    case 'pause':
    case 'resume':
      // Left to the caller — the main loop watches shouldStop / run.status.
      return;
    default:
      // Silently ignore unknown ops; the backend already rejects unknowns before
      // ever queuing them, so hitting this branch means a version drift.
      return;
  }
}

// Returns a controller with .stop() so the caller (main.js) can shut the loops
// down when the run ends. Both loops respect getShouldStop() so they exit
// promptly.
function startLiveMirror({
  driver,
  backend,
  hostId,
  frameIntervalMs = 3000,
  controlIntervalMs = 1500,
  getShouldStop = () => false,
  logger = console,
} = {}) {
  if (!hostId) throw new Error('hostId is required for the live mirror');
  const log = (...a) => logger.warn ? logger.warn('[live-mirror]', ...a) : logger.log('[live-mirror]', ...a);
  let stopped = false;

  const frameLoop = (async () => {
    while (!stopped && !getShouldStop()) {
      const start = nowMs();
      await captureAndUpload({ driver, backend, hostId, log });
      const elapsed = nowMs() - start;
      const wait = Math.max(0, frameIntervalMs - elapsed);
      if (wait) await sleep(wait);
    }
  })();

  const controlLoop = (async () => {
    while (!stopped && !getShouldStop()) {
      try {
        const { ops } = (await backend.pullControls(hostId)) || { ops: [] };
        for (const op of ops || []) {
          try { await executeOp({ driver, op }); }
          catch (err) { log(`op ${op.op} failed:`, err.message); }
        }
      } catch (err) {
        log('pullControls failed:', err.message);
      }
      await sleep(controlIntervalMs);
    }
  })();

  return {
    async stop() { stopped = true; await Promise.allSettled([frameLoop, controlLoop]); },
  };
}

module.exports = { startLiveMirror, executeOp };
