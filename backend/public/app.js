const API = '';

const state = {
  campaigns: [],
  selectedCampaignId: null,
  templates: [],
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

async function refreshAuth() {
  try {
    const s = await api('/auth/status');
    const node = el('auth-status');
    if (s.authorized) {
      node.innerHTML = `Sending as <b>${s.senderEmail}</b> · <a href="/auth/google">re-auth</a>`;
    } else {
      node.innerHTML = `<a href="/auth/google" style="color:#fff;text-decoration:underline;">⚠ Connect Gmail (${s.senderEmail})</a>`;
    }
  } catch (err) {
    el('auth-status').textContent = `auth status error: ${err.message}`;
  }
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
    tree.innerHTML = '<p class="hint">No campaigns synced yet. Click Refresh.</p>';
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
      item.innerHTML = `<span>${c.name}</span><span class="meta">${c.creator_count}</span>`;
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
  el('templates-view').hidden = name !== 'templates';
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
  el('campaign-title').textContent = `${c.brand_name} · ${c.name}`;
  el('campaign-stats').innerHTML = `
    <span>Creators: <b>${c.creator_count}</b></span>
    <span>Pending: <b>${c.pending_extraction_count}</b></span>
    <span>Email found: <b>${c.email_found_count}</b></span>
    <span>Outreach: <b>${c.outreach_sent_count}</b></span>
    <span>Follow-up: <b>${c.followup_sent_count}</b></span>
    <span>Replied: <b>${c.replied_count}</b></span>
  `;
  updateDelegateBadge(c.action_count || 0);
  el('creator-form').hidden = false;
  el('creator-table-wrap').hidden = false;
  el('campaign-max-cpm').value = c.max_cpm != null ? c.max_cpm : '';
  el('campaign-template-card').hidden = false;
  renderCampaignTemplatePicker(c);
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

function renderViewsCell(r, td) {
  const s = r.ig_scraped_data;
  if (s && s.reel_count) {
    td.innerHTML =
      `<b>${fmtViews(s.p50)}</b> <span class="meta">median</span>` +
      `<br/><span class="meta">${s.reel_count} reels · low ${fmtViews(s.min_views)}</span>`;
  } else {
    td.innerHTML = '<span class="meta">— no views</span>';
  }
  // Editable: paste the recent reel view counts (comma/space separated). Lets
  // the admin seed or correct the numbers when the scraper comes up short.
  const rawViews =
    s && Array.isArray(s.views_raw) ? s.views_raw.map((n) => Math.round(n)).join(', ') : '';
  makeEditable(td, {
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

function renderRateCell(r, td) {
  // The editable rate value lives in its own element so click-to-edit is scoped
  // to it — clicking the timeline below never opens the editor, and the timeline
  // survives an inline edit (makeEditable only clears the element it owns).
  const valueDiv = document.createElement('div');
  valueDiv.className = 'rate-value';
  valueDiv.textContent = r.quoted_rate != null ? `$${fmtNum(r.quoted_rate)}` : '—';
  td.appendChild(valueDiv);
  makeEditable(valueDiv, {
    value: r.quoted_rate != null ? String(r.quoted_rate) : '',
    placeholder: 'rate $',
    onSave: (v) =>
      api(`/api/creators/${r.id}/quoted-rate`, {
        method: 'POST',
        body: JSON.stringify({ quoted_rate: Number(String(v).replace(/[^0-9.]/g, '')) }),
      }),
  });
  const log = Array.isArray(r.rate_log) ? r.rate_log : [];
  if (log.length) td.appendChild(renderRateLog(log));
}

// A compact, delivery-tracking-style timeline of rate updates, newest first.
// The newest entry is the "current" step (emphasized); older ones are muted.
function renderRateLog(log) {
  const ol = document.createElement('ol');
  ol.className = 'rate-log';
  const items = log.slice().reverse(); // newest first
  items.forEach((e, i) => {
    const li = document.createElement('li');
    li.className = `rate-log-item tone-${e.tone || 'done'}${i === 0 ? ' current' : ''}`;
    const dot = document.createElement('span');
    dot.className = 'rate-log-dot';
    const body = document.createElement('div');
    body.className = 'rate-log-body';
    const text = document.createElement('div');
    text.className = 'rate-log-text';
    text.textContent = e.text || '';
    const when = document.createElement('div');
    when.className = 'rate-log-when';
    when.textContent = fmtAgo(e.at);
    when.title = fmtDate(e.at);
    body.appendChild(text);
    body.appendChild(when);
    li.appendChild(dot);
    li.appendChild(body);
    ol.appendChild(li);
  });
  return ol;
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
    <button class="small neg-approve">${approveLabel}</button>
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

// --- Per-creator email thread dropdown -----------------------------------

function fmtThreadDate(s) {
  if (!s) return '';
  const d = new Date(s);
  return isNaN(d) ? String(s) : d.toLocaleString();
}

function renderThreadInto(box, data) {
  const messages = (data && data.messages) || [];
  if (!messages.length) {
    box.innerHTML = '<p class="hint" style="margin:0;">No messages yet.</p>';
    return;
  }
  const note =
    data.source === 'events'
      ? '<p class="hint" style="margin:0 0 8px;">Gmail not connected — showing the activity log (subjects only).</p>'
      : '';
  const items = messages
    .map((m) => {
      const side = m.direction === 'outbound' ? 'out' : 'in';
      const who = escapeHtml(m.fromName || (side === 'out' ? 'INFLUENCE' : 'Creator'));
      const when = escapeHtml(fmtThreadDate(m.date));
      const subj = m.subject ? `<div class="thread-subj">${escapeHtml(m.subject)}</div>` : '';
      const bodyText = (m.text || '').trim();
      const body = bodyText ? escapeHtml(bodyText) : '<span class="meta">(no text)</span>';
      return `
        <div class="thread-msg ${side}">
          <div class="thread-meta"><b>${who}</b><span class="meta">${when}</span></div>
          ${subj}
          <div class="thread-body">${body}</div>
        </div>`;
    })
    .join('');
  box.innerHTML = note + items;
}

async function toggleThreadRow(tr, creator, btn) {
  const existing = tr.nextElementSibling;
  if (existing && existing.classList.contains('thread-row')) {
    existing.remove();
    btn.classList.remove('active');
    return;
  }
  btn.classList.add('active');
  const row = document.createElement('tr');
  row.className = 'thread-row';
  const td = document.createElement('td');
  td.colSpan = tr.children.length;
  const box = document.createElement('div');
  box.className = 'thread-box';
  box.innerHTML = '<p class="hint" style="margin:0;">Loading conversation…</p>';
  td.appendChild(box);
  row.appendChild(td);
  tr.after(row);
  try {
    const data = await api(`/api/creators/${creator.id}/thread`);
    renderThreadInto(box, data);
  } catch (err) {
    box.innerHTML = `<p class="hint" style="margin:0;">Couldn't load thread: ${escapeHtml(err.message)}</p>`;
  }
}

async function refreshCreators() {
  if (!state.selectedCampaignId) return;
  const rows = await api(`/api/creators?campaign_id=${encodeURIComponent(state.selectedCampaignId)}`);
  const tbody = document.querySelector('#creator-table tbody');
  tbody.innerHTML = '';
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.dataset.creatorId = r.id;
    const lastActivity = r.replied_at || r.followup_sent_at || r.outreach_sent_at || r.updated_at;
    tr.innerHTML = `
      <td><a href="${r.instagram_url}" target="_blank" rel="noopener">@${r.instagram_username || r.instagram_url}</a></td>
      <td>${r.first_name || ''} ${r.full_name && r.full_name !== r.first_name ? `<br/><span class="meta">${r.full_name}</span>` : ''}</td>
      <td>${r.email || '<span class="meta">—</span>'}</td>
      <td><span class="tag ${r.status}">${r.status.replace(/_/g, ' ')}</span></td>
      <td>${r.open_count}${r.last_open_at ? `<br/><span class="meta">${fmtDate(r.last_open_at)}</span>` : ''}</td>
      <td><span class="meta">${fmtDate(lastActivity)}</span></td>
      <td class="neg-views-cell"></td>
      <td class="neg-rate-cell"></td>
      <td></td>
    `;
    const cells = tr.querySelectorAll('td');
    const nameTd = cells[1];
    const emailTd = cells[2];
    const actions = cells[cells.length - 1];
    renderViewsCell(r, tr.querySelector('.neg-views-cell'));
    renderRateCell(r, tr.querySelector('.neg-rate-cell'));

    makeEditable(nameTd, {
      value: r.full_name || r.first_name || '',
      placeholder: 'Account name',
      onSave: (v) =>
        api(`/api/creators/${r.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            full_name: v,
            first_name: v.split(/\s+/)[0],
          }),
        }),
    });
    makeEditable(emailTd, {
      value: r.email || '',
      placeholder: 'creator@email.com',
      allowEmpty: true, // blanking the cell clears the email
      onSave: (v) =>
        api(`/api/creators/${r.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ email: v || null }),
        }),
    });

    const threadBtn = document.createElement('button');
    threadBtn.className = 'small ghost thread-toggle';
    threadBtn.textContent = '💬 Thread';
    threadBtn.title = 'Show the email conversation';
    threadBtn.onclick = () => toggleThreadRow(tr, r, threadBtn);
    actions.appendChild(threadBtn);

    if (r.status === 'email_found') {
      const btn = document.createElement('button');
      btn.className = 'small';
      btn.textContent = 'Send outreach';
      btn.onclick = async () => {
        btn.disabled = true;
        try {
          await api(`/api/creators/${r.id}/send-outreach`, { method: 'POST' });
          await refreshCreators();
          await refreshCampaigns();
        } catch (err) {
          alert(err.message);
          btn.disabled = false;
        }
      };
      actions.appendChild(btn);
    }
    const del = document.createElement('button');
    del.className = 'small ghost';
    del.textContent = '✕';
    del.title = 'Remove from campaign';
    del.onclick = async () => {
      if (!confirm('Remove this creator?')) return;
      await api(`/api/creators/${r.id}`, { method: 'DELETE' });
      await refreshCreators();
      await refreshCampaigns();
    };
    actions.appendChild(del);
    tbody.appendChild(tr);
  }
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
  if (msg.type === 'OEA_SEND_PROGRESS') {
    handleSendProgress(msg);
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

// --- Send-via-Extension queue --------------------------------------------
// Mirrors the scrape-queue progress UI. The extension drives Gmail's compose
// UI for each pending creator instead of going through the Gmail API.

function showSendProgress(text) {
  el('send-progress').hidden = false;
  el('send-progress-text').textContent = text;
}

function hideSendProgress() {
  el('send-progress').hidden = true;
  el('send-progress-text').textContent = '';
}

function handleSendProgress(msg) {
  if (msg.event === 'start') {
    showSendProgress(`Sending 0/${msg.total}…`);
  } else if (msg.event === 'creator-start') {
    showSendProgress(`Sending ${msg.index}/${msg.total} — ${msg.label}…`);
  } else if (msg.event === 'creator-done') {
    let tail;
    if (msg.outcome === 'sent') {
      const thr = msg.sentMeta && msg.sentMeta.threaded ? '' : ' (no thread)';
      tail = `sent ${msg.label}${thr}`;
    } else if (msg.outcome === 'skipped') {
      tail = `skipped ${msg.label}: ${msg.error || 'unknown'}`;
    } else {
      tail = `error on ${msg.label}: ${msg.error || 'unknown'}`;
    }
    showSendProgress(`Sending ${msg.index}/${msg.total} — ${tail}`);
  } else if (msg.event === 'done') {
    const s = msg.summary || {};
    showSendProgress(
      `Done. ${s.processed || 0} processed · ${s.sent || 0} sent · ` +
      `${s.skipped || 0} skipped · ${s.errors || 0} errors. [hide]`,
    );
    el('send-cancel-btn').textContent = 'Hide';
    refreshCreators();
    refreshCampaigns();
  } else if (msg.event === 'aborted') {
    showSendProgress(`Aborted at ${msg.index}/${msg.total}.`);
    el('send-cancel-btn').textContent = 'Hide';
    refreshCreators();
    refreshCampaigns();
  } else if (msg.event === 'error') {
    showSendProgress(`Extension error: ${msg.error}`);
    el('send-cancel-btn').textContent = 'Hide';
  }
}

el('send-cancel-btn').addEventListener('click', () => {
  if (el('send-cancel-btn').textContent === 'Hide') {
    hideSendProgress();
    el('send-cancel-btn').textContent = 'Cancel';
    return;
  }
  window.postMessage({ type: 'OEA_ABORT_SEND_QUEUE' }, window.location.origin);
});

el('send-via-extension-btn').addEventListener('click', async () => {
  if (!state.selectedCampaignId) return;
  const btn = el('send-via-extension-btn');
  btn.disabled = true;
  el('send-cancel-btn').textContent = 'Cancel';
  // Same handshake pattern as the scrape button: ping so a missed initial
  // OEA_EXTENSION_READY doesn't read as "not installed".
  window.postMessage({ type: 'OEA_PING' }, window.location.origin);
  try {
    const rows = await api(
      `/api/creators?campaign_id=${encodeURIComponent(state.selectedCampaignId)}&status=email_found`,
    );
    // Same filter the server-side bulk endpoint uses — pending creators only.
    const pending = rows.filter((r) => !r.outreach_sent_at && r.email);
    if (!pending.length) {
      showSendProgress('No pending creators to send to.');
      el('send-cancel-btn').textContent = 'Hide';
      return;
    }
    if (
      !confirm(
        `Send outreach to ${pending.length} pending creator(s) via your local Gmail tab? ` +
          `Each send goes through Gmail's UI with a 60-150s random delay between sends. ` +
          `Make sure Gmail is open and logged in.`,
      )
    ) {
      hideSendProgress();
      return;
    }
    const creators = pending.map((r) => ({
      id: r.id,
      label: r.first_name
        ? `${r.first_name} <${r.email}>`
        : (r.instagram_username ? `@${r.instagram_username} <${r.email}>` : r.email),
    }));
    showSendProgress(`Starting send for ${creators.length} creator(s)…`);
    window.postMessage(
      {
        type: 'OEA_RUN_SEND_QUEUE',
        payload: {
          apiBase: window.location.origin,
          creators,
          pacingMs: 90_000,
          spreadMs: 60_000,
        },
      },
      window.location.origin,
    );
    setTimeout(() => {
      if (!extensionBridge.ready) {
        showSendProgress(
          'Extension not detected. Load the unpacked extension at chrome://extensions then reload this page.',
        );
        el('send-cancel-btn').textContent = 'Hide';
      }
    }, 2000);
  } catch (err) {
    showSendProgress(`Failed: ${err.message}`);
    el('send-cancel-btn').textContent = 'Hide';
  } finally {
    btn.disabled = false;
  }
});

// --- Email Templates -----------------------------------------------------

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function describeFollowups(followups) {
  if (!Array.isArray(followups) || !followups.length) return 'no follow-ups';
  return followups.map((s) => `${s.delayHours}h`).join(' → ');
}

async function refreshTemplates() {
  state.templates = await api('/api/templates');
  renderTemplatesList();
  // Re-render the campaign view's dropdown if it's currently visible.
  const c = state.campaigns.find((x) => x.id === state.selectedCampaignId);
  if (c && !el('campaign-template-card').hidden) renderCampaignTemplatePicker(c);
}

function renderTemplatesList() {
  const root = el('templates-list');
  root.innerHTML = '';
  if (!state.templates.length) {
    root.innerHTML = '<p class="hint">No templates yet. Click "+ New template" to add one.</p>';
    return;
  }
  for (const t of state.templates) root.appendChild(buildTemplateBlock(t));
}

// Renders one template as a collapsible <details> with the full editor.
// `template.id` is omitted for unsaved drafts.
function buildTemplateBlock(template) {
  const block = document.createElement('details');
  block.className = 'template-block template-row';
  if (template.id) block.dataset.templateId = String(template.id);
  if (!template.id) block.setAttribute('open', '');

  const draft = {
    name: template.name || '',
    is_default: !!template.is_default,
    // AI replies default ON unless explicitly false (matches backend default).
    ai_replies_enabled: template.ai_replies_enabled !== false,
    outreach: {
      subject: (template.outreach && template.outreach.subject) || '',
      body: (template.outreach && template.outreach.body) || '',
    },
    followups: Array.isArray(template.followups)
      ? template.followups.map((s) => ({
          delayHours: Number(s.delayHours) || 0,
          label: s.label || '',
          subject: s.subject || '',
          body: s.body || '',
        }))
      : [],
  };

  block.innerHTML = `
    <summary>
      <span class="template-block-title"></span>
      <span class="template-block-meta">
        <span class="badge default" hidden>default</span>
        <span class="badge ai-off" hidden>AI off</span>
        <span class="meta steps-summary"></span>
      </span>
    </summary>
    <div class="template-block-body"></div>
  `;
  const titleEl = block.querySelector('.template-block-title');
  const badgeEl = block.querySelector('.badge.default');
  const aiBadgeEl = block.querySelector('.badge.ai-off');
  const summaryMeta = block.querySelector('.steps-summary');
  const body = block.querySelector('.template-block-body');

  function refreshSummary() {
    titleEl.textContent = draft.name || '(unnamed)';
    badgeEl.hidden = !draft.is_default;
    aiBadgeEl.hidden = draft.ai_replies_enabled;
    summaryMeta.textContent = describeFollowups(draft.followups);
  }

  function renderFollowups() {
    const list = body.querySelector('.followups-list');
    list.innerHTML = '';
    if (!draft.followups.length) {
      const empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = 'No follow-ups configured. Click "+ Add follow-up" to add one.';
      list.appendChild(empty);
      return;
    }
    draft.followups.forEach((step, i) => {
      const row = document.createElement('details');
      row.className = 'followup-row';
      row.setAttribute('open', '');
      row.innerHTML = `
        <summary>
          <span class="followup-row-title">Follow-up #${i + 1}</span>
          <span class="meta followup-row-meta"></span>
          <button type="button" class="ghost small followup-remove">Remove</button>
        </summary>
        <div class="followup-row-body">
          <div class="row" style="gap: 12px; flex-wrap: wrap;">
            <label style="flex: 0 0 120px;">Delay (h)
              <input type="number" min="0" step="1" class="fup-delay" value="${step.delayHours}" />
            </label>
            <label style="flex: 1; min-width: 200px;">Label (optional)
              <input type="text" class="fup-label" value="${escapeHtml(step.label)}" placeholder="e.g. First bump" />
            </label>
          </div>
          <label>Subject
            <input type="text" class="fup-subject" value="${escapeHtml(step.subject)}" placeholder="Re: ..." />
          </label>
          <label>Body
            <textarea class="fup-body" rows="8" placeholder="Hi {firstName}, ...">${escapeHtml(step.body)}</textarea>
          </label>
        </div>
      `;
      const metaEl = row.querySelector('.followup-row-meta');
      const updateMeta = () => {
        const lbl = step.label ? ` — ${step.label}` : '';
        metaEl.textContent = `after ${step.delayHours}h${lbl}`;
      };
      updateMeta();
      row.querySelector('.fup-delay').oninput = (ev) => {
        step.delayHours = Number(ev.target.value) || 0;
        updateMeta();
        refreshSummary();
      };
      row.querySelector('.fup-label').oninput = (ev) => { step.label = ev.target.value; updateMeta(); };
      row.querySelector('.fup-subject').oninput = (ev) => { step.subject = ev.target.value; };
      row.querySelector('.fup-body').oninput = (ev) => { step.body = ev.target.value; };
      row.querySelector('.followup-remove').onclick = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        draft.followups.splice(i, 1);
        renderFollowups();
        refreshSummary();
      };
      list.appendChild(row);
    });
  }

  body.innerHTML = `
    <p class="hint">
      Placeholders: <code>{firstName}</code>, <code>{brandName}</code>, <code>{campaignName}</code>.
      Formatting: <code>[click here](https://example.com)</code> for links, <code>{{grey}}text{{/grey}}</code> for grey.
    </p>
    <div class="row" style="gap: 12px; flex-wrap: wrap;">
      <label style="flex: 1; min-width: 200px;">Template name
        <input type="text" class="tpl-name" value="${escapeHtml(draft.name)}" placeholder="e.g. Standard outreach" />
      </label>
      <label class="checkbox-label" style="align-self: end;">
        <input type="checkbox" class="tpl-is-default" ${draft.is_default ? 'checked' : ''} />
        Mark as default
      </label>
      <label class="checkbox-label" style="align-self: end;" title="When off, the AI never auto-replies for creators on this template — every reply goes to the campaign's Delegate window.">
        <input type="checkbox" class="tpl-ai-replies" ${draft.ai_replies_enabled ? 'checked' : ''} />
        Auto-reply with AI
      </label>
    </div>

    <h4 style="margin-top: 16px;">Outreach email (initial)</h4>
    <label>Subject
      <input type="text" class="out-subject" value="${escapeHtml(draft.outreach.subject)}" placeholder="Paid collaboration with {brandName}" />
    </label>
    <label>Body
      <textarea class="out-body" rows="10" placeholder="Hi {firstName}, ...">${escapeHtml(draft.outreach.body)}</textarea>
    </label>

    <h4 style="margin-top: 16px;">Follow-ups (in order)</h4>
    <div class="followups-list"></div>
    <div style="margin-top: 8px;">
      <button type="button" class="ghost small add-followup">+ Add follow-up</button>
    </div>

    <div class="row" style="gap: 8px; margin-top: 16px; justify-content: flex-end; align-items: center;">
      <span class="hint tpl-status" style="margin-right: auto;"></span>
      ${template.id ? '<button type="button" class="ghost tpl-delete">Delete</button>' : ''}
      <button type="button" class="tpl-save">${template.id ? 'Save changes' : 'Create template'}</button>
    </div>
  `;
  body.querySelector('.tpl-name').oninput = (ev) => {
    draft.name = ev.target.value;
    refreshSummary();
  };
  body.querySelector('.tpl-is-default').onchange = (ev) => {
    draft.is_default = ev.target.checked;
    refreshSummary();
  };
  body.querySelector('.tpl-ai-replies').onchange = (ev) => {
    draft.ai_replies_enabled = ev.target.checked;
    refreshSummary();
  };
  body.querySelector('.out-subject').oninput = (ev) => { draft.outreach.subject = ev.target.value; };
  body.querySelector('.out-body').oninput = (ev) => { draft.outreach.body = ev.target.value; };
  body.querySelector('.add-followup').onclick = (ev) => {
    ev.preventDefault();
    draft.followups.push({ delayHours: 48, label: '', subject: '', body: '' });
    renderFollowups();
    refreshSummary();
  };

  body.querySelector('.tpl-save').onclick = async (ev) => {
    ev.preventDefault();
    const btn = ev.currentTarget;
    const status = body.querySelector('.tpl-status');
    if (!draft.name.trim()) { status.textContent = 'name required'; return; }
    btn.disabled = true;
    status.textContent = 'Saving…';
    try {
      const payload = {
        name: draft.name.trim(),
        is_default: draft.is_default,
        ai_replies_enabled: draft.ai_replies_enabled,
        outreach: { subject: draft.outreach.subject, body: draft.outreach.body },
        followups: draft.followups.map((s) => ({
          delayHours: Number(s.delayHours) || 0,
          label: s.label || '',
          subject: s.subject || '',
          body: s.body || '',
        })),
      };
      if (template.id) {
        await api(`/api/templates/${template.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      } else {
        await api('/api/templates', { method: 'POST', body: JSON.stringify(payload) });
      }
      await refreshTemplates();
    } catch (err) {
      status.textContent = `Failed: ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  };
  const delBtn = body.querySelector('.tpl-delete');
  if (delBtn) {
    delBtn.onclick = async (ev) => {
      ev.preventDefault();
      if (!confirm(`Delete template "${template.name}"? Campaigns using it will fall back to the default.`)) return;
      try {
        await api(`/api/templates/${template.id}`, { method: 'DELETE' });
        await refreshTemplates();
        await refreshCampaigns();
      } catch (err) {
        body.querySelector('.tpl-status').textContent = `Failed: ${err.message}`;
      }
    };
  }

  refreshSummary();
  renderFollowups();
  return block;
}

el('new-template-btn').addEventListener('click', () => {
  const root = el('templates-list');
  if (root.querySelector('.template-row:not([data-template-id])')) return;
  const block = buildTemplateBlock({
    name: '',
    is_default: false,
    outreach: { subject: '', body: '' },
    followups: [],
  });
  root.prepend(block);
});

el('open-templates-btn').addEventListener('click', () => {
  showView('templates');
});

// --- Guidelines (universal AI prompt) ------------------------------------

async function refreshGuidelines() {
  try {
    const s = await api('/api/settings');
    el('guidelines-text').value = s.guidelines || '';
  } catch (err) {
    el('guidelines-status').textContent = `Failed to load: ${err.message}`;
  }
}

el('open-guidelines-btn').addEventListener('click', async () => {
  showView('guidelines');
  el('guidelines-status').textContent = '';
  await refreshGuidelines();
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
      '<p class="hint">Nothing needs you right now. Replies the AI hands off (or anything on AI-off templates), plus offers awaiting your approval, will appear here.</p>';
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
      <label class="meta" style="display:block; margin-top:12px;">Your reply</label>
      <textarea class="delegate-reply" rows="5" placeholder="Write your reply…  ([text](url) and {{grey}}…{{/grey}} formatting supported)"></textarea>
      <div class="row" style="justify-content: flex-end; align-items: center; margin-top: 8px;">
        <span class="delegate-status hint" style="margin-right: auto;"></span>
        <button class="ghost small delegate-dismiss" type="button">Dismiss</button>
        <button class="small delegate-send" type="button">Send reply</button>
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

// --- Per-campaign template picker ----------------------------------------

function renderCampaignTemplatePicker(campaign) {
  const select = el('campaign-template-select');
  select.innerHTML = '';
  if (!state.templates.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No templates available';
    select.appendChild(opt);
    select.disabled = true;
    el('campaign-template-summary').textContent = 'Create a template first';
    return;
  }
  select.disabled = false;

  const defaultTpl = state.templates.find((t) => t.is_default);
  const defaultLabel = defaultTpl ? `Default (${defaultTpl.name})` : 'Default';
  const noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = `Use default — ${defaultLabel}`;
  select.appendChild(noneOpt);

  for (const t of state.templates) {
    const opt = document.createElement('option');
    opt.value = String(t.id);
    const stepCount = Array.isArray(t.followups) ? t.followups.length : 0;
    opt.textContent = `${t.name} · ${stepCount} follow-up${stepCount === 1 ? '' : 's'}`;
    if (campaign.template_id === t.id) opt.selected = true;
    select.appendChild(opt);
  }

  const refreshSummary = () => {
    const picked = select.value
      ? state.templates.find((t) => t.id === Number(select.value))
      : defaultTpl;
    el('campaign-template-summary').textContent = picked
      ? describeFollowups(picked.followups)
      : '(no follow-ups configured)';
  };
  refreshSummary();

  select.onchange = async () => {
    const value = select.value ? Number(select.value) : null;
    refreshSummary();
    try {
      const updated = await api(`/api/campaigns/${encodeURIComponent(campaign.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ template_id: value }),
      });
      campaign.template_id = updated.template_id;
      await refreshCampaigns();
    } catch (err) {
      el('campaign-template-summary').textContent = `Failed: ${err.message}`;
    }
  };
}

el('campaign-template-open-btn').addEventListener('click', () => {
  showView('templates');
});

(async () => {
  await refreshAuth();
  await refreshTemplates();
  await refreshCampaigns();
})();
