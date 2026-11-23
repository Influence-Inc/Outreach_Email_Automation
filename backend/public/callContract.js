'use strict';

// "Create contract" — the contract for a deal agreed on a CALL.
//
// Every other contract path waits for the creator's "yes" in the email thread
// and writes the contract from that thread. A deal settled on a call has
// neither, so this form takes the terms the team agreed, and the server
// (services/callContract.js) writes the contract from exactly those, books the
// deal, and delivers the signing link the way the team picks here.
//
// Loaded after app.js and uses its globals: api, ensureInterventionModal,
// confirmDialog, refreshCreators, refreshCampaigns, closeInterventionModal,
// escapeHtml, fmtNum.

(function () {
  const SHAPES = [
    { id: 'video_based', label: 'Per video' },
    { id: 'view_based', label: 'Guaranteed views' },
    { id: 'video_bonus', label: 'Videos + views bonus' },
  ];
  // What a commission-only deal asks them to post. Any other pay model pays for
  // set videos, so these only show when "Commission" is picked.
  const MODES = [
    { id: 'fixed', label: 'Set videos' },
    { id: 'open', label: 'Open-ended' },
    { id: 'none', label: 'No deliverables' },
  ];
  const POLICY_HINT = {
    required: 'This campaign requires paid ad rights.',
    free_only: 'This campaign includes them by default.',
    no_rights: 'This campaign doesn’t ask for them.',
  };
  const PICKER_HINTS = {
    flat: 'A fixed fee for the deliverables below.',
    commission: 'No fee — a share of the sales they drive. The contract spells out the commission terms.',
    hybrid: 'An upfront fee plus a share of the sales they drive.',
    product: 'Product / gifting only, no cash. The contract says so.',
    commission_referral: 'No fee — a share of the campaign spend of each new brand they bring to the platform. The contract spells out the referral rules.',
    hybrid_referral: 'An upfront fee plus a share of the campaign spend of each new brand they bring to the platform.',
  };

  const esc = (s) => escapeHtml(s == null ? '' : String(s));
  const numOrNull = (v) => (v === '' || v == null ? null : Number(v));

  function handleOf(r) {
    return r.instagram_username ? `@${r.instagram_username}` : r.full_name || r.first_name || 'Creator';
  }

  window.openCallContractModal = async function openCallContractModal(r) {
    const m = ensureInterventionModal();
    m.bodyEl.innerHTML = '<div class="cc-loading hint">Loading…</div>';
    m.dialog.classList.remove('wide');
    m.dialog.classList.add('cc-modal');
    m.kicker.textContent = 'Create contract';
    m.subject.textContent = r.first_name ? `${handleOf(r)} · ${r.first_name}` : handleOf(r);
    m.subject.hidden = false;
    m.meta.textContent = 'For a deal agreed on a call';
    m.meta.hidden = false;
    m.show();

    let defaults;
    try {
      defaults = await api(`/api/creators/${r.id}/call-contract`);
    } catch (err) {
      m.bodyEl.innerHTML = `<div class="delegate-question">Couldn’t load this creator: ${esc(err.message)}</div>`;
      return;
    }
    m.bodyEl.innerHTML = '';
    if (defaults.blocked) {
      const note = document.createElement('div');
      note.className = 'delegate-question';
      note.textContent = defaults.blocked;
      m.bodyEl.appendChild(note);
      return;
    }
    m.bodyEl.appendChild(buildForm(r, defaults, m));
    m.bodyEl.scrollTop = 0;
  };

  function buildForm(r, d, m) {
    const form = document.createElement('div');
    form.className = 'cc-form';
    const uid = Math.random().toString(36).slice(2, 8);
    const platformChips = d.platformOptions
      .map(
        (p) => `<label class="cc-chip"><input type="checkbox" value="${esc(p)}" ${d.platforms.includes(p) ? 'checked' : ''}><span>${esc(p)}</span></label>`,
      )
      .join('');

    form.innerHTML = `
      <p class="cc-intro">Enter what you agreed on the call. The contract is written from exactly these terms — nothing is read from the email thread.</p>

      <section class="cc-section">
        <div class="cc-pay"></div>
      </section>

      <section class="cc-section">
        <div class="tp-label">Deliverables</div>
        <div class="cc-shape tp-models" role="radiogroup" aria-label="Deal shape">
          ${SHAPES.map((s) => `<button type="button" class="tp-model" role="radio" data-shape="${s.id}">${s.label}</button>`).join('')}
        </div>
        <div class="cc-mode tp-models" role="radiogroup" aria-label="What they post" hidden>
          ${MODES.map((x) => `<button type="button" class="tp-model" role="radio" data-mode="${x.id}">${x.label}</button>`).join('')}
        </div>
        <div class="cc-well">
          <div class="tp-row cc-if-open">
            <label class="tp-field tp-wide"><span class="tp-flabel">What they’ll do <span class="tp-opt">optional · shown as the Deliverables line</span></span>
              <input type="text" class="tp-input cc-note" maxlength="300" autocomplete="off"></label>
          </div>
          <div class="cc-none-note cc-sub cc-if-none"></div>
          <div class="tp-row cc-if-fixed">
            <label class="tp-field tp-narrow cc-if-videos"><span class="tp-flabel">Videos</span>
              <input type="number" min="1" max="50" class="tp-input cc-videos" inputmode="numeric"></label>
            <label class="tp-field cc-if-views"><span class="tp-flabel">Guaranteed total views</span>
              <input type="number" min="1000" step="1000" class="tp-input cc-views" inputmode="numeric" placeholder="e.g. 400000"></label>
            <label class="tp-field tp-narrow cc-if-views"><span class="tp-flabel">Min. videos <span class="tp-opt">optional</span></span>
              <input type="number" min="1" max="50" class="tp-input cc-min-videos" inputmode="numeric"></label>
            <label class="tp-field tp-narrow cc-if-bonus"><span class="tp-flabel">Bonus</span>
              <span class="tp-money"><span class="tp-affix">$</span><input type="number" min="1" step="50" class="tp-input cc-bonus" inputmode="decimal"></span></label>
            <label class="tp-field cc-if-bonus"><span class="tp-flabel">Unlocks at views</span>
              <input type="number" min="1000" step="1000" class="tp-input cc-bonus-views" inputmode="numeric" placeholder="e.g. 250000"></label>
            <label class="tp-field tp-narrow cc-if-window"><span class="tp-flabel">Views counted for</span>
              <span class="tp-money"><input type="number" min="1" max="365" class="tp-input cc-window" inputmode="numeric"><span class="tp-affix tp-affix-r">days</span></span></label>
          </div>
          <div class="tp-row cc-if-platforms">
            <div class="tp-field tp-wide"><span class="tp-flabel">Platforms <span class="tp-opt cc-if-open">optional · where they’ll promote</span></span>
              <div class="cc-chips">${platformChips}</div></div>
          </div>
          <div class="tp-row cc-if-platforms">
            <label class="tp-field tp-narrow cc-if-fixed"><span class="tp-flabel">Posting deadline</span>
              <input type="date" class="tp-input cc-deadline"></label>
            <div class="tp-field cc-shape-note"></div>
          </div>
        </div>
      </section>

      <section class="cc-section">
        <div class="tp-label">Terms</div>
        <div class="cc-well">
          <label class="cc-toggle cc-ads-row"><input type="checkbox" class="cc-ads">
            <span><b>Paid ad rights included</b> <span class="cc-sub">${esc(POLICY_HINT[d.usageRightsPolicy] || '')}</span></span></label>
          <label class="cc-toggle cc-upfront-row"><input type="checkbox" class="cc-upfront">
            <span><b>Part of the fee upfront</b> <span class="cc-sub cc-upfront-sub">Paid on the first video draft, the rest on completion.</span></span>
            <span class="tp-money cc-upfront-pct" hidden><input type="number" min="1" max="99" class="tp-input cc-pct" value="30" inputmode="numeric"><span class="tp-affix tp-affix-r">% upfront</span></span></label>
          <div class="tp-row">
            <label class="tp-field"><span class="tp-flabel">Exclusivity</span>
              <input type="text" class="tp-input cc-excl" maxlength="200" placeholder="None"></label>
          </div>
          <div class="tp-row">
            <label class="tp-field tp-wide"><span class="tp-flabel">Anything else agreed <span class="tp-opt">optional · one point per line — shown under Additional Terms</span></span>
              <textarea class="tp-input cc-extra io-scroll" rows="3" placeholder="e.g. One extra round of revisions&#10;Raw footage shared with each video"></textarea></label>
          </div>
        </div>
      </section>

      <section class="cc-section">
        <div class="tp-label">Send it</div>
        <div class="cc-well cc-delivery">
          <label class="cc-radio"><input type="radio" name="cc-del-${uid}" value="thread">
            <span><b>Reply in their email thread</b> <span class="cc-sub cc-thread-sub"></span></span></label>
          <label class="cc-radio"><input type="radio" name="cc-del-${uid}" value="email">
            <span><b>Email the signing link</b> <span class="cc-sub cc-email-sub"></span></span>
            <input type="email" class="tp-input cc-to" placeholder="creator@email.com" autocomplete="off" spellcheck="false"></label>
          <label class="cc-radio"><input type="radio" name="cc-del-${uid}" value="none">
            <span><b>Don’t send — I’ll share the link</b> <span class="cc-sub">e.g. you’re still messaging them</span></span></label>
          <label class="cc-toggle cc-stop" hidden><input type="checkbox" class="cc-stop-box" checked>
            <span><b>Stop their outreach follow-ups</b> <span class="cc-sub">They never replied by email, so Instantly is still sending them follow-ups.</span></span></label>
        </div>
      </section>

      <section class="cc-section">
        <label class="tp-field tp-wide"><span class="tp-flabel">Call notes <span class="tp-opt">optional · internal, not on the contract</span></span>
          <textarea class="tp-input cc-notes io-scroll" rows="2" maxlength="4000" placeholder="When you spoke, who was on the call, anything worth remembering"></textarea></label>
      </section>

      <div class="delegate-reply-foot cc-foot">
        <span class="delegate-status hint"></span>
        <button class="btn-primary cc-submit" type="button">Create &amp; send contract</button>
      </div>`;

    const q = (sel) => form.querySelector(sel);
    const els = {
      videos: q('.cc-videos'), views: q('.cc-views'), minVideos: q('.cc-min-videos'),
      bonus: q('.cc-bonus'), bonusViews: q('.cc-bonus-views'), window: q('.cc-window'),
      deadline: q('.cc-deadline'), ads: q('.cc-ads'), upfront: q('.cc-upfront'), pct: q('.cc-pct'),
      excl: q('.cc-excl'), extra: q('.cc-extra'), to: q('.cc-to'), notes: q('.cc-notes'), note: q('.cc-note'),
      stopRow: q('.cc-stop'), stopBox: q('.cc-stop-box'), status: q('.delegate-status'), submit: q('.cc-submit'),
    };

    const picker = window.EmailComposer.createTermsPicker({
      allowNone: false,
      label: 'How they’re paid',
      hints: PICKER_HINTS,
      initial: d.terms || null,
    });
    q('.cc-pay').appendChild(picker.el);

    // Initial values from the server's defaults (the deal on the table, the
    // campaign's usage-rights policy, three weeks out).
    let shape = d.shape;
    let mode = d.deliverablesMode || 'fixed';
    els.note.value = d.deliverablesNote || '';
    els.videos.value = d.numberOfVideos || 1;
    if (d.minTotalViews) els.views.value = d.minTotalViews;
    if (d.minVideos) els.minVideos.value = d.minVideos;
    if (d.bonusAmount) els.bonus.value = d.bonusAmount;
    if (d.bonusThresholdViews) els.bonusViews.value = d.bonusThresholdViews;
    els.window.value = d.viewCountingDays || 30;
    els.deadline.value = d.postingDeadline;
    els.deadline.min = new Date().toISOString().slice(0, 10);
    els.ads.checked = !!d.paidAdsIncluded;
    els.to.value = (d.creator && d.creator.email) || '';

    // Delivery options: the thread only when there is one to reply in.
    const radios = [...form.querySelectorAll('.cc-radio input[type=radio]')];
    const radio = (v) => radios.find((x) => x.value === v);
    const threadSub = q('.cc-thread-sub');
    if (d.delivery.thread) {
      threadSub.textContent = 'Keeps it in the conversation you already have.';
    } else {
      radio('thread').disabled = true;
      radio('thread').closest('.cc-radio').classList.add('is-disabled');
      threadSub.textContent = 'Not available — they haven’t replied to us by email.';
    }
    q('.cc-email-sub').textContent = d.delivery.emailConfigured
      ? 'From contracts@, mentioning your call.'
      : 'Not set up on this server (RESEND_API_KEY) — use another option.';
    if (!d.delivery.emailConfigured) {
      radio('email').disabled = true;
      radio('email').closest('.cc-radio').classList.add('is-disabled');
    }
    const startMethod = radio(d.delivery.defaultMethod) && !radio(d.delivery.defaultMethod).disabled
      ? d.delivery.defaultMethod
      : 'none';
    radio(startMethod).checked = true;

    const method = () => (radios.find((x) => x.checked) || {}).value || 'none';
    const isFlat = () => picker.getModel() === 'flat';
    // Only a commission-only deal can be open-ended or have no deliverables:
    // a fee or product pays for set videos.
    const isCommissionOnly = () => picker.getModel() === 'commission';
    const isReferral = () => {
      const t = picker.read().terms;
      return !!(t && t.commission && t.commission.basis === 'referral');
    };
    const effectiveMode = () => (isCommissionOnly() ? mode : 'fixed');

    function render() {
      // Guaranteed-views and bonus deals are priced on a cash fee, so any
      // other pay model is a plain per-video deal.
      if (!isFlat()) shape = 'video_based';
      const md = effectiveMode();
      // A commission-only deal picks what they post (set videos / open-ended /
      // none) instead of a deal shape — the other shapes need a cash fee.
      q('.cc-shape').hidden = isCommissionOnly();
      q('.cc-mode').hidden = !isCommissionOnly();
      form.querySelectorAll('.cc-shape .tp-model').forEach((b) => {
        const on = b.dataset.shape === shape;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        b.disabled = !isFlat() && b.dataset.shape !== 'video_based';
      });
      form.querySelectorAll('.cc-mode .tp-model').forEach((b) => {
        const on = b.dataset.mode === md;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      });
      const show = (cls, on) => form.querySelectorAll(cls).forEach((el) => { el.hidden = !on; });
      show('.cc-if-fixed', md === 'fixed');
      show('.cc-if-open', md === 'open');
      show('.cc-if-none', md === 'none');
      show('.cc-if-platforms', md !== 'none');
      show('.cc-if-videos', md === 'fixed' && shape !== 'view_based');
      show('.cc-if-views', md === 'fixed' && shape === 'view_based');
      show('.cc-if-bonus', md === 'fixed' && shape === 'video_bonus');
      show('.cc-if-window', md === 'fixed' && shape !== 'video_based');
      els.note.placeholder = isReferral()
        ? 'e.g. Referral link in bio, plus a mention in stories when it fits'
        : 'e.g. Link in bio, plus a mention in stories when it fits';
      q('.cc-none-note').textContent = isReferral()
        ? 'Nothing to post. They earn on the brands they refer alone — the contract says so, with no deadline and no content rights.'
        : 'Nothing to post. They earn on the sales they drive alone — the contract says so, with no deadline and no content rights.';
      q('.cc-shape-note').textContent = md === 'open'
        ? 'No minimum number of posts and no deadline — the contract says so.'
        : shape === 'video_bonus'
          ? 'The fee above is the guaranteed base; the bonus is paid on top.'
          : shape === 'view_based'
            ? 'They post as many videos as it takes to reach the total.'
            : '';
      // No deliverables: no content, so no ad rights to grant over it.
      q('.cc-ads-row').hidden = md === 'none';

      const model = picker.getModel();
      const hasFee = model === 'flat' || model === 'hybrid';
      q('.cc-upfront-row').hidden = !hasFee;
      if (!hasFee) els.upfront.checked = false;
      q('.cc-upfront-pct').hidden = !els.upfront.checked;
      q('.cc-upfront-sub').hidden = els.upfront.checked;

      const m = method();
      els.to.hidden = m !== 'email';
      els.stopRow.hidden = !d.outreachInFlight;
      els.submit.textContent = m === 'none' ? 'Create contract' : 'Create & send contract';
    }

    form.querySelectorAll('.cc-mode .tp-model').forEach((b) => {
      b.addEventListener('click', () => {
        mode = b.dataset.mode;
        render();
        if (mode === 'open' && !els.note.value) els.note.focus();
        else if (mode === 'fixed' && !els.videos.value) els.videos.focus();
      });
    });
    form.querySelectorAll('.cc-shape .tp-model').forEach((b) => {
      b.addEventListener('click', () => {
        if (b.disabled) return;
        shape = b.dataset.shape;
        render();
        const first = { video_based: els.videos, view_based: els.views, video_bonus: els.bonus }[shape];
        if (first && !first.value) first.focus();
      });
    });
    picker.onChange(render);
    form.addEventListener('change', render);
    form.addEventListener('input', (ev) => { if (ev.target !== els.notes && ev.target !== els.extra) els.status.textContent = ''; });
    render();

    // ── Read + validate (the server re-validates and is authoritative) ──────
    function fail(message, el) {
      els.status.textContent = message;
      if (el) el.focus();
      return null;
    }
    function read() {
      const pay = picker.read();
      if (pay.error) return fail(pay.error, pay.el);
      const md = effectiveMode();
      const body = {
        terms: pay.terms,
        shape,
        deliverablesMode: md,
        platforms: md === 'none' ? [] : [...form.querySelectorAll('.cc-chips input:checked')].map((x) => x.value),
        postingDeadline: md === 'fixed' ? els.deadline.value : null,
        paidAdsIncluded: md !== 'none' && els.ads.checked,
        upfrontPayment: els.upfront.checked,
        upfrontPercent: numOrNull(els.pct.value),
        exclusivity: els.excl.value.trim(),
        manualTerms: els.extra.value,
        callNotes: els.notes.value.trim(),
        delivery: { method: method(), to: els.to.value.trim() },
        stopOutreach: d.outreachInFlight && els.stopBox.checked,
      };
      if (md === 'open') body.deliverablesNote = els.note.value.trim();
      if (md !== 'fixed') {
        // Open-ended / none: no count, views or deadline to check.
      } else if (shape === 'view_based') {
        body.minTotalViews = numOrNull(els.views.value);
        body.minVideos = numOrNull(els.minVideos.value);
        if (!body.minTotalViews) return fail('Enter the guaranteed total views.', els.views);
      } else {
        body.numberOfVideos = numOrNull(els.videos.value);
        if (!body.numberOfVideos || body.numberOfVideos < 1) return fail('Enter the number of videos.', els.videos);
      }
      if (md === 'fixed' && shape === 'video_bonus') {
        body.bonusAmount = numOrNull(els.bonus.value);
        body.bonusThresholdViews = numOrNull(els.bonusViews.value);
        if (!body.bonusAmount) return fail('Enter the bonus amount.', els.bonus);
        if (!body.bonusThresholdViews) return fail('Enter the views that unlock the bonus.', els.bonusViews);
      }
      if (md === 'fixed' && shape !== 'video_based') body.viewCountingDays = numOrNull(els.window.value);
      if (md === 'fixed' && !body.platforms.length) return fail('Pick at least one platform.', form.querySelector('.cc-chips input'));
      if (md === 'fixed' && !body.postingDeadline) return fail('Pick the posting deadline.', els.deadline);
      if (body.delivery.method === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.delivery.to)) {
        return fail('Enter the email address to send it to.', els.to);
      }
      return body;
    }

    // One line naming the deal, for the confirm dialog.
    function dealLine(b) {
      const pay = window.EmailComposer.describeTerms(b.terms);
      const what = b.deliverablesMode === 'open'
        ? 'open-ended content'
        : b.deliverablesMode === 'none'
          ? 'no deliverables'
          : b.shape === 'view_based'
            ? `${fmtNum(b.minTotalViews)} guaranteed views`
            : `${b.numberOfVideos} video${b.numberOfVideos === 1 ? '' : 's'}`;
      const bonus = b.shape === 'video_bonus' ? ` + $${fmtNum(b.bonusAmount)} bonus` : '';
      return `${pay}${bonus} · ${what}`;
    }

    els.submit.onclick = async () => {
      if (els.submit.dataset.busy === '1') return;
      const body = read();
      if (!body) return;
      const where = {
        thread: 'sent as a reply in their email thread',
        email: `emailed to ${body.delivery.to}`,
        none: 'ready for you to share — nothing is sent',
      }[body.delivery.method];
      // Busy from the first click, so a second click can't stack a second
      // confirmation (and a second create) behind the first.
      els.submit.dataset.busy = '1';
      const ok = await confirmDialog({
        title: `Create the contract — ${dealLine(body)}?`,
        message: `The deal is booked as agreed and the signing link is ${where}. Only do this once the brand POC has given the go-ahead.`,
        confirmLabel: body.delivery.method === 'none' ? 'Create contract' : 'Create & send',
      });
      if (!ok) { els.submit.dataset.busy = ''; return; }
      els.submit.disabled = true;
      picker.setDisabled(true);
      els.status.textContent = 'Creating contract…';
      try {
        const res = await api(`/api/creators/${r.id}/call-contract`, { method: 'POST', body: JSON.stringify(body) });
        m.bodyEl.innerHTML = '';
        m.bodyEl.appendChild(buildDone(res));
        m.bodyEl.scrollTop = 0;
        // Refresh behind the pop-up so the row shows its contract right away.
        Promise.all([refreshCreators(), refreshCampaigns()]).catch(() => {});
      } catch (err) {
        els.status.textContent = `Couldn’t create it: ${err.message}`;
        els.submit.disabled = false;
        els.submit.dataset.busy = '';
        picker.setDisabled(false);
      }
    };
    return form;
  }

  // The result: what happened to the link, plus the link itself — always, so a
  // send that failed (or "I'll share it") leaves the team one click from it.
  function buildDone(res) {
    const wrap = document.createElement('div');
    wrap.className = 'cc-done';
    const dl = res.delivery || {};
    let headline;
    let tone = 'ok';
    if (dl.sent && dl.method === 'thread') headline = 'Contract created and sent in their email thread.';
    else if (dl.sent && dl.method === 'email') headline = `Contract created and emailed to ${dl.to}.`;
    else if (dl.method === 'none') headline = 'Contract created. Share the signing link below with the creator.';
    else {
      tone = 'warn';
      headline = `Contract created, but it couldn’t be sent: ${dl.error || 'unknown error'}. Share the link below instead.`;
    }
    const outreach = res.outreach;
    let outreachNote = '';
    if (outreach && outreach.stopped) outreachNote = 'Their Instantly follow-ups have been stopped.';
    else if (outreach && outreach.error) outreachNote = outreach.error;

    wrap.innerHTML = `
      <div class="cc-done-head ${tone}">
        <span class="cc-done-icon" aria-hidden="true">${tone === 'ok' ? '✓' : '!'}</span>
        <div>${esc(headline)}</div>
      </div>
      ${outreachNote ? `<div class="cc-sub cc-done-note">${esc(outreachNote)}</div>` : ''}
      <label class="tp-field tp-wide"><span class="tp-flabel">Signing link</span>
        <div class="cc-link-row">
          <input type="text" class="tp-input cc-link" readonly value="${esc(res.url)}">
          <button type="button" class="ghost small cc-copy">Copy link</button>
          <a class="ghost small cc-open" href="${esc(res.url)}" target="_blank" rel="noopener">Open</a>
        </div></label>
      <div class="cc-sub">The terms can still be adjusted from the Deals column until the creator signs — the link stays the same.</div>
      <div class="delegate-reply-foot"><button type="button" class="btn-primary cc-close">Done</button></div>`;
    const copy = wrap.querySelector('.cc-copy');
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(res.url);
        copy.textContent = 'Copied ✓';
        setTimeout(() => { copy.textContent = 'Copy link'; }, 1400);
      } catch {
        wrap.querySelector('.cc-link').select();
      }
    };
    wrap.querySelector('.cc-link').addEventListener('focus', (ev) => ev.target.select());
    wrap.querySelector('.cc-close').onclick = () => closeInterventionModal();
    return wrap;
  }
})();
