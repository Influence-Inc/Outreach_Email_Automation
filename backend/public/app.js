const API = '';

const state = {
  campaigns: [],
  selectedCampaignId: null,
};

async function api(path, options = {}) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `${res.status} ${res.statusText}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

function el(id) { return document.getElementById(id); }

function fmtDate(s) {
  if (!s) return '';
  return new Date(s).toLocaleString();
}

async function refreshCampaigns() {
  state.campaigns = await api('/api/campaigns');
  const tree = el('brand-tree');
  tree.innerHTML = '';

  // Group by brand_name preserving the order returned by the API.
  const groups = new Map();
  for (const c of state.campaigns) {
    if (!groups.has(c.brand_name)) groups.set(c.brand_name, []);
    groups.get(c.brand_name).push(c);
  }

  if (!groups.size) {
    tree.innerHTML = '<p class="hint" style="padding:0 8px;">No campaigns synced yet. Click Refresh.</p>';
    return;
  }

  for (const [brand, list] of groups) {
    const group = document.createElement('div');
    group.className = 'brand-group';
    const head = document.createElement('div');
    head.className = 'brand-name';
    head.textContent = brand;
    group.appendChild(head);
    for (const c of list) {
      const item = document.createElement('div');
      item.className = 'campaign-item';
      if (c.id === state.selectedCampaignId) item.classList.add('active');
      // A red pending dot appears when the campaign has anything awaiting a
      // human (delegated replies or offers to approve) — mirrors action_count.
      const hasPending = (c.action_count || 0) > 0;
      if (hasPending) item.classList.add('has-pending');
      const name = document.createElement('span');
      name.className = 'campaign-name';
      name.textContent = c.name;
      item.appendChild(name);
      if (hasPending) {
        const dot = document.createElement('span');
        dot.className = 'pending-dot';
        dot.title = `${c.action_count} item(s) need you`;
        item.appendChild(dot);
      }
      const count = document.createElement('span');
      count.className = 'count-pill num';
      count.textContent = c.creator_count;
      item.appendChild(count);
      item.onclick = () => selectCampaign(c.id);
      group.appendChild(item);
    }
    tree.appendChild(group);
  }

  if (state.campaigns.length) {
    const latest = state.campaigns
      .map((c) => c.synced_at)
      .filter(Boolean)
      .sort()
      .pop();
    if (latest) el('sync-status').textContent = `Synced ${fmtDate(latest)}`;
  }
}

function showView(name) {
  el('campaign-view').hidden = name !== 'campaign';
  el('guidelines-view').hidden = name !== 'guidelines';
  el('delegate-view').hidden = name !== 'delegate';
  closeSidebarOnMobile();
}

// --- Mobile sidebar drawer -----------------------------------------------

function isMobileLayout() {
  return window.matchMedia('(max-width: 720px)').matches;
}

function setSidebarOpen(open) {
  const sidebar = el('sidebar');
  const backdrop = el('sidebar-backdrop');
  sidebar.classList.toggle('open', open);
  backdrop.classList.toggle('open', open);
  backdrop.hidden = !open;
}

function closeSidebarOnMobile() {
  if (isMobileLayout()) setSidebarOpen(false);
}

el('sidebar-toggle').addEventListener('click', () => {
  const isOpen = el('sidebar').classList.contains('open');
  setSidebarOpen(!isOpen);
});
el('sidebar-backdrop').addEventListener('click', () => setSidebarOpen(false));
// Close drawer if the viewport grows back to desktop width.
window.addEventListener('resize', () => {
  if (!isMobileLayout()) setSidebarOpen(false);
});

async function selectCampaign(id) {
  showView('campaign');
  state.selectedCampaignId = id;
  await refreshCampaigns();
  const c = state.campaigns.find((x) => x.id === id);
  if (!c) return;
  const eyebrow = el('campaign-eyebrow');
  eyebrow.textContent = c.brand_name;
  eyebrow.hidden = false;
  el('campaign-title').textContent = c.name;
  const stats = [
    { label: 'Creators', value: c.creator_count },
    { label: 'Pending', value: c.pending_extraction_count },
    { label: 'Email found', value: c.email_found_count },
    { label: 'Outreach', value: c.outreach_sent_count },
    { label: 'Follow-up', value: c.followup_sent_count },
    { label: 'Replied', value: c.replied_count, accent: true },
  ];
  const statsEl = el('campaign-stats');
  statsEl.hidden = false;
  statsEl.innerHTML = stats
    .map(
      (s) => `<div class="stat-cell">
        <div class="stat-label">${s.label}</div>
        <div class="stat-value num${s.accent && Number(s.value) > 0 ? ' accent' : ''}">${s.value}</div>
      </div>`,
    )
    .join('');
  updateDelegateBadge(c.action_count || 0);
  el('creator-form').hidden = false;
  el('creator-table-wrap').hidden = false;
  el('campaign-max-cpm').value = c.max_cpm != null ? c.max_cpm : '';
  el('campaign-instantly-id').value = c.instantly_campaign_id || '';
  el('instantly-status').textContent = '';
  await refreshCreators();
}

function makeEditable(td, { value, placeholder, onSave, allowEmpty = false }) {
  td.classList.add('editable');
  td.title = 'Click to edit';
  td.addEventListener('click', () => {
    if (td.querySelector('input')) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value || '';
    input.placeholder = placeholder || '';
    td.innerHTML = '';
    td.appendChild(input);
    input.focus();
    input.select();

    let finished = false;
    const restore = () => {
      if (finished) return;
      finished = true;
      refreshCreators();
    };
    const commit = async () => {
      if (finished) return;
      finished = true;
      const next = input.value.trim();
      if (next === (value || '')) {
        refreshCreators();
        return;
      }
      if (!next && !allowEmpty) {
        // empty input = cancel for fields that can't be blank (name, rate…).
        refreshCreators();
        return;
      }
      try {
        await onSave(next);
      } catch (err) {
        alert(err.message);
      }
      refreshCreators();
      await refreshCampaigns();
    };

    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        commit();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        restore();
      }
    });
    input.addEventListener('blur', commit);
  });
}

// --- Negotiation cells ----------------------------------------------------

function fmtNum(n) {
  return Number(n || 0).toLocaleString('en-US');
}

function fmtViews(n) {
  n = Number(n || 0);
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(Math.round(n));
}

// Live CPM (mirrors pricing.cpmFor on the backend).
function cpmFor(fee, views) {
  return views ? Math.round((fee / views) * 1000 * 100) / 100 : null;
}

// Inverse of cpmFor: the fee implied by a CPM over a fixed view basis. Used by
// the offer controls, where the admin sets CPM and the fee follows.
function feeFor(cpm, views) {
  return Math.round((Number(cpm) * Number(views)) / 1000);
}

// Compact relative time for the rate timeline ("just now", "5m ago", "2h ago").
function fmtAgo(s) {
  if (!s) return '';
  const then = new Date(s).getTime();
  if (isNaN(then)) return '';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(s).toLocaleDateString();
}

// Avatar tints, cycled per row. First is the near-black accent.
const AVATAR_COLORS = ['#191817', '#147a52', '#c2410c', '#0e7490', '#5b45e0', '#b83280'];

function avatarInitial(r) {
  const src = r.full_name || r.first_name || r.instagram_username || '?';
  return String(src).replace(/^@/, '').charAt(0).toUpperCase() || '?';
}

// Status pill class + label. An accepted negotiation is surfaced as its own
// pill even though the outreach status stays 'replied'.
function statusPillFor(r) {
  if (r.negotiation_status === 'ACCEPTED') return { cls: 'accepted', text: 'accepted' };
  const st = r.status || 'pending_extraction';
  return { cls: st, text: st.replace(/_/g, ' ') };
}

// Reach column: median reel views + reel count/low, editable to paste the raw
// reel view counts (comma/space separated) when the scraper comes up short.
function renderReachCell(r, cell) {
  const s = r.ig_scraped_data;
  if (s && s.reel_count) {
    cell.innerHTML =
      `<div class="reach-main num">${fmtViews(s.p50)} <span class="unit">median</span></div>` +
      `<div class="reach-sub">${s.reel_count} reels · low ${fmtViews(s.min_views)}</div>`;
  } else {
    cell.innerHTML = '<span class="empty">— no views</span>';
  }
  const rawViews =
    s && Array.isArray(s.views_raw) ? s.views_raw.map((n) => Math.round(n)).join(', ') : '';
  makeEditable(cell, {
    value: rawViews,
    placeholder: 'reel views e.g. 120k, 95k, 210k',
    onSave: (v) => {
      const list = String(v)
        .split(/[\s,]+/)
        .map((x) => x.trim())
        .filter(Boolean);
      return api(`/api/creators/${r.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ reel_views: list }),
      });
    },
  });
}

// Rate column: just the editable quoted rate (the delivery timeline now lives
// in the Status column).
function renderRateCell(r, cell) {
  const valueDiv = document.createElement('div');
  valueDiv.className = 'rate-value num' + (r.quoted_rate != null ? '' : ' empty');
  valueDiv.textContent = r.quoted_rate != null ? `$${fmtNum(r.quoted_rate)}` : '—';
  cell.appendChild(valueDiv);
  makeEditable(valueDiv, {
    value: r.quoted_rate != null ? String(r.quoted_rate) : '',
    placeholder: 'rate $',
    onSave: (v) =>
      api(`/api/creators/${r.id}/quoted-rate`, {
        method: 'POST',
        body: JSON.stringify({ quoted_rate: Number(String(v).replace(/[^0-9.]/g, '')) }),
      }),
  });
}

const TRASH_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path></svg>';

// Status column: pill + delete + (send-outreach when pending) + timeline.
function renderStatusCell(r, cell) {
  const top = document.createElement('div');
  top.className = 'cr-status-top';
  const pill = statusPillFor(r);
  const pillEl = document.createElement('span');
  pillEl.className = `status-pill ${pill.cls}`;
  pillEl.textContent = pill.text;
  top.appendChild(pillEl);

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'icon-btn-sq';
  del.title = 'Remove from campaign';
  del.innerHTML = TRASH_SVG;
  del.onclick = async () => {
    if (!confirm('Remove this creator?')) return;
    await api(`/api/creators/${r.id}`, { method: 'DELETE' });
    await refreshCreators();
    await refreshCampaigns();
  };
  top.appendChild(del);
  cell.appendChild(top);

  if (r.status === 'email_found') {
    const send = document.createElement('button');
    send.type = 'button';
    send.className = 'ghost small cr-send-btn';
    send.textContent = 'Send outreach';
    send.onclick = async () => {
      send.disabled = true;
      try {
        await api(`/api/creators/${r.id}/send-outreach`, { method: 'POST' });
        await refreshCreators();
        await refreshCampaigns();
      } catch (err) {
        alert(err.message);
        send.disabled = false;
      }
    };
    cell.appendChild(send);
  }

  const log = Array.isArray(r.rate_log) ? r.rate_log : [];
  if (log.length) cell.appendChild(renderTimeline(log));
}

// A vertical delivery-tracking timeline, oldest → newest. The newest entry is
// the "current" step (emphasized); a connecting line joins consecutive steps.
function renderTimeline(log) {
  const wrap = document.createElement('div');
  wrap.className = 'timeline';
  const items = Array.isArray(log) ? log : [];
  items.forEach((e, i) => {
    const isLast = i === items.length - 1;
    const step = document.createElement('div');
    step.className = 'timeline-step' + (isLast ? ' current' : '');
    if (e.tone === 'success') step.classList.add('tone-success');

    const rail = document.createElement('div');
    rail.className = 'timeline-rail';
    const dot = document.createElement('div');
    dot.className = 'timeline-dot ' + (isLast ? 'current' : 'done');
    if (e.tone === 'success') dot.classList.add('tone-success');
    if (e.tone === 'muted') dot.classList.add('tone-muted');
    rail.appendChild(dot);
    if (!isLast) {
      const line = document.createElement('div');
      line.className = 'timeline-line';
      rail.appendChild(line);
    }

    const body = document.createElement('div');
    body.className = 'timeline-body';
    body.style.paddingBottom = isLast ? '0' : '4px';
    const label = document.createElement('div');
    label.className = 'timeline-label';
    label.textContent = e.text || '';
    const time = document.createElement('div');
    time.className = 'timeline-time num';
    time.textContent = fmtAgo(e.at);
    time.title = fmtDate(e.at);
    body.appendChild(label);
    body.appendChild(time);

    step.appendChild(rail);
    step.appendChild(body);
    wrap.appendChild(step);
  });
  return wrap;
}

// Offer dropdown + CPM slider + computed Fee + Approve & send. Returns a
// standalone element (lives in the Delegate window now, not a table cell).
// `onRefresh` runs after a successful approve so the caller can repaint.
function buildOfferControls(r, onRefresh) {
  const container = document.createElement('div');
  container.className = 'neg-offer';
  const offers = Array.isArray(r.suggested_offers) ? r.suggested_offers : [];
  // Detect a counter-offer scenario: any prior 'rate_offer_sent' event means
  // this isn't the first approval — the admin is now setting a counter, not an
  // initial offer. Label the controls so it's obvious which round they're in.
  const priorOfferSent = Array.isArray(r.rate_log)
    && r.rate_log.some((e) => e && e.type === 'rate_offer_sent');
  const offerNoun = priorOfferSent ? 'counter offer' : 'offer';
  const stage = r.negotiation_status
    ? `<div class="neg-stage">${r.negotiation_status.replace(/_/g, ' ').toLowerCase()}</div>`
    : '';
  const sent = r.negotiation_status === 'AWAITING_DECISION';
  const approvedBadge = r.offer_approved
    ? `<span class="neg-approved-badge ${sent ? 'sent' : ''}">${sent ? `✓ ${offerNoun} sent` : '✓ approved'}</span>`
    : '';
  if (!offers.length) {
    container.innerHTML =
      (stage || '') +
      '<div class="meta">Scrape reel views to generate offers, or enter views in the Views column.</div>';
    return container;
  }

  const custom = r.custom_offer && typeof r.custom_offer === 'object' ? r.custom_offer : null;
  let selectedId = (custom && custom.offer_id) || r.selected_offer_id || offers[0].offer_id;
  let selected = offers.find((o) => o.offer_id === selectedId) || offers[0];
  selectedId = selected.offer_id;

  // The fixed view basis a fee is priced on: the guarantee for view deals, or
  // the implied views behind a video deal's flat fee (flat_fee/cpm*1000).
  // Computed once per selected offer so CPM and the read-only Fee don't chase
  // each other.
  const billableFor = (o) =>
    Number(o.view_guarantee) ||
    (o.cpm_applied ? Math.round((Number(o.flat_fee) / Number(o.cpm_applied)) * 1000) : 0);

  const seedFromCustom = custom && custom.offer_id === selectedId;
  let billableViews = billableFor(selected);
  let cpm =
    seedFromCustom && custom.cpm_applied != null
      ? Number(custom.cpm_applied)
      : Number(selected.cpm_applied) || 0;

  const cpmCeil = Math.max(...offers.map((o) => Number(o.cpm_applied) || 0), cpm, 1);
  const cpmMax = Math.max(Math.ceil(cpmCeil * 2), 1);

  const offerNounUcFirst = offerNoun.charAt(0).toUpperCase() + offerNoun.slice(1);
  const approveLabel = r.offer_approved
    ? `Re-approve &amp; send ${offerNoun}`
    : `Approve &amp; send ${offerNoun}`;
  container.innerHTML = `
    <div class="neg-offer-head"><span class="neg-offer-title">${offerNounUcFirst}</span>${stage}${approvedBadge}</div>
    <select class="neg-offer-select small"></select>
    <div class="neg-offer-basis meta"></div>
    <div class="neg-slider">
      <label>CPM <b class="neg-cpm-val"></b></label>
      <input type="range" class="neg-cpm" min="0" max="${cpmMax}" step="0.5" />
    </div>
    <div class="neg-fee-badge"></div>
    <button class="neg-approve" type="button">${approveLabel}</button>
    <span class="neg-offer-status hint"></span>
  `;
  const sel = container.querySelector('.neg-offer-select');
  const basisEl = container.querySelector('.neg-offer-basis');
  const cpmRange = container.querySelector('.neg-cpm');
  const cpmVal = container.querySelector('.neg-cpm-val');
  const feeBadge = container.querySelector('.neg-fee-badge');
  const approveBtn = container.querySelector('.neg-approve');
  const statusEl = container.querySelector('.neg-offer-status');

  for (const o of offers) {
    const opt = document.createElement('option');
    opt.value = o.offer_id;
    // Flag whether the offer clears the creator's quoted rate (when known).
    const meets = o.satisfies_creator_rate === true ? ' ✓' : o.satisfies_creator_rate === false ? ' ✗' : '';
    opt.textContent = `${o.label} · $${fmtNum(o.flat_fee)}${meets}`;
    if (o.offer_id === selectedId) opt.selected = true;
    sel.appendChild(opt);
  }

  const isView = () => selected.offer_type === 'view_based';
  const fmtCpm = (n) => '$' + (Math.round(Number(n) * 100) / 100);
  const currentFee = () => feeFor(cpm, billableViews);
  function syncFee() {
    cpmVal.textContent = fmtCpm(cpm);
    feeBadge.textContent = 'Fee $' + fmtNum(currentFee());
  }
  function syncUI() {
    cpmRange.value = String(cpm);
    basisEl.textContent = isView()
      ? `Guarantees ${fmtViews(billableViews)} views`
      : `${selected.num_videos} video${selected.num_videos === 1 ? '' : 's'} · flat`;
    syncFee();
  }
  syncUI();

  sel.onchange = () => {
    selected = offers.find((o) => o.offer_id === sel.value) || offers[0];
    selectedId = selected.offer_id;
    billableViews = billableFor(selected);
    cpm = Number(selected.cpm_applied) || 0;
    syncUI();
  };
  cpmRange.oninput = () => {
    cpm = Number(cpmRange.value);
    syncFee();
  };

  approveBtn.onclick = async () => {
    approveBtn.disabled = true;
    statusEl.textContent = 'Approving…';
    const numVideos = isView() ? 1 : Number(selected.num_videos || 1);
    const fee = currentFee();
    const customOffer = {
      ...selected,
      offer_id: selected.offer_id,
      flat_fee: fee,
      view_guarantee: isView() ? Math.round(billableViews) : 0,
      num_videos: numVideos,
      flat_per_video: isView() ? fee : Math.round(fee / numVideos),
      cpm_applied: Math.round(cpm * 100) / 100,
    };
    try {
      const resp = await api(`/api/creators/${r.id}/offer`, {
        method: 'PATCH',
        body: JSON.stringify({
          selected_offer_id: selected.offer_id,
          custom_offer: customOffer,
          offer_approved: true,
        }),
      });
      const sr = resp && resp.send_result;
      // Reflect the outcome before the re-render replaces these controls.
      // Offers are sent only by this approval action — never automatically —
      // so when a send is skipped we say why instead of promising a later send.
      let hold = 1400;
      if (sr && sr.sent) {
        statusEl.textContent = `✓ ${offerNounUcFirst} email sent.`;
      } else if (sr && sr.error) {
        statusEl.textContent = `Approved, but sending failed: ${sr.error}`;
        hold = 4000;
      } else if (sr && sr.skipped) {
        statusEl.textContent = `Approved, not sent — ${sr.skipped}. Approve again when ready.`;
        hold = 4500;
      } else {
        statusEl.textContent = `✓ ${offerNounUcFirst} approved.`;
      }
      // Brief pause so the status is visible, then let the caller repaint.
      setTimeout(onRefresh, hold);
    } catch (err) {
      statusEl.textContent = err.message;
      approveBtn.disabled = false;
    }
  };
  return container;
}

async function refreshCreators() {
  if (!state.selectedCampaignId) return;
  const rows = await api(`/api/creators?campaign_id=${encodeURIComponent(state.selectedCampaignId)}`);
  const container = el('creator-rows');
  container.innerHTML = '';
  if (!rows.length) {
    container.innerHTML =
      '<div class="hint" style="padding:26px 6px;">No creators yet. Paste Instagram links above to add some.</div>';
    return;
  }
  rows.forEach((r, idx) => {
    const row = document.createElement('div');
    row.className = 'creator-row';
    row.dataset.creatorId = r.id;

    // --- Creator (avatar + handle link + editable account name) ---
    const creatorCell = document.createElement('div');
    creatorCell.className = 'cr-creator';
    const avatar = document.createElement('div');
    avatar.className = 'cr-avatar';
    avatar.style.background = AVATAR_COLORS[idx % AVATAR_COLORS.length];
    avatar.textContent = avatarInitial(r);
    const identity = document.createElement('div');
    identity.className = 'cr-identity';
    const handle = document.createElement('div');
    handle.className = 'cr-handle';
    handle.innerHTML = `<a href="${r.instagram_url}" target="_blank" rel="noopener">@${escapeHtml(r.instagram_username || r.instagram_url)}</a>`;
    const nameDiv = document.createElement('div');
    nameDiv.className = 'cr-name';
    nameDiv.textContent = r.full_name || r.first_name || '';
    identity.appendChild(handle);
    identity.appendChild(nameDiv);
    creatorCell.appendChild(avatar);
    creatorCell.appendChild(identity);
    makeEditable(nameDiv, {
      value: r.full_name || r.first_name || '',
      placeholder: 'Account name',
      onSave: (v) =>
        api(`/api/creators/${r.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ full_name: v, first_name: v.split(/\s+/)[0] }),
        }),
    });

    // --- Email (editable) ---
    const emailCell = document.createElement('div');
    emailCell.className = 'cr-email';
    if (r.email) emailCell.textContent = r.email;
    else emailCell.innerHTML = '<span class="empty">—</span>';
    makeEditable(emailCell, {
      value: r.email || '',
      placeholder: 'creator@email.com',
      allowEmpty: true, // blanking the cell clears the email
      onSave: (v) =>
        api(`/api/creators/${r.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ email: v || null }),
        }),
    });

    // --- Reach ---
    const reachCell = document.createElement('div');
    reachCell.className = 'cr-reach';
    renderReachCell(r, reachCell);

    // --- Rate ---
    const rateCell = document.createElement('div');
    rateCell.className = 'cr-rate';
    renderRateCell(r, rateCell);

    // --- Status (pill + delete + send + timeline) ---
    const statusCell = document.createElement('div');
    statusCell.className = 'cr-status';
    renderStatusCell(r, statusCell);

    row.appendChild(creatorCell);
    row.appendChild(emailCell);
    row.appendChild(reachCell);
    row.appendChild(rateCell);
    row.appendChild(statusCell);
    container.appendChild(row);
  });
}

el('sync-btn').addEventListener('click', async () => {
  const btn = el('sync-btn');
  const status = el('sync-status');
  btn.disabled = true;
  status.textContent = 'Syncing…';
  try {
    const r = await api('/api/campaigns/sync', { method: 'POST' });
    status.textContent = `Synced ${r.upserted} campaigns`;
    await refreshCampaigns();
  } catch (err) {
    status.textContent = `Sync failed: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

el('creator-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.selectedCampaignId) return;
  const raw = el('ig-urls').value;
  const urls = Array.from(
    new Set(
      raw
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter((s) => /instagram\.com/i.test(s)),
    ),
  );
  if (!urls.length) {
    alert('Paste at least one Instagram URL.');
    return;
  }
  const status = el('add-status');
  const submitBtn = e.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  let added = 0;
  let failed = 0;
  for (let i = 0; i < urls.length; i++) {
    status.textContent = `Adding ${i + 1}/${urls.length}…`;
    try {
      await api('/api/creators', {
        method: 'POST',
        body: JSON.stringify({
          campaign_id: state.selectedCampaignId,
          instagram_url: urls[i],
        }),
      });
      added += 1;
    } catch (err) {
      failed += 1;
      console.warn(`Failed to add ${urls[i]}: ${err.message}`);
    }
  }
  status.textContent = `Added ${added} creator(s)${failed ? `, ${failed} failed` : ''}.`;
  if (!failed) el('ig-urls').value = '';
  submitBtn.disabled = false;
  await refreshCreators();
  await refreshCampaigns();
});

el('refresh-btn').addEventListener('click', refreshCreators);

el('remove-all-btn').addEventListener('click', async () => {
  if (!state.selectedCampaignId) return;
  const c = state.campaigns.find((x) => x.id === state.selectedCampaignId);
  const count = c ? c.creator_count : 0;
  if (!count) { alert('No creators to remove.'); return; }
  if (!confirm(`Remove ALL ${count} creator(s) from this campaign? This permanently deletes them and cannot be undone.`)) return;
  const btn = el('remove-all-btn');
  btn.disabled = true;
  try {
    await api('/api/creators/bulk/delete', {
      method: 'POST',
      body: JSON.stringify({ campaign_id: state.selectedCampaignId }),
    });
    await refreshCreators();
    await refreshCampaigns();
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
  }
});

el('save-cpm-btn').addEventListener('click', async () => {
  if (!state.selectedCampaignId) return;
  const raw = el('campaign-max-cpm').value.trim();
  const status = el('cpm-status');
  const btn = el('save-cpm-btn');
  btn.disabled = true;
  status.textContent = 'Saving…';
  try {
    await api(`/api/campaigns/${encodeURIComponent(state.selectedCampaignId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ max_cpm: raw === '' ? null : Number(raw) }),
    });
    status.textContent = 'Recalculating…';
    const r = await api(
      `/api/campaigns/${encodeURIComponent(state.selectedCampaignId)}/recalculate-offers`,
      { method: 'POST' },
    );
    status.textContent = `Saved. ${r.updated} creator(s) updated.`;
    await refreshCampaigns();
    await refreshCreators();
  } catch (err) {
    status.textContent = `Failed: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

el('save-instantly-btn').addEventListener('click', async () => {
  if (!state.selectedCampaignId) return;
  const raw = el('campaign-instantly-id').value.trim();
  const status = el('instantly-status');
  const btn = el('save-instantly-btn');
  btn.disabled = true;
  status.textContent = 'Saving…';
  try {
    await api(`/api/campaigns/${encodeURIComponent(state.selectedCampaignId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ instantly_campaign_id: raw === '' ? null : raw }),
    });
    status.textContent = raw === '' ? 'Cleared — using env default.' : 'Saved.';
    await refreshCampaigns();
  } catch (err) {
    status.textContent = `Failed: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

el('send-emails-btn').addEventListener('click', async () => {
  if (!state.selectedCampaignId) return;
  const c = state.campaigns.find((x) => x.id === state.selectedCampaignId);
  const pendingCount = c ? c.email_found_count : '?';
  if (!confirm(`Send outreach to ${pendingCount} pending creator(s)? This sends real emails.`)) return;
  const btn = el('send-emails-btn');
  const status = el('fetch-status');
  btn.disabled = true;
  status.hidden = false;
  status.textContent = 'Sending outreach emails…';
  try {
    const result = await api('/api/creators/bulk/send-outreach', {
      method: 'POST',
      body: JSON.stringify({ campaign_id: state.selectedCampaignId }),
    });
    status.textContent = `Done. Sent ${result.sent}, failed ${result.failed} (of ${result.processed}).`;
    await refreshCreators();
    await refreshCampaigns();
  } catch (err) {
    status.textContent = `Failed: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

// --- Extension bridge ----------------------------------------------------
// The Chrome extension content script announces itself on load with a
// window.postMessage({type: 'OEA_EXTENSION_READY'}). Track that so we can
// tell the user when the extension isn't installed.
const extensionBridge = { ready: false };

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.origin !== window.location.origin) return;
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'OEA_EXTENSION_READY') {
    extensionBridge.ready = true;
    return;
  }
  if (msg.type === 'OEA_SCRAPE_PROGRESS') {
    handleScrapeProgress(msg);
  }
});

function showScrapeProgress(text) {
  el('scrape-progress').hidden = false;
  el('scrape-progress-text').textContent = text;
}

function hideScrapeProgress() {
  el('scrape-progress').hidden = true;
  el('scrape-progress-text').textContent = '';
}

let scrapeAffectedRowIds = new Set();

function handleScrapeProgress(msg) {
  if (msg.event === 'start') {
    showScrapeProgress(`Scraping 0/${msg.total}…`);
    scrapeAffectedRowIds = new Set();
  } else if (msg.event === 'creator-start') {
    showScrapeProgress(
      `Scraping ${msg.index}/${msg.total} — @${msg.username || msg.creatorId}…`,
    );
  } else if (msg.event === 'creator-done') {
    scrapeAffectedRowIds.add(msg.creatorId);
    let tail;
    // Report what the backend actually stored. If we scraped counts but none
    // stored, surface that explicitly — it means the numbers weren't usable.
    const stored = msg.storedViews || 0;
    let viewsTail = stored ? ` · ${stored} reel views` : '';
    if (!stored && msg.reelViews) viewsTail = ` · ${msg.reelViews} scraped but 0 stored`;
    if (msg.outcome === 'email_found') {
      tail = `got ${msg.email} for @${msg.username || msg.creatorId}${viewsTail}`;
    } else if (msg.outcome === 'no_email') {
      tail = `no email for @${msg.username || msg.creatorId}${viewsTail}`;
    } else {
      tail = `error on @${msg.username || msg.creatorId}: ${msg.error || 'unknown'}`;
    }
    showScrapeProgress(`Scraping ${msg.index}/${msg.total} — ${tail}`);
  } else if (msg.event === 'done') {
    const s = msg.summary || {};
    showScrapeProgress(
      `Done. ${s.processed || 0} processed · ${s.emailFound || 0} found · ${s.noEmail || 0} no email · ` +
      `${s.withViews || 0} with views · ${s.errors || 0} errors. [hide]`,
    );
    el('scrape-cancel-btn').textContent = 'Hide';
    refreshCreators();
    refreshCampaigns();
  } else if (msg.event === 'aborted') {
    showScrapeProgress(`Aborted at ${msg.index}/${msg.total}.`);
    el('scrape-cancel-btn').textContent = 'Hide';
    refreshCreators();
    refreshCampaigns();
  } else if (msg.event === 'error') {
    showScrapeProgress(`Extension error: ${msg.error}`);
    el('scrape-cancel-btn').textContent = 'Hide';
  }
}

el('scrape-cancel-btn').addEventListener('click', () => {
  if (el('scrape-cancel-btn').textContent === 'Hide') {
    hideScrapeProgress();
    el('scrape-cancel-btn').textContent = 'Cancel';
    return;
  }
  window.postMessage({ type: 'OEA_ABORT_SCRAPE_QUEUE' }, window.location.origin);
  showScrapeProgress('Cancelling after current creator…');
});

el('run-extension-btn').addEventListener('click', async () => {
  if (!state.selectedCampaignId) return;
  const btn = el('run-extension-btn');
  btn.disabled = true;
  el('scrape-cancel-btn').textContent = 'Cancel';
  // Ask the bridge to (re)announce, so a missed initial handshake doesn't make
  // the "not detected" check below a false positive.
  window.postMessage({ type: 'OEA_PING' }, window.location.origin);
  try {
    const rows = await api(
      `/api/creators?campaign_id=${encodeURIComponent(state.selectedCampaignId)}`,
    );
    if (!rows.length) {
      showScrapeProgress('No creators in this campaign.');
      el('scrape-cancel-btn').textContent = 'Hide';
      return;
    }
    const creators = rows.map((r) => ({
      id: r.id,
      instagramUrl: r.instagram_url,
      instagramUsername: r.instagram_username,
    }));
    showScrapeProgress(`Starting scrape for ${creators.length} creator(s)…`);
    window.postMessage(
      {
        type: 'OEA_RUN_SCRAPE_QUEUE',
        payload: {
          apiBase: window.location.origin,
          creators,
          pacingMs: 5000,
        },
      },
      window.location.origin,
    );
    // If the extension never responds within 2s, assume it isn't installed.
    setTimeout(() => {
      if (!extensionBridge.ready) {
        showScrapeProgress(
          'Extension not detected. Load the unpacked extension at chrome://extensions then reload this page.',
        );
        el('scrape-cancel-btn').textContent = 'Hide';
      }
    }, 2000);
  } catch (err) {
    showScrapeProgress(`Failed: ${err.message}`);
    el('scrape-cancel-btn').textContent = 'Hide';
  } finally {
    btn.disabled = false;
  }
});

// --- HTML escape ---------------------------------------------------------

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// --- Guidelines (universal AI prompt + global AI kill-switch) ------------

async function refreshSettings() {
  try {
    const s = await api('/api/settings');
    el('guidelines-text').value = s.guidelines || '';
    el('ai-replies-toggle').checked = s.ai_replies_enabled !== false;
    el('ai-replies-status').textContent = '';
  } catch (err) {
    el('guidelines-status').textContent = `Failed to load: ${err.message}`;
  }
}

el('open-guidelines-btn').addEventListener('click', async () => {
  showView('guidelines');
  el('guidelines-status').textContent = '';
  await refreshSettings();
});

el('guidelines-back-btn').addEventListener('click', () => showView('campaign'));

el('save-guidelines-btn').addEventListener('click', async () => {
  const btn = el('save-guidelines-btn');
  const status = el('guidelines-status');
  btn.disabled = true;
  status.textContent = 'Saving…';
  try {
    await api('/api/settings/guidelines', {
      method: 'PUT',
      body: JSON.stringify({ guidelines: el('guidelines-text').value }),
    });
    status.textContent = 'Saved.';
  } catch (err) {
    status.textContent = `Failed: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

el('ai-replies-toggle').addEventListener('change', async (ev) => {
  const enabled = !!ev.target.checked;
  const status = el('ai-replies-status');
  const toggle = ev.target;
  toggle.disabled = true;
  status.textContent = 'Saving…';
  try {
    await api('/api/settings/ai-replies-enabled', {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    });
    status.textContent = enabled ? 'On — AI will auto-reply.' : 'Off — all replies go to Delegate.';
  } catch (err) {
    // Roll the checkbox back so the UI matches the server state.
    toggle.checked = !enabled;
    status.textContent = `Failed: ${err.message}`;
  } finally {
    toggle.disabled = false;
  }
});

// --- Delegate window (per campaign) --------------------------------------

function updateDelegateBadge(n) {
  const badge = el('delegate-count');
  if (!badge) return;
  badge.textContent = String(n);
  badge.hidden = !(n > 0);
}

el('open-delegate-btn').addEventListener('click', async () => {
  if (!state.selectedCampaignId) return;
  showView('delegate');
  const c = state.campaigns.find((x) => x.id === state.selectedCampaignId);
  el('delegate-title').textContent = c ? `Delegate · ${c.brand_name} · ${c.name}` : 'Delegate';
  await renderDelegateList();
});

el('delegate-back-btn').addEventListener('click', () => showView('campaign'));

// A creator has an offer the admin can act on: priced offers exist and we're
// waiting on internal approval. Mirrors the send gate (AWAITING_APPROVAL) and
// the server-side action_count used for the badge.
function isOfferActionable(r) {
  return (
    Array.isArray(r.suggested_offers) &&
    r.suggested_offers.length > 0 &&
    r.negotiation_status === 'AWAITING_APPROVAL'
  );
}

// Shows in the Delegate window: AI hand-offs plus offers awaiting approval.
function isDelegateActionable(r) {
  return !!r.needs_human || isOfferActionable(r);
}

async function renderDelegateList() {
  const root = el('delegate-list');
  root.innerHTML = '<p class="hint">Loading…</p>';
  let rows;
  try {
    rows = await api(`/api/creators?campaign_id=${encodeURIComponent(state.selectedCampaignId)}`);
  } catch (err) {
    root.innerHTML = `<p class="hint">Failed to load: ${escapeHtml(err.message)}</p>`;
    return;
  }
  const pending = rows.filter(isDelegateActionable);
  updateDelegateBadge(pending.length);
  if (!pending.length) {
    root.innerHTML =
      '<p class="hint">Nothing needs you right now. Replies the AI hands off (or every reply, while &ldquo;Auto-reply with AI&rdquo; is off), plus offers awaiting your approval, will appear here.</p>';
    return;
  }
  root.innerHTML = '';
  for (const r of pending) root.appendChild(buildDelegateCard(r));
}

function buildDelegateCard(r) {
  const card = document.createElement('div');
  card.className = 'delegate-card';
  const isHandoff = !!r.needs_human;
  const offerActionable = isOfferActionable(r);

  // Header — the reason pill shows the hand-off reason, or "offer to approve"
  // when the card is here purely because an offer is ready.
  const head = document.createElement('div');
  head.className = 'delegate-head';
  head.innerHTML = `
    <div>
      <a href="${r.instagram_url}" target="_blank" rel="noopener">@${escapeHtml(r.instagram_username || '')}</a>
      ${r.first_name ? `<span class="meta"> · ${escapeHtml(r.first_name)}</span>` : ''}
      <div class="meta">${escapeHtml(r.email || 'no email')}</div>
    </div>
    ${
      isHandoff && r.delegate_reason
        ? `<span class="delegate-reason">${escapeHtml(r.delegate_reason)}</span>`
        : offerActionable
        ? '<span class="delegate-reason offer">offer to approve</span>'
        : ''
    }`;
  card.appendChild(head);

  // The creator's parked message (hand-off), or a short prompt (offer-only).
  if (isHandoff && r.delegate_question) {
    const q = document.createElement('div');
    q.className = 'delegate-question';
    q.textContent = r.delegate_question;
    card.appendChild(q);
  } else if (!isHandoff && offerActionable) {
    const sub = document.createElement('div');
    sub.className = 'delegate-subtitle meta';
    sub.textContent = 'Creator shared a rate — review & send an offer.';
    card.appendChild(sub);
  }

  // Offer controls (relocated from the table) when an offer awaits approval.
  if (offerActionable) {
    card.appendChild(
      buildOfferControls(r, async () => {
        await renderDelegateList();
        await refreshCampaigns();
      }),
    );
  }

  // Reply block — only for AI hand-offs (there's a creator message to answer).
  if (isHandoff) {
    const block = document.createElement('div');
    block.className = 'delegate-reply-block';
    block.innerHTML = `
      <label>Your reply</label>
      <textarea class="delegate-reply io-scroll" rows="5" placeholder="Write your reply…  ([text](url) and {{grey}}…{{/grey}} formatting supported)"></textarea>
      <div class="delegate-reply-foot">
        <span class="delegate-status hint"></span>
        <button class="ghost small delegate-dismiss" type="button">Dismiss</button>
        <button class="btn-primary delegate-send" type="button">Send reply</button>
      </div>`;
    card.appendChild(block);

    const replyEl = block.querySelector('.delegate-reply');
    const statusEl = block.querySelector('.delegate-status');
    const sendBtn = block.querySelector('.delegate-send');
    const dismissBtn = block.querySelector('.delegate-dismiss');

    sendBtn.onclick = async () => {
      const body = replyEl.value.trim();
      if (!body) { statusEl.textContent = 'Write a reply first.'; return; }
      sendBtn.disabled = true; dismissBtn.disabled = true;
      statusEl.textContent = 'Sending…';
      try {
        await api(`/api/creators/${r.id}/delegate-reply`, {
          method: 'POST',
          body: JSON.stringify({ body }),
        });
        await renderDelegateList();
        await refreshCampaigns();
      } catch (err) {
        statusEl.textContent = `Failed: ${err.message}`;
        sendBtn.disabled = false; dismissBtn.disabled = false;
      }
    };

    dismissBtn.onclick = async () => {
      if (!confirm('Dismiss without replying? This clears it from Delegate.')) return;
      sendBtn.disabled = true; dismissBtn.disabled = true;
      try {
        await api(`/api/creators/${r.id}/dismiss-delegate`, { method: 'POST' });
        await renderDelegateList();
        await refreshCampaigns();
      } catch (err) {
        statusEl.textContent = `Failed: ${err.message}`;
        sendBtn.disabled = false; dismissBtn.disabled = false;
      }
    };
  }
  return card;
}

(async () => {
  await refreshCampaigns();
})();
