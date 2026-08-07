'use strict';

// Thin HTTP client for the Deal Studio backend. Every request carries the paired
// host's machine token as x-api-token, which siteAuth.js accepts as a bearer
// credential (same header the dashboard's headless integrations already use).
//
// The client is deliberately tiny — no retries, no polling — so the caller (the
// runner main loop) owns pacing and error handling.

function makeBackend({ backendUrl, hostToken, fetchImpl = globalThis.fetch }) {
  if (!fetchImpl) throw new Error('fetch is not available');
  const base = String(backendUrl || '').replace(/\/$/, '');

  async function req(method, path, body) {
    const res = await fetchImpl(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-api-token': hostToken,
      },
      body: body == null ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { /* non-json */ }
    if (!res.ok) {
      const msg = (json && json.error) || text || `${res.status} ${res.statusText}`;
      throw new Error(`${method} ${path} -> ${res.status} ${msg}`);
    }
    return json;
  }

  return {
    getRun: (id) => req('GET', `/api/sourcing/runs/${id}`),
    // Auto mode: poll for the next queued run. Returns { run } or null when the
    // backend responded 204 ("nothing queued right now").
    getNextRun: async () => {
      const res = await fetchImpl(base + '/api/sourcing/runs/next', {
        method: 'GET',
        headers: { 'Content-Type': 'application/json', 'x-api-token': hostToken },
      });
      if (res.status === 204) return null;
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch (_) { /* non-json */ }
      if (!res.ok) throw new Error(`GET /api/sourcing/runs/next -> ${res.status} ${(json && json.error) || text}`);
      return json;
    },
    postCandidates: (id, candidates) =>
      req('POST', `/api/sourcing/runs/${id}/candidates`, { candidates }),
    stopRun: (id) => req('POST', `/api/sourcing/runs/${id}/stop`),
    // Server-side vision: send the parsed UI-element tree (+ device size) and get
    // back the navigator's structured reading. Interpretation lives on the backend.
    readScreen: (payload) => req('POST', '/api/sourcing/vision/read', payload),
    // Live mirror surface (only meaningful when SOURCING_LIVE_MIRROR=on on the
    // backend; each 404s otherwise, which the caller treats as "off").
    publishFrame: (hostId, payload) =>
      req('POST', `/api/sourcing/hosts/${hostId}/frame`, payload),
    pullControls: (hostId) => req('GET', `/api/sourcing/hosts/${hostId}/control`),

    // Agent-mode surface (backend-driven scouting; SOURCING_REMOTE_CONTROL=on).
    // claimSession returns { active, runId? } — 204 means nothing is queued.
    claimSession: async (hostId) => {
      const res = await fetchImpl(base + `/api/sourcing/hosts/${hostId}/session/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-token': hostToken },
      });
      if (res.status === 204) return { active: false };
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch (_) { /* non-json */ }
      if (!res.ok) throw new Error(`POST /session/claim -> ${res.status} ${(json && json.error) || text}`);
      return json || { active: false };
    },
    pullCommands: (hostId) => req('GET', `/api/sourcing/hosts/${hostId}/commands`),
    postCommandResult: (hostId, payload) =>
      req('POST', `/api/sourcing/hosts/${hostId}/commands/result`, payload),
  };
}

module.exports = { makeBackend };
