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
  // ── Phone country calling codes (ITU E.164) ────────────────────────────
  // Compact [country, dialCode] tuples used to populate the phone-country
  // dropdown. US is emitted first (default selection) then everything else
  // alphabetically. Multiple countries can share a dial code (NANP: +1 covers
  // US, Canada, and Caribbean territories) — the SUBMITTED value is just the
  // dial code, so the choice of country within a shared code is cosmetic for
  // the creator's own recognition. Kept comprehensive so no creator has to
  // hand-edit a "+" prefix.
  var DIAL_CODES = [
    ['United States', '+1'],
    ['Afghanistan', '+93'], ['Aland Islands', '+358'], ['Albania', '+355'], ['Algeria', '+213'],
    ['American Samoa', '+1'], ['Andorra', '+376'], ['Angola', '+244'], ['Anguilla', '+1'],
    ['Antigua and Barbuda', '+1'], ['Argentina', '+54'], ['Armenia', '+374'], ['Aruba', '+297'],
    ['Ascension Island', '+247'], ['Australia', '+61'], ['Austria', '+43'], ['Azerbaijan', '+994'],
    ['Bahamas', '+1'], ['Bahrain', '+973'], ['Bangladesh', '+880'], ['Barbados', '+1'],
    ['Belarus', '+375'], ['Belgium', '+32'], ['Belize', '+501'], ['Benin', '+229'], ['Bermuda', '+1'],
    ['Bhutan', '+975'], ['Bolivia', '+591'], ['Bosnia and Herzegovina', '+387'], ['Botswana', '+267'],
    ['Brazil', '+55'], ['British Indian Ocean Territory', '+246'], ['Brunei', '+673'], ['Bulgaria', '+359'],
    ['Burkina Faso', '+226'], ['Burundi', '+257'], ['Cambodia', '+855'], ['Cameroon', '+237'], ['Canada', '+1'],
    ['Cape Verde', '+238'], ['Caribbean Netherlands', '+599'], ['Cayman Islands', '+1'],
    ['Central African Republic', '+236'], ['Chad', '+235'], ['Chile', '+56'], ['China', '+86'],
    ['Christmas Island', '+61'], ['Cocos (Keeling) Islands', '+61'], ['Colombia', '+57'], ['Comoros', '+269'],
    ['Congo - Brazzaville', '+242'], ['Congo - Kinshasa', '+243'], ['Cook Islands', '+682'],
    ['Costa Rica', '+506'], ["Côte d'Ivoire", '+225'], ['Croatia', '+385'], ['Cuba', '+53'],
    ['Curaçao', '+599'], ['Cyprus', '+357'], ['Czechia', '+420'], ['Denmark', '+45'], ['Djibouti', '+253'],
    ['Dominica', '+1'], ['Dominican Republic', '+1'], ['Ecuador', '+593'], ['Egypt', '+20'],
    ['El Salvador', '+503'], ['Equatorial Guinea', '+240'], ['Eritrea', '+291'], ['Estonia', '+372'],
    ['Eswatini', '+268'], ['Ethiopia', '+251'], ['Falkland Islands', '+500'], ['Faroe Islands', '+298'],
    ['Fiji', '+679'], ['Finland', '+358'], ['France', '+33'], ['French Guiana', '+594'],
    ['French Polynesia', '+689'], ['Gabon', '+241'], ['Gambia', '+220'], ['Georgia', '+995'],
    ['Germany', '+49'], ['Ghana', '+233'], ['Gibraltar', '+350'], ['Greece', '+30'], ['Greenland', '+299'],
    ['Grenada', '+1'], ['Guadeloupe', '+590'], ['Guam', '+1'], ['Guatemala', '+502'], ['Guernsey', '+44'],
    ['Guinea', '+224'], ['Guinea-Bissau', '+245'], ['Guyana', '+592'], ['Haiti', '+509'], ['Honduras', '+504'],
    ['Hong Kong SAR China', '+852'], ['Hungary', '+36'], ['Iceland', '+354'], ['India', '+91'],
    ['Indonesia', '+62'], ['Iran', '+98'], ['Iraq', '+964'], ['Ireland', '+353'], ['Isle of Man', '+44'],
    ['Israel', '+972'], ['Italy', '+39'], ['Jamaica', '+1'], ['Japan', '+81'], ['Jersey', '+44'],
    ['Jordan', '+962'], ['Kazakhstan', '+7'], ['Kenya', '+254'], ['Kiribati', '+686'], ['Kosovo', '+383'],
    ['Kuwait', '+965'], ['Kyrgyzstan', '+996'], ['Laos', '+856'], ['Latvia', '+371'], ['Lebanon', '+961'],
    ['Lesotho', '+266'], ['Liberia', '+231'], ['Libya', '+218'], ['Liechtenstein', '+423'],
    ['Lithuania', '+370'], ['Luxembourg', '+352'], ['Macao SAR China', '+853'], ['Madagascar', '+261'],
    ['Malawi', '+265'], ['Malaysia', '+60'], ['Maldives', '+960'], ['Mali', '+223'], ['Malta', '+356'],
    ['Marshall Islands', '+692'], ['Martinique', '+596'], ['Mauritania', '+222'], ['Mauritius', '+230'],
    ['Mayotte', '+262'], ['Mexico', '+52'], ['Micronesia', '+691'], ['Moldova', '+373'], ['Monaco', '+377'],
    ['Mongolia', '+976'], ['Montenegro', '+382'], ['Montserrat', '+1'], ['Morocco', '+212'],
    ['Mozambique', '+258'], ['Myanmar (Burma)', '+95'], ['Namibia', '+264'], ['Nauru', '+674'],
    ['Nepal', '+977'], ['Netherlands', '+31'], ['New Caledonia', '+687'], ['New Zealand', '+64'],
    ['Nicaragua', '+505'], ['Niger', '+227'], ['Nigeria', '+234'], ['Niue', '+683'], ['Norfolk Island', '+672'],
    ['North Korea', '+850'], ['North Macedonia', '+389'], ['Northern Mariana Islands', '+1'],
    ['Norway', '+47'], ['Oman', '+968'], ['Pakistan', '+92'], ['Palau', '+680'],
    ['Palestinian Territories', '+970'], ['Panama', '+507'], ['Papua New Guinea', '+675'],
    ['Paraguay', '+595'], ['Peru', '+51'], ['Philippines', '+63'], ['Poland', '+48'], ['Portugal', '+351'],
    ['Puerto Rico', '+1'], ['Qatar', '+974'], ['Romania', '+40'], ['Russia', '+7'], ['Rwanda', '+250'],
    ['Réunion', '+262'], ['Samoa', '+685'], ['San Marino', '+378'], ['Saudi Arabia', '+966'],
    ['Senegal', '+221'], ['Serbia', '+381'], ['Seychelles', '+248'], ['Sierra Leone', '+232'],
    ['Singapore', '+65'], ['Sint Maarten', '+1'], ['Slovakia', '+421'], ['Slovenia', '+386'],
    ['Solomon Islands', '+677'], ['Somalia', '+252'], ['South Africa', '+27'], ['South Korea', '+82'],
    ['South Sudan', '+211'], ['Spain', '+34'], ['Sri Lanka', '+94'], ['St. Barthélemy', '+590'],
    ['St. Helena', '+290'], ['St. Kitts & Nevis', '+1'], ['St. Lucia', '+1'], ['St. Martin', '+590'],
    ['St. Pierre & Miquelon', '+508'], ['St. Vincent & Grenadines', '+1'], ['Sudan', '+249'],
    ['Suriname', '+597'], ['Svalbard & Jan Mayen', '+47'], ['Sweden', '+46'], ['Switzerland', '+41'],
    ['Syria', '+963'], ['São Tomé & Príncipe', '+239'], ['Taiwan', '+886'], ['Tajikistan', '+992'],
    ['Tanzania', '+255'], ['Thailand', '+66'], ['Timor-Leste', '+670'], ['Togo', '+228'], ['Tokelau', '+690'],
    ['Tonga', '+676'], ['Trinidad & Tobago', '+1'], ['Tunisia', '+216'], ['Turkey', '+90'],
    ['Turkmenistan', '+993'], ['Turks & Caicos Islands', '+1'], ['Tuvalu', '+688'], ['U.S. Virgin Islands', '+1'],
    ['Uganda', '+256'], ['Ukraine', '+380'], ['United Arab Emirates', '+971'], ['United Kingdom', '+44'],
    ['Uruguay', '+598'], ['Uzbekistan', '+998'], ['Vanuatu', '+678'], ['Vatican City', '+379'],
    ['Venezuela', '+58'], ['Vietnam', '+84'], ['Wallis and Futuna', '+681'], ['Yemen', '+967'],
    ['Zambia', '+260'], ['Zimbabwe', '+263'],
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
    // View-based deals are priced by a guaranteed view total, not by a fixed
    // video count — showing "Number of deliverables" there is misleading
    // (it's just "at least 1 post"), so omit it entirely for view_based.
    var isViewBased = d.offerType === 'view_based';
    var isVideoBased = d.offerType === 'video_based';
    // For flat video-based deals the base extraction always writes the count
    // into the deliverables string itself ("1 short-form video", "3 short-form
    // videos"), so a separate "Number of deliverables: N" row just repeats
    // what's directly above it. Only show the row when the deliverables text
    // doesn't already carry a number — the edge case where a Claude
    // extraction produced a count-less description like "Instagram Reel and
    // TikTok short" and the numeric count is genuinely extra information.
    var deliverablesText = String(d.deliverables || '');
    var deliverablesHasCount = /\d/.test(deliverablesText);
    html += section('Campaign & Deliverables', rowsWrap(
      row('Campaign', d.campaignName) +
      (platforms ? '<div class="k">Platforms</div><div class="v">' + platforms + '</div>' : '') +
      row('Deliverables', d.deliverables) +
      (isViewBased || deliverablesHasCount
        ? ''
        : row('Number of deliverables', fmtNum(d.numberOfDeliverables || d.numberOfVideos))) +
      // Min. guaranteed views is a view-based term — a flat video-based deal is
      // priced per video and promises no view floor, so never show it there.
      (!isVideoBased && minViews ? row('Min. guaranteed views', fmtNum(minViews)) : '') +
      (d.bonusAmount && d.bonusThresholdViews
        ? row('Performance bonus', fmtMoney(d.bonusAmount, d.currency) + ' if views cross ' + fmtNum(d.bonusThresholdViews) + ' in ' + (d.bonusWindowDays || 30) + ' days')
        : '')
    ));

    // Cadence only makes sense when there's more than one video to pace out.
    // A single-video deal has one drop date, not a rhythm.
    var deliverableCount = Number(d.numberOfDeliverables != null ? d.numberOfDeliverables : d.numberOfVideos);
    var showCadence = !(Number.isFinite(deliverableCount) && deliverableCount <= 1);
    html += section('Timeline', rowsWrap(
      (showCadence ? row('Cadence', d.timeline) : '') +
      row('Deadline', d.postingDeadline || d.deadline)
    ));

    var compensation = d.totalPayment != null ? d.totalPayment : d.compensation;
    var upPct = d.upfrontPercent, remPct = d.remainderPercent;
    var hasSchedule = Number(upPct) > 0 && Number(remPct) > 0;
    // Payment terms is a boilerplate payment-METHOD clause (bank transfer, net-N
    // days) — it describes how the money moves, not the upfront/remainder split
    // shown below. Derived from the numeric paymentTermsDays (not the stored
    // prose) so it stays correct for every contract, old or new — the stored
    // string could carry a schedule-like phrasing from an earlier extraction and
    // would otherwise duplicate the Payment schedule row. When a split applies,
    // anchor the net-days to "each payment milestone" instead of "completing
    // and posting all agreed deliverables" — the upfront installment is due
    // BEFORE completion, so the completion phrasing would contradict it.
    var days = Number(d.paymentTermsDays);
    var daysN = Number.isFinite(days) && days > 0 ? days : 7;
    var termsAnchor = hasSchedule
      ? 'each payment milestone'
      : 'completing and posting all agreed deliverables';
    var termsText = 'Direct bank transfer, initiated within ' + daysN + ' working days of ' + termsAnchor;
    html += section('Compensation & Payment', rowsWrap(
      row('Compensation', fmtMoney(compensation, d.currency), { big: true }) +
      row('Currency', d.currency) +
      row('Payment terms', termsText) +
      (hasSchedule
        ? row('Payment schedule', upPct + '% upfront, ' + remPct + '% ' + (d.remainderTrigger || 'on completion'))
        : '')
    ));

    // Usage rights reads straight off the paid-ads grant — a concise
    // "Included / Not included" rather than a long sentence. Derived from
    // paidAdsIncluded (not the stored prose) so it stays correct for every
    // contract, old or new. No separate Scope row.
    html += section('Usage Rights & Exclusivity', rowsWrap(
      row('Usage rights', d.paidAdsIncluded ? 'Included' : 'Not included') +
      row('Paid ads', d.paidAdsIncluded ? 'Included' : 'Not included') +
      row('Exclusivity', d.exclusivity) +
      // Standard on every contract — defaults to 6 months, never conditional,
      // so it's never silently dropped if a field comes back empty.
      row('Posts remain live for', (d.postLiveMonths || 6) + ' months')
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

  // ── Secret fields (account number / IBAN) ──────────────────────────────
  // Rendered as type=password so characters are masked. We additionally block
  // copy / cut / drag / right-click so the entered value can't be lifted back
  // out of the field even if it's still selected — the creator types their
  // details, we accept them, and they stay hidden. Pasting is blocked too so
  // the account number / IBAN must be typed (and the confirm field can't just
  // be pasted to match).
  function lockSecretFields() {
    var nodes = document.querySelectorAll('input.secret');
    for (var i = 0; i < nodes.length; i += 1) {
      var el = nodes[i];
      el.addEventListener('copy', function (e) { e.preventDefault(); });
      el.addEventListener('cut', function (e) { e.preventDefault(); });
      el.addEventListener('paste', function (e) { e.preventDefault(); });
      el.addEventListener('dragstart', function (e) { e.preventDefault(); });
      el.addEventListener('drop', function (e) { e.preventDefault(); });
      el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    }
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

  // A returning visitor whose contract is already signed sees the actual
  // contract — read-only — with a banner noting who signed it and when,
  // rather than the bare "Contract signed" confirmation.
  function showSigned(c) {
    var d = c.data || {};
    var who = (c.signerName || d.creatorName || '').trim();
    var when = '';
    if (c.signedAt) {
      var dt = new Date(c.signedAt);
      if (!isNaN(dt.getTime())) {
        when = dt.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
      }
    }
    $('signed-banner-text').textContent =
      'This contract has been signed by ' + (who || 'the creator') +
      (when ? ' on ' + when : '') + '.';
    $('signed-banner').hidden = false;

    // Hide the interactive parts — the contract is already executed, so the
    // "Your details" form and the signature/continue section aren't shown.
    var page1 = $('page1');
    var details = page1.querySelector('.section.editable');
    var sign = page1.querySelector('.sign');
    if (details) details.hidden = true;
    if (sign) sign.hidden = true;

    // Show what the creator actually submitted (signature, contact, bank), so
    // the executed contract is complete rather than terms-only.
    renderSubmitted(c);

    page1.hidden = false;
  }

  // Read-only render of the signing submission on an already-signed contract.
  function renderSubmitted(c) {
    var sub = (c.submission && c.submission.fields) || null;
    if (!sub) return;
    if (document.getElementById('submitted-details')) return; // idempotent
    var addr = sub.address || {};
    var bank = sub.bankAccount || {};
    var addrStr = [addr.line1, addr.line2, addr.city, addr.state, addr.zip, addr.country]
      .filter(Boolean)
      .join(', ');
    function row(k, v) {
      return v ? '<div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + '</div>' : '';
    }
    var contactRows =
      row('Full legal name', sub.legalName) +
      row('Gender', sub.gender) +
      row('Phone', sub.phone) +
      row('Email', c.signerEmail) +
      row('Address', addrStr);
    var bankRows =
      row('Account holder', bank.accountHolderName) +
      row('Bank name', bank.bankName) +
      row('Account number', bank.accountNumber) +
      row('IBAN', bank.iban) +
      row('Routing number', bank.routingNumber) +
      row('IFSC code', bank.ifscCode) +
      row('SWIFT / BIC', bank.swiftCode) +
      row('PAN number', bank.panNumber) +
      row('Tax ID number', bank.taxIdNumber);
    var sig = sub.signatureDataUrl
      ? '<div style="border:1px solid var(--line-2);border-radius:var(--radius-sm);background:#ffffff;padding:14px;display:flex;align-items:center;justify-content:center;min-height:90px">' +
        '<img src="' + esc(sub.signatureDataUrl) + '" alt="Signature" style="max-width:100%;max-height:190px;object-fit:contain"></div>'
      : '<div class="prose">No signature captured.</div>';

    var html =
      '<div class="section"><h2>Signature</h2>' + sig + '</div>' +
      '<div class="section"><h2>Contact &amp; identity</h2><div class="rows">' +
      (contactRows || '<div class="v">—</div>') +
      '</div></div>' +
      (bankRows
        ? '<div class="section"><h2>Payment / bank details</h2><div class="rows">' + bankRows + '</div></div>'
        : '');

    var wrap = document.createElement('div');
    wrap.id = 'submitted-details';
    wrap.innerHTML = html;
    var sections = $('sections');
    sections.parentNode.insertBefore(wrap, sections.nextSibling);
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

        // Populate the phone country-code dropdown. US is emitted first in
        // DIAL_CODES and pre-selected — the field is used mostly by US
        // creators. The option value is just the dial code (e.g. "+1"), so
        // NANP siblings (US / Canada / Caribbean) all submit the same prefix;
        // showing the country in the label is for the creator's recognition.
        //
        // Two labels per option: the compact "dial code only" text shown in
        // the collapsed select, and the full "+1 · United States" label shown
        // in the open dropdown. The open-label lives on a data attribute; a
        // focus/blur handler swaps the option's visible text between the two
        // (browsers use the selected option's .text for the collapsed view,
        // so this trick avoids a full custom-dropdown widget).
        var phoneSel = $('phoneCountry');
        phoneSel.innerHTML = DIAL_CODES.map(function (row, i) {
          var dial = row[1];
          var full = dial + ' · ' + row[0];
          return '<option value="' + esc(dial) + '" data-full="' + esc(full) + '"' +
            (i === 0 ? ' selected' : '') + '>' + esc(dial) + '</option>';
        }).join('');
        function setPhoneOptionText(useFull) {
          for (var i = 0; i < phoneSel.options.length; i += 1) {
            var opt = phoneSel.options[i];
            opt.text = useFull ? (opt.getAttribute('data-full') || opt.value) : opt.value;
          }
        }
        // mousedown fires before the dropdown opens, so options are already
        // expanded to full labels when the list appears. blur/change collapses
        // them back so the selected option renders as just the dial code.
        phoneSel.addEventListener('mousedown', function () { setPhoneOptionText(true); });
        phoneSel.addEventListener('focus', function () { setPhoneOptionText(true); });
        phoneSel.addEventListener('change', function () { setPhoneOptionText(false); });
        phoneSel.addEventListener('blur', function () { setPhoneOptionText(false); });

        // Payment currency label on page 2.
        $('payCurrency').textContent = d.currency || 'USD';

        // Default the signed date to today.
        $('signedDate').value = new Date().toISOString().slice(0, 10);

        $('loading').hidden = true;
        if (c.status && c.status !== 'pending') {
          // Already signed: show the contract itself (read-only) with a banner
          // noting the creator has signed, instead of the bare confirmation.
          showSigned(c);
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

  // A field is "required" on page 2 only if the block wrapping it is visible
  // for the selected country. That way we don't demand an IFSC from a US
  // creator (whose India row is hidden) or an IBAN from an American.
  function blockVisible(blockId) {
    var el = $(blockId);
    return !!el && !el.hidden;
  }

  // Final submit → package everything into the contract submission.
  function finalSubmit(e) {
    e.preventDefault();
    var btn = $('btn-submit');
    var errEl = $('err2');
    errEl.textContent = '';

    // Every visible page-2 field must be filled. Ordered so the highlight
    // always lands on the FIRST missing field.
    var checks = [
      { id: 'bankHolder',  label: 'the account holder name', block: null },
      { id: 'bankName',    label: 'your bank name',          block: null },
      { id: 'bankAccount', label: 'your account number',     block: 'accountNumBlock' },
      { id: 'bankAccountConfirm', label: 'the confirmation account number', block: 'accountNumBlock' },
      { id: 'bankIban',    label: 'your IBAN',               block: 'ibanBlock' },
      { id: 'bankRouting', label: 'your routing number',     block: 'routingBlock' },
      { id: 'bankIfsc',    label: 'your IFSC code',          block: 'indiaRow' },
      { id: 'bankPan',     label: 'your PAN number',         block: 'indiaRow' },
      { id: 'bankSwift',   label: 'your SWIFT code',         block: 'swiftBlock' },
      { id: 'bankTaxId',   label: 'your tax ID number',      block: null },
    ];
    for (var i = 0; i < checks.length; i += 1) {
      var c = checks[i];
      if (c.block && !blockVisible(c.block)) continue;
      var v = ($(c.id).value || '').trim();
      if (!v) {
        errEl.textContent = 'Please enter ' + c.label + '.';
        highlight(c.id);
        return;
      }
    }

    var acct = ($('bankAccount').value || '').trim();
    var acct2 = ($('bankAccountConfirm').value || '').trim();
    if (blockVisible('accountNumBlock') && acct !== acct2) {
      errEl.textContent = 'Account number and confirmation do not match.';
      highlight('bankAccountConfirm');
      return;
    }

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
        phone: (function () {
          // Recombine the country code + local number into a single E.164-ish
          // string on submit so the stored payload stays the same shape it was
          // before this field became two controls ("+1 (555) 123-4567").
          var local = ($('phone').value || '').trim();
          if (!local) return null;
          var dial = ($('phoneCountry').value || '').trim();
          return dial ? (dial + ' ' + local) : local;
        })(),
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
    lockSecretFields();
    $('page1').addEventListener('submit', goToPage2);
    $('page2').addEventListener('submit', finalSubmit);
    $('btn-back').addEventListener('click', goBackToPage1);
    load();
  });
})();
