'use strict';

// One creator, end to end, the way creator-list's tools/run_request.py + run_real.py do it:
//   1. Apify: the newest 30 Reels (pinned and trial excluded)           -> P1/P2
//   2. per Reel: thumbnail OCR (Tesseract), video -> FLAC -> Whisper     -> on-screen text, speech
//   3. per Reel: Jev collaboration + brand (P3/P4), Jev topic/niche/genre/format (P5)
//   4. Apify: Instagram's "Account based in" country of the creator, and the follower counts of
//      the brands they did deals with (the "major brands" sticker)
// The result is a compact document (no captions or transcripts are kept: only labels, counts and
// the evidence the panel shows) that cpmEstimate.estimateForCreator prices from.

const providersDefault = require('./providers');
const { JevClient } = require('./jev');
const { fromApify, handle: cleanHandle } = require('./reels');
const sponsorship = require('./sponsorship');
const content = require('./content');

const VERSION = '1.0';
const MAJOR_FIELDS = ['topic', 'niche', 'genre', 'format'];

// Groq allows ~20 requests a minute on the base plan: space transcription starts.
function pacer(perMinute = 20) {
  const interval = 60000 / perMinute + 100;
  let next = 0;
  let tail = Promise.resolve();
  return () => {
    const turn = tail.then(async () => {
      const wait = next - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      next = Date.now() + interval;
    });
    tail = turn.catch(() => {});
    return turn;
  };
}

async function eachLimit(items, limit, fn) {
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

const brief = (sig) => sig.map((s) => ({ kind: s.kind, strength: s.strength, value: s.value }));

// `opts.providers` / `opts.jev` are injectable for tests. `opts.knownAccounts(handles)` returns
// cached account facts { handle: {country_name, followers} } so a brand is looked up once.
async function analyzeCreator(handleRaw, opts = {}) {
  const providers = opts.providers || providersDefault;
  const jev = opts.jev || new JevClient();
  const limit = opts.reels || 30;
  const handle = cleanHandle(handleRaw);
  const onProgress = opts.onProgress || (() => {});
  const cost = { apify_reels: 0, apify_accounts: 0, groq: 0, jev: 0 };
  const started = Date.now();

  onProgress({ step: 'collecting' });
  const scrape = await providers.scrapeReels(handle, { limit, budgetUsd: opts.budgetUsd || 0.1 });
  cost.apify_reels = scrape.cost_usd || 0;
  const seen = new Set();
  const reels = [];
  for (const row of scrape.rows) {
    if (!row.shortCode || seen.has(row.shortCode)) continue;
    seen.add(row.shortCode);
    reels.push(fromApify(row, handle));
  }
  if (!reels.length) throw new Error(`Apify returned no Reels for @${handle} (${scrape.status || 'no status'})`);
  const asOf = new Date();

  const paced = pacer(opts.groqRpm || 20);
  let done = 0;
  const results = new Array(reels.length);
  await eachLimit(reels, opts.concurrency || 4, async (r, idx) => {
    try {
      r.ocr_text = await providers.thumbnailText(r.thumbnail_url);
    } catch {
      r.ocr_text = '';
    }
    if (r.video_url || r.audio_url) {
      try {
        await paced();
        const t = await providers.transcribe(r);
        cost.groq += t.cost_usd || 0;
        if (t.text && t.text.trim()) {
          r.transcript = t.text;
          r.transcript_language = t.language;
          r.transcript_status = t.text.trim().split(/\s+/).length < 6 ? 'no_speech' : 'complete';
        } else {
          r.transcript_status = 'no_speech';
        }
      } catch (e) {
        r.transcript_status = e && e.name === 'NoAudioTrackError' ? 'no_audio' : 'failed';
      }
    }
    const [det, c] = await Promise.all([sponsorship.detect(r, jev), content.classify(r, jev)]);
    cost.jev += (det.cost_usd || 0) + (c.cost_usd || 0);
    results[idx] = { r, det, c };
    done++;
    onProgress({ step: 'analysing', done, total: reels.length });
  });

  // Country of the creator and sizes of the brands they worked with, one lookup run.
  const brands = [...new Set(results
    .filter((x) => x.det.sponsorship.decision === 'COLLABORATED' && x.det.brand.sponsor_brand)
    .map((x) => x.det.brand.sponsor_brand.toLowerCase().replace(/^@/, '')))];
  const cached = opts.knownAccounts ? await opts.knownAccounts([handle, ...brands]) : {};
  const todo = [handle, ...brands].filter((h) => !cached[h]);
  let looked = {};
  let lookupError = null;
  if (todo.length) {
    onProgress({ step: 'looking_up_accounts' });
    try {
      const out = await providers.lookupAccounts(todo);
      looked = out.accounts;
      cost.apify_accounts = out.cost_usd || 0;
    } catch (e) {
      lookupError = e.message;
    }
  }
  const accounts = { ...cached, ...looked };
  const me = accounts[handle] || {};
  const brandSizes = {};
  for (const b of brands) brandSizes[b] = accounts[b] && accounts[b].found ? accounts[b].followers ?? null : null;

  const reelDocs = results.map(({ r, det, c }) => ({
    post_id: r.post_id,
    url: r.url,
    owner: r.owner,
    published_at: r.published_at ? r.published_at.toISOString() : null,
    plays: r.plays,
    likes: r.likes,
    comments: r.comments,
    duration_s: r.duration_s,
    paid_partnership: r.paid_partnership,
    transcript_status: r.transcript_status,
    transcript_language: r.transcript_language || null,
    has_on_screen_text: Boolean(r.ocr_text),
    p3: {
      decision: det.sponsorship.decision,
      confidence: det.sponsorship.confidence,
      decided_by: det.sponsorship.decided_by,
      commercial_class: det.sponsorship.commercial_class,
      signals: brief(det.sponsorship.signals),
      error: det.sponsorship.error || null,
    },
    p4: { sponsor_brand: det.brand.sponsor_brand, method: det.brand.method },
    p5: c.attributes
      ? Object.fromEntries(MAJOR_FIELDS.filter((k) => c.attributes[k]).map((k) => [k, c.attributes[k]]))
      : null,
    p5_used_speech: c.used_speech,
    p5_error: c.error || null,
  }));
  const total = Object.values(cost).reduce((a, b) => a + b, 0);
  return {
    version: VERSION,
    taxonomy_version: content.TAXONOMY_VERSION,
    handle,
    as_of: asOf.toISOString(),
    reels: reelDocs,
    account: {
      instagram_country: me.country_name || null,
      transparency_status: me.transparency_status || null,
      followers: me.followers ?? null,
      lookup_error: lookupError,
    },
    brand_sizes: brandSizes,
    counts: {
      reels: reelDocs.length,
      transcribed: reelDocs.filter((x) => x.transcript_status === 'complete').length,
      no_audio: reelDocs.filter((x) => x.transcript_status === 'no_audio').length,
      transcript_failed: reelDocs.filter((x) => x.transcript_status === 'failed').length,
      with_on_screen_text: reelDocs.filter((x) => x.has_on_screen_text).length,
      classified: reelDocs.filter((x) => x.p5).length,
      brand_deals: reelDocs.filter((x) => x.p3.decision === 'COLLABORATED').length,
      jev_errors: reelDocs.filter((x) => x.p3.decided_by === 'jev_error' || x.p5_error).length,
    },
    cost_usd: { ...Object.fromEntries(Object.entries(cost).map(([k, v]) => [k, Number(v.toFixed(5))])), total: Number(total.toFixed(5)) },
    seconds: Math.round((Date.now() - started) / 1000),
  };
}

module.exports = { VERSION, analyzeCreator, pacer };
