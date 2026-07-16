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
  async function api(path, options = {}) {
    if (!apiBase) throw new Error('Dashboard URL not set. Open the extension popup to set it.');
    const res = await fetch(apiBase + path, {
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

  function buildOfferConfigurator(r, onRefresh) {
    const root = document.createElement('div');

    const stats = r.ig_scraped_data && typeof r.ig_scraped_data === 'object' ? r.ig_scraped_data : {};
    const offers = Array.isArray(r.suggested_offers) ? r.suggested_offers : [];
    const viewOffer = offers.find((o) => o.offer_type === 'view_based');
    const seedCpm =
      Math.round(Number((viewOffer && viewOffer.cpm_applied) || (offers[0] && offers[0].cpm_applied) || 12)) || 12;
    const safeFloor0 = Math.round(Number(stats.min_views) || Number(stats.p50) || 25000);

    const priorOfferSent =
      Array.isArray(r.rate_log) && r.rate_log.some((e) => e && e.type === 'rate_offer_sent');
    const sent = r.negotiation_status === 'AWAITING_DECISION';

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
