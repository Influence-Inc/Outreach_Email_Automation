const API = '';

const state = {
  campaigns: [],
  selectedCampaignId: null,
  // Which stage stat the creator table is filtered by (null = show all).
  stageFilter: null,
  // Free-text search over the creator rows (name / @handle). Empty = no filter.
  // Reset when switching campaigns so an old query doesn't carry across.
  searchQuery: '',
};

// Whether the admin has dismissed this creator's CURRENT flag from the "needs
// you" list. Computed server-side and returned on each creator row as
// `flag_dismissed` (see routes/creators.js + db/flagFingerprint.js): the
// dismissal is stored against a fingerprint of the flag, so it holds only until
// genuinely new activity that needs a human — a fresh hand-off, a re-priced
// offer, a status move — shifts that fingerprint and the row re-flags on its
// own. Server-side so a dismissal syncs across devices and the sidebar
// pending-dot (campaigns action_count) honors it too.
function isFlagDismissed(r) {
  return !!r.flag_dismissed;
}

// Dismiss the creator's current flag on the server (POST /:id/dismiss-flag).
// Non-destructive — the negotiation state is untouched, nothing closed or sent.
async function dismissFlag(r) {
  await api(`/api/creators/${r.id}/dismiss-flag`, { method: 'POST' });
}

// Predicate for each clickable stat, mirroring the FILTER (...) definitions the
// backend uses to compute the counts in the stats bar (see routes/campaigns.js).
// Keeping these in sync means clicking a stat shows exactly that many rows.
const STAGE_FILTERS = {
  creators: () => true,
  // Awaiting outreach: we haven't reached them on any channel yet, and the
  // row isn't an auto-rejected duplicate / stopped one. "Reached them" covers
  // both email outreach (outreach_sent_at stamped when Instantly confirms) and
  // an Instagram Priority DM (ig_dm_sent_at stamped when the extension confirms).
  // Without the ig_dm_sent_at guard, DM'd creators kept showing up under
  // Pending even though they'd already been contacted.
  pending: (r) =>
    !r.outreach_sent_at &&
    !r.ig_dm_sent_at &&
    r.status !== 'duplicate' &&
    r.status !== 'stopped',
  // Outreach confirmed sent, on any channel — email OR Instagram DM. Keeps the
  // "how many creators have we actually reached out to?" number honest.
  outreach: (r) => r.outreach_sent_at != null || r.ig_dm_sent_at != null,
  replied: (r) => r.status === 'replied',
  // Contract signed or completed (a merely-sent 'pending' contract doesn't count).
  contracted: (r) => r.contract && (r.contract.status === 'signed' || r.contract.status === 'completed'),
  // Removed: outreach explicitly stopped for this creator (removed from campaign).
  removed: (r) => r.status === 'stopped',
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
  closeSidebarOnMobile();
}

// --- Path routing --------------------------------------------------------
// Each view has its own path URL so a refresh (or a shared/bookmarked link)
// lands back on the same campaign instead of the empty picker. Routes:
//   /campaign/<id>            → a campaign's creators
//   /guidelines               → the global Guidelines page
//   /                         → empty picker
// The server serves the app shell for all of these (see the SPA fallback in
// server.js); navigation goes through navigate() and handleRoute() is the
// single place that renders a view, keeping the URL and the UI in sync.
//
// The old `/campaign/<id>/delegate` route is gone — delegations (AI hand-offs,
// offers awaiting approval, accepted deals awaiting the brand's go-ahead) now
// surface at the top of the campaign activity list itself. A bookmarked delegate
// URL falls back to the campaign view below.
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
    // A stale `/delegate` deep link drops the trailing segment and lands on the
    // campaign, where the delegations are now surfaced inline.
    if (parts[2] === 'delegate') {
      history.replaceState({}, '', routePath(['campaign', id]));
    }
    showView('campaign');
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
  // Switching campaigns clears any stage filter / search query carried over
  // from the last one, so the operator lands on a clean unfiltered view.
  state.stageFilter = null;
  state.searchQuery = '';
  const searchInput = el('creator-search');
  if (searchInput) searchInput.value = '';
  const stats = [
    { stage: 'creators', label: 'Creators', value: c.creator_count },
    { stage: 'pending', label: 'Pending', value: c.pending_count },
    { stage: 'outreach', label: 'Outreach', value: c.outreach_sent_count },
    { stage: 'replied', label: 'Replied', value: c.replied_count, accent: true },
    { stage: 'contracted', label: 'Contracted', value: c.contracted_count },
    { stage: 'removed', label: 'Removed', value: c.stopped_count },
  ];
  const statsEl = el('campaign-stats');
  statsEl.hidden = false;
  statsEl.innerHTML = stats
    .map(
      (s) => `<button type="button" class="stat-cell" data-stage="${s.stage}" aria-pressed="false">
        <div class="stat-label">${s.label}</div>
        <div class="stat-value num${s.accent && Number(s.value) > 0 ? ' accent' : ''}">${s.value}</div>
      </button>`,
    )
    .join('');
  statsEl.querySelectorAll('.stat-cell').forEach((cell) => {
    cell.addEventListener('click', () => setStageFilter(cell.dataset.stage));
  });
  el('creator-form').hidden = false;
  el('creator-table-wrap').hidden = false;
  setUsageRightsToggle(c.usage_rights_policy || 'no_rights');
  el('usage-rights-status').textContent = '';
  el('campaign-instantly-id').value = c.instantly_campaign_id || '';
  el('instantly-status').textContent = '';
  syncSendEmailsBtn(c);
  syncIgDmTemplateUI(c);
  syncMessagingBriefUI(c);
  syncStageFilterUI();
  await refreshCreators();
}

function syncSendEmailsBtn(c) {
  const btn = el('send-emails-btn');
  const count = c ? c.email_found_count || 0 : 0;
  btn.textContent = count ? `Send emails (${count})` : 'Send emails';
}

// Render the IG DM template card + Send-IG-DMs button state for a campaign.
// The button hides entirely when the campaign has no template (there is
// nothing to send yet); the card's summary hint also swaps between "not set"
// and "N queued" so the operator sees at a glance whether it's ready.
function syncIgDmTemplateUI(c) {
  const card = el('ig-dm-template-card');
  const text = el('ig-dm-template-text');
  const hint = el('ig-dm-template-hint');
  const btn = el('send-ig-dms-btn');
  card.hidden = false;
  text.value = c.ig_dm_body || '';
  el('ig-dm-template-status').textContent = '';
  const queueCount = c.ig_dm_queue_count || 0;
  const sentCount = c.ig_dm_sent_count || 0;
  if (!c.ig_dm_body) {
    hint.textContent = 'not set';
    // Open the card automatically when the template is empty so the operator
    // sees the empty textarea instead of having to expand it themselves.
    card.open = true;
    btn.hidden = true;
  } else {
    const bits = [];
    if (queueCount) bits.push(`${queueCount} to DM`);
    if (sentCount) bits.push(`${sentCount} sent`);
    hint.textContent = bits.join(' · ') || 'ready';
    card.open = false;
    btn.hidden = queueCount === 0;
    btn.textContent = `Send Instagram DMs (${queueCount})`;
    btn.disabled = false;
  }
}

// Render the WhatsApp/iMessage brief card for a campaign. Unlike the IG DM
// template, an empty brief never disables anything (sendOfferBriefing falls
// back to a generic blurb) — the hint just tells the operator whether a
// custom pitch is set or the generic default is in use.
function syncMessagingBriefUI(c) {
  const card = el('messaging-brief-card');
  const text = el('messaging-brief-text');
  const hint = el('messaging-brief-hint');
  card.hidden = false;
  text.value = c.messaging_brief || '';
  el('messaging-brief-status').textContent = '';
  hint.textContent = c.messaging_brief ? 'custom' : 'using generic fallback';
  card.open = false;
}

// Toggle the creator table's stage filter. Clicking the active stage (or the
// "Creators" total, which represents everything) clears the filter.
function setStageFilter(stage) {
  const next = stage === 'creators' || state.stageFilter === stage ? null : stage;
  state.stageFilter = next;
  syncStageFilterUI();
  refreshCreators();
}

// Reflect the current filter on the stat buttons — the active one is highlighted
// so it's clear which stage the table is scoped to.
function syncStageFilterUI() {
  el('campaign-stats')
    .querySelectorAll('.stat-cell')
    .forEach((cell) => {
      const active = state.stageFilter === cell.dataset.stage;
      cell.classList.toggle('active', active);
      cell.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
}

// --- Creator search filter (name / @handle) ------------------------------
// Case-insensitive substring match over the fields the operator is likely to
// type. Leading '@' is stripped so both `gord` and `@gordonly` behave the same.
// Returns null when the query is empty so refreshCreators can skip the filter
// entirely.
function buildSearchPredicate(rawQuery) {
  const q = (rawQuery || '').trim().replace(/^@+/, '').toLowerCase();
  if (!q) return null;
  return (r) => {
    // Fields worth matching: the @handle Instagram exposes, the operator's
    // display name for the account (first / full), and the profile URL as a
    // fallback for pre-scrape rows that don't yet have a parsed username.
    const haystack = [
      r.instagram_username,
      r.full_name,
      r.first_name,
      r.instagram_url,
    ]
      .filter(Boolean)
      .map((s) => String(s).toLowerCase())
      .join(' ');
    return haystack.includes(q);
  };
}

// Update the "N of M" hint next to the search input so the operator can tell
// at a glance how narrow their query is. Left blank when nothing is filtering
// so the hint doesn't add noise on an empty box.
function syncSearchCount(shown, total) {
  const el2 = el('creator-search-count');
  if (!el2) return;
  const q = (state.searchQuery || '').trim();
  const stage = state.stageFilter;
  if (!q && !stage) {
    el2.textContent = '';
    return;
  }
  if (shown === total) {
    el2.textContent = `${total} creator${total === 1 ? '' : 's'}`;
  } else {
    el2.textContent = `${shown} of ${total}`;
  }
}

// Apply a new search query and re-render. Kept separate from the input's
// change handler so empty-state "Clear search" links can call it too.
function setSearchQuery(next) {
  const value = String(next == null ? '' : next);
  state.searchQuery = value;
  const input = el('creator-search');
  if (input && input.value !== value) input.value = value;
  refreshCreators();
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

// Small "Used / Unused / New" badge shown next to a creator's handle in the
// creators table. The category comes from Creator-DB's categorize endpoint
// (attached server-side by routes/creators.js — see attachCategories):
//   • used   — creator is in Creator-DB with ≥1 contract (worked with before)
//   • unused — in Creator-DB, no contracts (contacted but never signed)
//   • new    — not in Creator-DB (never seen before)
// The badge is skipped when the category isn't known (Creator-DB unconfigured
// or the call failed); the rest of the row still renders normally.
const CATEGORY_LABELS = { used: 'Used', unused: 'Unused', new: 'New' };
function renderCategoryBadge(r) {
  const cat = r && r.category;
  if (!cat || !(cat in CATEGORY_LABELS)) return null;
  const el = document.createElement('span');
  el.className = `creator-badge cat-${cat}`;
  el.textContent = CATEGORY_LABELS[cat];
  if (cat === 'used' && r.creator_db_ref && r.creator_db_ref.contractsCount) {
    el.title = `In Creator-DB · ${r.creator_db_ref.contractsCount} past contract${r.creator_db_ref.contractsCount === 1 ? '' : 's'}`;
  } else if (cat === 'unused') {
    el.title = 'In Creator-DB · contacted before but never signed';
  } else if (cat === 'new') {
    el.title = 'Not in Creator-DB yet — first outreach for this creator';
  }
  return el;
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
  if (r.negotiation_status === 'ACCEPTED') {
    // Accepted but not yet approved by the brand POC: the deal is parked in
    // the Delegate window and no contract has gone out yet.
    if (isContractApprovalPending(r)) return { cls: 'accepted', text: 'awaiting approval' };
    return { cls: 'accepted', text: 'accepted' };
  }
  // IG DM lifecycle. The DM columns are timestamps (creators.ig_dm_sent_at /
  // ig_dm_queued_at), not additions to the `status` enum, so they're checked
  // separately. Placed BEFORE the status→pill fallback so a 'no_email' row
  // that we've since DM'd stops advertising "no email" and shows "IG DM sent"
  // instead. Reuses the outreach_* pill styles — same visual weight, same
  // meaning to the operator (queued → sent).
  if (r.ig_dm_sent_at) return { cls: 'outreach_sent', text: 'IG DM sent' };
  if (r.ig_dm_queued_at) return { cls: 'outreach_queued', text: 'IG DM queued' };
  // Normalize the effective status so a legacy stuck row — one where status
  // is still 'email_found' but the email column has been blanked — reads as
  // 'no_email' here. The schema.sql cleanup rewrites those rows on boot, but
  // this backstop keeps the pill honest until the operator refreshes. The
  // ground-truth signal is r.email, not the status enum.
  let st = r.status || 'pending_extraction';
  if (st === 'email_found' && !r.email) st = 'no_email';
  // 'no_email' isn't a dead end when we have an IG handle — it's just the
  // signal that the next outreach path is a Priority IG DM. Reuse the
  // email_found pill styling so the row still reads as "ready to reach out"
  // rather than muted/failed. The Send IG DM button below carries the actual
  // action; this pill just names the state so it lines up with the button.
  if (st === 'no_email' && (r.instagram_username || r.instagram_url)) {
    return { cls: 'email_found', text: 'IG DM' };
  }
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
  const isVideoBased = data.offerType === 'video_based';
  const n = data.numberOfVideos != null ? Number(data.numberOfVideos) : null;
  const minViews = data.minTotalViews != null ? Number(data.minTotalViews) : null;

  // Videos — hidden for view-based deals (priced by guaranteed views, not by a
  // fixed post count).
  if (!isViewBased && n && Number.isFinite(n)) {
    items.push({ label: 'VIDEOS', value: String(n) });
  }
  // Min views — a view-based term; a flat video-based deal promises no view
  // floor, so never surface it there.
  if (!isVideoBased && minViews && Number.isFinite(minViews) && minViews > 0) {
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

  const bonusAmt = data.bonusAmount != null ? Number(data.bonusAmount) : null;
  const bonusViews = data.bonusThresholdViews != null ? Number(data.bonusThresholdViews) : null;
  if (bonusAmt && bonusViews) {
    items.push({ label: 'BONUS', value: `$${fmtNum(bonusAmt)} if ${fmtViews(bonusViews)}+ views` });
  }

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
// For signed contracts, appends ?force=1 so the server allows the edit
// without re-triggering signing or notifying the creator.
function saveContractField(r, patch) {
  const signed = r.contract && r.contract.status !== 'pending';
  const qs = signed ? '?force=1' : '';
  return api(`/api/creators/${r.id}/contract${qs}`, {
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

// The editable deal terms shown under the rate once a contract exists — the
// admin can correct anything the extraction got wrong straight from the Deals
// column. Works for both pending and signed contracts (signed edits are
// persisted silently without re-triggering signing or notifying the creator).
function renderEditableDeal(cell, r, data) {
  const signed = r.contract && r.contract.status !== 'pending';
  const hint = document.createElement('div');
  hint.className = 'deal-edit-hint';
  hint.textContent = signed ? 'Signed · click to edit' : 'Deal terms · click to edit';
  cell.appendChild(hint);

  const isViewBased = data.offerType === 'view_based';
  // Offer-type toggle: flips View-based ↔ Video-based when the extraction
  // shaped the wrong kind of deal. Also rewrites the deliverables text, the
  // label chip, and the video count in a single PATCH — the paired fields
  // stay consistent so the contract page and the Deals column re-render as
  // one shape.
  const typeLine = document.createElement('div');
  typeLine.className = 'deal-line';
  const typeTag = document.createElement('span');
  typeTag.className = 'deal-tag';
  typeTag.textContent = 'TYPE';
  const typeVal = document.createElement('span');
  typeVal.className = 'deal-val deal-toggle';
  typeVal.textContent = isViewBased ? 'View-based' : 'Video-based';
  typeVal.classList.toggle('on', !isViewBased);
  typeVal.title = 'Click to switch the deal shape (view-based ↔ video-based)';
  typeVal.onclick = async () => {
    try {
      await saveContractField(r, { offerType: isViewBased ? 'video_based' : 'view_based' });
    } catch (err) {
      alert(err.message);
    }
    await refreshCreators();
    await refreshCampaigns();
  };
  typeLine.appendChild(typeTag);
  typeLine.appendChild(typeVal);
  cell.appendChild(typeLine);

  if (!isViewBased) {
    appendEditableDealLine(cell, r, {
      label: 'VIDEOS',
      value: data.numberOfVideos != null ? Number(data.numberOfVideos) : '',
      placeholder: '# videos',
      onSave: (v) => saveContractField(r, { numberOfVideos: v === '' ? null : Number(v) }),
    });
  }
  // Min views is a view-based term — a flat video-based deal promises no view
  // floor, so the field is only editable on a view-based deal. Flipping the
  // TYPE toggle to video-based clears any leftover number server-side.
  if (isViewBased) {
    appendEditableDealLine(cell, r, {
      label: 'MIN VIEWS',
      value: data.minTotalViews > 0 ? fmtViews(data.minTotalViews) : '',
      placeholder: 'e.g. 100k',
      onSave: (v) => saveContractField(r, { minTotalViews: parseViewsInput(v) }),
    });
  }
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

  const bonusAmt = data.bonusAmount != null ? Number(data.bonusAmount) : null;
  const bonusViews = data.bonusThresholdViews != null ? Number(data.bonusThresholdViews) : null;
  if (bonusAmt && bonusViews) {
    const bonusLine = document.createElement('div');
    bonusLine.className = 'deal-line';
    const bonusTag = document.createElement('span');
    bonusTag.className = 'deal-tag';
    bonusTag.textContent = 'BONUS';
    const bonusVal = document.createElement('span');
    bonusVal.className = 'deal-val';
    bonusVal.textContent = `$${fmtNum(bonusAmt)} if ${fmtViews(bonusViews)}+ views`;
    bonusLine.appendChild(bonusTag);
    bonusLine.appendChild(bonusVal);
    cell.appendChild(bonusLine);
  }

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
    // Deal terms are always editable — including signed/completed contracts
    // (the server accepts ?force=1 so edits go through without re-triggering
    // signing or notifying the creator).
    renderEditableDeal(cell, r, data);
    return;
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

// "Reply hand-off" / "Approve deal" / "Configure here": open the intervention
// pop-up right here on the campaign page — the creator's parked message + reply
// box (hand-off), the approve-&-send-contract action (accepted deal), or the
// offer configurator (offer awaiting approval), rendered in a modal like the
// "view full email" one. Replaces the old separate Delegate window.
//   plain — render as a neutral ghost button rather than the accented one, used
//   for the "Configure here" fallback that sits beside the primary "Decide
//   offer" launcher.
function makeInterveneButton(r, { label = 'Reply hand-off', plain = false } = {}) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = plain ? 'ghost small cr-decide-btn' : 'ghost small cr-intervene-btn';
  btn.textContent = `${label} ▸`;
  btn.title = plain
    ? 'Configure and send this offer from the dashboard (fallback for the extension)'
    : 'Handle this hand-off without leaving the campaign';
  btn.onclick = () => openInterventionModal(r);
  return btn;
}

// Is this creator a candidate for a per-row "Send IG DM" button? Mirrors the
// backend's IG_DM_ELIGIBLE_STATUSES + prerequisite checks (no email, not
// already DM'd, has an IG handle we can resolve). The campaign's own template
// still has to exist for the button to fire — that's enforced on the server
// and surfaced as a tooltip below rather than hiding the button, so operators
// discover the "set a DM template first" requirement in situ.
//
// Legacy-row defensiveness: rows that landed in `status='email_found'` with
// no actual email (rejected addresses cleared on the dashboard before the
// PATCH handler learned to roll status back) are also eligible — the
// authoritative signal is r.email being empty. The schema.sql cleanup
// rewrites those rows on boot, but this covers them until the next server
// restart and any row we miss.
function isIgDmEligible(r) {
  if (!r) return false;
  if (r.email) return false;
  if (r.ig_dm_sent_at) return false;
  if (!r.instagram_username && !r.instagram_url) return false;
  const st = r.status || 'pending_extraction';
  return (
    st === 'no_email' ||
    st === 'pending_extraction' ||
    st === 'invalid_email' ||
    st === 'email_found' // stale-status backstop; !r.email above already guarded
  );
}

// Per-creator "Send IG DM" button. POSTs to the same /:id/queue-ig-dm endpoint
// the bulk sender uses; on success it hands the returned single-job array to
// the extension via the shared OEA_RUN_IG_DM_QUEUE bridge so the send drives
// through the exact same Instagram flow as the bulk button.
function makeSendIgDmButton(r) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ghost small cr-send-btn';
  btn.textContent = 'Send IG DM';
  // Cache the current campaign's template state so the button self-explains
  // when it can't send — no template = disabled with a clear tooltip that
  // points at the template card above.
  const campaign = state.campaigns.find((c) => c.id === state.selectedCampaignId);
  const hasTemplate = !!(campaign && campaign.ig_dm_body && String(campaign.ig_dm_body).trim());
  if (!hasTemplate) {
    btn.disabled = true;
    btn.title = 'Set an Instagram DM template for this campaign first (card above).';
  } else {
    btn.title = 'Send this creator the campaign\'s IG DM as a Priority Message Request.';
  }
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      const result = await api(`/api/creators/${r.id}/queue-ig-dm`, { method: 'POST' });
      if (!result || !result.job) {
        alert('Server returned no job payload — nothing to send.');
        return;
      }
      // Refresh eagerly so the row already reflects "IG DM queued" while the
      // extension starts driving Instagram in the background.
      await refreshCreators();
      await refreshCampaigns();
      startExtensionIgDmSend([result.job]);
    } catch (err) {
      alert(err.message);
      btn.disabled = false;
    }
  };
  return btn;
}

// "Dismiss" — snooze THIS flag from the "needs you" list without opening its
// pop-up/configurator. Works for any flagged row (offer awaiting approval,
// accepted deal awaiting contract approval, or an AI hand-off). Records the
// current flag on the server (see dismissFlag) so the creator drops out of the
// banner, the top-of-table sort, the row highlight and the inline launchers —
// but nothing about the underlying state changes: the offer stays open, the
// deal stays unapproved, the hand-off message stays parked. The dismissal is
// stored server-side: it syncs across devices, is reflected in the sidebar
// pending-dot, and stays put until there's genuinely new activity that needs a
// human — a fresh hand-off, a re-priced offer, or a status move — at which
// point the flag re-surfaces on its own.
function makeDismissFlagButton(r) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ghost small cr-dismiss-btn';
  btn.textContent = 'Dismiss';
  btn.title = 'Hide this from your flagged list for now — it re-surfaces on any new activity';
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      await dismissFlag(r);
      await refreshCreators();
      await refreshCampaigns();
    } catch (err) {
      alert(err.message);
      btn.disabled = false;
    }
  };
  return btn;
}

// Status column: pill + delete + (send-outreach when pending) + timeline.
// Offer-portal status pill (old creators): reflects the current offer's state
// across the portal + messaging channels.
function portalPillFor(p) {
  if (p.status === 'accepted') return { cls: 'accepted', text: 'offer accepted' };
  if (p.status === 'declined') return { cls: 'declined', text: 'offer declined' };
  const kind = p.isCounter ? 'counter' : 'offer';
  if (p.viewed) return { cls: 'viewed', text: kind + ' viewed' };
  return { cls: 'sent', text: kind + ' sent' };
}

// The Offer-portal block shown in the Status column for old creators: a portal
// status pill + rate + copy-link, and a row of per-channel chips (Email /
// WhatsApp / iMessage sent+replied, plus whether the offer page was viewed).
function renderPortalOfferBlock(r) {
  const p = r.portal_offer;
  const box = document.createElement('div');
  box.className = 'portal-offer';

  const head = document.createElement('div');
  head.className = 'po-head';
  const pill = portalPillFor(p);
  const pillEl = document.createElement('span');
  pillEl.className = 'po-pill ' + pill.cls;
  pillEl.textContent = pill.text;
  head.appendChild(pillEl);

  if (p.rateFormatted) {
    const rate = document.createElement('span');
    rate.className = 'po-rate num';
    rate.textContent = p.rateFormatted;
    head.appendChild(rate);
  }

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'ghost small po-copy';
  copy.textContent = 'Copy link';
  copy.title = p.url;
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(p.url);
      const prev = copy.textContent;
      copy.textContent = 'Copied ✓';
      setTimeout(() => { copy.textContent = prev; }, 1400);
    } catch (e) {
      window.prompt('Offer link', p.url);
    }
  };
  head.appendChild(copy);
  box.appendChild(head);

  const chips = document.createElement('div');
  chips.className = 'po-chips';
  const chan = p.channels || {};
  const addChip = (label, sent, replied, delivery) => {
    const c = document.createElement('span');
    const failed = delivery === 'failed';
    c.className =
      'po-chip' + (sent ? ' on' : ' off') + (replied ? ' replied' : '') + (failed ? ' failed' : '');
    let mark = ' —';
    if (sent) {
      if (replied) mark = ' ↩';
      else if (failed) mark = ' ⚠';
      else if (delivery === 'read' || delivery === 'delivered') mark = ' ✓✓';
      else mark = ' ✓';
    }
    c.textContent = label + mark;
    if (!sent) c.title = label + ' — not sent';
    else if (replied) c.title = label + ' — sent · creator replied';
    else if (delivery) c.title = label + ' — ' + delivery; // sent / delivered / read / failed
    else c.title = label + ' — sent';
    chips.appendChild(c);
  };
  if (chan.email) addChip('Email', chan.email.sent, false);
  if (chan.whatsapp) addChip('WhatsApp', chan.whatsapp.sent, chan.whatsapp.replied, chan.whatsapp.delivery);
  if (chan.imessage) addChip('iMessage', chan.imessage.sent, chan.imessage.replied, chan.imessage.delivery);
  const viewed = document.createElement('span');
  viewed.className = 'po-chip' + (p.viewed ? ' on' : ' off');
  viewed.textContent = 'Portal' + (p.viewed ? ' viewed' : ' —');
  viewed.title = p.viewed ? 'Creator opened the offer page' : 'Offer page not opened yet';
  chips.appendChild(viewed);
  box.appendChild(chips);

  if (p.needsReview) {
    const nr = document.createElement('div');
    nr.className = 'po-review';
    nr.textContent = '⚠ Reply needs review';
    box.appendChild(nr);
  }
  return box;
}

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

  // Dismiss sits beside delete (rather than down with the type-specific
  // launcher) so the two dismissive actions on a flagged row — snooze the flag
  // vs. remove the creator outright — read as a pair. Shown for every flagged
  // row (offer to decide, deal to approve, or hand-off), matching the same
  // isDelegateActionable check that puts the row in the "needs you" set in the
  // first place (it already excludes an already-dismissed flag).
  if (isDelegateActionable(r)) {
    top.appendChild(makeDismissFlagButton(r));
  }

  cell.appendChild(top);

  // Offer-portal negotiation status (old creators) — portal + WhatsApp/iMessage
  // updates, shown right under the main status pill.
  if (r.portal_offer) cell.appendChild(renderPortalOfferBlock(r));

  // Guard on r.email as well as the status. If a stale row is still tagged
  // 'email_found' but its address has since been cleared (e.g. the operator
  // rejected an incorrect email but the row hasn't reloaded yet), showing
  // Send outreach anyway would 400 the moment it's clicked. The row instead
  // falls through to the IG DM affordance, which is the right path when
  // there's no address to email.
  if (r.status === 'email_found' && r.email) {
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
  } else if (isIgDmEligible(r)) {
    // Per-row fallback for the bulk "Send Instagram DMs" button: any single
    // creator whose email we couldn't find can be DM'd on the spot without
    // sweeping the whole campaign. Same code path — queue-ig-dm renders the
    // template and hands the job to the extension for a Priority send.
    cell.appendChild(makeSendIgDmButton(r));
  }

  // Each delegation type gets an inline launcher, right by the timeline — no
  // separate Delegate view. "Dismiss" (up by delete) snoozes any of the three.
  //   • offer awaiting approval → "Decide offer" (IG + Chrome-extension panel)
  //     plus "Configure here", the in-dashboard fallback pop-up for when the
  //     extension isn't loaded
  //   • accepted deal           → "Approve deal" pop-up
  //   • AI hand-off             → "Reply hand-off" pop-up
  // The pop-up (openInterventionModal) also folds in the reply box whenever the
  // same creator has a parked message, so at most one intervene button is shown.
  // A dismissed flag hides the launcher too — the row reads as normal until the
  // flag re-surfaces.
  if (isFlagDismissed(r)) {
    // no launcher while snoozed
  } else if (isOfferActionable(r)) {
    const offerActions = document.createElement('div');
    offerActions.className = 'cr-offer-actions';
    offerActions.appendChild(makeDecideOfferButton(r));
    offerActions.appendChild(makeInterveneButton(r, { label: 'Configure here', plain: true }));
    cell.appendChild(offerActions);
  } else if (isContractApprovalPending(r)) {
    cell.appendChild(makeInterveneButton(r, { label: 'Approve deal' }));
  } else if (r.needs_human) {
    cell.appendChild(makeInterveneButton(r, { label: 'Reply hand-off' }));
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

// ── "View full email" affordance ──────────────────────────────────────────
// Every timeline row that summarizes (or quotes a rate from) a real email
// carries the full message on `entry.email` — see attachRateLog in the backend.
// A small envelope button next to the summary opens that message verbatim in a
// modal, so the one-line gist on the timeline can always be checked against the
// actual email the creator sent (or the reply we sent).
const EMAIL_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="m3 7 9 6 9-6"></path></svg>';

// Lazily-built singleton modal, reused for every email so the DOM carries one
// overlay rather than one per timeline row.
let _emailModal = null;
function ensureEmailModal() {
  if (_emailModal) return _emailModal;
  const backdrop = document.createElement('div');
  backdrop.className = 'email-modal-backdrop';
  backdrop.hidden = true;

  const dialog = document.createElement('div');
  dialog.className = 'email-modal';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');

  const head = document.createElement('div');
  head.className = 'email-modal-head';
  const titles = document.createElement('div');
  titles.className = 'email-modal-titles';
  const kicker = document.createElement('div');
  kicker.className = 'email-modal-kicker';
  const subject = document.createElement('div');
  subject.className = 'email-modal-subject';
  const meta = document.createElement('div');
  meta.className = 'email-modal-meta';
  titles.append(kicker, subject, meta);
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'email-modal-close';
  close.innerHTML = '✕';
  close.title = 'Close';
  close.setAttribute('aria-label', 'Close');
  head.append(titles, close);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'email-modal-body';

  dialog.append(head, bodyEl);
  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);

  const hide = () => {
    backdrop.hidden = true;
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (ev) => { if (ev.key === 'Escape') hide(); };
  close.addEventListener('click', hide);
  backdrop.addEventListener('click', (ev) => { if (ev.target === backdrop) hide(); });

  _emailModal = {
    kicker, subject, meta, bodyEl,
    show() { backdrop.hidden = false; document.addEventListener('keydown', onKey); },
  };
  return _emailModal;
}

function openEmailModal(email) {
  if (!email) return;
  const m = ensureEmailModal();
  const inbound = email.direction === 'inbound';
  m.kicker.textContent = inbound ? 'Email from creator' : 'Reply we sent';
  const subj = (email.subject || '').trim();
  m.subject.textContent = subj;
  m.subject.hidden = !subj;
  m.meta.textContent = email.at ? fmtDate(email.at) : '';
  m.meta.hidden = !email.at;
  m.bodyEl.textContent = String(email.body || '').trim() || '(This email has no text body.)';
  m.bodyEl.scrollTop = 0;
  m.show();
}

// Small envelope button that opens the full email. stopPropagation keeps a click
// from also toggling an enclosing expandable group (rate options / repeat runs).
function makeEmailExpandBtn(email) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'timeline-email-btn';
  btn.title = 'View the full email';
  btn.setAttribute('aria-label', 'View the full email');
  btn.innerHTML = EMAIL_ICON_SVG;
  btn.addEventListener('click', (ev) => { ev.stopPropagation(); openEmailModal(email); });
  return btn;
}

// ── Intervention pop-up ────────────────────────────────────────────────────
// A modal — built and styled like the "view full email" one — that lets a
// hand-off be actioned right on the campaign page. Two shapes:
//   • AI hand-off        → the creator's parked message + a reply box
//   • accepted deal      → the "Approve & send contract" action (with the reply
//                          box appended when the creator also has a parked message)
// Replaces the standalone Delegate window; the offer-approval flow keeps using
// the Chrome extension via the "Decide offer" launcher.
let _interveneModal = null;
function ensureInterventionModal() {
  if (_interveneModal) return _interveneModal;
  const backdrop = document.createElement('div');
  backdrop.className = 'email-modal-backdrop intervene-modal-backdrop';
  backdrop.hidden = true;

  const dialog = document.createElement('div');
  dialog.className = 'email-modal intervene-modal';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');

  const head = document.createElement('div');
  head.className = 'email-modal-head';
  const titles = document.createElement('div');
  titles.className = 'email-modal-titles';
  const kicker = document.createElement('div');
  kicker.className = 'email-modal-kicker';
  const subject = document.createElement('div');
  subject.className = 'email-modal-subject';
  const meta = document.createElement('div');
  meta.className = 'email-modal-meta';
  titles.append(kicker, subject, meta);
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'email-modal-close';
  close.innerHTML = '✕';
  close.title = 'Close';
  close.setAttribute('aria-label', 'Close');
  head.append(titles, close);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'intervene-modal-body io-scroll';

  dialog.append(head, bodyEl);
  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);

  const hide = () => {
    backdrop.hidden = true;
    bodyEl.innerHTML = ''; // drop the per-creator blocks so nothing lingers
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (ev) => { if (ev.key === 'Escape') hide(); };
  close.addEventListener('click', hide);
  backdrop.addEventListener('click', (ev) => { if (ev.target === backdrop) hide(); });

  _interveneModal = {
    dialog, kicker, subject, meta, bodyEl,
    show() { backdrop.hidden = false; document.addEventListener('keydown', onKey); },
    hide,
  };
  return _interveneModal;
}

function closeInterventionModal() {
  if (_interveneModal) _interveneModal.hide();
}

function openInterventionModal(r) {
  const m = ensureInterventionModal();
  m.bodyEl.innerHTML = '';
  const handle = r.instagram_username ? `@${r.instagram_username}` : r.full_name || 'Creator';
  const offer = isOfferActionable(r);
  const contract = isContractApprovalPending(r);
  m.kicker.textContent = offer ? 'Configure offer' : contract ? 'Approve deal' : 'Reply hand-off';
  m.subject.textContent = r.first_name ? `${handle} · ${r.first_name}` : handle;
  m.subject.hidden = false;
  m.meta.textContent = r.email || 'no email';
  m.meta.hidden = false;
  // The offer configurator is a wide three-card layout — give it room.
  m.dialog.classList.toggle('wide', offer);

  if (offer) {
    // Dashboard fallback for the extension: the full offer configurator, sending
    // through the exact same approve→send path.
    m.bodyEl.appendChild(buildOfferConfigurator(r, refreshAfterIntervention));
    // If the creator also has a parked reply, surface it beneath the offer.
    if (r.needs_human) {
      const msg = buildHandoffMessage(r);
      if (msg) m.bodyEl.appendChild(msg);
      m.bodyEl.appendChild(buildReplyBlock(r));
    }
  } else if (contract) {
    m.bodyEl.appendChild(buildContractApprovalBlock(r));
    // An accepted deal can also carry a parked reply — surface it beneath the
    // approval so it isn't missed.
    if (r.needs_human) {
      const msg = buildHandoffMessage(r);
      if (msg) m.bodyEl.appendChild(msg);
      m.bodyEl.appendChild(buildReplyBlock(r));
    }
  } else {
    const msg = buildHandoffMessage(r);
    if (msg) m.bodyEl.appendChild(msg);
    m.bodyEl.appendChild(buildReplyBlock(r));
  }
  m.bodyEl.scrollTop = 0;
  m.show();
}

// After a delegate action (reply sent, contract approved, dismissed) the pop-up
// closes and the campaign table + sidebar counts refresh, so the handled row
// leaves the "needs you" group at the top.
async function refreshAfterIntervention() {
  closeInterventionModal();
  await refreshCreators();
  await refreshCampaigns();
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
      // A "Creator quoted rates" run is one reply backing several rate options,
      // so a single expand button on the head opens that email. (Repeated-run
      // groups instead put a button on each occurrence's substep, below, since
      // each occurrence is a distinct email.)
      if (rateOptions && newest.email) head.appendChild(makeEmailExpandBtn(newest.email));

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
        // Repeated identical-text events: show each occurrence's timestamp,
        // each with its own "view email" button (every occurrence is a separate
        // message).
        g.entries.forEach((e) => {
          const li = document.createElement('div');
          li.className = 'timeline-substep timeline-substep-msg num';
          const when = document.createElement('span');
          when.textContent = fmtDate(e.at);
          li.appendChild(when);
          if (e.email) li.appendChild(makeEmailExpandBtn(e.email));
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
      // Expand button, inline with the summary/quoted-rate label, to read the
      // actual email this line is summarizing.
      if (newest.email) label.appendChild(makeEmailExpandBtn(newest.email));
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
//
// Primary offer flow is the Chrome extension (opened via "Decide offer"); this
// is the in-dashboard fallback, rendered inside the intervention pop-up via the
// "Configure here" button so an offer can still be sent when the extension
// isn't loaded.

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
        <button class="oc-ai-toggle ghost small" type="button">✎ Draft with AI</button>
        <button class="oc-dismiss ghost small" type="button">Dismiss</button>
        <button class="oc-approve btn-primary" type="button">${approveLabel} →</button>
      </div>
    </div>

    <div class="oc-ai" hidden>
      <div class="oc-ai-title">Draft with AI</div>
      <div class="oc-ai-desc">Add your own thoughts in a sentence or two — AI writes the full email around the selected offer above. You review and edit it before anything sends. The offer numbers stay exactly as you set them.</div>
      <textarea class="oc-ai-note" rows="3" placeholder="e.g. Push back gently on the per-view bonus, lean into the long-term retainer potential, and mention we can't do usage rights on this one."></textarea>
      <div class="oc-ai-bar">
        <button class="oc-ai-draft btn-primary" type="button">Draft email with AI →</button>
        <span class="oc-ai-status hint"></span>
      </div>
      <div class="oc-ai-preview" hidden>
        <div class="oc-ai-label">Review &amp; edit — this exact text is emailed to the creator</div>
        <textarea class="oc-ai-body" rows="14"></textarea>
        <div class="oc-ai-bar">
          <button class="oc-ai-send btn-primary" type="button">Send to creator →</button>
          <button class="oc-ai-redraft ghost small" type="button">Re-draft</button>
        </div>
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
          `Accept ${who}'s rate of ${rateStr}? We'll agree to their number — the contract goes out once the accepted deal is approved (brand POC go-ahead), flagged at the top of the campaign.`,
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
        statusEl.textContent = `✓ Accepted ${rateStr} — awaiting brand approval, flagged at the top of the campaign.`;
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
    if (!confirm('Dismiss this offer without sending? The creator will no longer be flagged for you.')) return;
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

  // ── "Draft with AI" — describe the message in a line or two, AI writes the
  //    full offer email around the selected offer, review/edit, then send. The
  //    send reuses the exact approve→send path (PATCH /offer with the reviewed
  //    body), so every send guarantee — atomic claim, timeline logging, stage
  //    transition — is identical to Approve & send.
  const aiPanel = root.querySelector('.oc-ai');
  const aiToggle = root.querySelector('.oc-ai-toggle');
  const aiNote = root.querySelector('.oc-ai-note');
  const aiDraftBtn = root.querySelector('.oc-ai-draft');
  const aiStatus = root.querySelector('.oc-ai-status');
  const aiPreview = root.querySelector('.oc-ai-preview');
  const aiBody = root.querySelector('.oc-ai-body');
  const aiSendBtn = root.querySelector('.oc-ai-send');
  const aiRedraftBtn = root.querySelector('.oc-ai-redraft');
  // The offer snapshot the current preview was drafted for. Sending uses THIS
  // (not the live sliders) so the logged fee always matches the body on screen;
  // editing the sliders after a draft clears the preview to keep them in sync.
  let draftedOffer = null;
  let draftedSubject = null;

  const resetAiPreview = () => {
    aiPreview.hidden = true;
    aiBody.value = '';
    draftedOffer = null;
    draftedSubject = null;
  };

  aiToggle.onclick = () => {
    aiPanel.hidden = !aiPanel.hidden;
    aiToggle.classList.toggle('is-open', !aiPanel.hidden);
    if (!aiPanel.hidden) aiNote.focus();
  };

  aiDraftBtn.onclick = async () => {
    if (aiDraftBtn.dataset.busy === '1') return;
    aiDraftBtn.dataset.busy = '1';
    aiDraftBtn.disabled = true;
    aiStatus.textContent = 'Drafting…';
    const offer = buildCustomOffer();
    try {
      const draft = await api(`/api/creators/${r.id}/draft-offer`, {
        method: 'POST',
        body: JSON.stringify({ custom_offer: offer, instructions: aiNote.value.trim() }),
      });
      draftedOffer = offer;
      draftedSubject = draft.subject || null;
      aiBody.value = draft.body || '';
      aiPreview.hidden = false;
      aiStatus.textContent = 'Draft ready — review and edit below, then send.';
      aiBody.focus();
    } catch (err) {
      aiStatus.textContent = `Couldn't draft: ${err.message}`;
    } finally {
      aiDraftBtn.disabled = false;
      aiDraftBtn.dataset.busy = '';
    }
  };

  aiRedraftBtn.onclick = () => {
    aiPreview.hidden = true;
    aiStatus.textContent = '';
    aiNote.focus();
  };

  aiSendBtn.onclick = async () => {
    if (aiSendBtn.dataset.busy === '1') return;
    const body = aiBody.value.trim();
    if (!body) {
      aiStatus.textContent = 'The email is empty — draft or write something first.';
      return;
    }
    const offer = draftedOffer || buildCustomOffer();
    aiSendBtn.dataset.busy = '1';
    aiSendBtn.disabled = true;
    aiRedraftBtn.disabled = true;
    aiStatus.textContent = 'Sending…';
    try {
      const resp = await api(`/api/creators/${r.id}/offer`, {
        method: 'PATCH',
        body: JSON.stringify({
          selected_offer_id: offer.offer_id,
          custom_offer: offer,
          offer_approved: true,
          email: { subject: draftedSubject, body },
        }),
      });
      const sr = resp && resp.send_result;
      let hold = 1400;
      if (sr && sr.sent) {
        aiStatus.textContent = '✓ Your email was sent.';
      } else if (sr && sr.error) {
        aiStatus.textContent = `Send failed: ${sr.error}. Check the creator's inbox before re-sending to avoid a duplicate.`;
        hold = 6000;
      } else if (sr && sr.skipped) {
        aiStatus.textContent = `Not sent — ${sr.skipped}.`;
        hold = 4500;
      } else {
        aiStatus.textContent = '✓ Saved.';
      }
      setTimeout(onRefresh, hold);
    } catch (err) {
      aiStatus.textContent = err.message;
      aiSendBtn.disabled = false;
      aiRedraftBtn.disabled = false;
      aiSendBtn.dataset.busy = '';
    }
  };

  // Editing the offer after drafting would desync the preview from the numbers,
  // so drop the stale draft and prompt a re-draft. (These listeners are additive
  // to the recompute() ones already wired above.)
  const markStaleOnEdit = () => {
    if (!aiPreview.hidden) {
      resetAiPreview();
      aiStatus.textContent = 'Offer changed — draft again to match the new numbers.';
    }
  };
  root.querySelectorAll('input[data-k]').forEach((input) => {
    input.addEventListener('input', markStaleOnEdit);
  });
  root.querySelectorAll('.oc-choose').forEach((btn) => {
    btn.addEventListener('click', markStaleOnEdit);
  });

  // Let the admin jump to the creator's Instagram profile with this same offer
  // panel latched to the side, straight from the offer pop-up.
  const sendbarActions = root.querySelector('.oc-sendbar-actions');
  if (sendbarActions && r.instagram_username) {
    sendbarActions.insertBefore(makeDecideOfferButton(r, { label: 'Open on IG' }), sendbarActions.firstChild);
  }

  recompute();
  return root;
}

async function refreshCreators() {
  if (!state.selectedCampaignId) return;
  const allRows = await api(`/api/creators?campaign_id=${encodeURIComponent(state.selectedCampaignId)}`);
  const container = el('creator-rows');
  container.innerHTML = '';
  // Campaign-wide count of creators needing a human right now, surfaced in the
  // banner above the table (replaces the old Delegate button's badge).
  updateAttentionBanner(allRows.filter(isDelegateActionable).length);
  if (!allRows.length) {
    syncSearchCount(0, 0);
    container.innerHTML =
      '<div class="hint" style="padding:26px 6px;">No creators yet. Paste Instagram links above to add some.</div>';
    return;
  }
  const stagePredicate = (state.stageFilter && STAGE_FILTERS[state.stageFilter]) || null;
  const searchPredicate = buildSearchPredicate(state.searchQuery);
  const filtered = allRows.filter((r) => {
    if (stagePredicate && !stagePredicate(r)) return false;
    if (searchPredicate && !searchPredicate(r)) return false;
    return true;
  });
  // Live match count next to the search input — always reflects the number of
  // rows currently rendered under the query, whether or not a stage is active.
  syncSearchCount(filtered.length, allRows.length);
  if (!filtered.length) {
    // Empty-state copy tells the operator what kind of nothing they're looking
    // at: a search miss, a stage miss, or both. Each nothing links straight to
    // the corresponding reset action.
    const hasSearch = !!searchPredicate;
    const hasStage = !!stagePredicate;
    let msg;
    if (hasSearch && hasStage) {
      msg = `No matches for "<b>${escapeHtml(state.searchQuery)}</b>" among ${
        state.stageFilter
      } creators. <a href="#" class="creator-search-clear">Clear search</a> · <a href="#" class="stage-filter-clear">Clear stage</a>`;
    } else if (hasSearch) {
      msg = `No creators match "<b>${escapeHtml(state.searchQuery)}</b>". <a href="#" class="creator-search-clear">Clear search</a>`;
    } else {
      const label = {
        pending: 'pending',
        outreach: 'in outreach',
        replied: 'replied',
        contracted: 'contracted',
        removed: 'removed',
      }[state.stageFilter];
      msg = `No ${label} creators. <a href="#" class="stage-filter-clear">Show all</a>`;
    }
    container.innerHTML = `<div class="hint" style="padding:26px 6px;">${msg}</div>`;
    const clearStage = container.querySelector('.stage-filter-clear');
    if (clearStage) clearStage.addEventListener('click', (e) => {
      e.preventDefault();
      setStageFilter(null);
    });
    const clearSearch = container.querySelector('.creator-search-clear');
    if (clearSearch) clearSearch.addEventListener('click', (e) => {
      e.preventDefault();
      setSearchQuery('');
    });
    return;
  }
  // Stable partition — creators that need a human (AI hand-offs, offers awaiting
  // approval, accepted deals awaiting the brand's go-ahead) float to the top so
  // an intervention is the first thing seen, while recency order is preserved
  // within each group.
  const rows = [
    ...filtered.filter(isDelegateActionable),
    ...filtered.filter((r) => !isDelegateActionable(r)),
  ];
  rows.forEach((r, idx) => {
    const row = document.createElement('div');
    row.className = 'creator-row';
    if (isDelegateActionable(r)) row.classList.add('needs-attention');
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
    // Used / Unused / New badge — comes from Creator-DB's categorize call
    // (see routes/creators.js attachCategories). Rendered inline with the
    // handle so the row's provenance reads at a glance. Replaces the older
    // 2-way Returning/New chip so the roster reads with the finer distinction
    // the operator team asked for. (The backend `creator_segment` remains
    // untouched and continues to drive the offer-portal routing decision in
    // negotiation.js — that's a display-independent concern.)
    const badge = renderCategoryBadge(r);
    if (badge) handle.appendChild(badge);
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

    // --- Email (editable) + its source ---
    const emailCell = document.createElement('div');
    emailCell.className = 'cr-email';
    const emailValue = document.createElement('div');
    emailValue.className = 'cr-email-value';
    if (r.email) emailValue.textContent = r.email;
    else emailValue.innerHTML = '<span class="empty">—</span>';
    makeEditable(emailValue, {
      value: r.email || '',
      placeholder: 'creator@email.com',
      allowEmpty: true, // blanking the cell clears the email
      onSave: (v) =>
        api(`/api/creators/${r.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ email: v || null }),
        }),
    });
    emailCell.appendChild(emailValue);
    const emailSrcEl = renderEmailSourceEl(r);
    if (emailSrcEl) emailCell.appendChild(emailSrcEl);

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

// ── "Add creators" panel: switch between DB search and paste-URLs ────────────
// The two flows share the same card. Clicking a tab shows one panel and hides
// the other; the panels stay separate so the search input's Enter key never
// accidentally submits the paste-URLs form.
(function initAddPanelTabs() {
  const tabSearch = el('add-tab-search');
  const tabNew = el('add-tab-new');
  const panelSearch = el('add-panel-search');
  const panelNew = el('add-panel-new');
  function show(which) {
    const showSearch = which === 'search';
    panelSearch.hidden = !showSearch;
    panelNew.hidden = showSearch;
    tabSearch.classList.toggle('active', showSearch);
    tabNew.classList.toggle('active', !showSearch);
    tabSearch.setAttribute('aria-selected', String(showSearch));
    tabNew.setAttribute('aria-selected', String(!showSearch));
  }
  tabSearch.addEventListener('click', () => show('search'));
  tabNew.addEventListener('click', () => show('new'));
  show('new');
})();

// ── Creator-DB search-and-add ────────────────────────────────────────────────
// Debounced free-text search against Creator-DB via /api/creator-db/search;
// each match renders as a row with an "Add to campaign" button that POSTs to
// /api/creator-db/import. Category filter (any/used/unused) is passed through
// so an admin can restrict to only past-worked creators.
(function initDbSearch() {
  const input = el('db-search-input');
  const status = el('db-search-status');
  const results = el('db-search-results');
  const filter = el('db-search-filter');
  const state2 = { category: 'any', lastQuery: '', timer: null, reqId: 0 };

  filter.querySelectorAll('.segmented-opt').forEach((btn) => {
    btn.addEventListener('click', () => {
      filter.querySelectorAll('.segmented-opt').forEach((b) => b.classList.toggle('active', b === btn));
      state2.category = btn.dataset.value;
      runSearch(input.value);
    });
  });

  input.addEventListener('input', () => {
    clearTimeout(state2.timer);
    state2.timer = setTimeout(() => runSearch(input.value), 250);
  });
  // A form containing a single text input submits on Enter; the search input
  // must NOT accidentally trigger the paste-URLs submit handler.
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); runSearch(input.value); }
  });

  async function runSearch(q) {
    const query = String(q || '').trim();
    state2.lastQuery = query;
    if (!query && state2.category === 'any') {
      results.hidden = true;
      results.innerHTML = '';
      status.textContent = 'Type to search creators the team has worked with or contacted before.';
      return;
    }
    status.textContent = 'Searching…';
    const myReq = ++state2.reqId;
    try {
      const params = new URLSearchParams();
      if (query) params.set('q', query);
      if (state2.category !== 'any') params.set('category', state2.category);
      const out = await api(`/api/creator-db/search?${params.toString()}`);
      if (myReq !== state2.reqId) return; // an even fresher search superseded us
      renderResults(out);
    } catch (err) {
      if (myReq !== state2.reqId) return;
      status.textContent = `Search failed: ${err.message}`;
      results.hidden = true;
    }
  }

  function renderResults(payload) {
    const rows = (payload && Array.isArray(payload.data)) ? payload.data : [];
    results.innerHTML = '';
    if (!rows.length) {
      status.textContent = 'No matches.';
      results.hidden = true;
      return;
    }
    status.textContent = `Showing ${rows.length}${payload.meta && payload.meta.total > rows.length ? ` of ${payload.meta.total}` : ''}.`;
    for (const c of rows) {
      const category = (c.contractsCount || 0) > 0 ? 'used' : 'unused';
      const item = document.createElement('div');
      item.className = 'db-search-item';
      const info = document.createElement('div');
      info.className = 'db-search-info';
      const name = document.createElement('div');
      name.className = 'db-search-name';
      const nameStr = c.creatorName || c.instagramUsername || c.email || '(unnamed)';
      name.textContent = nameStr;
      const badge = document.createElement('span');
      badge.className = `creator-badge cat-${category}`;
      badge.textContent = category === 'used' ? 'Used' : 'Unused';
      if (category === 'used') badge.title = `${c.contractsCount} past contract${c.contractsCount === 1 ? '' : 's'}`;
      name.appendChild(badge);
      const meta = document.createElement('div');
      meta.className = 'db-search-meta';
      const bits = [];
      if (c.instagramUsername) bits.push(`@${c.instagramUsername}`);
      if (c.email) bits.push(c.email);
      if (c.campaignName) bits.push(c.campaignName);
      meta.textContent = bits.join(' · ');
      info.appendChild(name);
      info.appendChild(meta);
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'ghost small';
      addBtn.textContent = 'Add';
      addBtn.addEventListener('click', () => addCreator(c, addBtn));
      item.appendChild(info);
      item.appendChild(addBtn);
      results.appendChild(item);
    }
    results.hidden = false;
  }

  async function addCreator(c, btn) {
    if (!state.selectedCampaignId) { alert('Select a campaign first.'); return; }
    btn.disabled = true;
    const prev = btn.textContent;
    btn.textContent = 'Adding…';
    try {
      const row = await api('/api/creator-db/import', {
        method: 'POST',
        body: JSON.stringify({
          campaign_id: state.selectedCampaignId,
          email: c.email || undefined,
          instagram_username: c.instagramUsername || undefined,
          first_name: c.creatorName ? String(c.creatorName).split(/\s+/)[0] : undefined,
          full_name: c.creatorName || undefined,
        }),
      });
      btn.textContent = 'Added ✓';
      setTimeout(() => { btn.textContent = prev; btn.disabled = false; }, 1400);
      await refreshCreators();
      await refreshCampaigns();
      // Used creators pulled from Creator-DB often already have a known email
      // (status 'email_found'), but have never had their reel views scraped in
      // THIS system. Trigger the same automatic extension scrape the "paste
      // Instagram URLs" flow uses, so Reach populates without a manual "Decide
      // offer" click. Skipped for an email-only match with no IG handle to visit.
      if (row && row.instagram_username) startExtensionScrape({ creators: [row] });
    } catch (err) {
      btn.textContent = prev;
      btn.disabled = false;
      alert(`Failed to add: ${err.message}`);
    }
  }
})();

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
  // The rows returned by each POST — exactly the creators this add produced.
  // The scrape below is scoped to these so it never sweeps in the campaign's
  // OTHER pending-extraction creators.
  const addedRows = [];
  for (let i = 0; i < urls.length; i++) {
    status.textContent = `Adding ${i + 1}/${urls.length}…`;
    try {
      const row = await api('/api/creators', {
        method: 'POST',
        body: JSON.stringify({
          campaign_id: state.selectedCampaignId,
          instagram_url: urls[i],
        }),
      });
      added += 1;
      if (row && row.id) addedRows.push(row);
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
  // Automatically scrape ONLY the creators just added here (the ones still
  // needing extraction). When that finishes, off-Instagram enrichment runs on
  // its own for anyone still without an email (see the 'done' handler).
  if (addedRows.length) startExtensionScrape({ creators: addedRows });
});

el('refresh-btn').addEventListener('click', refreshCreators);

// Live-filter the loaded creator rows as the operator types. Debounced so
// each keystroke doesn't tear down + rebuild the table for a fast typist —
// 120ms feels instant but batches typical typing bursts. Escape clears.
{
  const input = el('creator-search');
  if (input) {
    let debounce = null;
    input.addEventListener('input', () => {
      const value = input.value;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        if (state.searchQuery === value) return;
        state.searchQuery = value;
        refreshCreators();
      }, 120);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setSearchQuery('');
        input.blur();
      }
    });
  }
}

// Off-Instagram enrichment: for the creators still without an email, follow the
// links captured off their profile (website / Linktree) and scrape a verified
// contact address. Runs automatically after a scrape finishes (no manual
// button). Best-effort and paced server-side.
//
// `creatorIds` scopes the pass to the rows just scraped so it stays on the
// creators the operator added — never fanning out (and re-scraping) the
// campaign's other emailless rows. Omit for a campaign-wide sweep.
async function autoEnrichCampaign(creatorIds = null) {
  if (!state.selectedCampaignId) return;
  // A scoped run with an empty set has nothing to enrich — skip the round-trip.
  if (Array.isArray(creatorIds) && !creatorIds.length) {
    el('scrape-cancel-btn').textContent = 'Hide';
    return;
  }
  try {
    showScrapeProgress('Scrape done — searching linked sites for any missing emails…');
    const body = { campaign_id: state.selectedCampaignId };
    if (Array.isArray(creatorIds)) body.creator_ids = creatorIds;
    const result = await api('/api/creators/bulk/enrich-email', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (result.processed) {
      showScrapeProgress(
        `Done. Found ${result.found || 0} more email(s) off-site (of ${result.processed} without one). [hide]`,
      );
    } else {
      showScrapeProgress('Done. [hide]');
    }
  } catch (err) {
    // Enrichment is best-effort — a failure shouldn't erase the scrape summary.
    console.warn('auto-enrich failed:', err);
  } finally {
    el('scrape-cancel-btn').textContent = 'Hide';
    await refreshCreators();
    await refreshCampaigns();
  }
}

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
  if (!confirm(`Send outreach to ${pendingCount} pending creator(s)? This queues real emails in Instantly.`)) return;
  const btn = el('send-emails-btn');
  const status = el('fetch-status');
  btn.disabled = true;
  status.hidden = false;
  status.textContent = 'Queuing outreach emails…';
  try {
    const result = await api('/api/creators/bulk/send-outreach', {
      method: 'POST',
      body: JSON.stringify({ campaign_id: state.selectedCampaignId }),
    });
    status.textContent = result.total
      ? `Queuing ${result.total} creator(s) in the background — refresh to see progress.`
      : 'No eligible creators to queue.';
    await refreshCreators();
    await refreshCampaigns();
    const updated = state.campaigns.find((x) => x.id === state.selectedCampaignId);
    syncSendEmailsBtn(updated);
  } catch (err) {
    status.textContent = `Failed: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

// --- Instagram DM template + Send-IG-DMs ---------------------------------
// The per-campaign IG DM template is edited on the campaign page. Saving it
// enables the "Send Instagram DMs" button as soon as there is at least one
// eligible creator (no email + IG handle) waiting.
el('save-ig-dm-template-btn').addEventListener('click', async () => {
  if (!state.selectedCampaignId) return;
  const btn = el('save-ig-dm-template-btn');
  const status = el('ig-dm-template-status');
  const body = el('ig-dm-template-text').value;
  btn.disabled = true;
  status.textContent = 'Saving…';
  try {
    await api(`/api/campaigns/${encodeURIComponent(state.selectedCampaignId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ ig_dm_body: body }),
    });
    status.textContent = body.trim() ? 'Saved.' : 'Cleared.';
    await refreshCampaigns();
    const c = state.campaigns.find((x) => x.id === state.selectedCampaignId);
    if (c) syncIgDmTemplateUI(c);
  } catch (err) {
    status.textContent = `Failed: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

// --- WhatsApp/iMessage brief -----------------------------------------------
el('save-messaging-brief-btn').addEventListener('click', async () => {
  if (!state.selectedCampaignId) return;
  const btn = el('save-messaging-brief-btn');
  const status = el('messaging-brief-status');
  const body = el('messaging-brief-text').value;
  btn.disabled = true;
  status.textContent = 'Saving…';
  try {
    await api(`/api/campaigns/${encodeURIComponent(state.selectedCampaignId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ messaging_brief: body }),
    });
    status.textContent = body.trim() ? 'Saved.' : 'Cleared — using generic fallback.';
    await refreshCampaigns();
    const c = state.campaigns.find((x) => x.id === state.selectedCampaignId);
    if (c) syncMessagingBriefUI(c);
  } catch (err) {
    status.textContent = `Failed: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

el('send-ig-dms-btn').addEventListener('click', async () => {
  if (!state.selectedCampaignId) return;
  const c = state.campaigns.find((x) => x.id === state.selectedCampaignId);
  const queueCount = c ? c.ig_dm_queue_count : 0;
  if (!queueCount) { alert('Nothing to send — every creator either has an email or has already been DM’d.'); return; }
  if (!confirm(
    `Send Instagram DMs to ${queueCount} creator(s) as Priority Message Requests?\n\n` +
    `The Chrome extension will drive Instagram — keep the browser window focused ` +
    `and don't switch away while it runs.`,
  )) return;
  const btn = el('send-ig-dms-btn');
  btn.disabled = true;
  try {
    const result = await api('/api/creators/bulk/queue-ig-dm', {
      method: 'POST',
      body: JSON.stringify({ campaign_id: state.selectedCampaignId }),
    });
    if (!result.queued) {
      showIgDmProgress(`Nothing to send (${result.skipped || 0} skipped — no IG handle).`);
      el('ig-dm-cancel-btn').textContent = 'Hide';
      await refreshCreators();
      await refreshCampaigns();
      return;
    }
    startExtensionIgDmSend(result.jobs);
  } catch (err) {
    alert(err.message);
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
  if (msg.type === 'OEA_IG_DM_PROGRESS') {
    handleIgDmProgress(msg);
  }
});

// --- IG DM queue progress (mirrors scrape-progress UX) --------------------
let igDmInFlight = false;

function showIgDmProgress(text) {
  el('ig-dm-progress').hidden = false;
  el('ig-dm-progress-text').textContent = text;
  el('ig-dm-cancel-btn').textContent = 'Cancel';
}
function hideIgDmProgress() {
  el('ig-dm-progress').hidden = true;
  el('ig-dm-progress-text').textContent = '';
}

el('ig-dm-cancel-btn').addEventListener('click', () => {
  if (el('ig-dm-cancel-btn').textContent === 'Hide') {
    hideIgDmProgress();
    return;
  }
  window.postMessage({ type: 'OEA_ABORT_IG_DM_QUEUE' }, window.location.origin);
  showIgDmProgress('Cancelling after current DM…');
});

function handleIgDmProgress(msg) {
  if (msg.event === 'start') {
    showIgDmProgress(`Sending 0/${msg.total} Instagram DMs…`);
  } else if (msg.event === 'creator-start') {
    showIgDmProgress(
      `DM ${msg.index}/${msg.total} — @${msg.username || msg.creatorId}…`,
    );
  } else if (msg.event === 'creator-done') {
    let tail;
    if (msg.outcome === 'sent') {
      tail = `sent to @${msg.username || msg.creatorId}`;
    } else {
      tail = `failed on @${msg.username || msg.creatorId}: ${msg.error || 'unknown'}`;
    }
    showIgDmProgress(`DM ${msg.index}/${msg.total} — ${tail}`);
    refreshCreators();
  } else if (msg.event === 'done') {
    igDmInFlight = false;
    const s = msg.summary || {};
    showIgDmProgress(
      `Done. ${s.processed || 0} processed · ${s.sent || 0} sent · ${s.errors || 0} failed.`,
    );
    el('ig-dm-cancel-btn').textContent = 'Hide';
    refreshCreators();
    refreshCampaigns();
  } else if (msg.event === 'aborted') {
    igDmInFlight = false;
    showIgDmProgress(`Aborted at ${msg.index}/${msg.total}.`);
    el('ig-dm-cancel-btn').textContent = 'Hide';
    refreshCreators();
    refreshCampaigns();
  } else if (msg.event === 'error') {
    igDmInFlight = false;
    showIgDmProgress(`Extension error: ${msg.error}`);
    el('ig-dm-cancel-btn').textContent = 'Hide';
  }
}

// Hand the pre-rendered IG DM jobs off to the extension. The extension drives
// Instagram — navigates each profile, opens the DM composer, types the body,
// flips it to a Priority Message Request, and reports each result back via
// /api/creators/:id/ig-dm-result (the backend already logs those events).
function startExtensionIgDmSend(jobs) {
  if (!jobs || !jobs.length) return;
  window.postMessage({ type: 'OEA_PING' }, window.location.origin);
  igDmInFlight = true;
  showIgDmProgress(`Starting ${jobs.length} Instagram DM(s)…`);
  window.postMessage(
    {
      type: 'OEA_RUN_IG_DM_QUEUE',
      payload: {
        apiBase: window.location.origin,
        jobs,
        pacingMs: 8000,
      },
    },
    window.location.origin,
  );
  setTimeout(() => {
    if (!extensionBridge.ready) {
      igDmInFlight = false;
      showIgDmProgress(
        'Extension not detected. Load the unpacked extension at chrome://extensions then reload this page.',
      );
      el('ig-dm-cancel-btn').textContent = 'Hide';
    }
  }, 2000);
}

function showScrapeProgress(text) {
  el('scrape-progress').hidden = false;
  el('scrape-progress-text').textContent = text;
}

function hideScrapeProgress() {
  el('scrape-progress').hidden = true;
  el('scrape-progress-text').textContent = '';
}

let scrapeAffectedRowIds = new Set();
// Guards against stacking scrape queues (e.g. adding creators while one runs).
let scrapeInFlight = false;

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
    scrapeInFlight = false;
    const s = msg.summary || {};
    showScrapeProgress(
      `Done. ${s.processed || 0} processed · ${s.emailFound || 0} found · ${s.noEmail || 0} no email · ` +
      `${s.withViews || 0} with views · ${s.errors || 0} errors.`,
    );
    // Automatically follow up: find emails off-Instagram for anyone THIS scrape
    // left without one. Scoped to the rows we just scraped so it stays on the
    // creators just added. autoEnrichCampaign refreshes the table when it's done.
    autoEnrichCampaign([...scrapeAffectedRowIds]);
  } else if (msg.event === 'aborted') {
    scrapeInFlight = false;
    showScrapeProgress(`Aborted at ${msg.index}/${msg.total}.`);
    el('scrape-cancel-btn').textContent = 'Hide';
    refreshCreators();
    refreshCampaigns();
  } else if (msg.event === 'error') {
    scrapeInFlight = false;
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

// Kick off the extension scrape queue for this campaign.
//
// Scoping:
//   • creators: [rows]  → scrape exactly these rows (the ones just added). Only
//     those still needing extraction are kept, so the queue stops after this
//     batch and never touches the campaign's other pending creators.
//   • onlyPending: true → every still-unscraped row in the campaign.
//   • (neither)         → an explicit full re-scrape of the whole campaign.
// Runs automatically when creators are added; there's no manual button.
async function startExtensionScrape({ onlyPending = false, creators: explicitRows = null } = {}) {
  if (!state.selectedCampaignId) return;
  if (scrapeInFlight) return; // don't stack queues over one another
  el('scrape-cancel-btn').textContent = 'Cancel';
  // Ask the bridge to (re)announce, so a missed initial handshake doesn't make
  // the "not detected" check below a false positive.
  window.postMessage({ type: 'OEA_PING' }, window.location.origin);
  try {
    let list;
    if (explicitRows) {
      // Scoped run: scrape only the given rows (e.g. the just-added creators),
      // still skipping any that don't need it. A row is skipped only if it's
      // NOT pending_extraction AND already has real ig_scraped_data (reel_count)
      // — i.e. genuinely nothing left to do. A Creator-DB import can arrive
      // with status 'email_found' (a known returning creator) but no views on
      // file yet in this system, so that alone must never skip the scrape.
      list = explicitRows.filter(
        (r) => r.status === 'pending_extraction' || !(r.ig_scraped_data && r.ig_scraped_data.reel_count),
      );
    } else {
      const rows = await api(
        `/api/creators?campaign_id=${encodeURIComponent(state.selectedCampaignId)}`,
      );
      list = onlyPending ? rows.filter((r) => r.status === 'pending_extraction') : rows;
    }
    if (!list.length) {
      // Nothing to do. Only surface a message for an explicit full run.
      if (!onlyPending && !explicitRows) {
        showScrapeProgress('No creators in this campaign.');
        el('scrape-cancel-btn').textContent = 'Hide';
      }
      return;
    }
    const creators = list.map((r) => ({
      id: r.id,
      instagramUrl: r.instagram_url,
      instagramUsername: r.instagram_username,
    }));
    scrapeInFlight = true;
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
        scrapeInFlight = false;
        showScrapeProgress(
          'Extension not detected. Load the unpacked extension at chrome://extensions then reload this page.',
        );
        el('scrape-cancel-btn').textContent = 'Hide';
      }
    }, 2000);
  } catch (err) {
    scrapeInFlight = false;
    showScrapeProgress(`Failed: ${err.message}`);
    el('scrape-cancel-btn').textContent = 'Hide';
  }
}

// --- Email source display ------------------------------------------------

// Short human label for a non-URL email source (Instagram / provider / manual).
function emailSourceLabel(src) {
  if (/^instagram_contact$/i.test(src) || /^(business_email|public_email)$/i.test(src))
    return 'Instagram (contact)';
  if (/^instagram_bio$/i.test(src) || /^(bio_regex|html_text)$/i.test(src))
    return 'Instagram (bio)';
  if (/^instagram/i.test(src)) return 'Instagram';
  if (/^provider:/i.test(src)) {
    const p = src.slice(src.indexOf(':') + 1);
    return p ? p[0].toUpperCase() + p.slice(1) : 'provider';
  }
  if (src === 'web-search') return 'web search';
  if (src === 'manual') return 'manual entry';
  return src;
}

// A small "via …" line under the email. Off-Instagram emails link to the EXACT
// page they were scraped from (hostname shown, full URL on hover); Instagram /
// provider / manual sources show a short label. Returns null when there's no
// email or no recorded source.
function renderEmailSourceEl(r) {
  if (!r.email || !r.email_source) return null;
  const src = String(r.email_source);
  const wrap = document.createElement('div');
  wrap.className = 'cr-email-src';
  if (/^https?:\/\//i.test(src)) {
    let host = src;
    try { host = new URL(src).hostname.replace(/^www\./, ''); } catch { /* keep raw */ }
    wrap.appendChild(document.createTextNode('via '));
    const a = document.createElement('a');
    a.href = src;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = host;
    a.title = src; // the exact page the email was scraped from
    wrap.appendChild(a);
  } else {
    wrap.textContent = 'via ' + emailSourceLabel(src);
  }
  return wrap;
}

// --- HTML escape ---------------------------------------------------------

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// --- Guidelines (universal AI prompt + global AI kill-switch + per-reply notes)

// Renders one card per reply type into the Guidelines "Per-reply instructions"
// section. Each card shows the current master prompt Claude follows (view-only,
// collapsible) plus a textarea where the admin writes plain-English steering
// notes. The reply-type list, notes, and master prompt snapshots all come from
// the server so the UI stays in sync with the backend without hard-coding.
function renderReplyNotes(types, notes, masterPrompts) {
  const wrap = el('reply-notes-list');
  const safeTypes = Array.isArray(types) ? types : [];
  const safeNotes = notes && typeof notes === 'object' ? notes : {};
  const safePrompts = masterPrompts && typeof masterPrompts === 'object' ? masterPrompts : {};
  wrap.innerHTML = safeTypes
    .map((t) => {
      const key = t && t.key;
      const label = t && t.label ? t.label : key;
      if (!key) return '';
      const val = typeof safeNotes[key] === 'string' ? safeNotes[key] : '';
      const prompt = typeof safePrompts[key] === 'string' ? safePrompts[key] : '';
      const inputId = `reply-note-${key}`;
      const promptBlock = prompt
        ? '<details>' +
          '<summary>View current master prompt</summary>' +
          `<pre class="reply-prompt-view io-scroll">${escapeHtml(prompt)}</pre>` +
          '</details>'
        : '';
      return (
        '<div class="reply-note-item">' +
        `<div class="reply-note-label">${escapeHtml(label)}</div>` +
        promptBlock +
        `<label class="reply-note-input-label" for="${escapeHtml(inputId)}">Your instructions to change or refine this prompt</label>` +
        `<textarea id="${escapeHtml(inputId)}" data-reply-note-key="${escapeHtml(key)}" class="io-scroll" rows="4" placeholder="e.g. keep it under 3 short lines; never mention discounts.">${escapeHtml(val)}</textarea>` +
        '</div>'
      );
    })
    .join('');
}

// Populates the global "How every reply is framed" collapsible block. Empty
// string clears + hides the framing details entirely.
function renderReplyFraming(framing) {
  const wrap = el('reply-framing-wrap');
  const text = el('reply-framing-text');
  if (!wrap || !text) return;
  const t = typeof framing === 'string' ? framing : '';
  if (!t) {
    wrap.hidden = true;
    text.textContent = '';
    return;
  }
  wrap.hidden = false;
  text.textContent = t;
}

// Collect the current textarea values keyed by reply type. Reads from the DOM
// so unsaved edits are what gets sent on Save.
function collectReplyNotes() {
  const out = {};
  document.querySelectorAll('[data-reply-note-key]').forEach((node) => {
    const key = node.getAttribute('data-reply-note-key');
    if (key) out[key] = node.value || '';
  });
  return out;
}

async function refreshSettings() {
  try {
    const s = await api('/api/settings');
    el('guidelines-text').value = s.guidelines || '';
    el('ai-replies-toggle').checked = s.ai_replies_enabled !== false;
    el('ai-replies-status').textContent = '';
    renderReplyNotes(
      s.reply_note_types || [],
      s.reply_prompt_notes || {},
      s.reply_master_prompts || {},
    );
    renderReplyFraming(s.reply_master_prompts_framing || '');
    el('reply-notes-status').textContent = '';
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

el('save-reply-notes-btn').addEventListener('click', async () => {
  const btn = el('save-reply-notes-btn');
  const status = el('reply-notes-status');
  btn.disabled = true;
  status.textContent = 'Saving…';
  try {
    await api('/api/settings/reply-prompt-notes', {
      method: 'PUT',
      body: JSON.stringify({ notes: collectReplyNotes() }),
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
    status.textContent = enabled
      ? 'On — AI will auto-reply.'
      : 'Off — every reply is flagged for you at the top of the campaign.';
  } catch (err) {
    // Roll the checkbox back so the UI matches the server state.
    toggle.checked = !enabled;
    status.textContent = `Failed: ${err.message}`;
  } finally {
    toggle.disabled = false;
  }
});

// --- Intervention surfacing (per campaign) -------------------------------
// Delegations no longer live on a separate page — they're flagged at the top of
// the campaign activity list and actioned via the "Reply hand-off" / "Approve
// deal" pop-ups (see makeInterveneButton / openInterventionModal). The banner
// above the table is the campaign-level notification; the sidebar pending-dots
// stay the cross-campaign one.

function updateAttentionBanner(n) {
  const banner = el('attention-banner');
  if (!banner) return;
  if (!(n > 0)) {
    banner.hidden = true;
    banner.innerHTML = '';
    return;
  }
  banner.hidden = false;
  banner.innerHTML =
    '<span class="attention-dot"></span>' +
    `<span class="attention-text"><b>${n}</b> creator${n > 1 ? 's' : ''} need${n > 1 ? '' : 's'} you</span>` +
    '<span class="attention-hint">Flagged at the top — hand-offs, offers to decide, and deals to approve</span>';
}

// Clicking the banner clears any stage filter so every flagged creator shows at
// the top, then scrolls the table into view.
el('attention-banner').addEventListener('click', () => {
  if (state.stageFilter) setStageFilter(null);
  el('creator-table-wrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// A creator has an offer the admin can act on: priced offers exist and we're
// waiting on internal approval. Mirrors the send gate (AWAITING_APPROVAL) and
// the server-side action_count used for the sidebar pending-dot.
function isOfferActionable(r) {
  return (
    Array.isArray(r.suggested_offers) &&
    r.suggested_offers.length > 0 &&
    r.negotiation_status === 'AWAITING_APPROVAL'
  );
}

// An accepted deal parked for the brand POC's go-ahead: the approval hasn't
// been recorded and no contract exists yet. Surfaced as an "Approve & send
// contract" pop-up — the contract goes out only from there.
function isContractApprovalPending(r) {
  return (
    r.negotiation_status === 'ACCEPTED' &&
    !r.contract_approved &&
    !(r.contract && r.contract.status)
  );
}

// Needs a human right now: an AI hand-off, an offer awaiting approval, or an
// accepted deal awaiting the brand POC's contract approval. Drives the top-of-
// table sort, the row highlight, and the banner count. A flag the admin has
// temporarily dismissed (Dismiss button) is suppressed until it re-surfaces.
function isDelegateActionable(r) {
  if (isFlagDismissed(r)) return false;
  return !!r.needs_human || isOfferActionable(r) || isContractApprovalPending(r);
}

// The "Approve & send contract" block on a pending-approval intervention pop-up.
// Approving records the brand POC's go-ahead, then generates the contract and
// emails its signing link — nothing is sent to the creator until this click.
function buildContractApprovalBlock(r) {
  const rate = effectiveRate(r);
  const rateStr = rate != null ? ` at $${fmtNum(rate)}` : '';
  const block = document.createElement('div');
  block.className = 'delegate-approval-block';
  block.innerHTML = `
    <div class="delegate-question">Deal agreed${rateStr}. Get the brand POC's go-ahead, then approve — the contract is generated and emailed for signing only after that.</div>
    <div class="delegate-reply-foot">
      <span class="delegate-status hint"></span>
      <button class="btn-primary delegate-approve-contract" type="button">Approve &amp; send contract</button>
    </div>`;
  const statusEl = block.querySelector('.delegate-status');
  const approveBtn = block.querySelector('.delegate-approve-contract');
  approveBtn.onclick = async () => {
    if (
      !confirm(
        `Approve this deal${rateStr}? The contract will be generated and emailed to the creator for signing.`,
      )
    )
      return;
    approveBtn.disabled = true;
    statusEl.textContent = 'Approving & sending contract…';
    try {
      await api(`/api/creators/${r.id}/approve-contract`, { method: 'POST' });
      await refreshAfterIntervention();
    } catch (err) {
      statusEl.textContent = `Failed: ${err.message}`;
      approveBtn.disabled = false;
    }
  };
  return block;
}

// The creator's parked message (+ the hand-off reason), shown above the reply
// box in the intervention pop-up so the message being answered is visible.
// Returns null when there's nothing to show.
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
    <div class="delegate-ai-row">
      <input class="delegate-ai-note" type="text" placeholder="Or describe the reply and let AI draft it — e.g. “reassure them on the timeline, then ask for their rate”">
      <button class="ghost small delegate-ai-draft" type="button">✎ Draft with AI</button>
    </div>
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
  const aiNote = block.querySelector('.delegate-ai-note');
  const aiDraftBtn = block.querySelector('.delegate-ai-draft');

  // "Draft with AI" — describe the reply in a line or two, AI drafts it into the
  // reply box, which stays the review/edit surface. Sending is unchanged (the
  // existing Send reply button posts the reviewed body).
  aiDraftBtn.onclick = async () => {
    if (aiDraftBtn.dataset.busy === '1') return;
    const instructions = aiNote.value.trim();
    if (!instructions) { statusEl.textContent = 'Describe what the reply should say first.'; return; }
    aiDraftBtn.dataset.busy = '1';
    aiDraftBtn.disabled = true;
    statusEl.textContent = 'Drafting…';
    try {
      const draft = await api(`/api/creators/${r.id}/draft-reply`, {
        method: 'POST',
        body: JSON.stringify({ instructions }),
      });
      replyEl.value = draft.body || '';
      statusEl.textContent = 'Draft ready — review and edit, then Send reply.';
      replyEl.focus();
    } catch (err) {
      statusEl.textContent = `Couldn't draft: ${err.message}`;
    } finally {
      aiDraftBtn.disabled = false;
      aiDraftBtn.dataset.busy = '';
    }
  };

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
      await refreshAfterIntervention();
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
      await refreshAfterIntervention();
    } catch (err) {
      statusEl.textContent = `Failed: ${err.message}`;
      sendBtn.disabled = false; dismissBtn.disabled = false;
    }
  };
  return block;
}

// ---------------------------------------------------------------------------
// Needs-review inbox — inbound messaging replies the bot couldn't action.
// Populated from /api/offer-review; lets an admin reply on the same channel
// (WhatsApp / iMessage) or dismiss, clearing offer_messages.needs_review.
// ---------------------------------------------------------------------------
const reviewState = { items: [] };

function channelLabel(ch) {
  return ch === 'imessage' ? 'iMessage' : ch === 'whatsapp' ? 'WhatsApp' : ch;
}

function setReviewCount(n) {
  const btn = el('review-inbox-btn');
  const badge = el('review-inbox-count');
  if (!btn || !badge) return;
  badge.textContent = String(n);
  btn.hidden = n === 0;
}

async function refreshReviewCount() {
  try {
    reviewState.items = await api('/api/offer-review');
    setReviewCount(reviewState.items.length);
    if (!el('review-inbox').hidden) renderReviewList();
  } catch (_) {
    /* secondary surface — never block the dashboard on it */
  }
}

function removeReviewItem(id) {
  reviewState.items = reviewState.items.filter((x) => x.id !== id);
  setReviewCount(reviewState.items.length);
  renderReviewList();
}

function renderReviewItem(it) {
  const card = document.createElement('div');
  card.className = 'review-item';

  const head = document.createElement('div');
  head.className = 'review-item-head';
  const who = document.createElement('span');
  who.className = 'review-who';
  who.textContent = it.name + (it.handle && it.handle !== it.name ? ` · ${it.handle}` : '');
  const meta = document.createElement('span');
  meta.className = 'review-meta';
  meta.textContent = `${channelLabel(it.channel)} · ${fmtDate(it.at)}`;
  head.appendChild(who);
  head.appendChild(meta);
  card.appendChild(head);

  const body = document.createElement('div');
  body.className = 'review-body';
  body.textContent = it.body;
  card.appendChild(body);

  if (it.offer) {
    const offer = document.createElement('div');
    offer.className = 'review-offer';
    const rate = it.offer.rate != null ? `${it.offer.currency || ''} ${it.offer.rate}`.trim() : '—';
    offer.textContent = `Offer: ${rate} · ${it.offer.status}`;
    card.appendChild(offer);
  }

  const replyBox = document.createElement('textarea');
  replyBox.className = 'review-reply io-scroll';
  replyBox.rows = 2;
  replyBox.placeholder = `Reply to ${it.name} over ${channelLabel(it.channel)}…`;
  card.appendChild(replyBox);

  const foot = document.createElement('div');
  foot.className = 'review-item-foot';
  const status = document.createElement('span');
  status.className = 'review-status hint';
  const dismiss = document.createElement('button');
  dismiss.className = 'ghost small';
  dismiss.type = 'button';
  dismiss.textContent = 'Dismiss';
  const send = document.createElement('button');
  send.className = 'btn-primary small';
  send.type = 'button';
  send.textContent = 'Send reply';

  send.onclick = async () => {
    const text = replyBox.value.trim();
    if (!text) return replyBox.focus();
    send.disabled = true;
    dismiss.disabled = true;
    status.textContent = 'Sending…';
    try {
      await api(`/api/offer-review/${it.id}/reply`, {
        method: 'POST',
        body: JSON.stringify({ body: text }),
      });
      removeReviewItem(it.id);
    } catch (err) {
      status.textContent = `Failed: ${err.message}`;
      send.disabled = false;
      dismiss.disabled = false;
    }
    return undefined;
  };

  dismiss.onclick = async () => {
    send.disabled = true;
    dismiss.disabled = true;
    status.textContent = 'Dismissing…';
    try {
      await api(`/api/offer-review/${it.id}/resolve`, { method: 'POST' });
      removeReviewItem(it.id);
    } catch (err) {
      status.textContent = `Failed: ${err.message}`;
      send.disabled = false;
      dismiss.disabled = false;
    }
  };

  foot.appendChild(status);
  foot.appendChild(dismiss);
  foot.appendChild(send);
  card.appendChild(foot);
  return card;
}

function renderReviewList() {
  const list = el('review-list');
  const empty = el('review-empty');
  list.innerHTML = '';
  if (!reviewState.items.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  for (const it of reviewState.items) list.appendChild(renderReviewItem(it));
}

function openReviewInbox() {
  el('review-inbox').hidden = false;
  renderReviewList();
  refreshReviewCount();
}
function closeReviewInbox() {
  el('review-inbox').hidden = true;
}

if (el('review-inbox-btn')) {
  el('review-inbox-btn').addEventListener('click', openReviewInbox);
  el('review-close').addEventListener('click', closeReviewInbox);
  el('review-backdrop').addEventListener('click', closeReviewInbox);
}

(async () => {
  await refreshCampaigns();
  // Restore the view encoded in the URL so a refresh keeps the current
  // campaign instead of dropping back to the empty picker.
  await handleRoute();
  refreshReviewCount();
})();
