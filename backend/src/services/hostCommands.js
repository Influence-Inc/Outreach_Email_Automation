'use strict';

// Request/response command channel for a paired host running in AGENT mode.
//
// This is the inversion of the control plane: instead of the laptop running the
// Instagram navigator and deciding every tap, the BACKEND runs the navigator
// (services/sourcingNavigator.js) and the laptop is a thin pair of hands that
// executes device primitives on demand. The backend drives the phone by:
//
//   1. enqueue(hostId, {op,args})  -> { id, promise }   (backend awaits promise)
//   2. agent pulls the queued commands (GET /hosts/:id/commands)
//   3. agent runs each on its local driver, then POSTs the result
//   4. resolve(hostId, id, {ok,result}) settles the awaiting promise
//
// So on the backend a RemoteDriver method is just `await enqueue(...).promise` —
// the navigator code doesn't know the phone is a network hop away.
//
// In-memory + single-host-session, mirroring services/hostChannel.js (the live
// mirror): one active run per host at a time. Gated by SOURCING_REMOTE_CONTROL=on
// so the whole surface is opt-in — the routes 404 when it's off.

const DEFAULT_TIMEOUT_MS = 30_000; // a single device op should never take this long
const MAX_QUEUE = 64; // guard against a wedged agent backing commands up unbounded
const HOSTS = new Map(); // hostId -> { queue:[], inflight:Map, done:bool, seq:int }

function enabled() {
  return String(process.env.SOURCING_REMOTE_CONTROL || '').toLowerCase() === 'on';
}

function ensure(hostId) {
  let s = HOSTS.get(hostId);
  if (!s) { s = { queue: [], inflight: new Map(), done: false, seq: 0 }; HOSTS.set(hostId, s); }
  return s;
}

// Start a fresh session for a host: reject any stragglers from a previous run so
// their awaiters don't hang, and clear the done flag.
function beginSession(hostId) {
  const s = ensure(hostId);
  for (const [, p] of s.inflight) { clearTimeout(p.timer); p.reject(new Error('command channel reset')); }
  s.queue = [];
  s.inflight = new Map();
  s.done = false;
  return s;
}

// Backend -> agent: enqueue a command and get a promise for its result. The
// promise rejects if the agent doesn't answer within timeoutMs (a dead/lagging
// host shouldn't wedge the navigator forever).
function enqueue(hostId, { op, args = {} } = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!op) throw new Error('op is required');
  const s = ensure(hostId);
  if (s.queue.length >= MAX_QUEUE) throw new Error('command queue full');
  const id = (s.seq += 1);
  let resolveFn;
  let rejectFn;
  const promise = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });
  const timer = setTimeout(() => {
    if (s.inflight.has(id)) {
      s.inflight.delete(id);
      rejectFn(new Error(`command '${op}' timed out after ${timeoutMs}ms`));
    }
  }, timeoutMs);
  s.inflight.set(id, { resolve: resolveFn, reject: rejectFn, timer });
  s.queue.push({ id, op, args });
  return { id, promise };
}

// Agent -> backend: drain the queued commands to execute. `done` tells the agent
// the backend has finished this run's session (no more commands are coming).
function pull(hostId) {
  const s = HOSTS.get(hostId);
  if (!s) return { commands: [], done: false };
  const commands = s.queue;
  s.queue = [];
  return { commands, done: !!s.done };
}

// Agent -> backend: settle a command's result. ok:false rejects the awaiter with
// `error`. Returns false when the id is unknown (already timed out / reset).
function resolve(hostId, id, { ok = true, result = null, error = null } = {}) {
  const s = HOSTS.get(hostId);
  if (!s) return false;
  const p = s.inflight.get(Number(id));
  if (!p) return false;
  clearTimeout(p.timer);
  s.inflight.delete(Number(id));
  if (ok) p.resolve(result);
  else p.reject(new Error(error || 'agent reported command failure'));
  return true;
}

// Backend: mark the session finished so the agent's next pull returns done:true.
function endSession(hostId) {
  const s = ensure(hostId);
  s.done = true;
  return true;
}

// Test-only: wipe state + clear timers so nothing leaks across cases.
function _reset() {
  for (const [, s] of HOSTS) for (const [, p] of s.inflight) clearTimeout(p.timer);
  HOSTS.clear();
}

module.exports = {
  enabled,
  beginSession,
  enqueue,
  pull,
  resolve,
  endSession,
  _reset,
  DEFAULT_TIMEOUT_MS,
  MAX_QUEUE,
};
