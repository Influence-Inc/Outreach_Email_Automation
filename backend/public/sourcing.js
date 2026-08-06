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

function wire() {
  el('campaign').addEventListener('change', () => { currentRun = null; el('run-card').hidden = true; stopPolling(); loadConfig(); });
  el('save-btn').addEventListener('click', saveDefaults);
  el('start-btn').addEventListener('click', startRun);
  el('stop-btn').addEventListener('click', stopRun);
  el('feed-mock-btn').addEventListener('click', feedMock);
}

wire();
loadCampaigns().catch((err) => setStatus(err.message, 'err'));
