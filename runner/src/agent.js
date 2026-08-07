'use strict';

// Agent mode — the thin "hands + eyes" half of the inverted control plane.
//
// In RUNNER_MODE=agent the laptop does NOT run the Instagram navigator. Instead
// the Deal Studio backend runs it and drives the phone by enqueuing device
// commands; this loop just:
//   1. claims a run for its host (POST /hosts/:id/session/claim)
//   2. pulls queued commands (GET /hosts/:id/commands)
//   3. executes each on the local AndroidDriver
//   4. posts the result back (POST /hosts/:id/commands/result)
//   5. repeats until the backend marks the session done, then claims the next run
//
// So every scouting-logic change ships by deploying the backend — this host is a
// dumb, near-zero-maintenance relay. Everything is injected (backend, driver,
// clock, stop flag) so the whole loop is testable with no phone and no network.

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Map one backend command to a local driver call. Ops that mutate the phone
// resolve with null; dumpUi/getWindowSize/screenshot carry data back so the
// backend navigator can read the screen.
async function executeCommand(driver, cmd) {
  const a = (cmd && cmd.args) || {};
  switch (cmd.op) {
    case 'openApp': await driver.openApp(a.pkg); return null;
    case 'tap': await driver.tap(a.x, a.y); return null;
    case 'swipe': await driver.swipe(a); return null;
    case 'type': await driver.typeText(a.text); return null;
    case 'home': await driver.home(); return null;
    case 'keepAwake': if (driver.keepAwake) await driver.keepAwake(); return null;
    case 'wake': if (driver.wake) await driver.wake(); return null;
    case 'dumpUi': return driver.dumpUi();
    case 'getWindowSize': return driver.getWindowSize();
    case 'screenshot': {
      const shot = await driver.screenshot();
      return { mediaType: shot.mediaType, dataBase64: shot.data.toString('base64') };
    }
    default:
      throw new Error(`unknown command op: ${cmd && cmd.op}`);
  }
}

// Drive one backend-owned session: pull -> execute -> post, until the backend
// signals done (or we're asked to stop).
async function serveSession({ driver, backend, hostId, config, logger = console, shouldStop = () => false, sleepFn = sleep }) {
  const pollMs = Math.max(0, Number(config.agentPollMs || 400));
  const warn = (...a) => (logger.warn || logger.log || (() => {})).call(logger, ...a);

  while (!shouldStop()) {
    let pulled;
    try {
      pulled = await backend.pullCommands(hostId);
    } catch (err) {
      warn('[agent] pull failed:', err.message);
      await sleepFn(pollMs);
      continue;
    }
    const cmds = (pulled && pulled.commands) || [];
    for (const cmd of cmds) {
      let result = null;
      let ok = true;
      let error = null;
      try {
        result = await executeCommand(driver, cmd);
      } catch (err) {
        ok = false;
        error = err.message;
      }
      try {
        await backend.postCommandResult(hostId, { id: cmd.id, ok, result, error });
      } catch (err) {
        warn('[agent] result post failed:', err.message);
      }
    }
    if (pulled && pulled.done && !cmds.length) return; // session finished
    if (!cmds.length) await sleepFn(pollMs);
  }
}

// Top-level agent loop: claim work, serve the session, repeat. One-time setup —
// start it once and it handles every run an admin queues.
async function runAgent({ driver, backend, config, logger = console, shouldStop = () => false, sleepFn = sleep }) {
  const hostId = config.hostId;
  if (!hostId) throw new Error('RUNNER_MODE=agent requires RUNNER_HOST_ID');
  const idleMs = Math.max(1000, Number(config.idlePollMs || 15000));
  const log = (...a) => (logger.log || (() => {})).call(logger, ...a);
  const warn = (...a) => (logger.warn || logger.log || (() => {})).call(logger, ...a);

  while (!shouldStop()) {
    let claim;
    try {
      claim = await backend.claimSession(hostId);
    } catch (err) {
      warn('[agent] claim failed:', err.message);
      await sleepFn(idleMs);
      continue;
    }
    if (!claim || !claim.active) {
      await sleepFn(idleMs); // nothing queued right now
      continue;
    }
    log(`[agent] session started (run #${claim.runId != null ? claim.runId : '?'})`);
    await serveSession({ driver, backend, hostId, config, logger, shouldStop, sleepFn });
    log('[agent] session ended');
  }
  log('[agent] stopped');
}

module.exports = { runAgent, serveSession, executeCommand };
