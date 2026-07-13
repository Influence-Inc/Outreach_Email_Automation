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
      item.onclick = () => navigate('campaign', c.id);
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

// --- Path routing --------------------------------------------------------
// Each view has its own path URL so a refresh (or a shared/bookmarked link)
// lands back on the same campaign instead of the empty picker. Routes:
//   /campaign/<id>            → a campaign's creators
//   /campaign/<id>/delegate   → that campaign's Delegate window
//   /guidelines               → the global Guidelines page
//   /                         → empty picker
// The server serves the app shell for all of these (see the SPA fallback in
// server.js); navigation goes through navigate() and handleRoute() is the
// single place that renders a view, keeping the URL and the UI in sync.
function routePath(parts) {
  return parts.length ? `/${parts.map(encodeURIComponent).join('/')}` : '/';
}

function navigate(...parts) {
  const path = routePath(parts);
  if (location.pathname !== path) {
    history.pushState({}, '', path);
  }
  handleRoute();
}

function parseRoute() {
  return (location.pathname || '/')
    .split('/')
    .filter(Boolean)
    .map((p) => {
      try { return decodeURIComponent(p); } catch { return p; }
    });
}

async function handleRoute() {
  const parts = parseRoute();

  if (parts[0] === 'guidelines') {
    showView('guidelines');
    el('guidelines-status').textContent = '';
    await refreshSettings();
    return;
  }

  if (parts[0] === 'campaign' && parts[1]) {
    const id = parts[1];
    if (state.selectedCampaignId !== id) {
      if (!state.campaigns.some((c) => c.id === id)) {
        // Unknown/stale campaign id — drop back to the empty picker.
        if (location.pathname !== '/') { history.replaceState({}, '', '/'); }
        showView('campaign');
        return;
      }
      await selectCampaign(id);
    }
    if (parts[2] === 'delegate') {
      await openDelegate();
    } else {
      showView('campaign');
    }
    return;
  }

  // No route (or unrecognised) — show the campaign view's empty state.
  showView('campaign');
}

// Browser Back/Forward moves through the pushState history above.
window.addEventListener('popstate', handleRoute);

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
    { label: 'Pending', value: c.pending_count },
    { label: 'Outreach', value: c.outreach_sent_count },
    { label: 'Replied', value: c.replied_count, accent: true },
    { label: 'Contracted', value: c.contracted_count },
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
  setUsageRightsToggle(c.usage_rights_policy || 'no_rights');
  el('usage-rights-status').textContent = '';
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
  // Once a contract exists the pill continues the SAME status flow into the
  // contract stages (no separate column) — contract sent → signed → completed.
  if (r.contract && r.contract.status) {
    const contractPill = {
      pending: { cls: 'accepted', text: 'contract sent' },
      signed: { cls: 'accepted', text: 'contract signed' },
      completed: { cls: 'accepted', text: 'completed' },
    }[r.contract.status];
    if (contractPill) return contractPill;
  }
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

// The rate the creator currently wants: once they've ACCEPTED, that's the offer
// they accepted (the latest priced offer we sent), not their earlier quote. For
// older accepted rows whose quoted_rate wasn't updated, we recover the amount
// from the rate timeline. Otherwise it's their quoted_rate.
function effectiveRate(r) {
  if (r.negotiation_status === 'ACCEPTED') {
    const log = Array.isArray(r.rate_log) ? r.rate_log : [];
    for (let i = log.length - 1; i >= 0; i--) {
      const e = log[i];
      if (e && (e.type === 'rate_accepted' || e.type === 'rate_offer_sent') && e.amount != null) {
        return Number(e.amount);
      }
    }
  }
  return r.quoted_rate != null ? Number(r.quoted_rate) : null;
}

// Deliverables to show under the accepted rate, pulled from the creator's
// contract (generated the moment they accept; see contracts.js). Returns a
// list of structured items so the caller can render each as a tiny labelled
// "TAG · value" line (readable at a glance in a narrow column) and the
// offer-type item as a coloured pill.
//
// Item shapes:
//   { kind: 'badge', text: 'View-based deal' }      // offer type — coloured pill
//   { kind: 'field', label: 'MIN VIEWS', value: '100K' }
function dealSummaryItems(data) {
  if (!data) return [];
  const items = [];

  // Offer type first, as a coloured badge. Makes the shape of the accepted
  // deal legible at a glance without having to parse the details below.
  if (data.offerLabel) items.push({ kind: 'badge', text: data.offerLabel });

  const isViewBased = data.offerType === 'view_based';
  const n = data.numberOfVideos != null ? Number(data.numberOfVideos) : null;
  const minViews = data.minTotalViews != null ? Number(data.minTotalViews) : null;

  // Videos — hidden for view-based deals (priced by guaranteed views, not by a
  // fixed post count).
  if (!isViewBased && n && Number.isFinite(n)) {
    items.push({ label: 'VIDEOS', value: String(n) });
  }
  if (minViews && Number.isFinite(minViews) && minViews > 0) {
    items.push({ label: 'MIN VIEWS', value: fmtViews(minViews) });
  }

  if (Array.isArray(data.platforms) && data.platforms.length) {
    items.push({ label: 'PLATFORMS', value: data.platforms.join(', ') });
  }

  const deadline = data.postingDeadline || data.deadline;
  if (deadline) {
    // Base contract data spells out "Monday, April 20, 2026"; drop the
    // weekday prefix to keep this line short in a narrow column. Left as-is
    // if it doesn't match that shape (e.g. a Claude-extracted date string).
    items.push({ label: 'DUE', value: String(deadline).replace(/^[A-Za-z]+day,\s*/, '') });
  }

  const usageBits = [];
  if (data.paidAdsIncluded === true) usageBits.push('Paid ads OK');
  else if (data.paidAdsIncluded === false) usageBits.push('No paid ads');
  if (data.exclusivity && !/^(none|no exclusivity)$/i.test(String(data.exclusivity).trim())) {
    usageBits.push(`Excl: ${data.exclusivity}`);
  }
  if (usageBits.length) items.push({ label: 'USAGE', value: usageBits.join(' · ') });

  // Payment schedule — only shown when an upfront split actually applies (the
  // creator demanded upfront payment). No split means "paid in full on
  // completion", the default, so there's nothing to surface here.
  const upPct = Number(data.upfrontPercent);
  const remPct = Number(data.remainderPercent);
  if (upPct > 0 && remPct > 0) {
    items.push({ label: 'PAYMENT', value: `${upPct}% upfront, ${remPct}% on completion` });
  }

  return items;
}

// Parse a human "min views" input ("100k", "1.2M", "250,000") into a number.
function parseViewsInput(s) {
  const str = String(s == null ? '' : s).trim().toLowerCase().replace(/,/g, '');
  if (!str) return null;
  const m = str.match(/^([\d.]+)\s*([km])?$/);
  if (!m) {
    const n = Number(str.replace(/[^\d.]/g, ''));
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  let n = Number(m[1]);
  if (m[2] === 'k') n *= 1e3;
  else if (m[2] === 'm') n *= 1e6;
  return Number.isFinite(n) ? Math.round(n) : null;
}

// PATCH a single contract deal field. Used by the editable Deals column.
function saveContractField(r, patch) {
  return api(`/api/creators/${r.id}/contract`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

// Render one editable "TAG · value" deal line whose value is a click-to-edit
// text field (reuses the same makeEditable helper as the rate cell).
function appendEditableDealLine(cell, r, { label, value, placeholder, onSave }) {
  const lineDiv = document.createElement('div');
  lineDiv.className = 'deal-line';
  const tag = document.createElement('span');
  tag.className = 'deal-tag';
  tag.textContent = label;
  const val = document.createElement('span');
  val.className = 'deal-val';
  val.textContent = value == null || value === '' ? '—' : value;
  lineDiv.appendChild(tag);
  lineDiv.appendChild(val);
  cell.appendChild(lineDiv);
  makeEditable(val, { value: value == null ? '' : String(value), placeholder, allowEmpty: true, onSave });
}

// The editable deal terms shown under the rate once a contract exists and is
// still PENDING (unsigned) — the admin can correct anything the extraction got
// wrong straight from the Deals column. A signed contract is read-only.
function renderEditableDeal(cell, r, data) {
  const hint = document.createElement('div');
  hint.className = 'deal-edit-hint';
  hint.textContent = 'Deal terms · click to edit';
  cell.appendChild(hint);

  const isViewBased = data.offerType === 'view_based';
  if (!isViewBased) {
    appendEditableDealLine(cell, r, {
      label: 'VIDEOS',
      value: data.numberOfVideos != null ? Number(data.numberOfVideos) : '',
      placeholder: '# videos',
      onSave: (v) => saveContractField(r, { numberOfVideos: v === '' ? null : Number(v) }),
    });
  }
  appendEditableDealLine(cell, r, {
    label: 'MIN VIEWS',
    value: data.minTotalViews > 0 ? fmtViews(data.minTotalViews) : '',
    placeholder: 'e.g. 100k',
    onSave: (v) => saveContractField(r, { minTotalViews: parseViewsInput(v) }),
  });
  appendEditableDealLine(cell, r, {
    label: 'PLATFORMS',
    value: Array.isArray(data.platforms) ? data.platforms.join(', ') : '',
    placeholder: 'Instagram, TikTok…',
    onSave: (v) => saveContractField(r, { platforms: v }),
  });
  appendEditableDealLine(cell, r, {
    label: 'DUE',
    value: (data.postingDeadline || data.deadline || '').replace(/^[A-Za-z]+day,\s*/, ''),
    placeholder: 'e.g. April 20, 2026',
    onSave: (v) => saveContractField(r, { postingDeadline: v }),
  });

  // Paid ads is a boolean, so it's a click-to-toggle chip rather than a text
  // field — this is the control that fixes the reported "usage rights missing".
  const paidLine = document.createElement('div');
  paidLine.className = 'deal-line';
  const paidTag = document.createElement('span');
  paidTag.className = 'deal-tag';
  paidTag.textContent = 'PAID ADS';
  const paidVal = document.createElement('span');
  paidVal.className = 'deal-val deal-toggle';
  const included = data.paidAdsIncluded === true;
  paidVal.textContent = data.paidAdsIncluded == null ? '—' : included ? 'Included ✓' : 'Not included';
  paidVal.classList.toggle('on', included);
  paidVal.title = 'Click to toggle paid ad rights';
  paidVal.onclick = async () => {
    try {
      await saveContractField(r, { paidAdsIncluded: !included });
    } catch (err) {
      alert(err.message);
    }
    await refreshCreators();
    await refreshCampaigns();
  };
  paidLine.appendChild(paidTag);
  paidLine.appendChild(paidVal);
  cell.appendChild(paidLine);

  appendEditableDealLine(cell, r, {
    label: 'EXCLUSIVITY',
    value: data.exclusivity && !/^none$/i.test(String(data.exclusivity).trim()) ? data.exclusivity : '',
    placeholder: 'None',
    onSave: (v) => saveContractField(r, { exclusivity: v }),
  });

  // Upfront payment is a boolean toggle: ON adds the default 30/70 split, OFF
  // means paid in full on completion. The payment schedule is only meant to be
  // on the contract when the creator explicitly demanded upfront payment — this
  // is the control that adds/removes it by hand.
  const upfrontLine = document.createElement('div');
  upfrontLine.className = 'deal-line';
  const upfrontTag = document.createElement('span');
  upfrontTag.className = 'deal-tag';
  upfrontTag.textContent = 'UPFRONT';
  const upfrontVal = document.createElement('span');
  upfrontVal.className = 'deal-val deal-toggle';
  const upPct = Number(data.upfrontPercent);
  const remPct = Number(data.remainderPercent);
  const hasUpfront = upPct > 0 && remPct > 0;
  upfrontVal.textContent = hasUpfront ? `${upPct}% upfront ✓` : 'On completion';
  upfrontVal.classList.toggle('on', hasUpfront);
  upfrontVal.title = 'Click to toggle an upfront payment split';
  upfrontVal.onclick = async () => {
    try {
      await saveContractField(r, { upfrontPayment: !hasUpfront });
    } catch (err) {
      alert(err.message);
    }
    await refreshCreators();
    await refreshCampaigns();
  };
  upfrontLine.appendChild(upfrontTag);
  upfrontLine.appendChild(upfrontVal);
  cell.appendChild(upfrontLine);
}

// Rate column ("Deals"): the editable agreed/quoted rate, plus — once the
// creator has accepted — the deliverables they agreed to (videos, min views,
// deadline, platforms, usage rights), read from their contract. While the
// contract is still pending those deal terms are editable in place; once it's
// signed they're shown read-only.
function renderRateCell(r, cell) {
  const rate = effectiveRate(r);
  const valueDiv = document.createElement('div');
  valueDiv.className = 'rate-value num' + (rate != null ? '' : ' empty');
  valueDiv.textContent = rate != null ? `$${fmtNum(rate)}` : '—';
  cell.appendChild(valueDiv);
  makeEditable(valueDiv, {
    value: rate != null ? String(rate) : '',
    placeholder: 'rate $',
    onSave: (v) =>
      api(`/api/creators/${r.id}/quoted-rate`, {
        method: 'POST',
        body: JSON.stringify({ quoted_rate: Number(String(v).replace(/[^0-9.]/g, '')) }),
      }),
  });

  if (r.negotiation_status === 'ACCEPTED' && r.contract && r.contract.data) {
    const data = r.contract.data;
    if (data.offerLabel) {
      const badge = document.createElement('span');
      badge.className = 'deal-badge';
      badge.textContent = data.offerLabel;
      cell.appendChild(badge);
    }
    // Pending -> editable deal terms; signed/completed -> read-only summary.
    if (r.contract.status === 'pending') {
      renderEditableDeal(cell, r, data);
      return;
    }
    for (const item of dealSummaryItems(data)) {
      if (item.kind === 'badge') continue; // already rendered above
      const lineDiv = document.createElement('div');
      lineDiv.className = 'deal-line';
      const tag = document.createElement('span');
      tag.className = 'deal-tag';
      tag.textContent = item.label;
      const value = document.createElement('span');
      value.className = 'deal-val';
      value.textContent = item.value;
      lineDiv.appendChild(tag);
      lineDiv.appendChild(value);
      cell.appendChild(lineDiv);
    }
  }
}

const TRASH_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path></svg>';

// "Stop outreach" — a ban/no-entry glyph for the square icon button that sits
// beside the delete button on every creator row.
const STOP_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><line x1="5.6" y1="5.6" x2="18.4" y2="18.4"></line></svg>';

// "Decide offer": open this creator's Instagram profile in a new tab with the
// Chrome extension's offer panel latched to the right. The extension handles the
// hand-off (see dashboard-bridge.js → background.js openDecideOffer); here we
// just post the message the bridge forwards, carrying this dashboard's origin as
// the API base so the panel can reach the same endpoints. extensionBridge.ready
// (set when the bridge announces on load) tells us whether the extension is
// installed.
function launchDecideOffer(r, btn) {
  if (!r.instagram_username) {
    alert('This creator has no Instagram username to open.');
    return;
  }
  window.postMessage({ type: 'OEA_PING' }, window.location.origin);
  window.postMessage(
    {
      type: 'OEA_OPEN_DECIDE_OFFER',
      payload: {
        creatorId: r.id,
        username: r.instagram_username,
        campaignId: r.campaign_id,
        apiBase: window.location.origin,
      },
    },
    window.location.origin,
  );
  if (!btn) return;
  const prev = btn.textContent;
  btn.textContent = 'Opening Instagram…';
  setTimeout(() => {
    btn.textContent = prev;
    if (!extensionBridge.ready) {
      alert(
        'Chrome extension not detected. Load the unpacked extension at chrome://extensions, then reload this page.',
      );
    }
  }, 1500);
}

function makeDecideOfferButton(r, { label = 'Decide offer' } = {}) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ghost small cr-decide-btn';
  btn.textContent = `${label} ▸`;
  btn.title = 'Open this creator’s Instagram profile with the offer panel';
  btn.onclick = () => launchDecideOffer(r, btn);
  return btn;
}

// Status column: pill + delete + (send-outreach when pending) + timeline.
function renderStatusCell(r, cell) {
  const top = document.createElement('div');
  top.className = 'cr-status-top';

  // Left group: the status pill and — once a contract exists — the copy-link
  // button sit side by side, so the signing link reads as part of the
  // "contract sent" status rather than a detached control below it.
  const left = document.createElement('div');
  left.className = 'cr-status-left';
  const pill = statusPillFor(r);
  const pillEl = document.createElement('span');
  pillEl.className = `status-pill ${pill.cls}`;
  pillEl.textContent = pill.text;
  // Duplicates carry the "why" in notes — surface it on hover so the reject is
  // explainable at a glance.
  if (r.status === 'duplicate' && r.notes) pillEl.title = r.notes;
  left.appendChild(pillEl);

  // Contract link — shown once a contract exists, next to the status pill so
  // the same Status column carries the signing link (no dedicated column).
  // Copies the public URL.
  if (r.contract && r.contract.url) {
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'ghost small cr-copy-contract';
    copy.textContent = 'Copy link';
    copy.title = r.contract.url;
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(r.contract.url);
        const prev = copy.textContent;
        copy.textContent = 'Copied ✓';
        setTimeout(() => {
          copy.textContent = prev;
        }, 1400);
      } catch (e) {
        window.prompt('Contract link', r.contract.url);
      }
    };
    left.appendChild(copy);
  }

  top.appendChild(left);

  // Stop outreach — a square icon button beside delete, available on every
  // creator at any lifecycle stage (only hidden once already stopped, where it
  // would be a no-op). Removes the creator's lead from THIS Instantly campaign
  // so its queued follow-ups halt, then marks the row stopped. Scoped to this
  // campaign — the same person stays free to be enrolled elsewhere later.
  if (r.status !== 'stopped') {
    const stop = document.createElement('button');
    stop.type = 'button';
    stop.className = 'icon-btn-sq';
    stop.title = 'Stop outreach for this campaign — removes the lead from this Instantly campaign so no further emails are sent';
    stop.innerHTML = STOP_SVG;
    stop.onclick = async () => {
      if (!confirm('Stop outreach for this creator in this campaign? This removes them from this Instantly campaign so no further outreach or follow-ups are sent. It does not affect any other campaign.')) return;
      stop.disabled = true;
      try {
        const res = await api(`/api/creators/${r.id}/stop-outreach`, { method: 'POST' });
        if (res && res.warning) alert(res.warning);
        await refreshCreators();
        await refreshCampaigns();
      } catch (err) {
        alert(err.message);
        stop.disabled = false;
      }
    };
    top.appendChild(stop);
  }

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

  // On a creator awaiting our offer, surface "Decide offer" right by the
  // timeline — one click opens their Instagram profile with the offer panel
  // (rate, counters, safe floor, accept/counter) latched to the side.
  if (isOfferActionable(r)) {
    cell.appendChild(makeDecideOfferButton(r));
  }

  const log = Array.isArray(r.rate_log) ? r.rate_log : [];
  if (log.length) cell.appendChild(renderTimeline(log, r));
}

// Read-receipt tick badge for the "Outreach sent" timeline step. Rendered
// INSIDE the timeline (next to the label), not next to the main status pill —
// three states, driven by Instantly (opens + follow-up sends via the webhook):
//   • single gray  — outreach sent; no follow-up, no reply, not seen
//   • double gray  — a follow-up was sent, but the creator hasn't seen it
//   • double green — creator opened an email (seen) or replied
// The tick is only rendered when the timeline actually contains the "Outreach
// sent" step (see renderTimeline), so its very presence already proves outreach
// happened — this function must NOT gate on r.outreach_sent_at (some legacy /
// imported rows have status='outreach_sent' + a sent_outreach event but a NULL
// outreach_sent_at column; the tick was silently missing for those creators).
// Once the deal moves past acceptance the pill's "accepted / contract sent /
// signed" states tell the story instead, so hide the tick there.
function outreachTicksFor(r) {
  if (!r) return null;
  if (r.negotiation_status === 'ACCEPTED' || (r.contract && r.contract.status)) return null;
  const replied = r.status === 'replied' || r.replied_at != null;
  const seen = Number(r.open_count) > 0 || r.last_open_at != null;
  const followedUp =
    r.status === 'followup_sent' || r.followup_sent_at != null || Number(r.followup_step) >= 2;
  if (replied || seen) {
    return { count: 2, tone: 'green', title: replied ? 'Creator replied' : 'Seen — creator opened the email' };
  }
  if (followedUp) return { count: 2, tone: 'gray', title: 'Follow-up sent · not seen yet' };
  return { count: 1, tone: 'gray', title: 'Outreach sent · no follow-up or reply yet' };
}

// One or two overlapping check marks, drawn with currentColor so the wrapper's
// tone class (gray / green) drives the fill.
function ticksSvg(count) {
  const stroke = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  if (count >= 2) {
    return `<svg viewBox="0 0 22 12" width="18" height="10" ${stroke} aria-hidden="true">` +
      '<path d="M1 6.5 L4.6 10 L10.6 2.5"/><path d="M8 6.5 L11.6 10 L17.6 2.5"/></svg>';
  }
  return `<svg viewBox="0 0 13 12" width="11" height="10" ${stroke} aria-hidden="true">` +
    '<path d="M1 6.5 L4.6 10 L11 2.5"/></svg>';
}

function renderOutreachTicks(r) {
  const t = outreachTicksFor(r);
  if (!t) return null;
  const span = document.createElement('span');
  span.className = `outreach-ticks tone-${t.tone}`;
  span.title = t.title;
  span.setAttribute('aria-label', t.title);
  span.innerHTML = ticksSvg(t.count);
  return span;
}

// A vertical delivery-tracking timeline, oldest → newest. The newest entry is
// the "current" step (emphasized); a connecting line joins consecutive steps.
// Consecutive entries with the same label (e.g. "Creator replied" ×3) collapse
// into one expandable node to keep the column compact — distinct events (offers,
// quotes, accepted) stay as their own steps.
function renderTimeline(log, r) {
  const wrap = document.createElement('div');
  wrap.className = 'timeline';
  const items = Array.isArray(log) ? log : [];

  // Group runs of consecutive identical-label entries.
  const groups = [];
  for (const e of items) {
    const last = groups[groups.length - 1];
    if (last && last.text === (e.text || '')) last.entries.push(e);
    else groups.push({ text: e.text || '', entries: [e] });
  }

  const dotClassFor = (entry, isCurrent) => {
    let cls = 'timeline-dot ' + (isCurrent ? 'current' : 'done');
    if (entry.tone === 'success') cls += ' tone-success';
    if (entry.tone === 'muted') cls += ' tone-muted';
    return cls;
  };

  groups.forEach((g, gi) => {
    const isLast = gi === groups.length - 1;
    const newest = g.entries[g.entries.length - 1]; // group's representative
    // Two ways a step collapses into a "label + count + chevron" group:
    //   1) A run of consecutive identical-text events ("Creator replied ×3").
    //   2) A single "Creator quoted rates" event whose detail carries an
    //      `options` array — one negotiation reply where the creator named
    //      multiple rates ("$3,500 for 300k views / $5,000 for 600k / …").
    // The rate options render as substeps in that same expand-on-click UI.
    const rateOptions =
      g.entries.length === 1 && Array.isArray(newest.options) && newest.options.length > 1
        ? newest.options
        : null;
    const collapsed = g.entries.length > 1 || !!rateOptions;

    const step = document.createElement('div');
    step.className = 'timeline-step' + (isLast ? ' current' : '');
    if (newest.tone === 'success') step.classList.add('tone-success');

    const rail = document.createElement('div');
    rail.className = 'timeline-rail';
    const dot = document.createElement('div');
    dot.className = dotClassFor(newest, isLast);
    rail.appendChild(dot);
    if (!isLast) {
      const line = document.createElement('div');
      line.className = 'timeline-line';
      rail.appendChild(line);
    }

    const body = document.createElement('div');
    body.className = 'timeline-body';
    body.style.paddingBottom = isLast ? '0' : '4px';

    if (collapsed) {
      // Summary row: label + count + chevron; click to reveal each substep.
      // Count semantics: for repeated events show "×N" (three replies); for
      // rate options show "(N)" (three tiered rates in one reply).
      const head = document.createElement('div');
      head.className = 'timeline-group-head';
      head.setAttribute('role', 'button');
      head.tabIndex = 0;
      const label = document.createElement('span');
      label.className = 'timeline-label';
      label.textContent = g.text;
      const count = document.createElement('span');
      count.className = 'timeline-count';
      const subCount = rateOptions ? rateOptions.length : g.entries.length;
      count.textContent = rateOptions ? String(subCount) : '×' + subCount;
      const chev = document.createElement('span');
      chev.className = 'timeline-chevron';
      chev.textContent = '▾';
      head.append(label, count, chev);

      const time = document.createElement('div');
      time.className = 'timeline-time num';
      time.textContent = fmtAgo(newest.at);
      time.title = fmtDate(newest.at);

      const subs = document.createElement('div');
      subs.className = 'timeline-substeps';
      subs.hidden = true;
      if (rateOptions) {
        // Each rate option becomes one substep: "$3,500 · for 300,000 views".
        // If the label already starts with the amount (extracted verbatim from
        // the reply), strip the leading amount so it isn't rendered twice.
        const fmtMoney = (n) => `$${fmtNum(Math.round(Number(n) || 0))}`;
        rateOptions.forEach((o) => {
          const li = document.createElement('div');
          li.className = 'timeline-substep timeline-substep-rate';
          const amt = document.createElement('span');
          amt.className = 'timeline-substep-amt num';
          amt.textContent = fmtMoney(o.amount);
          const desc = document.createElement('span');
          desc.className = 'timeline-substep-desc';
          const amtStr = fmtMoney(o.amount);
          let d = String(o.label || '').trim();
          if (d.startsWith(amtStr)) d = d.slice(amtStr.length).replace(/^[\s·:,-]+/, '');
          desc.textContent = d;
          li.append(amt, desc);
          subs.appendChild(li);
        });
      } else {
        // Repeated identical-text events: show each occurrence's timestamp.
        g.entries.forEach((e) => {
          const li = document.createElement('div');
          li.className = 'timeline-substep num';
          li.textContent = fmtDate(e.at);
          subs.appendChild(li);
        });
      }

      const toggle = () => {
        const open = subs.hidden;
        subs.hidden = !open;
        head.classList.toggle('open', open);
      };
      head.addEventListener('click', toggle);
      head.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); }
      });

      body.append(head, time, subs);
    } else {
      const label = document.createElement('div');
      label.className = 'timeline-label';
      label.textContent = g.text;
      // Read-receipt ticks live inline with the "Outreach sent" step's label,
      // so the engagement signal reads as part of that single tracking node
      // rather than a separate control anywhere else in the row.
      if (newest.type === 'sent_outreach') {
        const ticks = renderOutreachTicks(r);
        if (ticks) label.appendChild(ticks);
      }
      const time = document.createElement('div');
      time.className = 'timeline-time num';
      time.textContent = fmtAgo(newest.at);
      time.title = fmtDate(newest.at);
      body.append(label, time);
    }

    step.append(rail, body);
    wrap.appendChild(step);
  });
  return wrap;
}

// ── Offer configurator ────────────────────────────────────────────────────
// Three editable deal structures (view-based / video-based / video + bonus),
// all seeded from a "safe floor" (the creator's weakest recent video's views).
// The admin shapes any structure, selects one, and Approve & send. The chosen
// structure is serialized into the `custom_offer` shape the backend already
// understands (offer_type view_based | video_based | video_bonus) and POSTed
// to the same /offer endpoint. Replaces the old dropdown + CPM slider.

const money = (n) => '$' + fmtNum(Math.round(Number(n) || 0));
const numOr = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round2 = (n) => Math.round(Number(n) * 100) / 100;

const OC_ICONS = {
  view: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"></path><circle cx="12" cy="12" r="3"></circle></svg>',
  video: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"></rect><path d="m10 9 5 3-5 3Z" fill="currentColor" stroke="none"></path></svg>',
  bonus: '<svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z"></path></svg>',
};

function buildOfferConfigurator(r, onRefresh) {
  const root = document.createElement('div');
  root.className = 'offer-config';

  const stats = r.ig_scraped_data && typeof r.ig_scraped_data === 'object' ? r.ig_scraped_data : {};
  const offers = Array.isArray(r.suggested_offers) ? r.suggested_offers : [];
  const viewOffer = offers.find((o) => o.offer_type === 'view_based');
  const seedCpm =
    Math.round(Number((viewOffer && viewOffer.cpm_applied) || (offers[0] && offers[0].cpm_applied) || 12)) || 12;
  const safeFloor0 = Math.round(Number(stats.min_views) || Number(stats.p50) || 1000000);

  // A prior 'rate_offer_sent' means this is a counter-offer round, not the first.
  const priorOfferSent =
    Array.isArray(r.rate_log) && r.rate_log.some((e) => e && e.type === 'rate_offer_sent');
  const offerNoun = priorOfferSent ? 'counter offer' : 'offer';
  const sent = r.negotiation_status === 'AWAITING_DECISION';

  // Seed from an existing custom_offer (previous approval) when present, so
  // reopening shows the last configuration; otherwise from the safe floor.
  const custom = r.custom_offer && typeof r.custom_offer === 'object' ? r.custom_offer : null;
  const bCpm0 = Math.max(1, seedCpm - 4);
  const bUnlock0 = Math.round((safeFloor0 * 2 * 1.4) / 100000) * 100000 || safeFloor0;
  const bBonus0 = Math.max(1000, Math.round(((safeFloor0 * 2) / 1000) * bCpm0 * 0.15 / 500) * 500);
  const isType = (t) => custom && custom.offer_type === t;
  const m = {
    safeFloor: safeFloor0,
    vViews: (isType('view_based') && custom.view_guarantee) || safeFloor0,
    vCpm: (isType('view_based') && custom.cpm_applied) || seedCpm,
    fVideos: (isType('video_based') && custom.num_videos) || 2,
    fCpm: (isType('video_based') && custom.cpm_applied) || seedCpm,
    bVideos: (isType('video_bonus') && custom.num_videos) || 2,
    bCpm: (isType('video_bonus') && custom.cpm_applied) || bCpm0,
    bUnlock: (isType('video_bonus') && custom.bonus_threshold_views) || bUnlock0,
    bBonus: (isType('video_bonus') && custom.bonus_amount) || bBonus0,
    selected: custom
      ? custom.offer_type === 'view_based'
        ? 'view'
        : custom.offer_type === 'video_bonus'
        ? 'bonus'
        : 'video'
      : 'view',
  };

  const initial = avatarInitial(r);
  const badge = sent
    ? '<span class="oc-badge sent">✓ Offer sent</span>'
    : '<span class="oc-badge pending">Awaiting approval</span>';
  const approveLabel = priorOfferSent ? 'Re-approve &amp; send counter offer' : 'Approve &amp; send offer';
  // No quoted rate on an offer-actionable creator means the creator asked us to
  // price it first — say so; otherwise reflect the rate they shared.
  const subtitle =
    r.quoted_rate != null
      ? `Creator shared a rate of $${fmtNum(r.quoted_rate)} — shape an offer and send.`
      : 'Creator asked us to quote a rate first — set a price and send the offer.';

  root.innerHTML = `
    <div class="oc-header">
      <div class="oc-id">
        <div class="oc-avatar">${escapeHtml(initial)}</div>
        <div>
          <div class="oc-handle">
            <a href="${r.instagram_url}" target="_blank" rel="noopener">@${escapeHtml(r.instagram_username || '')}</a>
            ${r.first_name ? `<span class="oc-name"> · ${escapeHtml(r.first_name)}</span>` : ''}
          </div>
          <div class="oc-email">${escapeHtml(r.email || 'no email')}</div>
        </div>
      </div>
      ${badge}
    </div>
    <div class="oc-subtitle">${subtitle}</div>

    <div class="oc-floor">
      <div class="oc-floor-main">
        <div class="oc-floor-label">Safe floor · per video <span class="oc-scraped">SCRAPED</span></div>
        <input type="number" min="0" class="oc-input oc-floor-input num" data-k="safeFloor" value="${m.safeFloor}">
        <div class="oc-sub">= <span data-r="safeFloorFmt"></span> guaranteed views · least-viewed recent video</div>
      </div>
      <div class="oc-floor-desc">The safe floor is the view count of the creator’s weakest recent video. It seeds the defaults below and drives every video-based structure.</div>
    </div>

    <div class="oc-deals">
      <!-- VIEW -->
      <div class="oc-deal" data-deal="view">
        <div class="oc-deal-head">
          <div class="oc-deal-icon view">${OC_ICONS.view}</div>
          <div><div class="oc-deal-kicker">01 · GUARANTEED</div><div class="oc-deal-title">View-based deal</div></div>
        </div>
        <div class="oc-deal-desc">Pay a flat CPM against a guaranteed view count. Simplest, most predictable spend.</div>
        <div class="oc-fields">
          <div class="oc-field">
            <label class="oc-field-label">Guaranteed views</label>
            <input type="number" min="0" class="oc-input num" data-k="vViews" value="${m.vViews}">
            <div class="oc-sub">= <span data-r="vViewsFmt"></span> views · seeded from safe floor</div>
          </div>
          <div class="oc-field">
            <label class="oc-field-label">CPM</label>
            <div class="oc-money"><span class="oc-money-prefix">$</span><input type="number" min="0" step="0.5" class="oc-input oc-money-input num" data-k="vCpm" value="${m.vCpm}"></div>
          </div>
        </div>
        <div class="oc-divider"></div>
        <div class="oc-rows">
          <div class="oc-row"><span>Guarantees</span><b data-r="vViewsFmt"></b></div>
          <div class="oc-row"><span>Effective CPM</span><b data-r="viewEff"></b></div>
          <div class="oc-row oc-row-total"><span>Total fee</span><span class="oc-fee num" data-r="viewFee"></span></div>
        </div>
        <button class="oc-choose" data-choose="view" type="button">Choose this offer</button>
      </div>

      <!-- VIDEO -->
      <div class="oc-deal" data-deal="video">
        <div class="oc-deal-head">
          <div class="oc-deal-icon video">${OC_ICONS.video}</div>
          <div><div class="oc-deal-kicker">02 · DELIVERABLES</div><div class="oc-deal-title">Video-based deal</div></div>
        </div>
        <div class="oc-deal-desc">Pay per video at the safe-floor rate. Views scale with the number of posts.</div>
        <div class="oc-fields">
          <div class="oc-field">
            <label class="oc-field-label">Number of videos</label>
            <input type="number" min="1" step="1" class="oc-input num" data-k="fVideos" value="${m.fVideos}">
            <div class="oc-sub">× <span data-r="safeFloorFmt"></span> floor = <span data-r="videoViewsFmt"></span> views</div>
          </div>
          <div class="oc-field">
            <label class="oc-field-label">CPM</label>
            <div class="oc-money"><span class="oc-money-prefix">$</span><input type="number" min="0" step="0.5" class="oc-input oc-money-input num" data-k="fCpm" value="${m.fCpm}"></div>
          </div>
        </div>
        <div class="oc-divider"></div>
        <div class="oc-rows">
          <div class="oc-row"><span>Total views</span><b data-r="videoViewsFmt"></b></div>
          <div class="oc-row"><span>Effective CPM</span><b data-r="videoEff"></b></div>
          <div class="oc-row oc-row-total"><span>Total fee</span><span class="oc-fee num" data-r="videoFee"></span></div>
        </div>
        <button class="oc-choose" data-choose="video" type="button">Choose this offer</button>
      </div>

      <!-- BONUS -->
      <div class="oc-deal" data-deal="bonus">
        <div class="oc-deal-head">
          <div class="oc-deal-icon bonus">${OC_ICONS.bonus}</div>
          <div><div class="oc-deal-kicker">03 · UPSIDE</div><div class="oc-deal-title">Video deal + bonus</div></div>
        </div>
        <div class="oc-deal-desc">Lower base CPM plus a flat bonus that unlocks past a view threshold.</div>
        <div class="oc-fields">
          <div class="oc-field-pair">
            <div class="oc-field">
              <label class="oc-field-label">Videos</label>
              <input type="number" min="1" step="1" class="oc-input num" data-k="bVideos" value="${m.bVideos}">
            </div>
            <div class="oc-field">
              <label class="oc-field-label">Base CPM</label>
              <div class="oc-money"><span class="oc-money-prefix">$</span><input type="number" min="0" step="0.5" class="oc-input oc-money-input num" data-k="bCpm" value="${m.bCpm}"></div>
            </div>
          </div>
          <div class="oc-field">
            <label class="oc-field-label">Bonus unlocks at (views)</label>
            <input type="number" min="0" class="oc-input num" data-k="bUnlock" value="${m.bUnlock}">
            <div class="oc-sub">= <span data-r="bUnlockFmt"></span> views · floor projects <span data-r="bonusViewsFmt"></span></div>
          </div>
          <div class="oc-field">
            <label class="oc-field-label">Bonus amount</label>
            <div class="oc-money"><span class="oc-money-prefix">$</span><input type="number" min="0" step="500" class="oc-input oc-money-input num" data-k="bBonus" value="${m.bBonus}"></div>
          </div>
        </div>
        <div class="oc-divider"></div>
        <div class="oc-rows">
          <div class="oc-row"><span>Base fee (<span data-r="bonusViewsFmt"></span> views)</span><b data-r="baseFee"></b></div>
          <div class="oc-row"><span>+ Bonus on unlock</span><b class="oc-plus">+ <span data-r="bBonusMoney"></span></b></div>
          <div class="oc-row oc-row-inset"><span>Effective CPM at unlock</span><b data-r="bonusUnlockEff"></b></div>
          <div class="oc-row oc-row-total"><span>Aggregate deal</span><span class="oc-fee num" data-r="aggregate"></span></div>
        </div>
        <button class="oc-choose" data-choose="bonus" type="button">Choose this offer</button>
      </div>
    </div>

    <div class="oc-sendbar">
      <div class="oc-sendbar-info">
        <div class="oc-sendbar-label">Selected offer · @${escapeHtml(r.instagram_username || '')}</div>
        <div class="oc-sendbar-headline"><span data-r="selName"></span> <span class="oc-dash">—</span> <span class="num" data-r="selFee"></span></div>
        <div class="oc-sendbar-meta" data-r="selMeta"></div>
      </div>
      <div class="oc-sendbar-actions">
        <span class="oc-send-status hint"></span>
        ${
          r.quoted_rate != null
            ? `<button class="oc-accept-rate btn-accept" type="button">Accept creator's rate — $${fmtNum(r.quoted_rate)} ✓</button>`
            : ''
        }
        <button class="oc-dismiss ghost small" type="button">Dismiss</button>
        <button class="oc-approve btn-primary" type="button">${approveLabel} →</button>
      </div>
    </div>
  `;

  const setR = (key, val) => {
    root.querySelectorAll(`[data-r="${key}"]`).forEach((n) => { n.textContent = val; });
  };
  const statusEl = root.querySelector('.oc-send-status');
  const approveBtn = root.querySelector('.oc-approve');
  const dismissBtn = root.querySelector('.oc-dismiss');
  let computed = {};

  function recompute() {
    const sf = numOr(m.safeFloor);
    const vViews = numOr(m.vViews), vCpm = numOr(m.vCpm);
    const viewFee = Math.round((vViews / 1000) * vCpm);
    const fVideos = numOr(m.fVideos), fCpm = numOr(m.fCpm);
    const videoViews = sf * fVideos;
    const videoFee = Math.round((videoViews / 1000) * fCpm);
    const perVideo = fVideos ? Math.round(videoFee / fVideos) : videoFee;
    const bVideos = numOr(m.bVideos), bCpm = numOr(m.bCpm), bUnlock = numOr(m.bUnlock), bBonus = numOr(m.bBonus);
    const bonusViews = sf * bVideos;
    const baseFee = Math.round((bonusViews / 1000) * bCpm);
    const aggregate = baseFee + bBonus;
    const unlockEff = bUnlock ? (aggregate / bUnlock) * 1000 : 0;

    setR('safeFloorFmt', fmtViews(sf));
    setR('vViewsFmt', fmtViews(vViews));
    setR('viewEff', '$' + vCpm.toFixed(2));
    setR('viewFee', money(viewFee));
    setR('videoViewsFmt', fmtViews(videoViews));
    setR('videoEff', '$' + fCpm.toFixed(2));
    setR('videoFee', money(videoFee));
    setR('bUnlockFmt', fmtViews(bUnlock));
    setR('bonusViewsFmt', fmtViews(bonusViews));
    setR('baseFee', money(baseFee));
    setR('bBonusMoney', money(bBonus));
    setR('aggregate', money(aggregate));
    setR('bonusUnlockEff', '$' + unlockEff.toFixed(2));

    let selName, selFee, selMeta;
    if (m.selected === 'view') {
      selName = 'View-based deal';
      selFee = money(viewFee);
      selMeta = `${fmtViews(vViews)} guaranteed views · $${vCpm} CPM`;
    } else if (m.selected === 'video') {
      selName = 'Video-based deal';
      selFee = money(videoFee);
      selMeta = `${fVideos} videos · ${fmtViews(videoViews)} views · $${fCpm} CPM`;
    } else {
      selName = 'Video + bonus deal';
      selFee = money(aggregate);
      selMeta = `${bVideos} videos · base ${money(baseFee)} + ${money(bBonus)} bonus`;
    }
    setR('selName', selName);
    setR('selFee', selFee);
    setR('selMeta', selMeta);

    root.querySelectorAll('.oc-deal').forEach((d) => {
      const on = d.dataset.deal === m.selected;
      d.classList.toggle('selected', on);
      const btn = d.querySelector('.oc-choose');
      btn.textContent = on ? '✓ Selected offer' : 'Choose this offer';
      btn.classList.toggle('is-selected', on);
    });

    computed = { viewFee, vViews, vCpm, videoViews, videoFee, perVideo, fVideos, fCpm, bonusViews, baseFee, aggregate, bVideos, bCpm, bUnlock, bBonus };
  }

  root.querySelectorAll('input[data-k]').forEach((input) => {
    input.addEventListener('input', () => {
      const k = input.dataset.k;
      m[k] = input.value === '' ? '' : Number(input.value);
      recompute();
    });
  });
  root.querySelectorAll('.oc-choose').forEach((btn) => {
    btn.addEventListener('click', () => {
      m.selected = btn.dataset.choose;
      recompute();
    });
  });

  function buildCustomOffer() {
    if (m.selected === 'view') {
      return {
        offer_id: 'cfg_view',
        offer_type: 'view_based',
        label: 'View-based deal',
        flat_fee: computed.viewFee,
        view_guarantee: Math.round(computed.vViews),
        num_videos: 1,
        flat_per_video: computed.viewFee,
        cpm_applied: round2(computed.vCpm),
      };
    }
    if (m.selected === 'video') {
      return {
        offer_id: 'cfg_video',
        offer_type: 'video_based',
        label: 'Video-based deal',
        flat_fee: computed.videoFee,
        num_videos: computed.fVideos,
        flat_per_video: computed.perVideo,
        view_guarantee: Math.round(computed.videoViews),
        cpm_applied: round2(computed.fCpm),
      };
    }
    return {
      offer_id: 'cfg_bonus',
      offer_type: 'video_bonus',
      label: 'Video + bonus deal',
      flat_fee: computed.aggregate, // top-line (base + bonus)
      base_fee: computed.baseFee,
      bonus_amount: computed.bBonus,
      bonus_threshold_views: Math.round(computed.bUnlock),
      num_videos: computed.bVideos,
      flat_per_video: Math.round(computed.baseFee / Math.max(1, computed.bVideos)),
      view_guarantee: Math.round(computed.bonusViews),
      cpm_applied: round2(computed.bCpm),
    };
  }

  approveBtn.onclick = async () => {
    // Belt-and-braces guard: even though we disable the button below, the
    // browser can still queue the "click" from a rapid double-tap BEFORE the
    // disabled flag lands. Track a per-click sentinel too, so a queued second
    // click bails out on entry. Combined with the server-side atomic claim,
    // this makes a duplicate approve-send-offer literally impossible from one
    // click.
    if (approveBtn.dataset.busy === '1') return;
    approveBtn.dataset.busy = '1';
    approveBtn.disabled = true;
    dismissBtn.disabled = true;
    statusEl.textContent = 'Approving…';
    const offer = buildCustomOffer();
    try {
      const resp = await api(`/api/creators/${r.id}/offer`, {
        method: 'PATCH',
        body: JSON.stringify({
          selected_offer_id: offer.offer_id,
          custom_offer: offer,
          offer_approved: true,
        }),
      });
      const sr = resp && resp.send_result;
      // Offers are sent only by this approval — never automatically — so when a
      // send is skipped we say why instead of promising a later send.
      let hold = 1400;
      if (sr && sr.sent) {
        statusEl.textContent = `✓ ${offer.label} sent.`;
      } else if (sr && sr.error) {
        // The send may or may not have gone through (network timeout mid-flight
        // is ambiguous). We deliberately do NOT roll the stage back on the
        // server, and we deliberately do NOT re-enable Approve here — the admin
        // must check the mailbox and re-approve manually if needed, to avoid a
        // duplicate email in the creator's inbox.
        statusEl.textContent =
          `Send failed: ${sr.error}. Check the creator's inbox before re-approving to avoid a duplicate.`;
        hold = 6000;
      } else if (sr && sr.skipped) {
        statusEl.textContent = `Approved, not sent — ${sr.skipped}. Approve again when ready.`;
        hold = 4500;
      } else {
        statusEl.textContent = `✓ ${offer.label} approved.`;
      }
      setTimeout(onRefresh, hold);
    } catch (err) {
      // Only network-layer failures reach here (the /offer PATCH itself never
      // hit the server, or hit and got a non-2xx). Re-enable the buttons so
      // the admin can retry — the server-side atomic claim + this button's
      // dataset.busy sentinel prevent a duplicate send.
      statusEl.textContent = err.message;
      approveBtn.disabled = false;
      dismissBtn.disabled = false;
      approveBtn.dataset.busy = '';
    }
  };

  const acceptRateBtn = root.querySelector('.oc-accept-rate');
  if (acceptRateBtn) {
    acceptRateBtn.onclick = async () => {
      // Guard the same way as approve: a queued double-tap must not fire two
      // acceptances (the server also claims atomically).
      if (acceptRateBtn.dataset.busy === '1') return;
      const rateStr = `$${fmtNum(r.quoted_rate)}`;
      const who = r.first_name || `@${r.instagram_username || 'this creator'}`;
      if (
        !confirm(
          `Accept ${who}'s rate of ${rateStr}? We'll agree to their number and send the contract for signing.`,
        )
      )
        return;
      acceptRateBtn.dataset.busy = '1';
      acceptRateBtn.disabled = true;
      approveBtn.disabled = true;
      dismissBtn.disabled = true;
      statusEl.textContent = 'Accepting…';
      try {
        await api(`/api/creators/${r.id}/accept-rate`, { method: 'POST' });
        statusEl.textContent = `✓ Accepted ${rateStr} — contract sent.`;
        setTimeout(onRefresh, 1400);
      } catch (err) {
        statusEl.textContent = `Couldn't accept: ${err.message}`;
        acceptRateBtn.disabled = false;
        approveBtn.disabled = false;
        dismissBtn.disabled = false;
        acceptRateBtn.dataset.busy = '';
      }
    };
  }

  dismissBtn.onclick = async () => {
    if (!confirm('Dismiss this offer without sending? The creator will be removed from Delegate.')) return;
    approveBtn.disabled = true;
    dismissBtn.disabled = true;
    statusEl.textContent = 'Dismissing…';
    try {
      await api(`/api/creators/${r.id}/dismiss-offer`, { method: 'POST' });
      statusEl.textContent = 'Dismissed.';
      setTimeout(onRefresh, 800);
    } catch (err) {
      statusEl.textContent = `Failed to dismiss: ${err.message}`;
      approveBtn.disabled = false;
      dismissBtn.disabled = false;
    }
  };

  // Let the admin jump to the creator's Instagram profile with this same offer
  // panel latched to the side, straight from the Delegate card.
  const sendbarActions = root.querySelector('.oc-sendbar-actions');
  if (sendbarActions && r.instagram_username) {
    sendbarActions.insertBefore(makeDecideOfferButton(r, { label: 'Open on IG' }), sendbarActions.firstChild);
  }

  recompute();
  return root;
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
    identity.appendChild(handle);

    // First name and full name are separate, independently editable fields —
    // NOT derived from one another. First name is what the outreach and
    // negotiation emails greet the creator by (used verbatim, spaces and
    // all — e.g. "Anvith K" stays "Anvith K" in "Hi Anvith K,"), so it needs
    // its own field rather than being auto-split from whatever's typed into
    // "full name".
    const nameFields = [
      { key: 'first_name', label: 'First', placeholder: 'First name' },
      { key: 'full_name', label: 'Full', placeholder: 'Full name' },
    ];
    for (const { key, label, placeholder } of nameFields) {
      const row = document.createElement('div');
      row.className = 'cr-name-row';
      const tag = document.createElement('span');
      tag.className = 'cr-name-tag';
      tag.textContent = label;
      const valueSpan = document.createElement('span');
      valueSpan.className = 'cr-name-value' + (r[key] ? '' : ' empty');
      // Empty needs a visible placeholder ("—") so the span has a click target;
      // an empty span collapses to zero width and can't be clicked open. Matches
      // the email cell's empty-state pattern.
      valueSpan.textContent = r[key] || '—';
      row.appendChild(tag);
      row.appendChild(valueSpan);
      identity.appendChild(row);
      makeEditable(valueSpan, {
        value: r[key] || '',
        placeholder,
        allowEmpty: true, // blanking the cell clears that field only
        onSave: (v) =>
          api(`/api/creators/${r.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ [key]: v || null }),
          }),
      });
    }
    creatorCell.appendChild(avatar);
    creatorCell.appendChild(identity);

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

// Usage Rights: a 3-way segmented toggle (no_rights / free_only / required)
// that PATCHes the campaign the moment a new option is clicked — no separate
// Save button, matching how a toggle is expected to behave.
function setUsageRightsToggle(value) {
  const buttons = document.querySelectorAll('#usage-rights-toggle .segmented-opt');
  buttons.forEach((btn) => btn.classList.toggle('active', btn.dataset.value === value));
}

document.querySelectorAll('#usage-rights-toggle .segmented-opt').forEach((btn) => {
  btn.addEventListener('click', async () => {
    if (!state.selectedCampaignId) return;
    const value = btn.dataset.value;
    const status = el('usage-rights-status');
    const buttons = document.querySelectorAll('#usage-rights-toggle .segmented-opt');
    buttons.forEach((b) => (b.disabled = true));
    // The active class on the clicked option IS the confirmation — a toggle
    // that snaps to the new value is self-evidently saved. So we don't print
    // "Saving…"/"Saved." on the happy path; the status span only exists to
    // carry a failure message (`.hint:empty` hides the empty span entirely,
    // so the label + toggle stay on one line).
    status.textContent = '';
    try {
      await api(`/api/campaigns/${encodeURIComponent(state.selectedCampaignId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ usage_rights_policy: value }),
      });
      setUsageRightsToggle(value);
      await refreshCampaigns();
    } catch (err) {
      status.textContent = `Failed: ${err.message}`;
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  });
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

el('open-guidelines-btn').addEventListener('click', () => navigate('guidelines'));

el('guidelines-back-btn').addEventListener('click', () => {
  if (state.selectedCampaignId) { navigate('campaign', state.selectedCampaignId); }
  else { navigate(); }
});

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

async function openDelegate() {
  if (!state.selectedCampaignId) return;
  showView('delegate');
  const c = state.campaigns.find((x) => x.id === state.selectedCampaignId);
  el('delegate-title').textContent = c ? `Delegate · ${c.brand_name} · ${c.name}` : 'Delegate';
  await renderDelegateList();
}

el('open-delegate-btn').addEventListener('click', () => {
  if (!state.selectedCampaignId) return;
  navigate('campaign', state.selectedCampaignId, 'delegate');
});

el('delegate-back-btn').addEventListener('click', () => {
  if (state.selectedCampaignId) { navigate('campaign', state.selectedCampaignId); }
  else { navigate(); }
});

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

const refreshDelegateAndCampaigns = async () => {
  await renderDelegateList();
  await refreshCampaigns();
};

function buildDelegateCard(r) {
  const isHandoff = !!r.needs_human;
  const offerActionable = isOfferActionable(r);

  // Offer-actionable creators get the full offer configurator, rendered on the
  // app background so its white deal cards read as the redesign intends. If the
  // same creator is also an AI hand-off, the reply block is appended below.
  if (offerActionable) {
    const item = document.createElement('div');
    item.className = 'delegate-offer-item';
    item.appendChild(buildOfferConfigurator(r, refreshDelegateAndCampaigns));
    // If the creator also has a hand-off (e.g. they replied while the offer was
    // awaiting approval), show their message + a reply box beneath the offer so
    // it isn't missed. The admin can answer it, or just send the offer.
    if (isHandoff) {
      const msg = buildHandoffMessage(r);
      if (msg) item.appendChild(msg);
      item.appendChild(buildReplyBlock(r));
    }
    return item;
  }

  // Hand-off only: the creator's parked message + a reply box, in a plain card.
  const card = document.createElement('div');
  card.className = 'delegate-card';
  const head = document.createElement('div');
  head.className = 'delegate-head';
  head.innerHTML = `
    <div>
      <a href="${r.instagram_url}" target="_blank" rel="noopener">@${escapeHtml(r.instagram_username || '')}</a>
      ${r.first_name ? `<span class="meta"> · ${escapeHtml(r.first_name)}</span>` : ''}
      <div class="meta">${escapeHtml(r.email || 'no email')}</div>
    </div>
    ${r.delegate_reason ? `<span class="delegate-reason">${escapeHtml(r.delegate_reason)}</span>` : ''}`;
  card.appendChild(head);

  if (r.delegate_question) {
    const q = document.createElement('div');
    q.className = 'delegate-question';
    q.textContent = r.delegate_question;
    card.appendChild(q);
  }
  card.appendChild(buildReplyBlock(r));
  return card;
}

// The creator's parked message (+ the hand-off reason) shown above the reply
// box on an offer-configurator card, so a reply that arrived while the offer was
// awaiting approval is visible instead of silent. The plain hand-off card
// renders the reason in its own header, so this helper is only used on the offer
// card. Returns null when there's nothing to show.
function buildHandoffMessage(r) {
  if (!r.delegate_reason && !r.delegate_question) return null;
  const wrap = document.createElement('div');
  wrap.className = 'delegate-handoff-msg';
  if (r.delegate_reason) {
    const label = document.createElement('div');
    label.className = 'delegate-handoff-label';
    label.textContent = r.delegate_reason;
    wrap.appendChild(label);
  }
  if (r.delegate_question) {
    const q = document.createElement('div');
    q.className = 'delegate-question';
    q.textContent = r.delegate_question;
    wrap.appendChild(q);
  }
  return wrap;
}

// The "Your reply" textarea + Dismiss/Send, used by hand-off cards (standalone,
// and alongside the offer configurator when a creator is both).
function buildReplyBlock(r) {
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
      await refreshDelegateAndCampaigns();
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
      await refreshDelegateAndCampaigns();
    } catch (err) {
      statusEl.textContent = `Failed: ${err.message}`;
      sendBtn.disabled = false; dismissBtn.disabled = false;
    }
  };
  return block;
}

(async () => {
  await refreshCampaigns();
  // Restore the view encoded in the URL so a refresh keeps the current
  // campaign instead of dropping back to the empty picker.
  await handleRoute();
})();
