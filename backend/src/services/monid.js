'use strict';

// TikHub through Monid — the way creator-list collects a creator's Reels
// (services/enrichment/enrichment/tikhub.py there), so Deal Studio reads the same rows.
//
//   card   /api/v1/instagram/v2/fetch_user_info    handle, bio, followers, "Account based in"
//   page   /api/v1/instagram/v2/fetch_user_reels   12 Reels: caption, hashtags, video link, cover
//
// Each call is $0.002. Monid runs a call synchronously (200 with the output) or answers 202
// with a run to poll; 402 means the wallet is empty.
//
//   MONID_API_KEY   the same key creator-list's worker uses

const MONID_URL = 'https://api.monid.ai';
const CARD = '/api/v1/instagram/v2/fetch_user_info';
const REELS = '/api/v1/instagram/v2/fetch_user_reels';
const PRICE = { [CARD]: 0.002, [REELS]: 0.002 };
const TERMINAL = new Set(['COMPLETED', 'FAILED', 'BLOCKED', 'STOPPED', 'TIMED_OUT']);
const HIDDEN_COUNTRY = 'not shared';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function key() {
  return String(process.env.MONID_API_KEY || '').trim();
}

function configured() {
  return Boolean(key());
}

// After a 402 the wallet stays empty until someone tops it up, and every later call would be
// refused the same way — one per creator, each a round trip. So calls pause for a few
// minutes (then try again, so a top-up is picked up on its own), and the Scout page says why.
const EMPTY_PAUSE_MS = 3 * 60 * 1000;
let walletEmptyAt = 0;
const EMPTY = 'Monid wallet is empty (HTTP 402): top it up';

/** { empty: true, since } while the wallet is known to be empty, else { empty: false }. */
function walletState(now = Date.now()) {
  return walletEmptyAt && now - walletEmptyAt < EMPTY_PAUSE_MS
    ? { empty: true, since: new Date(walletEmptyAt).toISOString() }
    : { empty: false };
}

/** Test-only: forget an empty wallet. */
function _resetWallet() { walletEmptyAt = 0; }

// Deal Studio's own daily Monid budget, so a busy day — or a bug that fetches the same
// creator twice — cannot drain the wallet other services share.
//   MONID_USD_PER_DAY   USD per UTC day (default 1.00, 250 creators); "none" = no cap
// Counted in this process: a restart starts the day's count again.
const DEFAULT_USD_PER_DAY = 1;
let ledger = { date: '', usd: 0, calls: 0 };

const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

function dailyCap(env = process.env) {
  const raw = String(env.MONID_USD_PER_DAY ?? '').trim().toLowerCase();
  if (!raw) return DEFAULT_USD_PER_DAY;
  if (raw === 'none') return Infinity;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_USD_PER_DAY;
}

/** What Deal Studio has spent on Monid today (UTC), and its cap. */
function spentToday(now = Date.now()) {
  if (ledger.date !== today(now)) ledger = { date: today(now), usd: 0, calls: 0 };
  const cap = dailyCap();
  return {
    date: ledger.date,
    usd: Math.round(ledger.usd * 10000) / 10000,
    calls: ledger.calls,
    cap: Number.isFinite(cap) ? cap : null,
    capped: ledger.usd + 0.002 > cap + 1e-9,
  };
}

function charge(usd) {
  spentToday();
  ledger.usd += usd;
  ledger.calls += 1;
}

/** Test-only: start the day's count again. */
function _resetLedger() { ledger = { date: '', usd: 0, calls: 0 }; }

class MonidError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = 'MonidError';
    this.status = status;
  }
}

/** Run one TikHub endpoint through Monid. Returns { output, costUsd } or throws MonidError. */
async function run(endpoint, query, {
  fetchImpl = fetch, apiKey = key(), pollMs = 2000, maxWaitMs = 120_000, retries = 3, wait = sleep,
} = {}) {
  if (!apiKey) throw new MonidError('MONID_API_KEY is not set');
  if (walletState().empty) throw new MonidError(EMPTY, 402);
  const day = spentToday();
  if (day.usd + (PRICE[endpoint] || 0.002) > dailyCap() + 1e-9) {
    throw new MonidError(
      `Deal Studio's daily Monid budget is spent ($${day.usd.toFixed(2)} of MONID_USD_PER_DAY $${dailyCap().toFixed(2)}) — more tomorrow (UTC), or raise it`,
      'cap',
    );
  }
  const call = async (method, path, body) => {
    for (let attempt = 0; ; attempt += 1) {
      let res;
      try {
        // eslint-disable-next-line no-await-in-loop
        res = await fetchImpl(MONID_URL + path, {
          method,
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(60_000),
        });
      } catch (err) {
        if (attempt < retries) { await wait(2000 * 2 ** attempt); continue; } // eslint-disable-line no-await-in-loop
        throw new MonidError(`Monid: ${(err && err.message) || 'connection failed'}`);
      }
      if (res.status === 402) {
        walletEmptyAt = Date.now();
        throw new MonidError(EMPTY, 402);
      }
      if ([429, 500, 503, 504].includes(res.status) && attempt < retries) {
        await wait(2000 * 2 ** attempt); // eslint-disable-line no-await-in-loop
        continue;
      }
      let json = {};
      try { json = await res.json(); } catch (_) { /* not JSON */ }
      return { status: res.status, body: json || {} };
    }
  };

  let { status, body } = await call('POST', '/v1/run', { provider: 'tikhub', endpoint, input: { queryParams: query } });
  let waited = 0;
  while (status === 202 || (status === 200 && !TERMINAL.has(body.status))) {
    if (!body.runId || waited > maxWaitMs) throw new MonidError(`${endpoint}: run did not finish`, status);
    await wait(pollMs); // eslint-disable-line no-await-in-loop
    waited += pollMs;
    ({ status, body } = await call('GET', `/v1/runs/${encodeURIComponent(body.runId)}`)); // eslint-disable-line no-await-in-loop
  }
  const reason = body.reason || body.error || body.status || `HTTP ${status}`;
  if (body.status === 'BLOCKED') throw new MonidError(`${endpoint}: blocked by Monid: ${reason}`, status);
  const provider = body.providerResponse && body.providerResponse.httpStatus;
  if (body.status === 'COMPLETED' && provider != null && !(provider >= 200 && provider < 300)) {
    throw new MonidError(`${endpoint}: provider HTTP ${provider}`, Number(provider));
  }
  if (body.status !== 'COMPLETED' || status >= 400) throw new MonidError(`${endpoint}: ${reason}`, status);
  const costUsd = costOf(body, endpoint);
  charge(costUsd);
  return { output: body.output || {}, costUsd };
}

function costOf(res, endpoint) {
  const billing = res.billing || {};
  for (let v of [billing.actualCost, billing.calculatedCost, res.cost]) {
    if (v && typeof v === 'object') v = v.value;
    if (typeof v === 'number') return v;
  }
  return PRICE[endpoint] || 0;
}

const ids = (v) => new Set((Array.isArray(v) ? v : []).map((x) => String(x)));

/** Pinned by this creator (left out, as creator-list does): only their own ID in the pinned lists. */
function pinnedBy(it, userId) {
  if ('clips_tab_pinned_user_ids' in it || 'timeline_pinned_user_ids' in it) {
    const all = new Set([...ids(it.clips_tab_pinned_user_ids), ...ids(it.timeline_pinned_user_ids)]);
    return all.has(String(userId));
  }
  const owner = String((it.user && (it.user.id || it.user.pk)) || '');
  return !!it.is_pinned && owner === String(userId);
}

/** Trial Reels are shown to non-followers only; left out, as creator-list does. */
function isTrial(it) {
  return it.clips_trial != null || !!it.is_trial_reel;
}

const MIN_COVER_WIDTH = 320;
/** The smallest cover at least MIN_COVER_WIDTH wide, else the largest (creator-list's media.thumb_url). */
function thumbUrl(it) {
  const found = (((it.image_versions2 || {}).candidates) || []).filter((c) => c && c.url && c.width);
  if (found.length) {
    const wide = found.filter((c) => c.width >= MIN_COVER_WIDTH);
    const pick = wide.length ? wide.reduce((a, b) => (b.width < a.width ? b : a)) : found.reduce((a, b) => (b.width > a.width ? b : a));
    return String(pick.url);
  }
  return it.thumbnail_url || it.display_uri || null;
}

/** A Reels page's items as the rows Deal Studio labels. */
function parseReels(output) {
  const data = (output && output.data) || {};
  const items = (Array.isArray(data.items) ? data.items : []).filter((it) => it && typeof it === 'object' && it.code);
  return items.map((it) => {
    const cap = it.caption || {};
    const text = typeof cap === 'string' ? cap : (cap.text || '');
    const tags = Array.isArray(cap.hashtags) ? cap.hashtags.map((t) => String(t).replace(/^#/, '')) : [];
    const meta = it.clips_metadata || {};
    return {
      code: it.code,
      raw: it,
      caption: text,
      hashtags: tags,
      videoUrl: it.video_url || null,
      thumbUrl: thumbUrl(it),
      durationS: it.video_duration != null ? Number(it.video_duration) : null,
      originalAudio: meta.audio_type ? meta.audio_type === 'original_sounds' : null,
      hasAudio: it.has_audio != null ? !!it.has_audio : null,
    };
  });
}

/** The creator's card: user ID and country (a hidden country is unknown). */
async function fetchCard(handle, opts = {}) {
  const { output, costUsd } = await run(CARD, { username: handle }, opts);
  const d = (output && output.data) || {};
  if (!d.username) throw new MonidError('card: no user in the response', 404);
  const about = d.about || {};
  const countryText = String(about.country || '').trim();
  return {
    userId: String(d.id || d.pk || about.id || ''),
    bio: d.biography || '',
    followers: d.follower_count != null ? Number(d.follower_count) : null,
    // The country's name as Instagram shows it ("United States"); hidden is unknown.
    country: countryText && countryText.toLowerCase() !== HIDDEN_COUNTRY ? countryText : null,
    costUsd,
  };
}

/**
 * The newest `limit` Reels on one page, leaving out the ones the creator pinned and trial
 * Reels, as creator-list's collection does. Returns { reels, costUsd }.
 */
async function fetchReels(handle, { limit = 12, userId = null, ...opts } = {}) {
  const query = userId ? { user_id: userId } : { username: handle };
  const { output, costUsd } = await run(REELS, query, opts);
  const rows = parseReels(output);
  const owner = userId || (rows[0] && String((rows[0].raw.user || {}).id || (rows[0].raw.user || {}).pk || ''));
  const kept = rows.filter((r) => !isTrial(r.raw) && !(owner && pinnedBy(r.raw, owner)));
  return { reels: kept.slice(0, limit), costUsd };
}

module.exports = {
  run, fetchCard, fetchReels, parseReels, pinnedBy, isTrial, thumbUrl, configured, walletState, _resetWallet,
  spentToday, dailyCap, _resetLedger,
  MonidError, CARD, REELS, EMPTY_PAUSE_MS,
};
