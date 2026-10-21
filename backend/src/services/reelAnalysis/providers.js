'use strict';

// The outside services creator-list's pipeline uses, with its settings:
//   - Apify instagram-scraper/instagram-profile-reels-scraper (eO62VlcRQs1OfFwHW): the newest
//     Reels of a creator, pinned and trial Reels excluded       (creator-lab lib/providers.mjs)
//   - Apify data-slayer/instagram-user-info-scraper-cookieless: Instagram's "Account based in"
//     country of the creator, and brands' follower counts        (tools/collect_countries.py,
//                                                                 tools/collect_brand_sizes.py)
//   - ffmpeg -> 16 kHz mono FLAC -> Groq whisper-large-v3-turbo  (creator-lab transcribe)
//   - Tesseract OCR of the Reel's thumbnail                      (enrichment/classify/ocr.py)
// Keys come from APIFY_TOKEN and GROQ_API_KEY and are never logged.

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { isTrial, isPinned, toReelRow, PINNED_MAX } = require('./reels');

const exec = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const APIFY = 'https://api.apify.com/v2';
const REEL_ACTOR = 'eO62VlcRQs1OfFwHW';
const USER_INFO_ACTOR = 'data-slayer~instagram-user-info-scraper-cookieless';
const GROQ = { model: 'whisper-large-v3-turbo', endpoint: 'https://api.groq.com/openai/v1/audio/transcriptions' };
const HANDLE = /^[a-z0-9._]{1,30}$/;

const keys = () => ({ apify: process.env.APIFY_TOKEN || '', groq: process.env.GROQ_API_KEY || '' });

class NoAudioTrackError extends Error {
  constructor() {
    super('No audio track in the available media.');
    this.name = 'NoAudioTrackError';
  }
}

// Redact anything key-like from a provider's error text before it is stored.
const redact = (s) => String(s || '')
  .replace(/https?:\/\/\S+/g, '[provider link]')
  .replace(/(?:gsk_|apify_api_|sk-or-)[A-Za-z0-9_-]+/g, '[redacted]')
  .slice(0, 300);

async function request(url, options = {}, { service = 'Service', retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { ...options, signal: AbortSignal.timeout(options.timeoutMs || 90000) });
    } catch {
      if (attempt >= retries) throw new Error(`${service}: connection failed or timed out`);
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (res.ok) return res;
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const after = Number(res.headers.get('retry-after'));
      await sleep(Math.min(60000, Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * 2 ** attempt));
      continue;
    }
    let detail = '';
    try { const j = await res.json(); detail = (j.error && (j.error.message || j.error)) || j.detail || ''; } catch { /* body not JSON */ }
    const err = new Error(`${service}: HTTP ${res.status}${detail ? ` ${redact(detail)}` : ''}`);
    err.status = res.status;
    throw err;
  }
}

const apifyAuth = () => ({ Authorization: `Bearer ${keys().apify}` });
const apifyJson = async (url, body) => (await request(url, body === undefined
  ? { headers: apifyAuth() }
  : { method: 'POST', headers: { ...apifyAuth(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
{ service: 'Apify' })).json();

const DONE = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']);
async function waitRun(run, { maxWaitMs = 10 * 60 * 1000 } = {}) {
  const started = Date.now();
  while (!DONE.has(run.status)) {
    if (Date.now() - started > maxWaitMs) throw new Error('Apify run took too long');
    await sleep(2500);
    run = (await apifyJson(`${APIFY}/actor-runs/${encodeURIComponent(run.id)}`)).data;
  }
  return run;
}

async function datasetItems(id, limit = 1000) {
  const rows = [];
  for (let offset = 0; offset < limit; offset += 250) {
    const page = await apifyJson(`${APIFY}/datasets/${encodeURIComponent(id)}/items?clean=true&format=json&offset=${offset}&limit=250`);
    if (!Array.isArray(page)) throw new Error('Invalid Apify dataset');
    rows.push(...page);
    if (page.length < 250) break;
  }
  return rows;
}

// The creator's newest `limit` Reels (pinned and trial Reels excluded, collab Reels kept), in
// the reel-scraper row shape. Returns { rows, cost_usd, status }.
async function scrapeReels(handle, { limit = 30, budgetUsd = 0.1 } = {}) {
  if (!keys().apify) throw new Error('APIFY_TOKEN is not set');
  let run = (await apifyJson(
    `${APIFY}/acts/${REEL_ACTOR}/runs?maxTotalChargeUsd=${budgetUsd}`,
    { instagramUsernames: [handle], postsPerProfile: limit + PINNED_MAX },
  )).data;
  run = await waitRun(run);
  const raw = await datasetItems(run.defaultDatasetId, limit + PINNED_MAX + 50);
  const rows = raw.filter((r) => !isTrial(r) && !isPinned(r)).map(toReelRow).slice(0, limit);
  // Charges settle a little after SUCCEEDED; one re-read is enough for the record.
  try {
    await sleep(5000);
    run = (await apifyJson(`${APIFY}/actor-runs/${encodeURIComponent(run.id)}`)).data;
  } catch { /* keep the first reading */ }
  return { rows, cost_usd: typeof run.usageTotalUsd === 'number' ? run.usageTotalUsd : null, status: run.status };
}

// Instagram's "About this account" facts for handles: { handle: {country_name, followers,
// verified, found} }, one Apify run for all of them.
async function lookupAccounts(handles, { capUsd } = {}) {
  const todo = [...new Set(handles.map((h) => String(h).toLowerCase().replace(/^@/, '')))].filter((h) => HANDLE.test(h));
  if (!todo.length) return { accounts: {}, cost_usd: 0 };
  if (!keys().apify) throw new Error('APIFY_TOKEN is not set');
  const cap = capUsd || Math.round((0.006 * todo.length + 0.01) * 1000) / 1000;
  let run = (await apifyJson(
    `${APIFY}/acts/${USER_INFO_ACTOR}/runs?maxTotalChargeUsd=${cap}&waitForFinish=240`,
    { usernames: todo, mode: 'basic' },
  )).data;
  run = await waitRun(run);
  const rows = await datasetItems(run.defaultDatasetId, todo.length + 10);
  const by = new Map(rows.map((r) => [String(r.username || '').toLowerCase(), r]));
  const accounts = {};
  for (const h of todo) {
    const r = by.get(h);
    // Only the country and size facts are kept; the actor's other fields (emails, phones) are not.
    accounts[h] = {
      country_name: (r && (r.account_country || (r.about || {}).country)) || null,
      transparency_status: (r && r.transparency_status) || null,
      followers: r && r.follower_count != null ? Number(r.follower_count) : null,
      verified: r ? r.is_verified ?? null : null,
      found: Boolean(r),
    };
  }
  return { accounts, cost_usd: typeof run.usageTotalUsd === 'number' ? run.usageTotalUsd : null };
}

// --- Media --------------------------------------------------------------------------------

const MEDIA_DOMAINS = ['cdninstagram.com', 'fbcdn.net', 'apifyusercontent.com'];
function mediaURL(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('No usable media URL'); }
  const h = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || u.username || u.password || !MEDIA_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`))) {
    throw new Error('Media URL must come from Instagram or Apify CDN');
  }
  return u.href;
}

async function download(raw, maxBytes = 80 * 1024 * 1024) {
  let url = mediaURL(raw);
  for (let i = 0; i < 4; i++) {
    const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(60000) });
    if (r.status >= 300 && r.status < 400) {
      url = mediaURL(new URL(r.headers.get('location'), url).href);
      if (r.body) await r.body.cancel();
      continue;
    }
    if (!r.ok) throw new Error(`Media download failed (${r.status})`);
    const chunks = [];
    let total = 0;
    for await (const chunk of r.body) {
      total += chunk.length;
      if (total > maxBytes) throw new Error('Media exceeds download size limit');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  throw new Error('Too many media redirects');
}

const tmpBase = () => path.join(os.tmpdir(), `reel-${crypto.randomUUID()}`);

// Video -> 16 kHz mono FLAC (Groq gets uploaded audio, never a media URL: its own fetch of
// Instagram's CDN times out for some Reels).
async function prepareAudio(reel) {
  const urls = [...new Set([reel.audio_url, reel.video_url].filter(Boolean))];
  let lastError;
  let noAudio = 0;
  for (const url of urls) {
    const base = tmpBase();
    try {
      await fs.writeFile(`${base}.media`, await download(url), { mode: 0o600 });
      const probe = await exec('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', `${base}.media`], { timeout: 15000 });
      const streams = JSON.parse(probe.stdout).streams;
      if (!Array.isArray(streams)) throw new Error('Could not inspect source audio');
      if (!streams.some((s) => s.codec_type === 'audio')) { noAudio++; throw new NoAudioTrackError(); }
      try {
        await exec('ffmpeg', ['-y', '-v', 'error', '-i', `${base}.media`, '-vn', '-ar', '16000', '-ac', '1', `${base}.flac`], { timeout: 60000, maxBuffer: 1024 * 1024 });
      } catch {
        throw new Error('No usable audio track');
      }
      const audio = await fs.readFile(`${base}.flac`);
      if (audio.length > 25 * 1024 * 1024) throw new Error('Audio exceeds upload limit');
      return audio;
    } catch (e) {
      lastError = e;
    } finally {
      await Promise.allSettled([fs.unlink(`${base}.media`), fs.unlink(`${base}.flac`)]);
    }
  }
  if (urls.length && noAudio === urls.length) throw new NoAudioTrackError();
  throw lastError || new Error('No usable media URL');
}

// { text, language, segments, duration, cost_usd }. Throws NoAudioTrackError for silent media.
async function transcribe(reel) {
  if (!keys().groq) throw new Error('GROQ_API_KEY is not set');
  const audio = await prepareAudio(reel);
  const form = new FormData();
  form.append('model', GROQ.model);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');
  form.append('temperature', '0');
  form.append('file', new Blob([audio], { type: 'audio/flac' }), 'audio.flac');
  const raw = await (await request(GROQ.endpoint, {
    method: 'POST', headers: { Authorization: `Bearer ${keys().groq}` }, body: form,
  }, { service: 'Groq' })).json();
  const duration = Number.isFinite(raw.duration) ? raw.duration : reel.duration_s || null;
  return {
    text: typeof raw.text === 'string' ? raw.text : '',
    language: raw.language || null,
    segments: Array.isArray(raw.segments) ? raw.segments : [],
    duration,
    // Groq bills at least 10 s per request, $0.04 an hour.
    cost_usd: duration == null ? null : (Math.max(10, duration) / 3600) * 0.04,
  };
}

// Thumbnail text: Tesseract's lines with spaces collapsed, lines with fewer than 3 letters
// dropped (ocr.py: Tesseract emits noise on photos). The image is deleted after reading.
async function thumbnailText(url) {
  if (!url) return '';
  const base = tmpBase();
  try {
    await fs.writeFile(`${base}.img`, (await download(url, 15 * 1024 * 1024)).subarray(0, 8 * 1024 * 1024), { mode: 0o600 });
    const { stdout } = await exec('tesseract', [`${base}.img`, 'stdout', '-l', 'eng', '--psm', '11'], {
      timeout: 120000, env: { ...process.env, OMP_THREAD_LIMIT: '1' }, maxBuffer: 1024 * 1024,
    });
    return stdout.split(/\r\n|\r|\n/).map((l) => l.split(/\s+/).filter(Boolean).join(' '))
      .filter((l) => (l.match(/\p{L}/gu) || []).length >= 3).join('\n');
  } finally {
    await fs.unlink(`${base}.img`).catch(() => {});
  }
}

module.exports = {
  REEL_ACTOR, USER_INFO_ACTOR, GROQ, NoAudioTrackError,
  scrapeReels, lookupAccounts, mediaURL, prepareAudio, transcribe, thumbnailText,
};
