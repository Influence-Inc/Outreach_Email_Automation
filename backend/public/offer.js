'use strict';

// Offer-portal client. Vanilla-JS port of the Influence-CDB-portal OfferView
// component: fetches the offer, renders the accept / decline / counter states,
// and posts responses back to /api/offers/:token/{respond,counter}.

(function () {
  var CARD = document.getElementById('card');
  var token = decodeURIComponent((location.pathname.split('/').filter(Boolean).pop() || ''));

  var DECLINE_REASONS = ['Budget', 'Timing', 'Not a fit'];

  var offer = null; // { token, firstName, brandName, deliverables, rate, currency, rateFormatted, expiresFormatted }
  var view = 'loading'; // loading | active | accepted | declined | expired | too_high | notfound
  var mode = 'cta'; // cta | reasons | budget
  var countered = false;
  var addedLabel = null;
  var tooHighRequested = null;
  var submitting = false;
  var error = null;
  var rateInput = '';
  var signerName = ''; // typed-name signature on the mini contract

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
      root = centered('', '', 'Thanks for letting us know',
        'No problem at all, ' + offer.firstName + '. We will keep you in mind for future opportunities. Have a great day.');
    } else if (view === 'expired') {
      root = centered('neutral', '⏳', 'This offer has expired',
        'Sorry, ' + offer.firstName + ' — this offer is no longer available. If you are still interested, reply to your INFLUENCE contact and we will sort it out.');
    } else if (view === 'too_high') {
      root = renderTooHigh();
    } else if (view === 'contract') {
      root = renderContract();
    } else if (view === 'signed') {
      root = renderSigned();
    } else {
      root = renderActive();
    }
    CARD.appendChild(root);
  }

  function renderActive() {
    var wrap = h('div', { class: 'fade' });

    if (countered) {
      wrap.appendChild(h('div', { class: 'note' },
        h('span', { class: 'spark' }, '✨'),
        h('span', {}, addedLabel
          ? "Good news — we've added " + addedLabel + ' and matched your rate. Have another look.'
          : "Good news — we've updated the offer to match your rate. Have another look.")));
    }

    wrap.appendChild(h('div', { class: 'eyebrow' }, h('span', { class: 'dot' }), 'New collaboration'));
    wrap.appendChild(h('h1', { class: 'brand' }, offer.brandName));
    wrap.appendChild(h('p', { class: 'lede' },
      'Hi ' + offer.firstName + ' — based on your previous work with us, we think this one is a great fit.'));

    // Terms
    var pills = h('div', { class: 'pill-list' });
    (offer.deliverables || []).forEach(function (d) { pills.appendChild(h('span', { class: 'pill' }, d)); });
    var terms = h('div', { class: 'terms' },
      h('div', { class: 'label' }, 'Deliverables'),
      pills,
      h('div', { class: 'terms-foot' },
        h('div', {}, h('div', { class: 'rate-cap' }, 'Your rate'), h('div', { class: 'rate num' }, offer.rateFormatted)),
        h('div', { class: 'by' }, h('div', { class: 'by-cap' }, 'Respond by'), h('div', { class: 'v num' }, offer.expiresFormatted))));
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
            if (reason === 'Budget') { error = null; mode = 'budget'; render(); }
            else respond('declined', reason);
          },
        }));
      });
      chips.appendChild(btn('Prefer not to say', { variant: 'outline', sm: true, onClick: function () { respond('declined'); } }));
      wrap.appendChild(h('div', { class: 'btns' },
        h('p', { class: 'ask-sub' }, 'Mind sharing why? (optional)'),
        chips,
        h('button', { class: 'linkbtn', type: 'button', onclick: function () { mode = 'cta'; render(); } }, '← Back')));
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

  function renderTooHigh() {
    return h('div', { class: 'fade' },
      h('div', { class: 'state', style: 'padding:18px 6px 20px' },
        h('h1', {}, "We can't match that one"),
        h('p', {}, 'Thanks for the proposal, ' + offer.firstName + ". We can't stretch to " +
          (tooHighRequested || 'that rate') + ' on this brief — but the original offer of ' +
          offer.rateFormatted + " still stands if you'd like to go ahead.")),
      h('div', { class: 'btns' },
        btn('Accept ' + offer.rateFormatted, { onClick: function () { respond('accepted'); } }),
        btn('Propose a different rate', { variant: 'outline', onClick: function () { error = null; mode = 'budget'; view = 'active'; render(); } }),
        h('button', { class: 'linkbtn center-link', type: 'button', onclick: function () { respond('declined', 'Budget'); } }, 'No thanks, decline')),
      errNode());
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
    box.appendChild(contractRow('Timeline', c.timeline));
    return box;
  }

  function renderContract() {
    var c = offer.contract || {};
    var wrap = h('div', { class: 'fade' });
    wrap.appendChild(h('div', { class: 'eyebrow' }, h('span', { class: 'dot' }), 'Agreement'));
    wrap.appendChild(h('h1', { class: 'brand' }, 'Collaboration agreement'));
    wrap.appendChild(h('p', { class: 'lede' }, 'Please review the details below and sign to confirm.'));
    wrap.appendChild(contractTermsBlock(c));

    var signBtn;
    var input = h('input', {
      type: 'text', placeholder: 'Type your full name', value: signerName,
      oninput: function (e) { signerName = e.target.value; if (signBtn) signBtn.disabled = submitting || !signerName.trim(); },
      onkeydown: function (e) { if (e.key === 'Enter' && signerName.trim()) signContract(); },
    });
    signBtn = btn('Sign & agree', { onClick: signContract, disabled: !signerName.trim() });
    wrap.appendChild(h('div', {},
      h('p', { class: 'ask' }, 'Sign to agree'),
      h('p', { class: 'ask-sub' }, 'By tapping “Sign & agree”, you confirm you agree to the terms above.'),
      h('div', { class: 'sign-input' }, input),
      signBtn));

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
        '. Your agreement is confirmed — our team will be in touch with next steps.')));
    var box = contractTermsBlock(c);
    box.appendChild(contractRow('Signed by', offer.serverSignerName || signerName));
    if (offer.signedAtFormatted) box.appendChild(contractRow('Signed on', offer.signedAtFormatted));
    wrap.appendChild(box);
    return wrap;
  }

  async function signContract() {
    var name = (signerName || '').trim();
    if (!name) { error = 'Please type your name to sign.'; render(); return; }
    setSubmitting(true);
    error = null;
    try {
      var res = await fetch('/api/offers/' + encodeURIComponent(offer.token) + '/sign-contract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signerName: name }),
      });
      var data = await res.json();
      if (data.ok) {
        offer.serverSignerName = data.signerName || name;
        offer.signedAtFormatted = data.signedAtFormatted || null;
        offer.contractSigned = true;
        view = 'signed';
      } else if (data.reason === 'already_signed') { return location.reload(); }
      else if (data.reason === 'not_accepted') { error = 'Please accept the offer first.'; }
      else if (data.reason === 'name_required') { error = 'Please type your name to sign.'; }
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
    setSubmitting(true);
    error = null;
    try {
      var res = await fetch('/api/offers/' + encodeURIComponent(offer.token) + '/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response: response, reason: reason }),
      });
      var data = await res.json();
      // Accepting doesn't finish the flow — it opens the mini contract to sign.
      if (data.ok) { view = data.status === 'accepted' ? 'contract' : data.status; }
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
      // Prefill the signature field with the creator's name (still editable).
      signerName = (data.contract && data.contract.creatorName) || '';
      view = data.initialState; // active | contract | signed | declined | expired
      render();
    } catch (e) {
      view = 'notfound';
      render();
    }
  }

  render();
  load();
})();
