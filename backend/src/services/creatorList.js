'use strict';

// The creator-list project ("Find creators") is where creators are scraped and analysed:
// newest 30 Reels, transcripts, OCR, Jev labels, brand deals, Estimated CPM and rate. Deal
// Studio reads a creator from its index through the partner API, server to server, and asks it
// to analyse the creators it doesn't have yet (they then join the index as requests by
// "Influence team (Deal Studio)"). A creator is never analysed twice.
//
//   CREATOR_LIST_API_URL   the creator-list bench's address, e.g. https://test-bench-production.up.railway.app
//   CREATOR_LIST_API_KEY   the same value as DEAL_STUDIO_API_KEY on the bench
//
// What came back is cached per handle in creator_list_profiles, and an indexed creator's data
// is copied onto their creators rows (creators.creator_list) for the pricing code.

const db = require('../db');
const { computeOffers } = require('./pricing');

const HANDLE = /^[a-z0-9._]{1,30}$/;
// An indexed creator is re-read after this long (creator-list re-prices and re-crawls them).
const FRESH_MS = 12 * 3600 * 1000;
// A queued / running one is asked again at most this often, however often the panel polls.
const POLL_MS = 15 * 1000;

const clean = (h) => String(h || '').trim().replace(/^@/, '').toLowerCase();
const config = () => ({
  url: String(process.env.CREATOR_LIST_API_URL || '').trim().replace(/\/+$/, ''),
  key: String(process.env.CREATOR_LIST_API_KEY || '').trim(),
});
const configured = () => {
  const c = config();
  return Boolean(c.url && c.key);
};

// One call to the partner API. GET reads; POST also queues a creator the index lacks.
// Returns { status, creator?, request? } or throws with a reason.
async function call(handle, { queue = false, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const { url, key } = config();
  const res = await fetchImpl(`${url}/api/partner/creators/${encodeURIComponent(handle)}`, {
    method: queue ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  let body = {};
  try { body = await res.json(); } catch { /* not JSON */ }
  if (res.status === 404 && body.status === 'not_indexed') return { status: 'not_indexed' };
  if (!res.ok) {
    const why = res.status === 401 ? 'creator-list refused the API key (CREATOR_LIST_API_KEY)'
      : res.status === 503 ? 'creator-list has no DEAL_STUDIO_API_KEY set'
      : `creator-list answered ${res.status}${body.error ? `: ${body.error}` : ''}`;
    throw new Error(why);
  }
  return body;
}

async function cached(handle) {
  return db.one(`SELECT * FROM creator_list_profiles WHERE handle = $1`, [handle]);
}

// What the pricing code needs from creator-list's document, small enough to sit on every row.
function pricingCopy(c) {
  const pick = (r) => (r && r.mid != null ? { mid: Number(r.mid), low: r.low != null ? Number(r.low) : null, high: r.high != null ? Number(r.high) : null } : null);
  return {
    as_of: c.as_of || null,
    estimated_cpm: pick(c.estimated_cpm),
    estimated_rate: pick(c.estimated_rate),
    realised_cpm: pick(c.realised_cpm),
    typical_views: c.typical_views ?? null,
    median_views: c.median_views ?? null,
    followers: c.followers ?? null,
    reels_analysed: c.reels_analysed ?? null,
    country: c.country || null,
    country_name: c.country_name || null,
    country_source: c.country_source || null,
    main_topic: c.main_topic || null,
    main_niche: c.main_niche || null,
    formats: c.formats || null,
    genres: c.genres || null,
    brand_deals: c.brand_deals ?? null,
    brands: Array.isArray(c.brands) ? c.brands.slice(0, 20) : [],
    major_brands: Array.isArray(c.major_brands) ? c.major_brands.slice(0, 20) : [],
  };
}

// Copy an indexed creator onto their rows and re-price the suggested offers at the new CPM
// (rows with an admin CPM keep theirs).
async function applyToCreators(handle, copy) {
  // Lazily required: cpmEstimate reads creator_list rows and does not need this module.
  const { dealCpmFor } = require('./cpmEstimate'); // eslint-disable-line global-require
  const rows = await db.many(
    `UPDATE creators SET creator_list = $2::jsonb, updated_at = NOW()
      WHERE lower(instagram_username) = $1 AND creator_list IS DISTINCT FROM $2::jsonb RETURNING *`,
    [handle, JSON.stringify(copy)],
  );
  for (const row of rows) {
    if (!row.ig_scraped_data || row.deal_cpm != null) continue;
    const quoted = row.quoted_rate != null ? Number(row.quoted_rate) : null;
    const offers = computeOffers(row.ig_scraped_data, dealCpmFor(row).cpm, quoted);
    await db.query(`UPDATE creators SET suggested_offers = $2::jsonb WHERE id = $1`, [row.id, JSON.stringify(offers)]);
  }
  return rows.length;
}

async function save(handle, out, { queued = false, error = null } = {}) {
  await db.query(
    `INSERT INTO creator_list_profiles (handle, status, data, request, error, queued_at, checked_at)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, CASE WHEN $6 THEN NOW() END, NOW())
     ON CONFLICT (handle) DO UPDATE SET status = EXCLUDED.status,
       data = COALESCE(EXCLUDED.data, creator_list_profiles.data),
       request = COALESCE(EXCLUDED.request, creator_list_profiles.request),
       error = EXCLUDED.error,
       queued_at = COALESCE(EXCLUDED.queued_at, creator_list_profiles.queued_at),
       checked_at = NOW()`,
    [handle, out.status, out.creator ? JSON.stringify(out.creator) : null, out.request ? JSON.stringify(out.request) : null, error, queued],
  );
}

const view = (row) => (row ? {
  handle: row.handle,
  status: row.status,
  request: row.request || null,
  error: row.error || null,
  checked_at: row.checked_at,
  as_of: row.data ? row.data.as_of : null,
} : null);

// Bring a creator's creator-list data up to date, and return where it is at.
//   queue: ask creator-list to analyse them when it has neither data nor a request for them.
//          Only once per creator: after that (failed, say) only `force` (the panel's Retry)
//          queues again, so one bad handle can't use up creator-list's daily runs.
//   force: queue even then.
async function sync(rawHandle, { queue = false, force = false, fetchImpl, timeoutMs } = {}) {
  const handle = clean(rawHandle);
  if (!HANDLE.test(handle)) return { status: 'invalid', error: 'not a valid Instagram handle' };
  if (!configured()) return { status: 'not_configured', error: 'Set CREATOR_LIST_API_URL and CREATOR_LIST_API_KEY on the server' };

  const row = await cached(handle);
  const age = row ? Date.now() - new Date(row.checked_at).getTime() : Infinity;
  if (!force && row) {
    if (row.status === 'indexed' && age < FRESH_MS) return view(row);
    if (['queued', 'running'].includes(row.status) && age < POLL_MS) return view(row);
    if (row.status === 'failed' && age < POLL_MS) return view(row);
  }
  const ask = force || (queue && (!row || (['not_indexed', 'error'].includes(row.status) && !row.queued_at)));
  let out;
  try {
    out = await call(handle, { queue: ask, fetchImpl, timeoutMs });
  } catch (e) {
    const reason = e && e.name === 'TimeoutError' ? 'creator-list did not answer in time' : e.message;
    // Keep what we had (an indexed creator stays priced from their last data).
    if (row && row.status === 'indexed') return { ...view(row), error: reason };
    await save(handle, { status: 'error' }, { error: reason });
    return view(await cached(handle));
  }
  await save(handle, out, { queued: ask && ['queued', 'running'].includes(out.status) });
  if (out.status === 'indexed' && out.creator) {
    await applyToCreators(handle, pricingCopy(out.creator));
  }
  return view(await cached(handle));
}

// ── the admin's collection on creator-list ──────────────────────────────────
//
// Creators the scout shortlists (services/jevJudge.js, or an admin approving a
// doubtful one) go to creator-list's "Curated by INFLUENCE Team" collection, the
// admin's list on the site. That collection lives in the site (apps/web), not
// the bench, so it has its own address:
//
//   CREATOR_LIST_WEB_URL   the creator-list site, e.g. https://influence-web-production.up.railway.app
//
// with the same CREATOR_LIST_API_KEY (DEAL_STUDIO_API_KEY on the site). The
// creator is also queued on the bench, so the site gets their Reels, labels and
// prices like any other indexed creator.

const webUrl = () => String(process.env.CREATOR_LIST_WEB_URL || '').trim().replace(/\/+$/, '');

/** One short line for the collection item: what Jev saw, who it is for, and how they were found. */
function curatedNote({ summary, sourceTerm, targetViewer } = {}) {
  const parts = [];
  if (summary) parts.push(summary);
  if (targetViewer) parts.push(`for: ${targetViewer}`);
  if (sourceTerm) parts.push(`found searching "${sourceTerm}"`);
  return `Scouted by Deal Studio${parts.length ? ` · ${parts.join(' · ')}` : ''}`.slice(0, 280);
}

/**
 * Add a shortlisted creator to the "Curated by INFLUENCE Team" collection, and
 * queue them for analysis on the bench. Returns { status, ... } and never throws:
 *   added            in the collection (and `already: true` when they were before)
 *   not_configured   CREATOR_LIST_WEB_URL / CREATOR_LIST_API_KEY missing
 *   error            creator-list refused or did not answer; `error` says why
 */
async function addToCurated(rawHandle, {
  labels = null, summary = null, sourceTerm = null, targetViewer = null, by = 'Deal Studio', fetchImpl = fetch, timeoutMs = 8000,
} = {}) {
  const handle = clean(rawHandle);
  if (!HANDLE.test(handle)) return { status: 'invalid', error: 'not a valid Instagram handle' };
  const url = webUrl();
  const { key } = config();
  if (!url || !key) return { status: 'not_configured', error: 'Set CREATOR_LIST_WEB_URL and CREATOR_LIST_API_KEY on the server' };

  const pick = (dim) => (labels && labels[dim] && !['unclear', 'other'].includes(labels[dim].value) ? labels[dim].value : null);
  let out;
  try {
    const res = await fetchImpl(`${url}/api/partner/curated`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        handle,
        note: curatedNote({ summary, sourceTerm, targetViewer }),
        labels: { topic: pick('topic'), niche: pick('niche'), genre: pick('genre'), format: pick('format') },
        by,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let body = {};
    try { body = await res.json(); } catch (_) { /* not JSON */ }
    if (!res.ok) {
      const why = res.status === 401 ? 'creator-list refused the API key (CREATOR_LIST_API_KEY)'
        : res.status === 503 ? 'creator-list has no DEAL_STUDIO_API_KEY set'
        : `creator-list answered ${res.status}${body.error ? `: ${body.error}` : ''}`;
      return { status: 'error', error: why };
    }
    out = { status: 'added', collection: body.collection || null, already: !!body.already };
  } catch (e) {
    return { status: 'error', error: e && e.name === 'TimeoutError' ? 'creator-list did not answer in time' : (e && e.message) || String(e) };
  }
  // Their Reels, labels and prices come from the bench's analysis. Best-effort:
  // the collection entry stands even if the bench is down.
  if (configured()) {
    try { out.analysis = (await sync(handle, { queue: true })).status; } catch (_) { /* best-effort */ }
  }
  return out;
}

/** Whether shortlisted creators can reach the "Curated by INFLUENCE Team" collection. */
function curatedConfigured() {
  return Boolean(webUrl() && config().key);
}

/** Which of the two creator-list settings are missing, for the Scout page. */
function curatedMissing() {
  return [!webUrl() && 'CREATOR_LIST_WEB_URL', !config().key && 'CREATOR_LIST_API_KEY'].filter(Boolean);
}

async function status(rawHandle) {
  const handle = clean(rawHandle);
  if (!configured()) return { status: 'not_configured', error: 'Set CREATOR_LIST_API_URL and CREATOR_LIST_API_KEY on the server' };
  return view(await cached(handle)) || { handle, status: 'unknown' };
}

module.exports = {
  sync, status, call, pricingCopy, applyToCreators, configured, addToCurated, curatedNote, curatedConfigured, curatedMissing,
  FRESH_MS, POLL_MS,
};
