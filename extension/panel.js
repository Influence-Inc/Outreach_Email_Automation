// Influence — Deal panel (extension side panel content)
//
// Runs inside an extension-origin iframe (panel.html) that the Instagram
// content script latches to the right of a creator's profile. It renders the
// same Delegate offer experience the dashboard shows — the rate timeline
// (creator's rate + our/their counters), the safe floor / least views, and the
// controls to accept the creator's rate or send a counter offer — and talks to
// the SAME backend endpoints the dashboard uses. The backend stays the single
// source of truth for pricing and sending; this panel only shapes inputs and
// POSTs the identical `custom_offer` shape.
//
// The offer configurator + timeline rendering below are ported from the
// dashboard (backend/public/app.js). Keep the offer JSON shape and API calls in
// sync with that file — the visual layout is intentionally re-authored for the
// narrow vertical rail.
(function () {
  'use strict';

  // ---- Config from the iframe URL ----------------------------------------
  const qs = new URLSearchParams(location.search);
  const apiBase = (qs.get('apiBase') || '').replace(/\/+$/, '');
  const initial = {
    creatorId: qs.get('creatorId') || null,
    username: qs.get('username') || null,
    campaignId: qs.get('campaignId') || null,
  };
  // Once resolved we always reload by id so actions re-render a stable row.
  let creatorId = initial.creatorId;

  const rootEl = document.getElementById('panel-root');

  // ---- Formatting helpers (ported from app.js) ---------------------------
  const fmtNum = (n) => Number(n || 0).toLocaleString('en-US');
  const money = (n) => '$' + fmtNum(Math.round(Number(n) || 0));
  const numOr = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const round2 = (n) => Math.round(Number(n) * 100) / 100;
  function fmtViews(n) {
    n = Number(n || 0);
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(Math.round(n));
  }
  function fmtDate(s) { return s ? new Date(s).toLocaleString() : ''; }
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
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function avatarInitial(r) {
    const src = r.full_name || r.first_name || r.instagram_username || '?';
    return String(src).replace(/^@/, '').charAt(0).toUpperCase() || '?';
  }

  // ---- API ----------------------------------------------------------------
  // The dashboard's admin API sits behind Sign in with Slack (see backend
  // services/siteAuth.js). Its `io_session` cookie is same-origin to the
  // dashboard, so this panel — served from the extension origin — can't send it.
  // Instead we reuse the team member's existing dashboard sign-in: read that
  // cookie via the browser's cookies API and forward the same signed token in
  // the `x-io-session` header. Nothing to configure; it just needs the user to
  // be signed in to the Deal Studio dashboard. The token never lands in the DOM
  // of the Instagram page hosting us.
  async function authHeaders() {
    try {
      if (apiBase && chrome.cookies) {
        const cookie = await chrome.cookies.get({ url: apiBase, name: 'io_session' });
        if (cookie && cookie.value) return { 'x-io-session': cookie.value };
      }
    } catch (e) {
      /* cookies unavailable — fall through to no auth header */
    }
    return {};
  }

  async function api(path, options = {}) {
    if (!apiBase) throw new Error('Dashboard URL not set. Open the extension popup to set it.');
    const res = await fetch(apiBase + path, {
      headers: {
        'Content-Type': 'application/json',
        ...(await authHeaders()),
      },
      ...options,
    });
    if (res.status === 401) {
      throw new Error('Not signed in. Open the Deal Studio dashboard and sign in with Slack, then retry.');
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `${res.status} ${res.statusText}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  function loadCreator() {
    const p = creatorId
      ? `creator_id=${encodeURIComponent(creatorId)}`
      : `username=${encodeURIComponent(initial.username || '')}${
          initial.campaignId ? `&campaign_id=${encodeURIComponent(initial.campaignId)}` : ''
        }`;
    return api(`/api/creators/panel?${p}`);
  }

  // ---- State helpers ------------------------------------------------------
  const isOfferConfigurable = (r) =>
    ['AWAITING_APPROVAL', 'AWAITING_RATE'].includes(r.negotiation_status) &&
    (Array.isArray(r.suggested_offers) || (r.ig_scraped_data && r.ig_scraped_data.min_views != null));

  function statusBadge(r) {
    if (r.negotiation_status === 'AWAITING_DECISION') return { cls: 'sent', text: 'Offer sent' };
    if (r.negotiation_status === 'ACCEPTED') return { cls: 'success', text: 'Accepted ✓' };
    if (r.negotiation_status === 'AWAITING_APPROVAL') return { cls: 'pending', text: 'Awaiting your offer' };
    if (r.negotiation_status === 'AWAITING_RATE') return { cls: 'pending', text: 'Awaiting rate' };
    if (r.negotiation_status === 'CLOSED') return { cls: 'neutral', text: 'Closed' };
    if (r.needs_human) return { cls: 'pending', text: 'Needs you' };
    return { cls: 'neutral', text: (r.negotiation_status || r.status || 'no reply').replace(/_/g, ' ') };
  }

  // ---- "View full email" affordance (ported from app.js) ------------------
  // Each message-backed timeline row carries the full email on `entry.email`
  // (see attachRateLog on the backend). A small envelope button opens that
  // message verbatim in a modal, so the one-line gist can be checked against
  // the actual email the creator sent (or the reply we sent).
  const EMAIL_ICON_SVG =
    '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="m3 7 9 6 9-6"></path></svg>';

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

  // stopPropagation keeps a click from also toggling an enclosing expandable
  // group (rate options / repeat runs).
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

  // ---- Timeline (ported from app.js renderTimeline, ticks omitted) --------
  function renderTimeline(log) {
    const wrap = document.createElement('div');
    wrap.className = 'timeline';
    const items = Array.isArray(log) ? log : [];
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
      const newest = g.entries[g.entries.length - 1];
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

      if (collapsed) {
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
        // One reply backing several rate options → a single expand button on
        // the head. (Repeated-run groups instead put a button on each substep.)
        if (rateOptions && newest.email) head.appendChild(makeEmailExpandBtn(newest.email));

        const time = document.createElement('div');
        time.className = 'timeline-time num';
        time.textContent = fmtAgo(newest.at);
        time.title = fmtDate(newest.at);

        const subs = document.createElement('div');
        subs.className = 'timeline-substeps';
        subs.hidden = true;
        if (rateOptions) {
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
          // Repeated identical-text events: each occurrence's timestamp plus
          // its own "view email" button (every occurrence is a separate message).
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
        // Expand button inline with the summary/quoted-rate label, to read the
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

  // ---- Offer configurator (ported from app.js buildOfferConfigurator) -----
  const OC_ICONS = {
    view: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"></path><circle cx="12" cy="12" r="3"></circle></svg>',
    video: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"></rect><path d="m10 9 5 3-5 3Z" fill="currentColor" stroke="none"></path></svg>',
    bonus: '<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z"></path></svg>',
  };

  // The bonus deal's base CPM sits below the headline CPM ($4 under it), but never under
  // half of it — an estimate of $6 shouldn't open the bonus deal at $2.
  const bonusBaseCpm = (cpm) => Math.max(1, round2(cpm * 0.5), round2(cpm - 4));

  // --- Estimated CPM & rate --------------------------------------------------------------
  // The automated estimate from the backend (services/cpmEstimate.js, ported from the
  // influence-creator-list repo): topic base range x country index, and rate = the
  // creator's median views / 1000 x CPM. CPM and rate are editable and linked through
  // those views; the topic and country can be corrected when the profile was misread.
  // Typing previews into the deals below (onPreview); a committed change is saved, which
  // also re-prices the suggested offers server-side.
  const money2 = (n) => '$' + Number(n || 0).toFixed(2).replace(/\.00$/, '');

  function cpmStickerLine(s) {
    const amount =
      s.name === 'topic'
        ? `${money2(s.low)}–${money2(s.high)}`
        : s.low === s.high
        ? `×${s.low}`
        : `×${s.low}–${s.high}`;
    const level = s.level === 'none' ? 'no data yet' : `${s.level} level`;
    const name = s.name.charAt(0).toUpperCase() + s.name.slice(1);
    return `<li><b>${escapeHtml(name)}</b> ${escapeHtml(s.label)} <span class="num">${escapeHtml(amount)}</span>
      <span class="cpm-why-meta">(${escapeHtml(level)}${s.evidence ? `; ${escapeHtml(s.evidence)}` : ''})</span></li>`;
  }

  function buildCpmEstimate(r, { onPreview }) {
    const el = document.createElement('div');
    el.className = 'section cpm-est';
    const opts = r.cpm_options || { topics: [], countries: [] };
    let ce = r.cpm_estimate;
    let status = '';

    const views = () => (ce && ce.expected_views ? Number(ce.expected_views.value) || 0 : 0);
    const rateFor = (cpm) => (views() ? round2((views() / 1000) * cpm) : null);

    function render() {
      if (!ce) {
        el.innerHTML = `<div class="section-title">Estimated CPM &amp; rate</div>
          <div class="cpm-empty">The dashboard didn't return an estimate — update the backend to enable it.</div>`;
        return;
      }
      const deal = ce.deal || {};
      const badge =
        deal.source === 'admin'
          ? '<span class="cpm-badge set">Set by you</span>'
          : deal.source === 'estimate_capped'
          ? '<span class="cpm-badge capped">Held to campaign max</span>'
          : '<span class="cpm-badge">Auto</span>';
      const est = ce.cpm;
      const shown = (s) => s.level !== 'none';
      const noData = est.stickers.filter((s) => !shown(s)).map((s) => s.name);
      const topicKey = (ce.overrides && ce.overrides.topic) || '';
      const countryKey = (ce.overrides && ce.overrides.country) || '';
      const topicOpts = opts.topics.some((t) => t.key === topicKey) || !topicKey
        ? opts.topics
        : [...opts.topics, { key: topicKey, label: topicKey.replace(/_/g, ' '), group: '' }];
      // Just the topic's name here; the full chain (niche → group) is in the breakdown below.
      const topicName = String(est.stickers[0].value || '').replace(/_/g, ' ');
      const autoTopic =
        !topicKey && ce.inputs && ce.inputs.topic.source === 'profile' && topicName
          ? ` — ${topicName.charAt(0).toUpperCase()}${topicName.slice(1)}`
          : '';
      const autoCountry = !countryKey && ce.inputs && ce.inputs.country.source === 'bio' ? ` — ${est.stickers[1].label}` : '';
      const option = (value, text, sel) =>
        `<option value="${escapeHtml(value)}"${sel ? ' selected' : ''}>${escapeHtml(text)}</option>`;
      const rate = deal.rate != null ? deal.rate : rateFor(deal.cpm);

      el.innerHTML = `
        <div class="section-title">Estimated CPM &amp; rate ${badge}</div>
        <div class="cpm-box">
          <div class="cpm-grid">
            <div class="oc-field">
              <label class="oc-field-label" for="deal-cpm">CPM</label>
              <div class="oc-money"><span class="oc-money-prefix">$</span><input id="deal-cpm" type="number" min="0" step="0.5" class="oc-input oc-money-input num" value="${round2(deal.cpm)}"></div>
              <div class="oc-sub">est. ${money2(est.low)}–${money2(est.high)} · mid ${money2(est.value)}</div>
            </div>
            <div class="oc-field">
              <label class="oc-field-label" for="deal-rate">Rate / video</label>
              <div class="oc-money"><span class="oc-money-prefix">$</span><input id="deal-rate" type="number" min="0" step="10" class="oc-input oc-money-input num" value="${rate != null ? Math.round(rate) : ''}" ${views() ? '' : 'disabled placeholder="—"'}></div>
              <div class="oc-sub">${views() ? `at ${fmtViews(views())} median views` : 'scrape their reels to estimate a rate'}</div>
            </div>
          </div>
          ${
            deal.source === 'estimate_capped'
              ? `<div class="cpm-note">Estimate ${money2(deal.estimate)} is above this campaign's max CPM, so deals use ${money2(deal.cap)}.</div>`
              : ''
          }
          <div class="cpm-selects">
            <label class="cpm-select"><span>Topic</span>
              <select id="cpm-topic">${option('', `Auto (from profile)${autoTopic}`, !topicKey)}${topicOpts
                .map((t) => option(t.key, t.group ? `${t.label} · ${t.group}` : t.label, t.key === topicKey))
                .join('')}</select>
            </label>
            <label class="cpm-select"><span>Country</span>
              <select id="cpm-country">${option('', `Auto (from bio)${autoCountry}`, !countryKey)}${opts.countries
                .map((c) => option(c.code, c.name, c.code === countryKey))
                .join('')}</select>
            </label>
          </div>
          <ul class="cpm-why">
            ${est.stickers.filter(shown).map(cpmStickerLine).join('')}
            ${noData.length ? `<li class="cpm-why-meta">${escapeHtml(noData.join(', '))}: no data yet (×1)</li>` : ''}
          </ul>
          <div class="cpm-foot">
            <span class="cpm-status">${escapeHtml(status)}</span>
            ${deal.source === 'admin' ? '<button type="button" class="cpm-reset">Reset to estimate</button>' : ''}
          </div>
        </div>`;
      wire();
    }

    async function save(body) {
      status = 'Saving…';
      const statusEl = el.querySelector('.cpm-status');
      if (statusEl) statusEl.textContent = status;
      try {
        const resp = await api(`/api/creators/${r.id}/cpm`, { method: 'POST', body: JSON.stringify(body) });
        ce = resp.cpm_estimate;
        r.cpm_estimate = ce;
        if (resp.suggested_offers) r.suggested_offers = resp.suggested_offers;
        status = 'Saved';
      } catch (err) {
        status = `Couldn't save: ${err.message}`;
      }
      // Saved or not, the deals go back to the CPM the backend actually holds.
      onPreview(ce.deal.cpm);
      render();
    }

    function wire() {
      const cpmIn = el.querySelector('#deal-cpm');
      const rateIn = el.querySelector('#deal-rate');
      const current = ce.deal;
      // Not a usable number: nothing is saved, and the field and the deals go back to the
      // saved CPM so the panel never shows a value the backend doesn't hold.
      const reject = (what) => {
        status = `Enter a positive ${what}`;
        onPreview(current.cpm);
        render();
      };
      const clearStatus = () => {
        status = '';
        const st = el.querySelector('.cpm-status');
        if (st) st.textContent = '';
      };
      cpmIn.addEventListener('input', () => {
        clearStatus();
        const cpm = Number(cpmIn.value);
        if (!(cpm > 0)) return;
        const rate = rateFor(cpm);
        if (rate != null && rateIn) rateIn.value = Math.round(rate);
        onPreview(cpm);
      });
      cpmIn.addEventListener('change', () => {
        const v = cpmIn.value.trim();
        if (v === '') return save({ deal_cpm: null });
        if (!(Number(v) > 0)) return reject('CPM');
        if (round2(Number(v)) !== round2(current.cpm)) save({ deal_cpm: Number(v) });
      });
      if (rateIn && !rateIn.disabled) {
        rateIn.addEventListener('input', () => {
          clearStatus();
          const rate = Number(rateIn.value);
          if (!(rate > 0) || !views()) return;
          const cpm = round2((rate * 1000) / views());
          cpmIn.value = cpm;
          onPreview(cpm);
        });
        rateIn.addEventListener('change', () => {
          const v = rateIn.value.trim();
          if (v === '') return save({ deal_cpm: null });
          if (!(Number(v) > 0)) return reject('rate');
          if (Math.round(Number(v)) !== Math.round(current.rate || 0)) save({ deal_rate: Number(v) });
        });
      }
      const enterBlurs = (input) => input && input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
      });
      enterBlurs(cpmIn);
      enterBlurs(rateIn);
      el.querySelector('#cpm-topic').addEventListener('change', (ev) => save({ topic: ev.target.value || null }));
      el.querySelector('#cpm-country').addEventListener('change', (ev) => save({ country: ev.target.value || null }));
      const reset = el.querySelector('.cpm-reset');
      if (reset) reset.addEventListener('click', () => save({ deal_cpm: null }));
    }

    render();
    return el;
  }

  function buildOfferConfigurator(r, onRefresh) {
    const root = document.createElement('div');

    const stats = r.ig_scraped_data && typeof r.ig_scraped_data === 'object' ? r.ig_scraped_data : {};
    const offers = Array.isArray(r.suggested_offers) ? r.suggested_offers : [];
    const viewOffer = offers.find((o) => o.offer_type === 'view_based');
    // Deals open at this creator's CPM — the one set in "Estimated CPM & rate" below, else
    // the automated estimate. Older backends without an estimate fall back to the offers.
    const dealCpm = r.cpm_estimate && r.cpm_estimate.deal ? Number(r.cpm_estimate.deal.cpm) : 0;
    const seedCpm =
      dealCpm > 0
        ? round2(dealCpm)
        : Math.round(Number((viewOffer && viewOffer.cpm_applied) || (offers[0] && offers[0].cpm_applied) || 12)) || 12;
    const safeFloor0 = Math.round(Number(stats.min_views) || Number(stats.p50) || 25000);

    const priorOfferSent =
      Array.isArray(r.rate_log) && r.rate_log.some((e) => e && e.type === 'rate_offer_sent');
    const sent = r.negotiation_status === 'AWAITING_DECISION';

    const custom = r.custom_offer && typeof r.custom_offer === 'object' ? r.custom_offer : null;
    const bCpm0 = bonusBaseCpm(seedCpm);
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

    const approveLabel = priorOfferSent ? 'Re-approve &amp; send counter offer' : 'Approve &amp; send offer';
    const medianTxt = stats.p50 ? `${fmtViews(stats.p50)} median` : '';
    const reelsTxt = stats.reel_count ? `${stats.reel_count} reels` : '';

    root.innerHTML = `
      <div class="section">
        <div class="section-title">Creator's rate</div>
        <div class="rate-row">
          <div class="k">Their asking rate<small>Edit to record what they sent</small></div>
          <div class="rate-input">
            <span>$</span><input type="number" min="0" class="num" id="quoted-rate" value="${r.quoted_rate != null ? Number(r.quoted_rate) : ''}" placeholder="—">
          </div>
        </div>
      </div>

      <div class="cpm-est-slot"></div>

      <div class="section">
        <div class="section-title">Safe floor</div>
        <div class="floor">
          <div class="floor-top">
            <span class="floor-label">Safe floor · per video</span>
            <span class="scraped">SCRAPED</span>
          </div>
          <div class="floor-value"><input type="number" min="0" class="num" data-k="safeFloor" value="${m.safeFloor}"></div>
          <div class="floor-sub">= <span data-r="safeFloorFmt"></span> guaranteed views · least-viewed recent video</div>
          <div class="floor-stats">
            <div class="floor-stat"><div class="k">Least views</div><div class="v num">${stats.min_views != null ? fmtViews(stats.min_views) : '—'}</div></div>
            <div class="floor-stat"><div class="k">Median</div><div class="v num">${stats.p50 != null ? fmtViews(stats.p50) : '—'}</div></div>
            <div class="floor-stat"><div class="k">Reels</div><div class="v num">${stats.reel_count || '—'}</div></div>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-title">Shape the ${priorOfferSent ? 'counter offer' : 'offer'}</div>

        <div class="oc-deal" data-deal="view">
          <div class="oc-deal-head">
            <div class="oc-deal-icon view">${OC_ICONS.view}</div>
            <div><div class="oc-deal-kicker">01 · GUARANTEED</div><div class="oc-deal-title">View-based deal</div></div>
          </div>
          <div class="oc-deal-desc">Flat CPM against a guaranteed view count. Simplest, most predictable spend.</div>
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
        <div class="oc-sendbar-inner">
          <div class="oc-sendbar-label">Selected ${priorOfferSent ? 'counter offer' : 'offer'}</div>
          <div class="oc-sendbar-headline"><span data-r="selName"></span> <span class="oc-dash">—</span> <span class="num" data-r="selFee"></span></div>
          <div class="oc-sendbar-meta" data-r="selMeta"></div>
          <div class="oc-send-status"></div>
          <div class="oc-actions">
            <button class="btn btn-primary oc-approve" type="button">${approveLabel} →</button>
            ${
              r.quoted_rate != null
                ? `<button class="btn btn-accept oc-accept-rate" type="button">Accept their rate — $${fmtNum(r.quoted_rate)} ✓</button>`
                : ''
            }
            <button class="btn btn-ghost oc-dismiss" type="button">Dismiss offer</button>
            <button class="btn btn-ghost oc-ai-toggle" type="button">✎ Draft with AI</button>
          </div>

          <div class="oc-ai" hidden>
            <div class="oc-ai-title">Draft with AI</div>
            <div class="oc-ai-desc">Add your own thoughts — AI writes the full email around the selected offer. Review and edit before it sends; the numbers stay as you set them.</div>
            <textarea class="oc-ai-note" rows="3" placeholder="e.g. Push back gently on the per-view bonus and lean into the long-term retainer."></textarea>
            <div class="oc-ai-bar">
              <button class="btn btn-primary oc-ai-draft" type="button">Draft email with AI →</button>
            </div>
            <div class="oc-ai-status"></div>
            <div class="oc-ai-preview" hidden>
              <div class="oc-ai-label">Review &amp; edit — sent to the creator as-is</div>
              <textarea class="oc-ai-body" rows="12"></textarea>
              <div class="oc-ai-bar">
                <button class="btn btn-primary oc-ai-send" type="button">Send to creator →</button>
                <button class="btn btn-ghost oc-ai-redraft" type="button">Re-draft</button>
              </div>
            </div>
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
      btn.addEventListener('click', () => { m.selected = btn.dataset.choose; recompute(); });
    });

    // Every deal follows the creator's CPM: the view and video deals at it, the bonus deal
    // at its lower base.
    root.querySelector('.cpm-est-slot').replaceWith(
      buildCpmEstimate(r, {
        onPreview: (cpm) => {
          m.vCpm = round2(cpm);
          m.fCpm = round2(cpm);
          m.bCpm = bonusBaseCpm(cpm);
          for (const k of ['vCpm', 'fCpm', 'bCpm']) {
            const input = root.querySelector(`input[data-k="${k}"]`);
            if (input) input.value = m[k];
          }
          recompute();
          // A drafted email quoting the old numbers is stale now. (Only ever called from a
          // user action, after markStaleOnEdit below is defined.)
          markStaleOnEdit();
        },
      }),
    );

    function buildCustomOffer() {
      if (m.selected === 'view') {
        return {
          offer_id: 'cfg_view', offer_type: 'view_based', label: 'View-based deal',
          flat_fee: computed.viewFee, view_guarantee: Math.round(computed.vViews),
          num_videos: 1, flat_per_video: computed.viewFee, cpm_applied: round2(computed.vCpm),
        };
      }
      if (m.selected === 'video') {
        return {
          offer_id: 'cfg_video', offer_type: 'video_based', label: 'Video-based deal',
          flat_fee: computed.videoFee, num_videos: computed.fVideos, flat_per_video: computed.perVideo,
          view_guarantee: Math.round(computed.videoViews), cpm_applied: round2(computed.fCpm),
        };
      }
      return {
        offer_id: 'cfg_bonus', offer_type: 'video_bonus', label: 'Video + bonus deal',
        flat_fee: computed.aggregate, base_fee: computed.baseFee, bonus_amount: computed.bBonus,
        bonus_threshold_views: Math.round(computed.bUnlock), num_videos: computed.bVideos,
        flat_per_video: Math.round(computed.baseFee / Math.max(1, computed.bVideos)),
        view_guarantee: Math.round(computed.bonusViews), cpm_applied: round2(computed.bCpm),
      };
    }

    // Persist the creator's rate (also advances AWAITING_RATE → AWAITING_APPROVAL
    // and recomputes suggested offers server-side). Only fires on a real change.
    const rateInput = root.querySelector('#quoted-rate');
    if (rateInput) {
      const prev = r.quoted_rate != null ? String(Number(r.quoted_rate)) : '';
      const commitRate = async () => {
        const next = rateInput.value.trim();
        if (next === prev) return;
        statusEl.textContent = 'Saving rate…';
        try {
          await api(`/api/creators/${r.id}/quoted-rate`, {
            method: 'POST',
            body: JSON.stringify({ quoted_rate: next === '' ? null : Number(next.replace(/[^0-9.]/g, '')) }),
          });
          onRefresh();
        } catch (err) {
          statusEl.textContent = `Couldn't save rate: ${err.message}`;
        }
      };
      rateInput.addEventListener('blur', commitRate);
      rateInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); rateInput.blur(); } });
    }

    approveBtn.onclick = async () => {
      if (approveBtn.dataset.busy === '1') return;
      approveBtn.dataset.busy = '1';
      approveBtn.disabled = true;
      dismissBtn.disabled = true;
      statusEl.textContent = 'Approving…';
      const offer = buildCustomOffer();
      try {
        const resp = await api(`/api/creators/${r.id}/offer`, {
          method: 'PATCH',
          body: JSON.stringify({ selected_offer_id: offer.offer_id, custom_offer: offer, offer_approved: true }),
        });
        const sr = resp && resp.send_result;
        let hold = 1200;
        if (sr && sr.sent) {
          statusEl.textContent = `✓ ${offer.label} sent.`;
        } else if (sr && sr.error) {
          statusEl.textContent = `Send failed: ${sr.error}. Check the creator's inbox before re-approving.`;
          hold = 5000;
        } else if (sr && sr.skipped) {
          statusEl.textContent = `Approved, not sent — ${sr.skipped}. Approve again when ready.`;
          hold = 4000;
        } else {
          statusEl.textContent = `✓ ${offer.label} approved.`;
        }
        setTimeout(onRefresh, hold);
      } catch (err) {
        statusEl.textContent = err.message;
        approveBtn.disabled = false;
        dismissBtn.disabled = false;
        approveBtn.dataset.busy = '';
      }
    };

    const acceptRateBtn = root.querySelector('.oc-accept-rate');
    if (acceptRateBtn) {
      acceptRateBtn.onclick = async () => {
        if (acceptRateBtn.dataset.busy === '1') return;
        const rateStr = `$${fmtNum(r.quoted_rate)}`;
        const who = r.first_name || `@${r.instagram_username || 'this creator'}`;
        if (!confirm(`Accept ${who}'s rate of ${rateStr}? We'll agree to their number — the contract goes out after the deal is approved in Delegate (brand POC go-ahead).`)) return;
        acceptRateBtn.dataset.busy = '1';
        acceptRateBtn.disabled = true;
        approveBtn.disabled = true;
        dismissBtn.disabled = true;
        statusEl.textContent = 'Accepting…';
        try {
          await api(`/api/creators/${r.id}/accept-rate`, { method: 'POST' });
          statusEl.textContent = `✓ Accepted ${rateStr} — awaiting brand approval in Delegate before the contract goes out.`;
          setTimeout(onRefresh, 1200);
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
      if (!confirm('Dismiss this offer without sending? The creator is removed from Delegate.')) return;
      approveBtn.disabled = true;
      dismissBtn.disabled = true;
      statusEl.textContent = 'Dismissing…';
      try {
        await api(`/api/creators/${r.id}/dismiss-offer`, { method: 'POST' });
        statusEl.textContent = 'Dismissed.';
        setTimeout(onRefresh, 700);
      } catch (err) {
        statusEl.textContent = `Failed to dismiss: ${err.message}`;
        approveBtn.disabled = false;
        dismissBtn.disabled = false;
      }
    };

    // ── "Draft with AI" — describe the message, AI writes the full offer email
    //    around the selected offer, review/edit, then send. Sending reuses the
    //    same PATCH /offer approve path (with the reviewed body) so all the send
    //    guarantees match Approve & send.
    const aiPanel = root.querySelector('.oc-ai');
    const aiToggle = root.querySelector('.oc-ai-toggle');
    const aiNote = root.querySelector('.oc-ai-note');
    const aiDraftBtn = root.querySelector('.oc-ai-draft');
    const aiStatus = root.querySelector('.oc-ai-status');
    const aiPreview = root.querySelector('.oc-ai-preview');
    const aiBody = root.querySelector('.oc-ai-body');
    const aiSendBtn = root.querySelector('.oc-ai-send');
    const aiRedraftBtn = root.querySelector('.oc-ai-redraft');
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
        let hold = 1200;
        if (sr && sr.sent) {
          aiStatus.textContent = '✓ Your email was sent.';
        } else if (sr && sr.error) {
          aiStatus.textContent = `Send failed: ${sr.error}. Check the creator's inbox before re-sending.`;
          hold = 5000;
        } else if (sr && sr.skipped) {
          aiStatus.textContent = `Not sent — ${sr.skipped}.`;
          hold = 4000;
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

    // Editing the offer after drafting desyncs the preview from the numbers —
    // drop the stale draft and prompt a re-draft.
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

    recompute();
    return root;
  }

  // ---- Hand-off reply block (ported from app.js buildReplyBlock) ----------
  function buildReplyBlock(r, onRefresh) {
    const block = document.createElement('div');
    block.className = 'section';
    block.innerHTML = `
      <div class="section-title">The creator's message</div>
      ${
        r.delegate_reason || r.delegate_question
          ? `<div class="handoff-msg">
               ${r.delegate_reason ? `<div class="handoff-label">${escapeHtml(r.delegate_reason)}</div>` : ''}
               ${r.delegate_question ? `<div>${escapeHtml(r.delegate_question)}</div>` : ''}
             </div>`
          : ''
      }
      <div class="reply">
        <label>Your reply</label>
        <div class="reply-ai-row">
          <input class="reply-ai-note" type="text" placeholder="Or describe it and let AI draft — e.g. “reassure on timeline, ask for rate”">
          <button class="btn btn-ghost reply-ai-draft" type="button">✎ AI</button>
        </div>
        <textarea class="reply-text" rows="5" placeholder="Write your reply…  ([text](url) formatting supported)"></textarea>
        <div class="oc-send-status reply-status"></div>
        <div class="btn-row" style="margin-top:8px">
          <button class="btn btn-ghost reply-dismiss" type="button">Dismiss</button>
          <button class="btn btn-primary reply-send" type="button">Send reply</button>
        </div>
      </div>`;
    const textEl = block.querySelector('.reply-text');
    const statusEl = block.querySelector('.reply-status');
    const sendBtn = block.querySelector('.reply-send');
    const dismissBtn = block.querySelector('.reply-dismiss');
    const aiNote = block.querySelector('.reply-ai-note');
    const aiDraftBtn = block.querySelector('.reply-ai-draft');

    // "Draft with AI" — describe the reply, AI drafts it into the reply box for
    // review/edit; the existing Send reply posts the reviewed body.
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
        textEl.value = draft.body || '';
        statusEl.textContent = 'Draft ready — review and edit, then Send reply.';
        textEl.focus();
      } catch (err) {
        statusEl.textContent = `Couldn't draft: ${err.message}`;
      } finally {
        aiDraftBtn.disabled = false;
        aiDraftBtn.dataset.busy = '';
      }
    };

    sendBtn.onclick = async () => {
      const body = textEl.value.trim();
      if (!body) { statusEl.textContent = 'Write a reply first.'; return; }
      sendBtn.disabled = true; dismissBtn.disabled = true;
      statusEl.textContent = 'Sending…';
      try {
        await api(`/api/creators/${r.id}/delegate-reply`, { method: 'POST', body: JSON.stringify({ body }) });
        onRefresh();
      } catch (err) {
        statusEl.textContent = `Failed: ${err.message}`;
        sendBtn.disabled = false; dismissBtn.disabled = false;
      }
    };
    dismissBtn.onclick = async () => {
      if (!confirm('Dismiss without replying?')) return;
      sendBtn.disabled = true; dismissBtn.disabled = true;
      try {
        await api(`/api/creators/${r.id}/dismiss-delegate`, { method: 'POST' });
        onRefresh();
      } catch (err) {
        statusEl.textContent = `Failed: ${err.message}`;
        sendBtn.disabled = false; dismissBtn.disabled = false;
      }
    };
    return block;
  }

  // ---- Render -------------------------------------------------------------
  function renderState({ icon = '', title, body, retry = false }) {
    rootEl.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'state';
    wrap.innerHTML = `${icon}<h3>${escapeHtml(title)}</h3><p>${body}</p>`;
    if (retry) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-ghost';
      btn.textContent = 'Retry';
      btn.onclick = () => load();
      wrap.appendChild(btn);
    }
    rootEl.appendChild(wrap);
  }

  function render(r) {
    creatorId = r.id; // lock to id for subsequent reloads
    rootEl.innerHTML = '';

    // Header
    const badge = statusBadge(r);
    const header = document.createElement('div');
    header.className = 'ph';
    header.innerHTML = `
      <div class="ph-avatar">${escapeHtml(avatarInitial(r))}</div>
      <div class="ph-id">
        <div class="ph-handle"><a href="${escapeHtml(r.instagram_url || '#')}" target="_blank" rel="noopener">@${escapeHtml(r.instagram_username || '')}</a>${
          r.first_name ? `<span class="ph-name"> · ${escapeHtml(r.first_name)}</span>` : ''
        }</div>
        <div class="ph-email">${escapeHtml(r.email || 'no email')}</div>
      </div>
      <span class="ph-badge ${badge.cls}">${escapeHtml(badge.text)}</span>`;
    rootEl.appendChild(header);

    // Subtitle: what to do
    const configurable = isOfferConfigurable(r);
    let subtitleText = null;
    if (configurable) {
      subtitleText =
        r.quoted_rate != null
          ? `Creator shared a rate of $${fmtNum(r.quoted_rate)} — shape an offer and send, or accept their rate.`
          : 'Creator asked us to quote a rate first — set a price and send the offer.';
    } else if (r.negotiation_status === 'AWAITING_DECISION') {
      subtitleText = 'Offer sent — waiting on the creator to accept or counter.';
    } else if (r.negotiation_status === 'ACCEPTED') {
      // Until the brand POC's go-ahead is recorded (contract_approved) no
      // contract exists — it's approved & sent from the dashboard's Delegate.
      subtitleText =
        !r.contract_approved && !(r.contract && r.contract.status)
          ? 'Deal accepted — approve it in the dashboard Delegate window (after the brand POC go-ahead) to generate and send the contract.'
          : 'Deal accepted. The contract has been generated and sent for signing.';
    }
    if (subtitleText) {
      const sub = document.createElement('div');
      sub.className = 'subtitle';
      sub.textContent = subtitleText;
      rootEl.appendChild(sub);
    }

    // Timeline
    const log = Array.isArray(r.rate_log) ? r.rate_log : [];
    if (log.length) {
      const sec = document.createElement('div');
      sec.className = 'section';
      sec.innerHTML = '<div class="section-title">Activity</div>';
      const card = document.createElement('div');
      card.className = 'card';
      card.appendChild(renderTimeline(log));
      sec.appendChild(card);
      rootEl.appendChild(sec);
    }

    // Offer configurator
    if (configurable) {
      rootEl.appendChild(buildOfferConfigurator(r, load));
    }

    // AI hand-off reply (shown when the AI parked a question for a human)
    if (r.needs_human) {
      rootEl.appendChild(buildReplyBlock(r, load));
    }

    if (!configurable && !r.needs_human && !subtitleText) {
      const note = document.createElement('div');
      note.className = 'subtitle';
      note.textContent = 'Nothing to decide here right now — the activity above is the latest.';
      rootEl.appendChild(note);
    }
  }

  async function load() {
    renderState({ icon: '<div class="spinner"></div>', title: 'Loading offer…', body: '' });
    if (!apiBase) {
      renderState({
        title: 'Dashboard not connected',
        body: 'Open the extension popup and set your Deal Studio dashboard URL, then reopen this panel.',
      });
      return;
    }
    if (!creatorId && !initial.username) {
      renderState({ title: 'No creator', body: 'Open this panel from the dashboard’s “Decide offer” button, or visit a creator’s Instagram profile.' });
      return;
    }
    try {
      const r = await loadCreator();
      render(r);
    } catch (err) {
      if (/not found/i.test(err.message)) {
        renderState({
          title: 'Not in a campaign',
          body: `@${escapeHtml(initial.username || '')} isn’t a creator in your Deal Studio yet, or has no pending offer.`,
        });
      } else {
        renderState({ title: 'Couldn’t load', body: escapeHtml(err.message), retry: true });
      }
    }
  }

  // Reload when the host content script points the panel at a new creator
  // (e.g. SPA navigation to another profile) without recreating the iframe.
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || msg.type !== 'INF_PANEL_TARGET') return;
    if (msg.creatorId) { creatorId = String(msg.creatorId); initial.username = null; }
    else if (msg.username) { creatorId = null; initial.username = msg.username; initial.campaignId = msg.campaignId || null; }
    load();
  });

  load();
})();
