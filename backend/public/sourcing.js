'use strict';

// Scout Creators — companion page for automated Instagram sourcing. Talks to the
// /api/sourcing/* endpoints (behind the same Slack/site-auth cookie as the
// dashboard). Set the target campaign, the scouting rules, start a run, and watch
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

function numOrUndef(id) {
  const raw = el(id).value;
  if (raw === '' || raw == null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function readForm() {
  return {
    niche: el('niche').value.trim(),
    keywords: el('keywords').value.trim(),
    floor: numOrUndef('floor'),
    ceiling: numOrUndef('ceiling'),
    risk: el('risk').value,
    targetCount: numOrUndef('targetCount'),
    reelsWindow: numOrUndef('reelsWindow'),
  };
}

function fillForm(cfg) {
  cfg = cfg || {};
  el('niche').value = cfg.niche || '';
  el('keywords').value = Array.isArray(cfg.keywords) ? cfg.keywords.join(', ') : (cfg.keywords || '');
  el('floor').value = cfg.floor ?? '';
  el('ceiling').value = cfg.ceiling ?? '';
  el('risk').value = ['low', 'medium', 'high'].includes(cfg.risk) ? cfg.risk : 'medium';
  el('targetCount').value = cfg.targetCount ?? '';
  el('reelsWindow').value = cfg.reelsWindow ?? 12;
}

function campaignId() { return el('campaign').value; }

async function loadCampaigns() {
  const campaigns = await api('/api/campaigns');
  const sel = el('campaign');
  sel.innerHTML = '';
  for (const c of campaigns) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = `${c.brand_name} — ${c.name}`;
    sel.appendChild(opt);
  }
  const preset = new URLSearchParams(location.search).get('campaign');
  if (preset && campaigns.some((c) => c.id === preset)) sel.value = preset;
  await loadConfig();
}

async function loadConfig() {
  if (!campaignId()) return;
  try {
    const cfg = await api(`/api/sourcing/config/${encodeURIComponent(campaignId())}`);
    fillForm(cfg);
  } catch (err) {
    setStatus(err.message, 'err');
  }
}

async function saveDefaults() {
  try {
    await api(`/api/sourcing/config/${encodeURIComponent(campaignId())}`, {
      method: 'PATCH',
      body: JSON.stringify(readForm()),
    });
    setStatus('Saved as campaign defaults.', 'ok');
  } catch (err) {
    setStatus(err.message, 'err');
  }
}

async function startRun() {
  try {
    setStatus('Starting run…');
    const run = await api('/api/sourcing/runs', {
      method: 'POST',
      body: JSON.stringify({ campaign_id: campaignId(), config: readForm() }),
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
  const reels = (v) => Array.from({ length: 12 }, () => ({ views: v, caption: cap }));
  const batch = [
    { username: 'home.fit.mia', full_name: 'Mia Fit', followers: 84000, bio: 'home fitness coach', reels: reels(120000) },
    { username: 'garage.gains', full_name: 'Garage Gains', followers: 51000, bio: 'gym at home, daily workout', reels: reels(45000) },
    { username: 'lowreach.lea', full_name: 'Lea', followers: 22000, bio: 'fitness', reels: [...Array(11).fill({ views: 60000, caption: cap }), { views: 6000, caption: cap }] },
    { username: 'wanderjoe', full_name: 'Joe Travels', followers: 130000, bio: 'budget travel & food', reels: Array.from({ length: 12 }, () => ({ views: 90000, caption: 'cheap flights to bali' })) },
    { username: 'viral.vic', full_name: 'Vic', followers: 60000, bio: 'home gym tips', reels: [...Array(11).fill({ views: 30000, caption: cap }), { views: 900000, caption: cap }] },
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

function renderCandidates(rows) {
  const tb = el('cand-rows');
  tb.innerHTML = '';
  for (const c of rows) {
    const tr = document.createElement('tr');
    const niche = c.niche_score == null ? '—' : Number(c.niche_score).toFixed(2);
    const risk = c.risk_profile || '—';
    tr.innerHTML = `
      <td>@${c.username}</td>
      <td>${fmt(c.followers)}</td>
      <td>${viewRange(c.reels)}</td>
      <td>${niche}</td>
      <td>${risk === '—' ? '—' : `<span class="pill ${risk}">${risk}</span>`}</td>
      <td><span class="pill ${c.decision}">${c.decision}</span></td>
      <td>${c.reject_reason || ''}</td>`;
    tb.appendChild(tr);
  }
}

async function refreshRun() {
  if (!currentRun) return;
  const { run, candidates } = await api(`/api/sourcing/runs/${currentRun.id}`);
  currentRun = run;
  el('run-id').textContent = `#${run.id}`;
  el('run-status').textContent = run.status;
  el('run-found').textContent = run.found_count ?? 0;
  el('run-target').textContent = run.target_count ?? 0;
  el('run-scanned').textContent = (run.stats && run.stats.scanned) || candidates.length || 0;
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

// --- Paired hosts ---------------------------------------------------------

let latestHosts = [];

async function loadHosts() {
  try {
    const rows = await api('/api/sourcing/hosts');
    latestHosts = rows;
    populateWatchHosts(rows);
    const tb = el('hosts-rows');
    tb.innerHTML = '';
    for (const h of rows) {
      const tr = document.createElement('tr');
      const seen = h.last_seen_at ? new Date(h.last_seen_at).toLocaleString() : '—';
      const plats = Array.isArray(h.platforms) ? h.platforms.join(', ') : '';
      tr.innerHTML = `
        <td>${h.label}</td>
        <td>${plats}</td>
        <td><span class="pill ${h.status === 'active' ? 'added' : 'rejected'}">${h.status}</span></td>
        <td>${seen}</td>
        <td>${h.status === 'active' ? `<button data-host="${h.id}" class="ghost small revoke-host">Revoke</button>` : ''}</td>`;
      tb.appendChild(tr);
    }
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
  const platforms = [];
  if (el('new-host-android').checked) platforms.push('android');
  if (el('new-host-ios').checked) platforms.push('ios');
  if (!label) { setStatus('Host label is required.', 'err'); return; }
  if (!platforms.length) { setStatus('Pick at least one platform.', 'err'); return; }
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
  el('campaign').addEventListener('change', () => { currentRun = null; el('run-card').hidden = true; stopPolling(); loadConfig(); });
  el('save-btn').addEventListener('click', saveDefaults);
  el('start-btn').addEventListener('click', startRun);
  el('stop-btn').addEventListener('click', stopRun);
  el('feed-mock-btn').addEventListener('click', feedMock);
  el('mint-host-btn').addEventListener('click', mintHost);
  el('watch-toggle').addEventListener('click', () => (watchTimer ? stopWatching() : startWatching()));
  el('watch-pause').addEventListener('click', () => postControl({ op: 'pause' }));
  el('watch-frame').addEventListener('click', onFrameClick);
}

wire();
loadCampaigns().catch((err) => setStatus(err.message, 'err'));
loadHosts().catch(() => { /* non-fatal if the hosts card fails */ });
