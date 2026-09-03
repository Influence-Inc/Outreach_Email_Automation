'use strict';

// Offer-portal client. Vanilla-JS port of the Influence-CDB-portal OfferView
// component: fetches the offer, renders the accept / decline / counter states,
// and posts responses back to /api/offers/:token/{respond,counter}.

(function () {
  var CARD = document.getElementById('card');
  var token = decodeURIComponent((location.pathname.split('/').filter(Boolean).pop() || ''));

  var DECLINE_REASONS = ['Budget', 'Timing', 'Not a fit'];

  var offer = null; // { token, firstName, brandName, deliverables, rate, currency, rateFormatted, expiresFormatted }
  var view = 'loading'; // loading | active | options | platforms | contract | signed | declined | expired | too_high | on_hold | notfound
  // Platform picker state — the required + optional tokens the server hands us,
  // and the creator's tick-marks. Instagram is always locked on (Reels drive
  // the deal); tapping Continue POSTs the selection then reveals the contract.
  var platformOptions = { required: ['Instagram'], optional: ['TikTok', 'YouTube Shorts'] };
  var selectedPlatforms = {}; // { Instagram: true, TikTok: false, ... }
  var mode = 'cta'; // cta | reasons | budget | schedule
  var countered = false;
  var options = null; // the two typed counter deals (view-based + video-based) to choose between
  var addedLabel = null;
  var rescheduledDate = null; // set when a "Timing" re-offer switched us to a fresh offer on the creator's dates
  var holdDateFormatted = null; // the date shown on the on-hold "we'll be in touch" view
  var scheduleInput = ''; // the date the creator typed in the schedule step
  var tooHighRequested = null;
  var declinedReason = null; // remembered so the declined view can tailor its copy
  var submitting = false;
  var error = null;
  var rateInput = '';
  var signatureDataUrl = null; // the creator's drawn signature (data:image/png URL)
  var sigPad = null; // the active signature-pad controller (see initSigPad)
  var signBtnRef = null; // the "Sign & agree" button, toggled as the pad fills
  var legallyBindingAcked = false; // creator ticked "I understand this is legally binding"

  // Tiny DOM helper. h('div', {class:'x', onclick:fn}, child, child…)
  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        if (k === 'class') el.className = props[k];
        else if (k === 'html') el.innerHTML = props[k];
        else if (k.slice(0, 2) === 'on' && typeof props[k] === 'function') {
          el.addEventListener(k.slice(2).toLowerCase(), props[k]);
        } else if (props[k] != null) el.setAttribute(k, props[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null || c === false) continue;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  }

  function btn(label, opts) {
    opts = opts || {};
    var b = h('button', {
      class: 'btn ' + (opts.variant === 'outline' ? 'btn-outline' : 'btn-primary') + (opts.sm ? ' btn-sm' : ''),
      type: 'button',
      onclick: opts.onClick,
    }, label);
    if (submitting || opts.disabled) b.disabled = true;
    return b;
  }

  function errNode() {
    return error ? h('div', { class: 'err' }, error) : null;
  }

  function centered(iconClass, icon, title, body) {
    return h('div', { class: 'state fade' },
      icon ? h('div', { class: 'ic ' + iconClass }, icon) : null,
      h('h1', {}, title),
      h('p', {}, body));
  }

  // Drawn signature pad — the same click-and-sign interaction as the full
  // contract's signature tab (ported from contract.js). onChange fires after
  // each stroke / clear so the caller can capture the image + toggle the button.
  function initSigPad(canvas, onChange) {
    var ctx = canvas.getContext('2d');
    var dirty = false;
    function resize() {
      var dpr = Math.max(1, window.devicePixelRatio || 1);
      var box = canvas.getBoundingClientRect();
      var w = Math.floor(box.width * dpr);
      var hgt = Math.floor(box.height * dpr);
      if (w === 0 || hgt === 0) return;
      if (canvas.width === w && canvas.height === hgt) return;
      var snapshot = dirty ? canvas.toDataURL('image/png') : null;
      canvas.width = w;
      canvas.height = hgt;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.strokeStyle = '#101010';
      if (snapshot) {
        var img = new Image();
        img.onload = function () { ctx.drawImage(img, 0, 0, box.width, box.height); };
        img.src = snapshot;
      }
    }
    window.addEventListener('resize', resize);
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resize).observe(canvas);
    resize();

    var drawing = false, lastP = null;
    function pos(e) {
      var box = canvas.getBoundingClientRect();
      var p = e.touches ? e.touches[0] : e;
      return { x: p.clientX - box.left, y: p.clientY - box.top };
    }
    function start(e) { drawing = true; lastP = pos(e); e.preventDefault(); }
    function move(e) {
      if (!drawing) return;
      var p = pos(e);
      ctx.beginPath(); ctx.moveTo(lastP.x, lastP.y); ctx.lineTo(p.x, p.y); ctx.stroke();
      lastP = p; dirty = true; e.preventDefault();
    }
    function end() { if (!drawing) return; drawing = false; lastP = null; if (onChange) onChange(); }
    canvas.addEventListener('mousedown', start);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', end);
    canvas.addEventListener('touchstart', start, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    canvas.addEventListener('touchend', end);

    return {
      isEmpty: function () { return !dirty; },
      clear: function () { ctx.clearRect(0, 0, canvas.width, canvas.height); dirty = false; if (onChange) onChange(); },
      toDataUrl: function () { return dirty ? canvas.toDataURL('image/png') : null; },
      load: function (dataUrl) {
        if (!dataUrl) return;
        var img = new Image();
        img.onload = function () {
          var box = canvas.getBoundingClientRect();
          ctx.drawImage(img, 0, 0, box.width, box.height);
          dirty = true;
        };
        img.src = dataUrl;
      },
    };
  }

  // Wire the signature pad to the canvas the contract view just rendered, and
  // repaint any signature already drawn (so an error re-render never loses it).
  function mountSigPad() {
    var canvas = CARD.querySelector('canvas.sig');
    if (!canvas) { sigPad = null; return; }
    sigPad = initSigPad(canvas, function () {
      signatureDataUrl = sigPad.toDataUrl();
      if (signBtnRef) signBtnRef.disabled = submitting || !signatureDataUrl || !legallyBindingAcked;
    });
    if (signatureDataUrl) sigPad.load(signatureDataUrl);
  }

  function render() {
    CARD.innerHTML = '';
    var root;

    if (view === 'loading') {
      root = h('div', { class: 'state' }, h('div', { class: 'spinner' }));
    } else if (view === 'notfound') {
      root = centered('neutral', '', 'Offer not found',
        "This offer link isn't valid. Please check the link, or contact your INFLUENCE point of contact.");
    } else if (view === 'accepted') {
      root = centered('ok', '✓', 'Offer accepted',
        'Thanks, ' + offer.firstName + '. We are looking forward to working with you on ' + offer.brandName +
        '. Our team will reach out shortly with the next steps.');
    } else if (view === 'declined') {
      root = renderDeclined();
    } else if (view === 'expired') {
      root = centered('neutral', '⏳', 'This offer has expired',
        'Sorry, ' + offer.firstName + ' — this offer is no longer available. If you are still interested, reply to your INFLUENCE contact and we will sort it out.');
    } else if (view === 'options') {
      root = renderOptions();
    } else if (view === 'too_high') {
      root = renderTooHigh();
    } else if (view === 'on_hold') {
      root = renderOnHold();
    } else if (view === 'platforms') {
      root = renderPlatforms();
    } else if (view === 'contract') {
      root = renderContract();
    } else if (view === 'signed') {
      root = renderSigned();
    } else {
      root = renderActive();
    }
    CARD.appendChild(root);
    // The signature canvas must be initialised after it's attached to the DOM.
    if (view === 'contract') mountSigPad();
  }

  function renderActive() {
    var wrap = h('div', { class: 'fade' });

    if (countered) {
      var noteMsg;
      if (rescheduledDate) {
        noteMsg = "Great — we've set this to start around " + rescheduledDate + '. Have another look.';
      } else if (addedLabel) {
        noteMsg = "Good news — we've added " + addedLabel + ' and matched your rate. Have another look.';
      } else {
        noteMsg = "Good news — we've updated the offer to match your rate. Have another look.";
      }
      wrap.appendChild(h('div', { class: 'note' }, h('span', { class: 'spark' }, '✨'), h('span', {}, noteMsg)));
    }

    wrap.appendChild(h('div', { class: 'eyebrow' }, h('span', { class: 'dot' }), 'New collaboration'));
    wrap.appendChild(h('h1', { class: 'brand' }, offer.brandName));
    wrap.appendChild(h('p', { class: 'lede' },
      'Hi ' + offer.firstName + ' — based on your previous work with us, we think this one is a great fit.'));

    // Terms
    var pills = h('div', { class: 'pill-list' });
    (offer.deliverables || []).forEach(function (d) { pills.appendChild(h('span', { class: 'pill' }, d)); });
    // "Respond by" is shown ONLY on the outreach message + email (see
    // offerPortal/whatsapp.js:renderOfferOutreachBody and offerPortal/email.js's
    // "It's open until …" copy). Keeping it off the portal too avoids double-
    // messaging a hard deadline once the creator's already sitting on the page.
    var terms = h('div', { class: 'terms' },
      h('div', { class: 'label' }, 'Deliverables'),
      pills,
      h('div', { class: 'terms-foot' },
        h('div', {}, h('div', { class: 'rate-cap' }, 'Your rate'), h('div', { class: 'rate num' }, offer.rateFormatted))));
    wrap.appendChild(terms);

    if (mode === 'cta') {
      wrap.appendChild(h('div', { class: 'btns' },
        btn('Accept offer', { onClick: function () { respond('accepted'); } }),
        btn('Decline', { variant: 'outline', onClick: function () { error = null; mode = 'reasons'; render(); } })));
    } else if (mode === 'reasons') {
      var chips = h('div', { class: 'chip-row' });
      DECLINE_REASONS.forEach(function (reason) {
        chips.appendChild(btn(reason, {
          variant: 'outline', sm: true,
          onClick: function () {
            error = null;
            if (reason === 'Budget') { mode = 'budget'; render(); }
            else if (reason === 'Timing') { mode = 'schedule'; render(); }
            else respond('declined', reason);
          },
        }));
      });
      chips.appendChild(btn('Prefer not to say', { variant: 'outline', sm: true, onClick: function () { respond('declined'); } }));
      wrap.appendChild(h('div', { class: 'btns' },
        h('p', { class: 'ask-sub' }, 'Mind sharing why? (optional)'),
        chips,
        h('button', { class: 'linkbtn', type: 'button', onclick: function () { mode = 'cta'; render(); } }, '← Back')));
    } else if (mode === 'schedule') {
      var dateInput = h('input', {
        type: 'date', value: scheduleInput,
        oninput: function (e) { scheduleInput = e.target.value; },
        onkeydown: function (e) { if (e.key === 'Enter') proposeSchedule(); },
      });
      wrap.appendChild(h('div', {},
        h('p', { class: 'ask' }, 'When are you free to start?'),
        h('p', { class: 'ask-sub' }, "Pick the date you could begin, and we'll fit the offer around it."),
        h('div', { class: 'rate-input' },
          h('div', { class: 'box' }, dateInput),
          btn(submitting ? '…' : 'Send', { onClick: proposeSchedule })),
        h('button', { class: 'linkbtn', type: 'button', onclick: function () { scheduleInput = ''; mode = 'reasons'; render(); } }, '← Back')));
    } else {
      var input = h('input', {
        type: 'number', min: '1', inputmode: 'numeric', placeholder: 'Your rate', value: rateInput,
        oninput: function (e) { rateInput = e.target.value; },
        onkeydown: function (e) { if (e.key === 'Enter') proposeRate(); },
      });
      wrap.appendChild(h('div', {},
        h('p', { class: 'ask' }, 'What rate would work for you?'),
        h('p', { class: 'ask-sub' }, 'Current offer: ' + offer.rateFormatted + ". Propose a number and we'll see what we can do."),
        h('div', { class: 'rate-input' },
          h('div', { class: 'box' }, h('span', { class: 'cur' }, offer.currency), input),
          btn(submitting ? '…' : 'Send', { onClick: proposeRate })),
        h('button', { class: 'linkbtn', type: 'button', onclick: function () { rateInput = ''; mode = 'reasons'; render(); } }, '← Back')));
    }

    var e = errNode();
    if (e) wrap.appendChild(e);
    return wrap;
  }

  // Two typed counter deals — a view-based and a video-based shape, both paying
  // the creator's requested rate (we size the guarantee / video count so our CPM
  // holds). They pick the one they prefer and it locks on tap, exactly like
  // accepting any offer. "No thanks" declines the whole set (siblings expire).
  function renderOptions() {
    var wrap = h('div', { class: 'fade' });
    wrap.appendChild(h('div', { class: 'note' }, h('span', { class: 'spark' }, '✨'),
      h('span', {}, "Good news — we can do " + (offer.rateFormatted || 'your rate') +
        '. Pick the deal that works best for you.')));
    wrap.appendChild(h('div', { class: 'eyebrow' }, h('span', { class: 'dot' }), 'Choose your deal'));
    wrap.appendChild(h('h1', { class: 'brand' }, offer.brandName));

    var grid = h('div', { class: 'opt-grid' });
    (options || []).forEach(function (opt) {
      var pills = h('div', { class: 'pill-list' });
      (opt.deliverables || []).forEach(function (d) { pills.appendChild(h('span', { class: 'pill' }, d)); });
      var sub = opt.dealType === 'view_based'
        ? 'We guarantee the views — however many Reels it takes.'
        : 'A set number of Reels at your rate.';
      grid.appendChild(h('div', { class: 'opt-card' },
        h('div', { class: 'opt-type' }, opt.label),
        h('p', { class: 'opt-sub' }, sub),
        pills,
        h('div', { class: 'opt-rate' },
          h('div', { class: 'rate-cap' }, 'Your rate'),
          h('div', { class: 'rate num' }, opt.rateFormatted)),
        btn('Choose this deal', { onClick: function () { acceptOption(opt); } })));
    });
    wrap.appendChild(grid);

    // Respond-by intentionally omitted here — same rule as the active view.
    wrap.appendChild(h('div', { class: 'btns' },
      h('button', { class: 'linkbtn center-link', type: 'button', onclick: function () { respond('declined', 'Budget'); } },
        'None of these work — decline')));

    var e = errNode();
    if (e) wrap.appendChild(e);
    return wrap;
  }

  // Lock the chosen deal: swap the live offer to that child's terms + token, then
  // accept it exactly like any offer. The backend expires the sibling on accept.
  function acceptOption(opt) {
    offer = {
      token: opt.token, firstName: offer.firstName, brandName: opt.brandName,
      deliverables: opt.deliverables, rate: opt.rate, currency: opt.currency,
      rateFormatted: opt.rateFormatted, expiresFormatted: opt.expiresFormatted,
    };
    respond('accepted');
  }

  // Decline confirmation — "Not a fit" gets a warmer, forward-looking close
  // (mirrors notAFitCloseMessage on the backend); anything else is the neutral
  // "we'll keep you in mind" message.
  function renderDeclined() {
    if (declinedReason === 'Not a fit') {
      return centered('', '', 'Thanks for the honesty',
        'No worries at all, ' + offer.firstName + ". This one may not be the right match — but we'll reach out when we've got a campaign that's a better fit for you.");
    }
    return centered('', '', 'Thanks for letting us know',
      'No problem at all, ' + offer.firstName + '. We will keep you in mind for future opportunities. Have a great day.');
  }

  // On hold — the creator's availability is further out than we can auto-fit, so
  // an admin will follow up with a schedule that works (their deal isn't closed).
  function renderOnHold() {
    return centered('neutral', '🗓️', 'Thanks — we\'ll be in touch',
      'Got it, ' + offer.firstName + (holdDateFormatted ? ' — noted that you\'re free from ' + holdDateFormatted + '.' : '.') +
      ' That\'s a little further out than this brief\'s window, so your INFLUENCE contact will follow up shortly with a schedule that works for you.');
  }

  // "Too high" — the counter-ask is above the ceiling. We DON'T take the ask,
  // but the most recent offer stays live, so the primary action is going back to
  // it (Accept). They can also re-propose a lower rate, or decline outright.
  function renderTooHigh() {
    return h('div', { class: 'fade' },
      h('div', { class: 'state', style: 'padding:18px 6px 20px' },
        h('h1', {}, "We can't match that one"),
        h('p', {}, 'Thanks for the proposal, ' + offer.firstName + ". We can't stretch to " +
          (tooHighRequested || 'that rate') + ' on this brief — but your current offer of ' +
          offer.rateFormatted + " still stands if you'd like to go ahead.")),
      h('div', { class: 'btns' },
        btn('← Go back to ' + offer.rateFormatted + ' offer', { onClick: function () { respond('accepted'); } }),
        btn('Propose a different rate', { variant: 'outline', onClick: function () { error = null; mode = 'budget'; view = 'active'; render(); } }),
        h('button', { class: 'linkbtn center-link', type: 'button', onclick: function () { respond('declined', 'Budget'); } }, 'No thanks, decline')),
      errNode());
  }

  // --- Platform picker (shown after acceptance, before the contract) --------
  // Instagram is required (the deal is Reels-first); TikTok + YouTube Shorts
  // are opt-in cross-posts. The picker is a checkbox row: Instagram is checked
  // and disabled, the optional ones toggle. Continue → POST /platforms →
  // view = 'contract'.
  function platformRow(name, opts) {
    opts = opts || {};
    var box = h('input', {
      type: 'checkbox',
      id: 'plat-' + name.toLowerCase().replace(/\s+/g, '-'),
      onchange: function (e) {
        if (opts.locked) { e.target.checked = true; return; }
        selectedPlatforms[name] = e.target.checked;
      },
    });
    if (selectedPlatforms[name] || opts.locked) box.checked = true;
    if (opts.locked) box.disabled = true;
    var label = h('label', { class: 'plat-row' + (opts.locked ? ' plat-locked' : ''), for: box.id },
      box,
      h('span', { class: 'plat-name' }, name),
      opts.locked ? h('span', { class: 'plat-tag' }, 'Required') : null);
    return label;
  }

  function renderPlatforms() {
    var wrap = h('div', { class: 'fade' });
    wrap.appendChild(h('div', { class: 'eyebrow' }, h('span', { class: 'dot' }), 'One quick step'));
    wrap.appendChild(h('h1', { class: 'brand' }, 'Where will you post?'));
    wrap.appendChild(h('p', { class: 'lede' },
      'Thanks, ' + offer.firstName + '. Pick the platforms you\'ll post this on. ' +
      'Instagram is included by default — TikTok and YouTube Shorts are optional cross-posts.'));

    var list = h('div', { class: 'plat-list' });
    (platformOptions.required || []).forEach(function (name) { list.appendChild(platformRow(name, { locked: true })); });
    (platformOptions.optional || []).forEach(function (name) { list.appendChild(platformRow(name)); });
    wrap.appendChild(list);

    wrap.appendChild(h('div', { class: 'btns' },
      btn(submitting ? '…' : 'Continue', { onClick: savePlatforms })));

    var e = errNode();
    if (e) wrap.appendChild(e);
    return wrap;
  }

  async function savePlatforms() {
    var chosen = (platformOptions.required || []).slice();
    (platformOptions.optional || []).forEach(function (name) {
      if (selectedPlatforms[name]) chosen.push(name);
    });
    setSubmitting(true);
    error = null;
    try {
      var res = await fetch('/api/offers/' + encodeURIComponent(offer.token) + '/platforms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platforms: chosen }),
      });
      var data = await res.json();
      if (data.ok) {
        // The contract on the loaded `offer` was assembled with the OLD (or
        // default) platforms; refresh it so the terms match what they picked
        // before they see the mini-contract preview.
        try {
          var refreshed = await fetch('/api/offers/' + encodeURIComponent(offer.token)).then(function (r) { return r.json(); });
          if (refreshed && refreshed.contract) offer.contract = refreshed.contract;
        } catch (_) { /* keep going — the snapshot on sign uses the server-side value regardless */ }
        view = 'contract';
      } else if (data.reason === 'already_signed') { return location.reload(); }
      else if (data.reason === 'not_accepted') { error = 'Please accept the offer first.'; }
      else { error = 'Something went wrong. Please try again.'; }
    } catch (e) {
      error = 'Network error. Please try again.';
    } finally {
      submitting = false;
      render();
    }
  }

  // --- Mini contract (shown after acceptance) --------------------------------
  function contractRow(label, value) {
    return h('div', { class: 'crow' },
      h('span', { class: 'crow-l' }, label),
      h('span', { class: 'crow-v' }, value || '—'));
  }
  function contractPills(label, arr) {
    var pills = h('div', { class: 'pill-list' });
    (arr || []).forEach(function (x) { pills.appendChild(h('span', { class: 'pill' }, x)); });
    return h('div', { class: 'crow crow-pills' }, h('span', { class: 'crow-l' }, label), pills);
  }
  function contractTermsBlock(c) {
    var box = h('div', { class: 'terms' });
    box.appendChild(contractRow('Creator', c.creatorName));
    box.appendChild(contractRow('Brand', c.brandName));
    if (c.campaignName) box.appendChild(contractRow('Campaign', c.campaignName));
    box.appendChild(contractPills('Deliverables', c.deliverables));
    box.appendChild(contractPills('Platforms', c.platforms));
    // Prefer the accurate calendar deadline the admin set on the campaign; only
    // fall back to the free-text `timeline` for legacy contracts (or campaigns
    // where the admin hasn't set a date yet).
    box.appendChild(contractRow('Deadline', c.deadline || c.timeline));
    return box;
  }

  function renderContract() {
    var c = offer.contract || {};
    var wrap = h('div', { class: 'fade' });
    wrap.appendChild(h('div', { class: 'eyebrow' }, h('span', { class: 'dot' }), 'Agreement'));
    wrap.appendChild(h('h1', { class: 'brand' }, 'Collaboration agreement'));
    wrap.appendChild(h('p', { class: 'lede' }, 'Please review the details below and sign to confirm.'));
    wrap.appendChild(contractTermsBlock(c));

    // Draw-on-screen signature (replaces the old typed-name signature) — the
    // same click-and-sign experience as the full contract. The pad itself is
    // wired up in mountSigPad() once this canvas is attached to the DOM.
    var canvas = h('canvas', { class: 'sig', width: '1200', height: '300' });
    var clearBtn = h('button', {
      type: 'button',
      onclick: function () {
        if (sigPad) sigPad.clear();
        signatureDataUrl = null;
        if (signBtnRef) signBtnRef.disabled = true;
      },
    }, 'Clear');
    signBtnRef = btn('Sign & agree', { onClick: signContract, disabled: !signatureDataUrl || !legallyBindingAcked });

    // The "legally binding" acknowledgement — required tick between the
    // signature pad and the sign button. Same rule as the full contract
    // (public/contract.html): a drawn signature isn't enough on its own.
    var bindingCheckbox = h('input', { type: 'checkbox', id: 'binding-ack' });
    if (legallyBindingAcked) bindingCheckbox.checked = true;
    bindingCheckbox.addEventListener('change', function () {
      legallyBindingAcked = !!bindingCheckbox.checked;
      if (signBtnRef) signBtnRef.disabled = submitting || !signatureDataUrl || !legallyBindingAcked;
    });
    var bindingLabel = h('label', { class: 'agree', for: 'binding-ack' },
      bindingCheckbox,
      h('span', {}, 'I understand that this contract is legally binding.'));

    wrap.appendChild(h('div', {},
      h('p', { class: 'ask' }, 'Sign to agree'),
      h('p', { class: 'ask-sub' }, 'Draw your signature below to confirm you agree to the terms above.'),
      h('div', { class: 'sig-wrap' },
        canvas,
        h('div', { class: 'sig-baseline' }),
        h('div', { class: 'sig-caption' }, 'Signature')),
      h('div', { class: 'sig-tools' },
        h('span', {}, 'Draw with your mouse or finger'),
        clearBtn),
      bindingLabel,
      signBtnRef));

    var e = errNode();
    if (e) wrap.appendChild(e);
    return wrap;
  }

  function renderSigned() {
    var c = offer.contract || {};
    var wrap = h('div', { class: 'fade' });
    wrap.appendChild(h('div', { class: 'state', style: 'padding: 24px 6px 8px' },
      h('div', { class: 'ic ok' }, '✓'),
      h('h1', {}, 'Agreement signed'),
      h('p', {}, 'Thanks, ' + (offer.serverSignerName || offer.firstName) +
        ". Your agreement is confirmed — you'll get your personalised content brief link from us shortly." +
        (offer.copyEmailed ? ' A signed copy is on its way to your inbox.' : ''))));
    var box = contractTermsBlock(c);
    box.appendChild(contractRow('Signed by', offer.serverSignerName || offer.firstName));
    if (offer.signedAtFormatted) box.appendChild(contractRow('Signed on', offer.signedAtFormatted));
    wrap.appendChild(box);
    return wrap;
  }

  async function signContract() {
    var sig = signatureDataUrl || (sigPad && sigPad.toDataUrl());
    if (!sig) { error = 'Please draw your signature to sign.'; render(); return; }
    if (!legallyBindingAcked) {
      error = 'Please tick the box confirming you understand this contract is legally binding.';
      render();
      return;
    }
    setSubmitting(true);
    error = null;
    try {
      var res = await fetch('/api/offers/' + encodeURIComponent(offer.token) + '/sign-contract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signature: sig }),
      });
      var data = await res.json();
      if (data.ok) {
        offer.serverSignerName = data.signerName || offer.firstName;
        offer.signedAtFormatted = data.signedAtFormatted || null;
        offer.contractSigned = true;
        // Only true when the signed copy actually went out — the confirmation
        // never promises an inbox delivery that didn't happen.
        offer.copyEmailed = !!data.copyEmailed;
        view = 'signed';
      } else if (data.reason === 'already_signed') { return location.reload(); }
      else if (data.reason === 'not_accepted') { error = 'Please accept the offer first.'; }
      else if (data.reason === 'signature_required') { error = 'Please draw your signature to sign.'; }
      else { error = 'Something went wrong. Please try again.'; }
    } catch (e) {
      error = 'Network error. Please try again.';
    } finally {
      submitting = false;
      render();
    }
  }

  function setSubmitting(v) { submitting = v; render(); }

  async function respond(response, reason) {
    if (response === 'declined') declinedReason = reason || null;
    setSubmitting(true);
    error = null;
    try {
      var res = await fetch('/api/offers/' + encodeURIComponent(offer.token) + '/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response: response, reason: reason }),
      });
      var data = await res.json();
      // Accepting doesn't finish the flow — it opens the platform picker, then
      // the mini contract to sign.
      if (data.ok) {
        if (data.status === 'accepted') {
          // A client-swapped offer (after a counter / reschedule) has no contract
          // loaded AND the browser URL still points at the old (now-declined)
          // token — navigate to the accepted offer's own page so it loads fresh
          // with its contract. A freshly-loaded offer already has its contract.
          if (!offer.contract) { location.href = '/o/' + encodeURIComponent(offer.token); return; }
          view = 'platforms';
        } else {
          view = data.status;
        }
      }
      else if (data.reason === 'expired') { view = 'expired'; }
      else if (data.reason === 'already_responded') { return location.reload(); }
      else { error = 'Something went wrong. Please try again.'; }
    } catch (e) {
      error = 'Network error. Please try again.';
    } finally {
      submitting = false;
      render();
    }
  }

  async function proposeRate() {
    var requestedRate = Number(rateInput);
    if (!isFinite(requestedRate) || requestedRate <= 0) { error = 'Please enter a valid rate.'; render(); return; }
    setSubmitting(true);
    error = null;
    try {
      var res = await fetch('/api/offers/' + encodeURIComponent(offer.token) + '/counter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestedRate: requestedRate }),
      });
      var data = await res.json();
      if (data.ok && data.outcome === 'countered') {
        var c = data.counter;
        offer = {
          token: c.token, firstName: offer.firstName, brandName: c.brandName,
          deliverables: c.deliverables, rate: c.rate, currency: c.currency,
          rateFormatted: c.rateFormatted, expiresFormatted: c.expiresFormatted,
        };
        countered = true;
        addedLabel = c.deliverablesChanged ? c.addedLabel : null;
        mode = 'cta'; rateInput = ''; view = 'active';
        // Keep the URL on the live offer so a manual reload loads it, not the old one.
        try { history.replaceState(null, '', '/o/' + encodeURIComponent(c.token)); } catch (e) {}
      } else if (data.ok && data.outcome === 'options') {
        // Two typed deals at their rate — present the choice. Point the live
        // offer at the first child so a decline (or reload) routes through a real
        // pending offer; accepting either child retires its sibling server-side.
        options = data.options;
        offer = {
          token: options[0].token, firstName: offer.firstName, brandName: options[0].brandName,
          rateFormatted: options[0].rateFormatted, expiresFormatted: options[0].expiresFormatted,
        };
        rateInput = ''; view = 'options';
        try { history.replaceState(null, '', '/o/' + encodeURIComponent(options[0].token)); } catch (e) {}
      } else if (data.ok && data.outcome === 'too_high') {
        tooHighRequested = data.requestedRateFormatted; rateInput = ''; view = 'too_high';
      } else if (data.reason === 'expired') { view = 'expired'; }
      else if (data.reason === 'already_responded') { return location.reload(); }
      else { error = 'Something went wrong. Please try again.'; }
    } catch (e) {
      error = 'Network error. Please try again.';
    } finally {
      submitting = false;
      render();
    }
  }

  async function proposeSchedule() {
    var date = (scheduleInput || '').trim();
    if (!date) { error = 'Please pick a date.'; render(); return; }
    setSubmitting(true);
    error = null;
    try {
      var res = await fetch('/api/offers/' + encodeURIComponent(offer.token) + '/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ availableDate: date }),
      });
      var data = await res.json();
      if (data.ok && data.outcome === 'rescheduled') {
        // Within the window — a fresh same-terms offer on their dates. Swap to it.
        var c = data.counter;
        offer = {
          token: c.token, firstName: offer.firstName, brandName: c.brandName,
          deliverables: c.deliverables, rate: c.rate, currency: c.currency,
          rateFormatted: c.rateFormatted, expiresFormatted: c.expiresFormatted,
        };
        countered = true; addedLabel = null; rescheduledDate = c.startDateFormatted;
        mode = 'cta'; scheduleInput = ''; view = 'active';
        // Keep the URL on the live offer so a manual reload loads it, not the old one.
        try { history.replaceState(null, '', '/o/' + encodeURIComponent(c.token)); } catch (e) {}
      } else if (data.ok && data.outcome === 'on_hold') {
        holdDateFormatted = data.startDateFormatted || null; scheduleInput = ''; view = 'on_hold';
      } else if (data.reason === 'invalid_date') { error = 'Please pick a valid date (today or later).'; }
      else if (data.reason === 'expired') { view = 'expired'; }
      else if (data.reason === 'already_responded') { return location.reload(); }
      else { error = 'Something went wrong. Please try again.'; }
    } catch (e) {
      error = 'Network error. Please try again.';
    } finally {
      submitting = false;
      render();
    }
  }

  async function load() {
    if (!token) { view = 'notfound'; render(); return; }
    try {
      var res = await fetch('/api/offers/' + encodeURIComponent(token));
      if (res.status === 404) { view = 'notfound'; render(); return; }
      if (!res.ok) throw new Error('load failed');
      var data = await res.json();
      offer = {
        token: data.token, firstName: data.firstName, brandName: data.brandName,
        deliverables: data.deliverables, rate: data.rate, currency: data.currency,
        rateFormatted: data.rateFormatted, expiresFormatted: data.expiresFormatted,
        contract: data.contract || null,
        contractSigned: !!data.contractSigned,
        serverSignerName: data.signerName || null,
        signedAtFormatted: data.signedAtFormatted || null,
      };
      // The signature is drawn on-screen (no pre-filled text field).
      signatureDataUrl = null;
      // A schedule-held offer reopens on the "we'll be in touch" view.
      if (data.initialState === 'on_hold') holdDateFormatted = data.startDateFormatted || null;
      // Platform picker: seed the required + optional tokens from the server,
      // and pre-check any prior selection so a reload doesn't lose their picks.
      if (data.platformOptions) {
        platformOptions = {
          required: (data.platformOptions.required || []).slice(),
          optional: (data.platformOptions.optional || []).slice(),
        };
      }
      selectedPlatforms = {};
      platformOptions.required.forEach(function (n) { selectedPlatforms[n] = true; });
      (data.selectedPlatforms || []).forEach(function (n) { selectedPlatforms[n] = true; });
      view = data.initialState; // active | platforms | contract | signed | declined | expired | on_hold
      render();
    } catch (e) {
      view = 'notfound';
      render();
    }
  }

  render();
  load();
})();
