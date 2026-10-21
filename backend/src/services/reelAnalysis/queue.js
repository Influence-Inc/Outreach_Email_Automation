'use strict';

// Runs Reel analyses one creator at a time in the background (each takes a few minutes: Apify,
// Whisper and Jev calls). State lives in creator_reel_analysis, so a restart resumes the queue.
//
// Settings (environment):
//   REEL_ANALYSIS_AUTO          'false' turns off the automatic run when the extension
//                               scrapes a creator (the panel's button still works)
//   REEL_ANALYSIS_REELS         Reels per creator (default 30, as creator-list)
//   REEL_ANALYSIS_MAX_PER_DAY   automatic runs a day (default 100; about $0.03-0.05 each)
//   REEL_ANALYSIS_MAX_AGE_DAYS  re-analyse automatically after this many days (default 30)

const db = require('../../db');
const { analyzeCreator } = require('./analyze');
const providers = require('./providers');
const { KEY_ENV } = require('./jev');
const { computeOffers } = require('../pricing');
const { dealCpmFor } = require('../cpmEstimate');

const HANDLE = /^[a-z0-9._]{1,30}$/;
const num = (name, dflt) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};

function missingKeys() {
  return [['APIFY_TOKEN', process.env.APIFY_TOKEN], ['GROQ_API_KEY', process.env.GROQ_API_KEY], [KEY_ENV, process.env[KEY_ENV]]]
    .filter(([, v]) => !v).map(([k]) => k);
}

const clean = (h) => String(h || '').trim().replace(/^@/, '').toLowerCase();

let running = false;
let deps = { analyzeCreator, providers };

async function status(handle) {
  const h = clean(handle);
  if (!h) return null;
  return db.one(
    `SELECT handle, status, progress, error, cost_usd, requested_at, started_at, finished_at,
            analysis->>'as_of' AS as_of
       FROM creator_reel_analysis WHERE handle = $1`,
    [h],
  );
}

// Queue a creator. `force` re-runs a finished analysis. Returns the status row, or
// { error } when the creator can't be analysed here.
async function enqueue(handle, { force = false } = {}) {
  const h = clean(handle);
  if (!HANDLE.test(h)) return { error: 'not a valid Instagram handle' };
  const missing = missingKeys();
  if (missing.length) return { error: `Set ${missing.join(', ')} on the server to analyse Reels` };
  await db.query(
    `INSERT INTO creator_reel_analysis (handle, status, requested_at) VALUES ($1, 'queued', NOW())
     ON CONFLICT (handle) DO UPDATE SET status = 'queued', error = NULL, progress = NULL, requested_at = NOW()
      WHERE creator_reel_analysis.status NOT IN ('queued', 'running')
        AND ($2 OR creator_reel_analysis.status = 'failed')`,
    [h, force],
  );
  kick();
  return status(h);
}

// The extension just scraped this creator: analyse their Reels if never done, or done long ago.
async function autoEnqueue(handle) {
  if (String(process.env.REEL_ANALYSIS_AUTO || 'true').toLowerCase() === 'false') return null;
  if (missingKeys().length) return null;
  const h = clean(handle);
  if (!HANDLE.test(h)) return null;
  const row = await status(h);
  const maxAge = num('REEL_ANALYSIS_MAX_AGE_DAYS', 30) * 86400000;
  if (row && (['queued', 'running'].includes(row.status) || row.status === 'failed'
    || (row.finished_at && Date.now() - new Date(row.finished_at).getTime() < maxAge))) return row;
  const today = await db.one(
    `SELECT COUNT(*)::int AS n FROM creator_reel_analysis WHERE started_at >= date_trunc('day', NOW())`,
  );
  if (today && today.n >= num('REEL_ANALYSIS_MAX_PER_DAY', 100)) return row;
  return enqueue(h, { force: true });
}

async function knownAccounts(handles) {
  if (!handles.length) return {};
  const rows = await db.many(
    `SELECT handle, country_name, transparency_status, followers, verified, found
       FROM instagram_accounts WHERE handle = ANY($1)`,
    [handles],
  );
  return Object.fromEntries(rows.map((r) => [r.handle, { ...r, followers: r.followers != null ? Number(r.followers) : null }]));
}

async function saveAccounts(accounts) {
  for (const [h, a] of Object.entries(accounts || {})) {
    await db.query(
      `INSERT INTO instagram_accounts (handle, country_name, transparency_status, followers, verified, found, observed_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (handle) DO UPDATE SET country_name = EXCLUDED.country_name,
         transparency_status = EXCLUDED.transparency_status, followers = EXCLUDED.followers,
         verified = EXCLUDED.verified, found = EXCLUDED.found, observed_at = NOW()`,
      [h, a.country_name, a.transparency_status, a.followers, a.verified, Boolean(a.found)],
    );
  }
}

// What pricing needs from an analysis (cpmEstimate.estimateForCreator), small enough to sit on
// every creators row: per Reel only the date, views, P3 decision, P4 brand and P5 labels.
function pricingCopy(a) {
  return {
    version: a.version,
    as_of: a.as_of,
    account: { instagram_country: a.account ? a.account.instagram_country : null },
    brand_sizes: a.brand_sizes || {},
    counts: a.counts || null,
    reels: a.reels.map((r) => ({
      post_id: r.post_id,
      published_at: r.published_at,
      plays: r.plays,
      p3: { decision: r.p3.decision },
      p4: { sponsor_brand: r.p4 ? r.p4.sponsor_brand : null },
      p5: r.p5 ? Object.fromEntries(Object.entries(r.p5).map(([k, v]) => [k, { value: v.value }])) : null,
    })),
  };
}

// Copy the analysis onto the creator's rows and re-price their suggested offers at the new
// Estimated CPM (rows with an admin CPM keep theirs).
async function applyToCreators(handle, analysis) {
  const rows = await db.many(
    `UPDATE creators SET reel_analysis = $2::jsonb, updated_at = NOW()
      WHERE lower(instagram_username) = $1 RETURNING *`,
    [handle, JSON.stringify(pricingCopy(analysis))],
  );
  for (const row of rows) {
    if (!row.ig_scraped_data || row.deal_cpm != null) continue;
    const quoted = row.quoted_rate != null ? Number(row.quoted_rate) : null;
    const offers = computeOffers(row.ig_scraped_data, dealCpmFor(row).cpm, quoted);
    await db.query(`UPDATE creators SET suggested_offers = $2::jsonb WHERE id = $1`, [row.id, JSON.stringify(offers)]);
  }
  return rows.length;
}

async function runOne() {
  const job = await db.one(
    `UPDATE creator_reel_analysis SET status = 'running', started_at = NOW(), progress = NULL, error = NULL
      WHERE handle = (SELECT handle FROM creator_reel_analysis WHERE status = 'queued'
                       ORDER BY requested_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING handle`,
  );
  if (!job) return false;
  const h = job.handle;
  let lastProgress = 0;
  try {
    let looked = {};
    const analysis = await deps.analyzeCreator(h, {
      reels: num('REEL_ANALYSIS_REELS', 30),
      knownAccounts,
      providers: {
        ...deps.providers,
        lookupAccounts: async (todo) => {
          const out = await deps.providers.lookupAccounts(todo);
          looked = out.accounts;
          return out;
        },
      },
      onProgress: (p) => {
        if (Date.now() - lastProgress < 3000 && p.step === 'analysing' && p.done !== p.total) return;
        lastProgress = Date.now();
        db.query(`UPDATE creator_reel_analysis SET progress = $2 WHERE handle = $1`, [h, p]).catch(() => {});
      },
    });
    await saveAccounts(looked);
    await db.query(
      `UPDATE creator_reel_analysis SET status = 'done', analysis = $2::jsonb, cost_usd = $3,
              progress = NULL, finished_at = NOW() WHERE handle = $1`,
      [h, JSON.stringify(analysis), analysis.cost_usd.total],
    );
    await applyToCreators(h, analysis);
  } catch (e) {
    console.error(`[reel-analysis] @${h} failed:`, e.message);
    await db.query(
      `UPDATE creator_reel_analysis SET status = 'failed', error = $2, progress = NULL, finished_at = NOW() WHERE handle = $1`,
      [h, String(e.message || e).slice(0, 500)],
    );
  }
  return true;
}

function kick() {
  if (running) return;
  running = true;
  (async () => {
    try {
      while (await runOne()) { /* next */ }
    } catch (e) {
      console.error('[reel-analysis] queue stopped:', e.message);
    } finally {
      running = false;
    }
  })();
}

// On boot: analyses a restart cut off go back in the queue.
async function recover() {
  await db.query(`UPDATE creator_reel_analysis SET status = 'queued' WHERE status = 'running'`);
  kick();
}

// Tests swap the analysis and providers.
const _setDeps = (d) => { deps = { ...deps, ...d }; };
const _idle = async () => { while (running) await new Promise((r) => setTimeout(r, 10)); };

module.exports = { enqueue, autoEnqueue, status, recover, kick, applyToCreators, pricingCopy, missingKeys, _setDeps, _idle };
