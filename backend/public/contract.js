(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  // Accepts both the current singular path (/contract/{token}, including when
  // proxied through campaigns.influence.technology) and the legacy plural path
  // (/contracts/{token}) so links already emailed out keep working.
  var token = (location.pathname.match(/\/contracts?\/([^/?#]+)/) || [])[1] || '';

  // ── Country list (ISO 3166-1 + common territories) ──────────────────────
  var COUNTRIES = [
    'Aland Islands','Albania','Algeria','Afghanistan','American Samoa','Andorra','Angola','Anguilla',
    'Antarctica','Antigua and Barbuda','Argentina','Armenia','Aruba','Ascension Island','Australia',
    'Austria','Azerbaijan','Bahamas','Bahrain','Bangladesh','Barbados','Belarus','Belgium','Belize',
    'Benin','Bermuda','Bhutan','Bolivia','Bosnia and Herzegovina','Botswana','Bouvet Island','Brazil',
    'British Indian Ocean Territory','Brunei','Bulgaria','Burkina Faso','Burundi','Cambodia','Cameroon',
    'Canada','Cape Verde','Caribbean Netherlands','Cayman Islands','Central African Republic','Chad',
    'Chile','China','Christmas Island','Cocos (Keeling) Islands','Colombia','Comoros','Congo - Brazzaville',
    'Congo - Kinshasa','Cook Islands','Costa Rica','Croatia','Cuba','Curaçao','Cyprus','Czechia',
    "Côte d'Ivoire",'Denmark','Djibouti','Dominica','Dominican Republic','Ecuador','Egypt','El Salvador',
    'Equatorial Guinea','Eritrea','Estonia','Eswatini','Ethiopia','Falkland Islands','Faroe Islands','Fiji',
    'Finland','France','French Guiana','French Polynesia','French Southern Territories','Gabon','Gambia',
    'Georgia','Germany','Ghana','Gibraltar','Greece','Greenland','Grenada','Guadeloupe','Guam','Guatemala',
    'Guernsey','Guinea','Guinea-Bissau','Guyana','Haiti','Heard & McDonald Islands','Honduras','Hong Kong SAR China',
    'Hungary','Iceland','India','Indonesia','Iran','Iraq','Ireland','Isle of Man','Israel','Italy','Jamaica',
    'Japan','Jersey','Jordan','Kazakhstan','Kenya','Kiribati','Kosovo','Kuwait','Kyrgyzstan','Laos','Latvia',
    'Lebanon','Lesotho','Liberia','Libya','Liechtenstein','Lithuania','Luxembourg','Macao SAR China','Madagascar',
    'Malawi','Malaysia','Maldives','Mali','Malta','Marshall Islands','Martinique','Mauritania','Mauritius',
    'Mayotte','Mexico','Micronesia','Moldova','Monaco','Mongolia','Montenegro','Montserrat','Morocco','Mozambique',
    'Myanmar (Burma)','Namibia','Nauru','Nepal','Netherlands','New Caledonia','New Zealand','Nicaragua','Niger',
    'Nigeria','Niue','Norfolk Island','North Korea','North Macedonia','Northern Mariana Islands','Norway','Oman',
    'Pakistan','Palau','Palestinian Territories','Panama','Papua New Guinea','Paraguay','Peru','Philippines',
    'Pitcairn Islands','Poland','Portugal','Puerto Rico','Qatar','Réunion','Romania','Russia','Rwanda',
    'Samoa','San Marino','São Tomé & Príncipe','Saudi Arabia','Senegal','Serbia','Seychelles','Sierra Leone',
    'Singapore','Sint Maarten','Slovakia','Slovenia','Solomon Islands','Somalia','South Africa',
    'South Georgia & South Sandwich Islands','South Korea','South Sudan','Spain','Sri Lanka','St. Barthélemy',
    'St. Helena','St. Kitts & Nevis','St. Lucia','St. Martin','St. Pierre & Miquelon','St. Vincent & Grenadines',
    'Sudan','Suriname','Svalbard & Jan Mayen','Sweden','Switzerland','Syria','Taiwan','Tajikistan','Tanzania',
    'Thailand','Timor-Leste','Togo','Tokelau','Tonga','Trinidad & Tobago','Tristan da Cunha','Tunisia',
    'Turkey','Turkmenistan','Turks & Caicos Islands','Tuvalu','U.S. Outlying Islands','U.S. Virgin Islands',
    'Uganda','Ukraine','United Arab Emirates','United Kingdom','United States','Uruguay','Uzbekistan',
    'Vanuatu','Vatican City','Venezuela','Vietnam','Virgin Islands','Wallis and Futuna','Yemen','Zambia','Zimbabwe',
  ];
  var IBAN_COUNTRIES = new Set([
    'Albania','Andorra','Austria','Belgium','Bosnia and Herzegovina','Bulgaria','Croatia','Cyprus','Czechia',
    'Denmark','Estonia','Faroe Islands','Finland','France','Georgia','Germany','Gibraltar','Greece','Greenland',
    'Guernsey','Hungary','Iceland','Ireland','Isle of Man','Italy','Jersey','Kosovo','Latvia','Liechtenstein',
    'Lithuania','Luxembourg','Malta','Moldova','Monaco','Montenegro','Netherlands','North Macedonia','Norway',
    'Poland','Portugal','Romania','San Marino','Serbia','Slovakia','Slovenia','Spain','Sweden','Switzerland',
    'Ukraine','United Kingdom','Vatican City',
  ]);

  // ── Formatters ─────────────────────────────────────────────────────────
  function fmtMoney(n, cur) {
    if (n == null || isNaN(Number(n))) return null;
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency', currency: cur || 'USD', maximumFractionDigits: 0,
      }).format(Number(n));
    } catch (e) {
      return (cur ? cur + ' ' : '$') + Number(n).toLocaleString('en-US');
    }
  }
  function fmtNum(n) {
    return n == null || isNaN(Number(n)) ? null : Number(n).toLocaleString('en-US');
  }

  // ── Row helpers (grey label + bold value pairs, v1 card style) ─────────
  function row(k, v, opts) {
    if (v == null || v === '') return '';
    opts = opts || {};
    return '<div class="k">' + esc(k) + '</div><div class="v' + (opts.big ? ' big' : '') + '">' +
      (opts.html ? v : esc(v)) + '</div>';
  }
  function pills(arr) {
    if (!arr || !arr.length) return null;
    return '<div class="pill-list">' + arr.map(function (p) {
      return '<span class="pill">' + esc(p) + '</span>';
    }).join('') + '</div>';
  }
  function section(title, inner) {
    return inner ? '<div class="section"><h2>' + esc(title) + '</h2>' + inner + '</div>' : '';
  }
  function rowsWrap(inner) { return inner ? '<div class="rows">' + inner + '</div>' : ''; }

  // ── Render the read-only contract sections (v1 layout, no Additional Terms) ──
  function renderSections(d) {
    var html = '';

    html += section('Parties', rowsWrap(
      row('Creator', d.creatorName, { big: true }) +
      row('Instagram', d.instagramUsername ? '@' + String(d.instagramUsername).replace(/^@/, '') : null) +
      row('Email', d.email) +
      row('Brand', d.brandLegalName || d.brandName, { big: true })
    ));

    var platforms = pills(Array.isArray(d.platforms) ? d.platforms : (d.platforms ? [d.platforms] : []));
    var minViews = d.minTotalViews != null ? d.minTotalViews : d.guaranteedViews;
    html += section('Campaign & Deliverables', rowsWrap(
      row('Campaign', d.campaignName) +
      (platforms ? '<div class="k">Platforms</div><div class="v">' + platforms + '</div>' : '') +
      row('Deliverables', d.deliverables) +
      row('Number of deliverables', fmtNum(d.numberOfDeliverables || d.numberOfVideos)) +
      (minViews ? row('Guaranteed views', fmtNum(minViews)) : '') +
      (d.bonusAmount && d.bonusThresholdViews
        ? row('Performance bonus', fmtMoney(d.bonusAmount, d.currency) + ' if views cross ' + fmtNum(d.bonusThresholdViews) + ' in ' + (d.bonusWindowDays || 30) + ' days')
        : '')
    ));

    html += section('Timeline', rowsWrap(
      row('Cadence', d.timeline) +
      row('Deadline', d.postingDeadline || d.deadline) +
      (d.postLiveMonths ? row('Posts remain live for', d.postLiveMonths + ' months') : '')
    ));

    var compensation = d.totalPayment != null ? d.totalPayment : d.compensation;
    var upPct = d.upfrontPercent, remPct = d.remainderPercent;
    html += section('Compensation & Payment', rowsWrap(
      row('Compensation', fmtMoney(compensation, d.currency), { big: true }) +
      row('Currency', d.currency) +
      (upPct && remPct
        ? row('Payment schedule', upPct + '% upfront (' + (d.upfrontTrigger || 'on first draft') + '), ' + remPct + '% ' + (d.remainderTrigger || 'on completion'))
        : row('Payment terms', d.paymentTerms))
    ));

    html += section('Usage Rights & Exclusivity', rowsWrap(
      row('Usage rights', d.usageRights) +
      (Array.isArray(d.usageRightsList) && d.usageRightsList.length
        ? '<div class="k">Permitted uses</div><div class="v">' + esc(d.usageRightsList.join(', ')) + '</div>'
        : '') +
      row('Scope', d.usageScope) +
      row('Paid ads', d.paidAdsIncluded ? 'Included' : 'Not included') +
      row('Exclusivity', d.exclusivity)
    ));

    $('sections').innerHTML = html;
  }

  // ── Drawn signature pad ────────────────────────────────────────────────
  function initSigPad(canvas) {
    var ctx = canvas.getContext('2d');
    var dirty = false;
    // Preserve any strokes across resizes (the internal canvas resolution is
    // tied to the CSS box, so we snapshot before resizing and repaint after).
    function resize() {
      var dpr = Math.max(1, window.devicePixelRatio || 1);
      var box = canvas.getBoundingClientRect();
      var w = Math.floor(box.width * dpr);
      var h = Math.floor(box.height * dpr);
      // Skip while the canvas is hidden (0x0) so we don't lock the internal
      // resolution to nothing — resize() will run again once it's visible.
      if (w === 0 || h === 0) return;
      if (canvas.width === w && canvas.height === h) return;
      var snapshot = dirty ? canvas.toDataURL('image/png') : null;
      canvas.width = w;
      canvas.height = h;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.strokeStyle = '#101010';
      if (snapshot) {
        var img = new Image();
        img.onload = function () { ctx.drawImage(img, 0, 0, box.width, box.height); };
        img.src = snapshot;
      }
    }
    // Fire on window resize AND on the canvas's own box changing — the box
    // stays 0x0 until page1 becomes visible, and only then does the ResizeObserver
    // trigger the actual first sizing. Without this, drawing lands on a 0-sized
    // buffer and never appears.
    window.addEventListener('resize', resize);
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(resize).observe(canvas);
    }
    resize();

    var drawing = false, last = null;
    function pos(e) {
      var box = canvas.getBoundingClientRect();
      var p = e.touches ? e.touches[0] : e;
      return { x: p.clientX - box.left, y: p.clientY - box.top };
    }
    function start(e) { drawing = true; last = pos(e); e.preventDefault(); }
    function move(e) {
      if (!drawing) return;
      var p = pos(e);
      ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
      last = p; dirty = true; e.preventDefault();
    }
    function end() { drawing = false; last = null; }
    canvas.addEventListener('mousedown', start);
    // Continue drawing even if the pointer leaves the canvas mid-stroke by
    // listening on the window; without this, one stray pixel outside the box
    // ends the stroke prematurely.
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', end);
    canvas.addEventListener('touchstart', start, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    canvas.addEventListener('touchend', end);

    return {
      isEmpty: function () { return !dirty; },
      clear: function () { ctx.clearRect(0, 0, canvas.width, canvas.height); dirty = false; },
      toDataUrl: function () { return dirty ? canvas.toDataURL('image/png') : null; },
      resize: resize,
    };
  }

  // ── Conditional bank field visibility ──────────────────────────────────
  // Country-driven blocks:
  //   European countries → IBAN only (no plain Account number / Confirm pair)
  //   United States      → Account number + Confirm + Routing number
  //   India              → Account number + Confirm + IFSC + PAN (no SWIFT)
  //   Everywhere else    → Account number + Confirm + SWIFT
  function updateBankVisibility(country) {
    var isUS = country === 'United States';
    var isIN = country === 'India';
    var isIBAN = IBAN_COUNTRIES.has(country);
    $('routingBlock').hidden = !isUS;
    $('indiaRow').hidden = !isIN;
    $('swiftBlock').hidden = isIN; // India uses IFSC/PAN instead
    $('ibanBlock').hidden = !isIBAN;
    // Europeans identify their account by IBAN — the plain Account number pair
    // is only shown outside the SEPA region.
    $('accountNumBlock').hidden = isIBAN;
  }

  // ── States ─────────────────────────────────────────────────────────────
  function markSigned() {
    $('page1').hidden = true; $('page2').hidden = true; $('done').hidden = false;
  }

  // ── Load contract ──────────────────────────────────────────────────────
  function load() {
    if (!token) { $('loading').hidden = true; $('notfound').hidden = false; return; }
    fetch('/api/contracts/' + encodeURIComponent(token))
      .then(function (r) { if (!r.ok) throw new Error('not found'); return r.json(); })
      .then(function (c) {
        var d = c.data || {};
        $('eyebrow').textContent = [d.brandName, d.campaignName].filter(Boolean).join(' · ') || 'Collaboration';
        $('subhead').textContent = d.creatorName ? 'Prepared for ' + d.creatorName : '';
        renderSections(d);

        // Prefill identity fields from the negotiation-known values.
        if (d.creatorName) $('legalName').value = d.creatorName;

        // Populate the country dropdown.
        var sel = $('addrCountry');
        sel.innerHTML = '<option value="">Country</option>' +
          COUNTRIES.map(function (co) { return '<option value="' + esc(co) + '">' + esc(co) + '</option>'; }).join('');
        sel.addEventListener('change', function () { updateBankVisibility(sel.value); });
        updateBankVisibility('');

        // Payment currency label on page 2.
        $('payCurrency').textContent = d.currency || 'USD';

        // Default the signed date to today.
        $('signedDate').value = new Date().toISOString().slice(0, 10);

        $('loading').hidden = true;
        if (c.status && c.status !== 'pending') {
          // Already signed: show the confirmation state instead of the form.
          markSigned();
          return;
        }
        $('page1').hidden = false;
        // Now that the canvas has a real box, size its internal buffer to match.
        // Without this, drawing lands on a 0x0 buffer while the CSS box shows the
        // signature area — the user sees no ink.
        if (sig && sig.resize) sig.resize();
      })
      .catch(function () { $('loading').hidden = true; $('notfound').hidden = false; });
  }

  var sig;

  // Move focus to a field and (best-effort) scroll it into view. The
  // .field-focus class briefly outlines the offender to draw the eye.
  function highlight(id) {
    var el = $(id);
    if (!el) return;
    el.classList.add('field-focus');
    setTimeout(function () { el.classList.remove('field-focus'); }, 1600);
    try { el.focus({ preventScroll: false }); } catch (_) { el.focus(); }
    if (el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // Continue → every required field on page 1 must be filled. Only line 2 of
  // the address is optional; everything else, including the drawn signature and
  // the agreement checkbox, is enforced before we let the creator advance.
  function goToPage2(e) {
    e.preventDefault();
    var errEl = $('err1');
    errEl.textContent = '';

    // Ordered so the message + highlight always land on the FIRST missing field.
    var checks = [
      { id: 'legalName',    label: 'your full legal name' },
      { id: 'gender',       label: 'your gender' },
      { id: 'phone',        label: 'your phone number' },
      { id: 'addrLine1',    label: 'address line 1' },
      { id: 'addrCity',     label: 'your city' },
      { id: 'addrState',    label: 'your state / province' },
      { id: 'addrZip',      label: 'your pincode / zip code' },
      { id: 'addrCountry',  label: 'your country' },
    ];
    for (var i = 0; i < checks.length; i += 1) {
      var v = ($(checks[i].id).value || '').trim();
      if (!v) {
        errEl.textContent = 'Please enter ' + checks[i].label + '.';
        highlight(checks[i].id);
        return;
      }
    }
    if (sig.isEmpty()) {
      errEl.textContent = 'Please draw your signature in the box above.';
      highlight('sig');
      return;
    }
    var date = ($('signedDate').value || '').trim();
    if (!date) {
      errEl.textContent = 'Please pick the date you signed.';
      highlight('signedDate');
      return;
    }
    if (!$('agree').checked) {
      errEl.textContent = 'Please confirm you understand and accept the terms.';
      highlight('agree');
      return;
    }

    $('page1').hidden = true;
    $('page2').hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // Back button on page 2 → returns to page 1 without losing state.
  function goBackToPage1() {
    $('page2').hidden = true;
    $('page1').hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // Final submit → package everything into the contract submission.
  function finalSubmit(e) {
    e.preventDefault();
    var btn = $('btn-submit');
    var errEl = $('err2');
    errEl.textContent = '';

    var acct = ($('bankAccount').value || '').trim();
    var acct2 = ($('bankAccountConfirm').value || '').trim();
    if (acct && acct !== acct2) { errEl.textContent = 'Account number and confirmation do not match.'; return; }

    var payload = {
      signerName: ($('legalName').value || '').trim(),
      agree: true,
      fields: {
        legalName: ($('legalName').value || '').trim(),
        gender: $('gender').value || null,
        address: {
          line1: $('addrLine1').value || null,
          line2: $('addrLine2').value || null,
          city: $('addrCity').value || null,
          state: $('addrState').value || null,
          zip: $('addrZip').value || null,
          country: $('addrCountry').value || null,
        },
        phone: $('phone').value || null,
        signatureDataUrl: sig.toDataUrl(),
        signedDate: $('signedDate').value || null,
        bankAccount: {
          accountHolderName: $('bankHolder').value || null,
          bankName: $('bankName').value || null,
          accountNumber: acct || null,
          iban: $('bankIban').value || null,
          routingNumber: $('bankRouting').value || null,
          ifscCode: $('bankIfsc').value || null,
          panNumber: $('bankPan').value || null,
          swiftCode: $('bankSwift').value || null,
          taxIdNumber: $('bankTaxId').value || null,
        },
      },
    };

    btn.disabled = true; btn.textContent = 'Submitting…';
    fetch('/api/contracts/' + encodeURIComponent(token) + '/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error((res.j && res.j.error) || 'Something went wrong.');
        markSigned();
      })
      .catch(function (err) {
        errEl.textContent = err.message || 'Something went wrong. Please try again.';
        btn.disabled = false; btn.textContent = 'Sign & submit contract';
      });
  }

  document.addEventListener('DOMContentLoaded', function () {
    sig = initSigPad($('sig'));
    $('sig-clear').addEventListener('click', function () { sig.clear(); });
    $('page1').addEventListener('submit', goToPage2);
    $('page2').addEventListener('submit', finalSubmit);
    $('btn-back').addEventListener('click', goBackToPage1);
    load();
  });
})();
