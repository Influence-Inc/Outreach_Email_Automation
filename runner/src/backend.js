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
    postCandidates: (id, candidates) =>
      req('POST', `/api/sourcing/runs/${id}/candidates`, { candidates }),
    stopRun: (id) => req('POST', `/api/sourcing/runs/${id}/stop`),
  };
}

module.exports = { makeBackend };
