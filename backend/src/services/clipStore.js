'use strict';

// Short-lived in-memory store for reel clips a host uploads.
//
// The agent records a reel (scrcpy, video+audio) and POSTs the mp4 bytes to
// /hosts/:id/clip, which stores them here and returns a clipId. The backend
// navigator then hands that clipId's bytes to the Gemini judge. Clips are
// consumed once (take()) and never persisted — this is a transient hop, bounded
// so a wedged host can't grow the heap. Mirrors the in-memory design of
// services/hostChannel.js (the live mirror).

const MAX_CLIPS = 8;                    // most-recent N kept
const MAX_BYTES = 20 * 1024 * 1024;     // per-clip ceiling (~inline Gemini limit)
const TTL_MS = 5 * 60 * 1000;           // a clip judged within a few minutes or dropped

const CLIPS = new Map(); // clipId -> { hostId, buf, mediaType, at }
let seq = 0;

function prune(now = Date.now()) {
  for (const [k, c] of CLIPS) if (now - c.at > TTL_MS) CLIPS.delete(k);
}

// Store a clip, returning its id. Evicts the oldest when over the count cap.
function put(hostId, buf, mediaType = 'video/mp4') {
  if (!buf || !buf.length) throw new Error('empty clip');
  if (buf.length > MAX_BYTES) throw new Error(`clip too large (${buf.length} > ${MAX_BYTES})`);
  prune();
  const id = `clip_${(seq += 1)}`;
  CLIPS.set(id, { hostId: Number(hostId), buf, mediaType, at: Date.now() });
  while (CLIPS.size > MAX_CLIPS) {
    const oldest = CLIPS.keys().next().value;
    CLIPS.delete(oldest);
  }
  return id;
}

// Read without consuming (returns null when missing/expired).
function get(id) {
  const c = CLIPS.get(id);
  if (!c) return null;
  if (Date.now() - c.at > TTL_MS) { CLIPS.delete(id); return null; }
  return c;
}

// Read and remove — the judge consumes a clip exactly once.
function take(id) {
  const c = get(id);
  if (c) CLIPS.delete(id);
  return c;
}

function _reset() { CLIPS.clear(); seq = 0; }

module.exports = { put, get, take, _reset, MAX_CLIPS, MAX_BYTES, TTL_MS };
