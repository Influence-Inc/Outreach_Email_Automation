'use strict';

// Scout Creators — companion page for automated Instagram sourcing. Talks to the
// /api/sourcing/* endpoints (behind the same Slack/site-auth cookie as the
// dashboard). Set the scouting rules, start a run, and watch
// candidates get scored + added. In Phase 1 (no phone yet) the "Feed sample
// captures" button exercises the whole pipeline in the browser.

const API = '';
let currentRun = null;
let pollTimer = null;

function el(id) { return document.getElementById(id); }

async function api(path, options = {}) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (res.status === 401) {
    window.location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
    throw new Error('Session expired');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `${res.status} ${res.statusText}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

function setStatus(msg, kind) {
  const s = el('status');
  s.textContent = msg || '';
  s.className = 'scout-status' + (kind ? ' ' + kind : '');
}

function fmt(n) {
  if (n == null || n === '' || Number.isNaN(Number(n))) return '—';
  const v = Number(n);
  if (v >= 1e6) return (v / 1e6).toFixed(v % 1e6 ? 1 : 0) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(v % 1e3 ? 1 : 0) + 'K';
  return String(v);
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

// A sourced handle rendered as a link to the creator's Instagram profile, opened
// in a new tab. The handle is scraped off-screen, so it is escaped for the visible
// text and URL-encoded for the href even though Instagram usernames are meant to
// be [a-z0-9._] only — the reader can misread, and a broken handle should not
// break the row or the link.
function handleLink(username) {
  const handle = String(username || '').replace(/^@/, '').trim();
  if (!handle) return '—';
  const url = `https://www.instagram.com/${encodeURIComponent(handle)}/`;
  return `<a href="${url}" target="_blank" rel="noopener">@${escapeHtml(handle)}</a>`;
}

// Colour the last-seen time by freshness: green < 2 min, amber < 1 h, grey older.
function seenFreshness(iso) {
  if (!iso) return '<span class="scout-hint">never</span>';
  const ageMs = Date.now() - new Date(iso).getTime();
  const dot = ageMs < 2 * 60 * 1000 ? '#067647' : ageMs < 60 * 60 * 1000 ? '#b25e09' : '#9ca3af';
  return `<span style="color:${dot}">●</span> ${new Date(iso).toLocaleString()}`;
}

// An empty field is sent as null, not left out. Saving defaults MERGES into
// what is stored (so settings this page does not show survive), and under a
// merge an omitted key keeps its old value — null is how a cleared field
// actually gets cleared.
function numOrNull(id) {
  const raw = el(id).value;
  if (raw === '' || raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// Settings the page no longer shows. Sent as null so a save removes what an
// older version of the page stored (defaults merge, and null is how a key is
// removed): the niche and brand details now live in the keywords and "what
// you're selling" fields, and the rest is decided by the backend — including
// the four switches every run needs (warm the feed, skip off-niche reels,
// screenshot pre-check, borderline → review), which are on whenever unset.
const RETIRED = {
  discovery: null,
  warmFeed: null,
  skipOffNicheReels: null,
  prescreenNiche: null,
  reviewBorderline: null,
  niche: null,
  brandBrief: null,
  floor: null,
  floorTolerance: null,
  ceiling: null,
  risk: null,
  reelsWindow: null,
  maxProfiles: null,
  jevAutoConfidence: null,
  jevRejectConfidence: null,
};

function readForm() {
  return {
    ...RETIRED,
    keywords: el('keywords').value.trim(),
    viralViews: numOrNull('viralViews'),
    targetCount: numOrNull('targetCount'),
    brandName: el('brandName').value.trim(),
    brandProduct: el('brandProduct').value.trim(),
  };
}

const listOf = (v) => (Array.isArray(v) ? v : String(v || '').split(','))
  .map((x) => String(x).trim())
  .filter(Boolean);

// One field, with no repeats: defaults saved by the older page may still
// carry a separate niche, which did the same job as the keywords.
function keywordsOf(cfg) {
  const seen = new Set();
  return [...listOf(cfg.keywords), ...listOf(cfg.niche)].filter((k) => {
    const key = k.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function fillForm(cfg) {
  cfg = cfg || {};
  el('keywords').value = keywordsOf(cfg).join(', ');
  el('viralViews').value = cfg.viralViews ?? '';
  el('targetCount').value = cfg.targetCount ?? '';
  el('brandName').value = cfg.brandName || '';
  // "What you're selling" and the older "Brand & product details", as one.
  el('brandProduct').value = [cfg.brandProduct, cfg.brandBrief].filter(Boolean).join('\n\n');
}

// Scouting is not done for a campaign: every shortlisted creator goes to
// creator-list, so the page keeps one set of saved defaults.
async function loadConfig() {
  try {
    const cfg = await api('/api/sourcing/config');
    fillForm(cfg);
  } catch (err) {
    setStatus(err.message, 'err');
  }
}

async function saveDefaults() {
  try {
    await api('/api/sourcing/config', {
      method: 'PATCH',
      body: JSON.stringify(readForm()),
    });
    setStatus('Saved as defaults.', 'ok');
  } catch (err) {
    setStatus(err.message, 'err');
  }
}

async function startRun() {
  try {
    setStatus('Starting run…');
    const run = await api('/api/sourcing/runs', {
      method: 'POST',
      body: JSON.stringify({
        // Empty means "any available device" — the run stays unpinned and the
        // first phone to ask for work takes it, which is how every run behaved
        // before the picker existed.
        host_id: el('runHost').value || null,
        config: readForm(),
      }),
    });
    currentRun = run;
    setStatus(`Run #${run.id} started.`, 'ok');
    el('run-card').hidden = false;
    await refreshRun();
    startPolling();
  } catch (err) {
    setStatus(err.message, 'err');
  }
}

async function stopRun() {
  if (!currentRun) return;
  try {
    await api(`/api/sourcing/runs/${currentRun.id}/stop`, { method: 'POST' });
    await refreshRun();
    stopPolling();
  } catch (err) {
    setStatus(err.message, 'err');
  }
}

// Phase 1 aid: post a representative batch of "captured" candidates so the whole
// scoring/dedup/add pipeline is visible in the browser without a phone.
async function feedMock() {
  if (!currentRun) return;
  const cap = 'Full home gym workout routine #homegym #fitness';
  // `viral` reels well over the bar, then `quiet` ones well under it.
  const reels = (viral, quiet, caption = cap) => [
    ...Array.from({ length: viral }, () => ({ views: 400000, caption })),
    ...Array.from({ length: quiet }, () => ({ views: 15000, caption })),
  ];
  const batch = [
    { username: 'home.fit.mia', full_name: 'Mia Fit', followers: 84000, bio: 'home fitness coach', reels: reels(6, 10) },
    { username: 'garage.gains', full_name: 'Garage Gains', followers: 9000, bio: 'gym at home, daily workout', reels: reels(3, 2) },
    { username: 'almost.ava', full_name: 'Ava', followers: 22000, bio: 'fitness', reels: reels(4, 12) },
    { username: 'wanderjoe', full_name: 'Joe Travels', followers: 130000, bio: 'budget travel & food', reels: reels(6, 10, 'cheap flights to bali') },
    { username: 'one.hit.vic', full_name: 'Vic', followers: 60000, bio: 'home gym tips', reels: reels(1, 11) },
  ];
  try {
    setStatus('Feeding sample captures…');
    await api(`/api/sourcing/runs/${currentRun.id}/candidates`, {
      method: 'POST',
      body: JSON.stringify({ candidates: batch }),
    });
    await refreshRun();
    setStatus('Sample captures scored.', 'ok');
  } catch (err) {
    setStatus(err.message, 'err');
  }
}

function viewRange(reels) {
  const vs = (reels || [])
    .map((r) => Number(r && r.views))
    .filter((v) => Number.isFinite(v));
  if (!vs.length) return '—';
  return `${fmt(Math.min(...vs))}–${fmt(Math.max(...vs))}`;
}

/** Jev's verdict on a candidate, wherever the evidence bundle put it. */
function jevOf(c) {
  const ev = (c && c.evidence) || {};
  return (ev.niche && ev.niche.jev) || null;
}

const labelText = (k) => (k ? String(k).replace(/_/g, ' ').replace(/^./, (ch) => ch.toUpperCase()) : '');

/**
 * One label, e.g. "Fitness 75%". Judged from the creator's Reels (creator-list's way) the
 * percentage is the share of their Reels; judged from one recorded reel it is Jev's
 * confidence. The next value is on hover.
 */
function labelCell(c, dim) {
  const j = jevOf(c);
  const l = j && j.labels && j.labels[dim];
  if (!l) return '—';
  const pct = l.confidence != null ? ` ${Math.round(l.confidence * 100)}%` : '';
  const what = l.share ? 'of their reels' : 'sure';
  const next = l.runnerUp ? `; next: ${labelText(l.runnerUp)}` : '';
  return `<span title="${escapeHtml(`${pct.trim()} ${what}${next}`)}">${escapeHtml(labelText(l.value))}${pct}</span>`;
}

/** What the labels were judged from, and the estimated audience — one hint line. */
function basisOf(c) {
  const j = jevOf(c);
  if (!j) return '';
  const cr = j.creator;
  const from = cr
    ? (cr.source === 'creator-list' ? `from creator-list (${cr.reels} reels)` : `from ${cr.labelled} of ${cr.reels} reels`)
    : 'from 1 recorded reel';
  const why = !cr && j.creatorNotLabelled ? ` title="${escapeHtml(j.creatorNotLabelled)}"` : '';
  const aud = j.audienceSummary ? ` · audience: ${escapeHtml(j.audienceSummary)}` : '';
  return `<br><span class="scout-hint"${why}>${escapeHtml(from)}${aud}</span>`;
}

/** Topic, with the niche under it when Jev placed one inside that topic. */
function topicCell(c) {
  const j = jevOf(c);
  const n = j && j.labels && j.labels.niche;
  const niche = n && !n.outsideTopic && !['unclear', 'other'].includes(n.value)
    ? `<br><span class="scout-hint">${escapeHtml(labelText(n.value))}</span>` : '';
  return labelCell(c, 'topic') + niche;
}

function fitOf(c) {
  const j = jevOf(c);
  return j && typeof j.fit === 'number' ? j.fit.toFixed(2) : '—';
}

/** Whether a shortlisted creator reached creator-list's admin collection. */
function creatorListOf(c) {
  const cl = c && c.evidence && c.evidence.creatorList;
  if (!cl) return c.decision === 'added' ? '—' : '';
  if (cl.status === 'added') return cl.already ? 'in collection' : 'added';
  return `<span title="${escapeHtml(cl.error || '')}" style="color:#b42318">${escapeHtml(cl.status)}</span>`;
}

/**
 * Why a row ended where it did: the reject reason, or — for a creator waiting
 * in review — what the reviewer is being asked to confirm.
 */
function reasonOf(c) {
  if (c.reject_reason) return c.reject_reason;
  if (c.decision === 'review' && c.evidence && c.evidence.reviewHold) return `held: ${c.evidence.reviewHold}`;
  return '';
}

/**
 * What the judge got from the recorded reel: words heard and frames read, or
 * why not — "34 words · 6 frames", "silent · 6 frames", "no recording".
 */
function reelOf(c) {
  const j = jevOf(c);
  if (!j) return '—';
  if (!j.hadVideo) return '<span style="color:#b42318" title="The phone did not deliver a recording of the reel">no recording</span>';
  const m = j.media;
  if (!m) return '—';
  const heard = m.audio === 'none' ? 'no audio'
    : m.audio === 'silent' ? 'silent'
      : `${m.words || 0} words`;
  const bad = m.audio === 'none' || m.audio === 'silent' || !m.framesRead || (m.errors && m.errors.length);
  const title = [
    `audio: ${m.audio}${m.maxVolumeDb != null ? ` (peak ${m.maxVolumeDb} dB)` : ''}`,
    `frames read: ${m.framesRead || 0} of ${m.framesCut || 0}`,
    ...(m.errors || []),
  ].join('\n');
  return `<span title="${escapeHtml(title)}"${bad ? ' style="color:#b25e09"' : ''}>${heard} · ${m.framesRead || 0} frames</span>`;
}

/** "5/16" — reels that reached the viral bar, of the reels read; the rule on hover. */
function viralOf(c) {
  const v = c && c.evidence && c.evidence.viral;
  if (!v) return '—';
  const color = v.pass ? '#067647' : (v.borderline ? '#b25e09' : '#b42318');
  return `<span title="${escapeHtml(v.reason || '')}" style="color:${color};font-weight:600">${v.viral}/${v.reels}</span>`;
}

function renderCandidates(rows) {
  const tb = el('cand-rows');
  tb.innerHTML = '';
  for (const c of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${handleLink(c.username)}</td>
      <td>${viewRange(c.reels)}</td>
      <td>${topicCell(c)}${basisOf(c)}</td>
      <td>${labelCell(c, 'genre')}</td>
      <td>${labelCell(c, 'format')}</td>
      <td>${fitOf(c)}</td>
      <td>${viralOf(c)}</td>
      <td>${reelOf(c)}</td>
      <td><span class="pill ${c.decision}">${c.decision}</span></td>
      <td>${escapeHtml(reasonOf(c))}</td>
      <td>${creatorListOf(c)}</td>`;
    tb.appendChild(tr);
  }
}

// "gemini-profile 9 · claude-profile 2 · keyword 1" — which judge gave each
// verdict. A run with no gemini-* entry never had a reel watched.
function judgesSummary(judgedBy) {
  const entries = Object.entries(judgedBy || {});
  if (!entries.length) return '—';
  return entries.map(([k, n]) => `${k} ${n}`).join(' · ');
}

async function refreshRun() {
  if (!currentRun) return;
  const { run, candidates } = await api(`/api/sourcing/runs/${currentRun.id}`);
  currentRun = run;
  const stats = run.stats || {};
  el('run-id').textContent = `#${run.id}`;
  el('run-status').textContent = run.status;
  el('run-found').textContent = run.found_count ?? 0;
  el('run-target').textContent = run.target_count ?? 0;
  el('run-scanned').textContent = stats.scanned || candidates.length || 0;
  // withVideo of all judgements. "0 of 12" on a live run means the phone is
  // recording nothing — screen capture was never granted, or Android stopped it.
  const judged = (stats.withVideo || 0) + (stats.withoutVideo || 0);
  el('run-video').textContent = judged ? `${stats.withVideo || 0} of ${judged}` : '—';
  el('run-video').style.color = judged && !stats.withVideo ? '#b42318' : '';
  el('run-judges').textContent = judgesSummary(stats.judgedBy);
  el('run-phase').textContent = phaseOf(stats.discovery);
  const rec = stats.recordings;
  const recTotal = rec ? rec.heard + rec.silent + rec.noAudio + rec.unchecked : 0;
  el('run-heard').textContent = recTotal
    ? `${rec.heard} of ${recTotal}${rec.silent ? ` · ${rec.silent} silent` : ''}${rec.noAudio ? ` · ${rec.noAudio} no audio` : ''} · frames ${rec.framesRead}`
    : '—';
  el('run-heard').style.color = recTotal && !rec.heard ? '#b42318' : '';
  const switches = (stats.discovery && stats.discovery.switches) || [];
  el('run-phase').title = switches.map((w) => `${w.from} → ${w.to}: ${w.reason || ''}`).join('\n');
  renderCandidates(candidates);
  if (run.status === 'done' || run.status === 'stopped' || run.status === 'error') stopPolling();
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => refreshRun().catch(() => {}), 2500);
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

// --- Review queue (borderline matches) ------------------------------------

function renderReview(rows) {
  const tb = el('review-rows');
  if (!tb) return;
  tb.innerHTML = '';
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="7" class="scout-hint">Nothing waiting for review.</td></tr>';
    return;
  }
  for (const c of rows) {
    const j = jevOf(c) || {};
    const labels = [topicCell(c), labelCell(c, 'genre'), labelCell(c, 'format')].join(' · ') + basisOf(c);
    // Transcript text came from a public reel: escaped like everything else.
    const heard = j.transcript || j.onScreenText || '';
    const held = (c.evidence && c.evidence.reviewHold) || '';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${handleLink(c.username)}</td>
      <td>${fmt(c.followers)}</td>
      <td>${labels}</td>
      <td>${fitOf(c)}</td>
      <td style="max-width:280px">${heard ? escapeHtml(heard.slice(0, 200)) : '—'}<br><span class="scout-hint">${reelOf(c)}</span></td>
      <td>${escapeHtml(held) || '—'}</td>
      <td style="white-space:nowrap">
        <button data-approve="${c.id}" class="btn-primary small">Shortlist</button>
        <button data-reject="${c.id}" class="ghost small">Reject</button>
      </td>`;
    tb.appendChild(tr);
  }
  tb.querySelectorAll('[data-approve]').forEach((b) =>
    b.addEventListener('click', () => reviewAction(`/api/sourcing/candidates/${b.dataset.approve}/approve`)));
  tb.querySelectorAll('[data-reject]').forEach((b) =>
    b.addEventListener('click', () => reviewAction(`/api/sourcing/candidates/${b.dataset.reject}/reject`)));
}

async function reviewAction(path) {
  try {
    await api(path, { method: 'POST', body: JSON.stringify({}) });
    await loadReview();
    if (currentRun) await refreshRun().catch(() => {});
  } catch (err) {
    setStatus(err.message, 'err');
  }
}

// How sure Jev has to be is learned from the decisions made in this queue.
async function loadJevBars() {
  try {
    const bars = await api('/api/sourcing/jev-calibration');
    el('jev-bars').textContent = bars.summary || '';
  } catch (_) {
    el('jev-bars').textContent = '';
  }
}

async function loadReview() {
  loadJevBars();
  try {
    const rows = await api('/api/sourcing/review');
    renderReview(rows);
  } catch (err) {
    setStatus(err.message, 'err');
  }
}

// --- Paired hosts ---------------------------------------------------------

let latestHosts = [];

/** Where a phone's account is in phone farming; why it last moved, on hover. */
function farmCell(h) {
  const phase = h.farm_phase === 'feed'
    ? '<span class="pill added">Scouting its feed</span>'
    : `<span class="pill review">Warming up ${Number(h.farm_warmed) || 0}/${Number(h.farm_goal) || 0}</span>`;
  const why = h.farm_note ? ` title="${escapeHtml(h.farm_note)}"` : '';
  return `<span${why}>${phase}</span>`;
}

/** The run's scouting phase, from stats.discovery (services/phoneFarm.js). */
function phaseOf(d) {
  if (!d) return '—';
  if (d.mode !== 'auto') return d.mode || '—';
  if (d.phase === 'feed') {
    return `Reel feed${d.feedOnNiche != null ? ` · ${Math.round(d.feedOnNiche * 100)}% on-niche` : ''}`;
  }
  return `Warm-up · ${d.warmed || 0}/${d.goal || 0} warmed`;
}

async function loadHosts() {
  try {
    const rows = await api('/api/sourcing/hosts');
    latestHosts = rows;
    populateWatchHosts(rows);
    populateRunHosts(rows);
    const tb = el('hosts-rows');
    tb.innerHTML = '';
    for (const h of rows) {
      const tr = document.createElement('tr');
      const plats = Array.isArray(h.platforms) ? h.platforms.join(', ') : '';
      const session = h.sessionActive
        ? `<span class="pill added">● scouting${h.activeRunId ? ` · run #${h.activeRunId}` : ''}</span>`
        : '<span class="scout-hint">idle</span>';
      tr.innerHTML = `
        <td>${escapeHtml(h.label)}</td>
        <td>${plats}</td>
        <td><span class="pill ${h.status === 'active' ? 'added' : 'rejected'}">${h.status}</span></td>
        <td>${farmCell(h)}</td>
        <td>${session}</td>
        <td>${seenFreshness(h.last_seen_at)}</td>
        <td style="white-space:nowrap">${h.status === 'active' ? `<button data-host="${h.id}" class="ghost small restart-farm" title="A new Instagram account was signed in on this phone: warm it up from the start">Restart warm-up</button> <button data-host="${h.id}" class="ghost small revoke-host">Revoke</button>` : ''}</td>`;
      tb.appendChild(tr);
    }
    tb.querySelectorAll('.restart-farm').forEach((b) => {
      b.addEventListener('click', async () => {
        if (!confirm('Start this phone\'s warm-up over?\n\nDo this when a new Instagram account is signed in on it: '
          + 'it will search and warm up on shortlisted creators again before it scouts its feed.')) return;
        try {
          await api(`/api/sourcing/hosts/${b.dataset.host}/farm/restart`, { method: 'POST', body: JSON.stringify({}) });
          await loadHosts();
          setStatus('Warm-up restarted for that phone.', 'ok');
        } catch (err) {
          setStatus(err.message, 'err');
        }
      });
    });
    tb.querySelectorAll('.revoke-host').forEach((b) => {
      b.addEventListener('click', async () => {
        if (!confirm('Revoke this host token? The runner using it will stop being able to authenticate.')) return;
        try {
          await api(`/api/sourcing/hosts/${b.dataset.host}`, { method: 'DELETE' });
          await loadHosts();
        } catch (err) {
          setStatus(err.message, 'err');
        }
      });
    });
  } catch (err) {
    setStatus(err.message, 'err');
  }
}

async function mintHost() {
  const label = el('new-host-label').value.trim();
  const platforms = ['android']; // the runner is Android-only — no iOS driver
  if (!label) { setStatus('Host label is required.', 'err'); return; }
  try {
    const created = await api('/api/sourcing/hosts', {
      method: 'POST',
      body: JSON.stringify({ label, platforms }),
    });
    el('new-host-token').textContent =
      `Copy this token into the runner's RUNNER_HOST_TOKEN env — it won't be shown again:\n${created.token}`;
    el('new-host-token').className = 'scout-status ok';
    el('new-host-label').value = '';
    await loadHosts();
  } catch (err) {
    setStatus(err.message, 'err');
  }
}

// --- Watch phone (live mirror + take-over) --------------------------------

let watchTimer = null;
let watchHostId = null;
let watchDims = { width: 0, height: 0 };

function setWatchStatus(msg, kind) {
  const s = el('watch-status');
  if (s) { s.textContent = msg || ''; s.className = 'scout-status' + (kind ? ' ' + kind : ''); }
}

/**
 * The "scout on device" picker.
 *
 * Only active hosts are offered — a revoked or stale one cannot pick up work,
 * and the backend refuses a run pinned to it anyway. A device already scouting
 * is still listed but labelled, because the run just queues behind the one it
 * is on rather than being rejected.
 */
function populateRunHosts(rows) {
  const sel = el('runHost');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '';
  const any = document.createElement('option');
  any.value = ''; any.textContent = 'Any available device';
  sel.appendChild(any);
  for (const h of rows.filter((r) => r.status === 'active')) {
    const o = document.createElement('option');
    o.value = String(h.id);
    o.textContent = `#${h.id} ${h.label}${h.sessionActive ? ' · busy' : ''}`;
    sel.appendChild(o);
  }
  // Keep the admin's choice across the 10s host refresh, unless that device has
  // gone away — in which case fall back to "any" rather than silently holding a
  // selection that is no longer on the list.
  sel.value = prev && [...sel.options].some((o) => o.value === prev) ? prev : '';
}

function populateWatchHosts(rows) {
  const sel = el('watch-host');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '';
  const opt0 = document.createElement('option');
  opt0.value = ''; opt0.textContent = '— pick a host —';
  sel.appendChild(opt0);
  for (const h of rows.filter((r) => r.status === 'active')) {
    const o = document.createElement('option');
    o.value = String(h.id); o.textContent = `#${h.id} ${h.label}`;
    sel.appendChild(o);
  }
  if (prev) sel.value = prev;
  el('watch-card').hidden = rows.length === 0;
}

async function fetchFrame() {
  if (!watchHostId) return;
  try {
    const resp = await fetch(`/api/sourcing/hosts/${watchHostId}/frame`, {
      headers: { Accept: 'image/*' },
    });
    if (resp.status === 204) {
      el('watch-frame').removeAttribute('src');
      el('watch-empty').style.display = '';
      setWatchStatus('Waiting for the runner to publish a frame…');
      return;
    }
    if (resp.status === 404) {
      setWatchStatus('Live mirror is disabled on the backend (SOURCING_LIVE_MIRROR=on).', 'err');
      stopWatching();
      return;
    }
    if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
    watchDims = {
      width: Number(resp.headers.get('X-Screen-Width') || 0),
      height: Number(resp.headers.get('X-Screen-Height') || 0),
    };
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const img = el('watch-frame');
    const prev = img.src;
    img.onload = () => { if (prev && prev.startsWith('blob:')) URL.revokeObjectURL(prev); };
    img.src = url;
    el('watch-empty').style.display = 'none';
    setWatchStatus('');
  } catch (err) {
    setWatchStatus(err.message, 'err');
  }
}

function startWatching() {
  const sel = el('watch-host');
  const id = Number(sel.value);
  if (!id) { setWatchStatus('Pick a host first.', 'err'); return; }
  watchHostId = id;
  el('watch-host-label').textContent = sel.options[sel.selectedIndex].textContent;
  el('watch-toggle').textContent = 'Stop watching';
  el('watch-pause').disabled = false;
  fetchFrame();
  watchTimer = setInterval(fetchFrame, 2000);
}

function stopWatching() {
  if (watchTimer) clearInterval(watchTimer); watchTimer = null;
  watchHostId = null;
  el('watch-toggle').textContent = 'Start watching';
  el('watch-pause').disabled = true;
  el('watch-frame').removeAttribute('src');
  el('watch-empty').style.display = '';
  setWatchStatus('');
}

async function postControl(op) {
  if (!watchHostId) return;
  try {
    const res = await fetch(`/api/sourcing/hosts/${watchHostId}/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(op),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  } catch (err) {
    setWatchStatus(err.message, 'err');
  }
}

function onFrameClick(ev) {
  if (!watchHostId) return;
  const img = ev.currentTarget;
  const rect = img.getBoundingClientRect();
  const localX = ev.clientX - rect.left;
  const localY = ev.clientY - rect.top;
  if (!watchDims.width || !watchDims.height || !rect.width || !rect.height) return;
  // Normalize dashboard-pixel click to real device pixels.
  const x = Math.round((localX / rect.width) * watchDims.width);
  const y = Math.round((localY / rect.height) * watchDims.height);
  setWatchStatus(`Sent tap (${x}, ${y})`, 'ok');
  postControl({ op: 'tap', x, y });
}

function wire() {
  const reviewRefresh = el('review-refresh');
  if (reviewRefresh) reviewRefresh.addEventListener('click', loadReview);
  el('save-btn').addEventListener('click', saveDefaults);
  el('start-btn').addEventListener('click', startRun);
  el('stop-btn').addEventListener('click', stopRun);
  el('feed-mock-btn').addEventListener('click', feedMock);
  el('mint-host-btn').addEventListener('click', mintHost);
  el('watch-toggle').addEventListener('click', () => (watchTimer ? stopWatching() : startWatching()));
  el('watch-pause').addEventListener('click', () => postControl({ op: 'pause' }));
  el('watch-frame').addEventListener('click', onFrameClick);
}

// --- Which judges this deployment has --------------------------------------
//
// Without Gemini no reel is watched; without Claude as well, nothing judges
// quality and every creator who passes the reach rules waits in review. A run
// looks normal either way, so say it before anyone starts one.
async function loadJudgeStatus() {
  const banner = el('judge-banner');
  if (!banner) return;
  let status;
  try {
    status = await api('/api/sourcing/status');
  } catch (_) {
    return; // informational only — never block the page on it
  }
  const mode = status && status.judge && status.judge.mode;
  if (mode === 'no-speech') {
    banner.textContent = 'Jev cannot hear the reels (GROQ_API_KEY is not set on the backend), so it labels '
      + 'creators from their captions and on-screen text only.';
    banner.className = 'judge-banner warn';
    banner.hidden = false;
  } else if (mode === 'none') {
    banner.textContent = 'Jev is not configured (JEV_API_KEY is not set on the backend), so nothing can check '
      + 'what creators post about: every creator who passes the viral rule waits in Pending review.';
    banner.className = 'judge-banner err';
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
  // Without ffmpeg the recording is never split into audio and frames; without
  // Tesseract the frames are never read.
  const m = status && status.media;
  if (m && banner.hidden && (!m.ffmpeg || !m.ffprobe || !m.tesseract)) {
    const missing = [!m.ffmpeg && 'ffmpeg', !m.ffprobe && 'ffprobe', !m.tesseract && 'tesseract'].filter(Boolean);
    banner.textContent = `The server is missing ${missing.join(', ')}, so the recorded reels are `
      + `${!m.ffmpeg || !m.ffprobe ? 'not split into audio and frames — Groq gets the whole video and no on-screen text is read' : 'not read for on-screen text'}. `
      + 'Redeploy the backend with nixpacks.toml, which installs them.';
    banner.className = 'judge-banner warn';
    banner.hidden = false;
  }
}

wire();
loadJudgeStatus();
loadConfig()
  .then(() => loadReview())
  .catch((err) => setStatus(err.message, 'err'));
loadHosts().catch(() => { /* non-fatal if the hosts card fails */ });
// Keep the host-health tile live (connection freshness + active session).
setInterval(() => loadHosts().catch(() => {}), 10000);
