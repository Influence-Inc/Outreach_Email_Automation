'use strict';

// In-memory live channel for paired sourcing hosts.
//
// Frames: the runner POSTs its most recent phone screenshot (as base64) every
// few seconds while a scouting run is active. Only the LATEST frame is kept per
// host, in memory — a live view, not an archive. Dashboards fetch it on demand.
//
// Control: an admin watching the dashboard can push a control instruction
// (tap / swipe / type / home / pause / resume). Instructions are queued in
// memory per host; the runner's control loop polls and drains them.
//
// Everything gated by SOURCING_LIVE_MIRROR=on so the whole surface is opt-in on
// first ship — the value defaults off, which turns the frame/control endpoints
// into 404s (see routes/sourcing.js). No sockets, no new deps: HTTP-only.
//
// Buffers deliberately capped so a wedged host can't grow memory unbounded.

const MAX_FRAME_BYTES = 400 * 1024;      // ~400 KB per frame (JPEG-quality)
const MAX_CONTROL_QUEUE = 32;             // per-host cap
const FRAME_STALE_MS = 60 * 1000;         // "live" only for the last minute
const HOSTS = new Map();                  // hostId -> { frame, controls: [] }

function enabled() {
  return String(process.env.SOURCING_LIVE_MIRROR || '').toLowerCase() === 'on';
}

function ensure(hostId) {
  let s = HOSTS.get(hostId);
  if (!s) {
    s = { frame: null, controls: [], lastFrameAt: null, lastError: null, misdirected: null };
    HOSTS.set(hostId, s);
  }
  return s;
}

// Runner → backend: publish a frame. Rejects payloads that are too big so a
// pathological host can't fill the process heap.
function publishFrame(hostId, { dataBase64, mediaType = 'image/jpeg', width, height }, { claimedId } = {}) {
  const s = ensure(Number(hostId));
  // The phone addressed its frame to a different host number than its token
  // belongs to (a mistyped Host ID in the app). The frame is filed under the
  // token's host; this is kept so the dashboard can say so.
  if (claimedId != null && Number(claimedId) !== Number(hostId)) {
    s.misdirected = { claimedId: Number(claimedId), at: Date.now() };
  }
  const buf = Buffer.from(String(dataBase64 || ''), 'base64');
  const reject = (message) => {
    s.lastError = { message, at: Date.now() };
    throw new Error(message);
  };
  if (!buf.length) reject('empty frame');
  if (buf.length > MAX_FRAME_BYTES) reject(`frame too large (${buf.length} > ${MAX_FRAME_BYTES})`);
  s.frame = { data: buf, mediaType, width: Number(width) || null, height: Number(height) || null, at: Date.now() };
  s.lastFrameAt = s.frame.at;
  s.lastError = null;
  return { bytes: buf.length };
}

// Dashboard → backend: read the latest frame (or null when nothing / stale).
function latestFrame(hostId) {
  const s = HOSTS.get(Number(hostId));
  if (!s || !s.frame) return null;
  if (Date.now() - s.frame.at > FRAME_STALE_MS) return null;
  return s.frame;
}

// Dashboard → backend: why there is no live frame. All of it is since this
// process started — the channel is in memory, so a redeploy forgets it.
function frameState(hostId) {
  const s = HOSTS.get(Number(hostId));
  return {
    lastFrameAt: (s && s.lastFrameAt) || null,
    lastError: (s && s.lastError) || null,
    misdirected: (s && s.misdirected) || null,
    staleAfterMs: FRAME_STALE_MS,
  };
}

// Dashboard → backend: push a control instruction.
function pushControl(hostId, op) {
  if (!op || typeof op !== 'object') throw new Error('op is required');
  if (!VALID_OPS.has(op.op)) throw new Error(`unknown op '${op.op}'`);
  const s = ensure(Number(hostId));
  if (s.controls.length >= MAX_CONTROL_QUEUE) s.controls.shift();
  const entry = { ...op, id: Date.now() + ':' + s.controls.length, at: Date.now() };
  s.controls.push(entry);
  return entry;
}

// Runner → backend: drain the queued instructions (returns them + clears).
function drainControls(hostId) {
  const s = HOSTS.get(Number(hostId));
  if (!s || !s.controls.length) return [];
  const out = s.controls;
  s.controls = [];
  return out;
}

const VALID_OPS = new Set(['tap', 'swipe', 'type', 'home', 'pause', 'resume']);

// Test-only: wipe state between cases so nothing leaks across tests.
function _reset() { HOSTS.clear(); }

module.exports = {
  enabled,
  publishFrame,
  latestFrame,
  frameState,
  pushControl,
  drainControls,
  VALID_OPS,
  MAX_FRAME_BYTES,
  MAX_CONTROL_QUEUE,
  FRAME_STALE_MS,
  _reset,
};
