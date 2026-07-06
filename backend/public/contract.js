(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var token = (location.pathname.match(/\/contracts\/([^/?#]+)/) || [])[1] || '';

  // ── Comprehensive country list (ISO 3166-1 plus common territories) ─────
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
  // Countries whose citizens typically use an IBAN (SEPA + a few extras).
  var IBAN_COUNTRIES = new Set([
    'Albania','Andorra','Austria','Belgium','Bosnia and Herzegovina','Bulgaria','Croatia','Cyprus','Czechia',
    'Denmark','Estonia','Faroe Islands','Finland','France','Georgia','Germany','Gibraltar','Greece','Greenland',
    'Guernsey','Hungary','Iceland','Ireland','Isle of Man','Italy','Jersey','Kosovo','Latvia','Liechtenstein',
    'Lithuania','Luxembourg','Malta','Moldova','Monaco','Montenegro','Netherlands','North Macedonia','Norway',
    'Poland','Portugal','Romania','San Marino','Serbia','Slovakia','Slovenia','Spain','Sweden','Switzerland',
    'Ukraine','United Kingdom','Vatican City',
  ]);

  function fmtMoney(n, cur) {
    if (n == null || isNaN(Number(n))) return null;
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur || 'USD', maximumFractionDigits: 0 }).format(Number(n));
    } catch (e) { return (cur ? cur + ' ' : '$') + Number(n).toLocaleString('en-US'); }
  }
  function fmtNum(n) { return n == null || isNaN(Number(n)) ? null : Number(n).toLocaleString('en-US'); }
  function ord(n) {
    var s = ['th','st','nd','rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  function percentWord(n) {
    var map = { 10:'ten', 20:'twenty', 25:'twenty-five', 30:'thirty', 33:'thirty-three', 40:'forty', 50:'fifty', 60:'sixty', 67:'sixty-seven', 70:'seventy', 75:'seventy-five', 80:'eighty', 90:'ninety' };
    return map[n] ? map[n] : String(n);
  }

  // ── Render the numbered contract sections from the extracted data ────────
  function renderSections(d) {
    var brand = d.brandLegalName || d.brandName || 'the brand';
    // The brand often ends with a period (e.g. "Reve AI, Inc.") that already
    // terminates a sentence — avoid printing "Inc.." by using this helper
    // whenever we're about to append our own "." right after the brand.
    var brandEnd = String(brand).replace(/\.$/, '');
    var brandShort = d.brandName || brand;
    var n = Number(d.numberOfVideos || d.numberOfDeliverables || 2);
    var minViews = Number(d.minTotalViews || d.guaranteedViews || 0);
    var platforms = Array.isArray(d.platforms) && d.platforms.length ? d.platforms : ['Instagram'];
    var platformsText = platforms.length === 1 ? platforms[0] : platforms.slice(0, -1).join(', ') + ' and ' + platforms[platforms.length - 1];
    var revisions = Number(d.revisionRounds || 2);
    var deadlineText = d.postingDeadline || d.deadline || 'the agreed deadline';
    var months = Number(d.postLiveMonths || 6);
    var total = Number(d.totalPayment != null ? d.totalPayment : d.compensation);
    var currency = d.currency || 'USD';
    var paymentDays = Number(d.paymentTermsDays || 7);
    var up = Number(d.upfrontPercent || 30);
    var rem = Number(d.remainderPercent || (100 - up));
    var upTrigger = d.upfrontTrigger || 'upon sharing the first video draft';
    var remTrigger = d.remainderTrigger || 'after deliverables outlined in this agreement are completed, posted and confirmed live';
    var bonusAmt = d.bonusAmount != null ? Number(d.bonusAmount) : null;
    var bonusThr = d.bonusThresholdViews != null ? Number(d.bonusThresholdViews) : null;
    var bonusWin = Number(d.bonusWindowDays || 30);
    var usageList = Array.isArray(d.usageRightsList) && d.usageRightsList.length
      ? d.usageRightsList
      : ['ads', 'reposting', 'promotion', 'testimonials', 'paid and organic marketing across any channels'];
    var usageScope = d.usageScope || 'non exclusive, royalty free, and worldwide';
    var paidIncluded = d.paidAdsIncluded === true;
    var includeDm = d.includeDmAutomation !== false;
    var windows = Array.isArray(d.postingWindows) ? d.postingWindows : [];

    var html = '';

    // 1. Deliverables
    html += '<h2 class="section">1. Deliverables</h2>';
    html += '<p class="clause">- The creator agrees to create and publish <strong>' + n + ' video' + (n === 1 ? '' : 's') + '</strong>.</p>';
    html += '<hr class="rule" />';
    html += '<p class="clause">The creator agrees to the following requirements:</p>';
    if (minViews > 0) {
      html += '<p class="clause">- Deliver a <strong>minimum total of ' + fmtNum(minViews) + ' views</strong> across all posted videos on ' + esc(platforms[0]) + '.</p>';
      html += '<hr class="rule" />';
      html += '<p class="clause">- The creator must publish additional videos until the total view count across all posted videos on ' + esc(platforms[0]) + ' meets or exceeds ' + fmtNum(minViews) + ' views.</p>';
      html += '<hr class="rule" />';
    }
    if (includeDm) {
      html += '<p class="clause">- Implement and run DM automation using ManyChat or a similar tool as part of the posting and distribution process.</p>';
    }

    // 2. Platform and Posting Guidelines
    html += '<h2 class="section">2. Platform and Posting Guidelines</h2>';
    html += '<p class="clause">- All videos must be posted on <strong>' + esc(platformsText) + '.</strong></p>';
    html += '<hr class="rule" />';
    html += '<p class="clause">- Creator must send all drafts to INFLUENCE for review and approval before posting, with up to <strong>' + (revisions === 1 ? 'one round' : revisions === 2 ? 'two rounds' : revisions === 3 ? 'three rounds' : (revisions + ' rounds')) + '</strong> of revisions included.</p>';
    html += '<hr class="rule" />';
    html += '<p class="clause">- Creator agrees to make reasonable edits requested by INFLUENCE or ' + esc(brandEnd) + '.</p>';

    // 3. Timeline
    html += '<h2 class="section">3. Timeline</h2>';
    html += '<p class="clause">- The required videos must be posted <strong>no later than ' + esc(deadlineText) + '</strong>.</p>';
    if (windows.length) {
      html += '<div class="italic-block"><p>- We\'re flexible with the exact dates of uploads, but here is a suggested posting window' + (minViews ? ', assuming you\'ll hit the ' + fmtNum(minViews) + ' minimum view requirement across ' + n + ' posts' : '') + ':</p><ul>';
      windows.forEach(function (w) {
        html += '<li>- ' + esc(w.label) + ': ' + esc(w.range) + '</li>';
      });
      html += '</ul></div>';
    }

    // 4. Content Usage Rights
    html += '<h2 class="section">4. Content Usage Rights</h2>';
    html += '<p class="clause">- INFLUENCE and ' + esc(brand) + ' have the right to use the creator\'s content for:</p>';
    html += '<ul class="bullets">';
    usageList.forEach(function (u) { html += '<li>- ' + esc(u) + '</li>'; });
    html += '</ul>';
    html += '<p class="clause">- These rights are <strong>' + esc(usageScope) + '.</strong></p>';
    html += '<hr class="rule" />';
    if (paidIncluded) {
      html += '<p class="clause">- INFLUENCE and ' + esc(brand) + ' have the right to use the content for <strong>paid and organic promotional purposes</strong>.</p>';
      html += '<p class="clause"><strong>Paid advertising usage rights are included</strong> in this agreement.</p>';
    } else {
      html += '<p class="clause">- INFLUENCE and ' + esc(brand) + ' have the right to use the content for <strong>organic promotional purposes only</strong>.</p>';
      html += '<p class="clause"><strong>- Paid advertising usage rights are not included</strong> in this agreement.</p>';
    }

    // 5. Content Availability
    html += '<h2 class="section">5. Content Availability</h2>';
    html += '<p class="clause">- All posts must remain live and public for <strong>at least ' + months + ' month' + (months === 1 ? '' : 's') + '</strong> from the posting date.</p>';

    // 6. Compensation
    html += '<h2 class="section">6. Compensation</h2>';
    if (Number.isFinite(total)) {
      html += '<p class="clause">- The total agreed payment for this collaboration is <strong>' + fmtMoney(total, currency) + ' ' + esc(currency) + '.</strong></p>';
      html += '<hr class="rule" />';
    }
    html += '<p class="clause">- Payment will be made <strong>within ' + paymentDays + ' working days</strong> of completion of all deliverables, provided they are posted and confirmed live in accordance with the terms of this agreement.</p>';
    html += '<hr class="rule" />';
    html += '<p class="clause">- <strong>' + percentWord(up) + ' percent</strong> of the payment will be issued <strong>upfront</strong> ' + esc(upTrigger) + '.</p>';
    html += '<p class="clause">- The remaining <strong>' + percentWord(rem) + ' percent</strong> will be issued <strong>' + esc(remTrigger) + '</strong>.</p>';
    if (bonusAmt && bonusThr) {
      html += '<p class="clause">- Additional bonus of <strong>' + fmtMoney(bonusAmt, currency) + ' ' + esc(currency) + '</strong> to be paid if the total views of all content posted on ' + esc(platforms[0]) + ' crosses <strong>' + fmtNum(bonusThr) + ' views</strong> within the first <strong>' + bonusWin + ' days</strong> from the date each piece of content is posted.</p>';
    }
    html += '<p class="clause">- If the creator fails to complete the required deliverables or does not meet the minimum requirements stated in this agreement, INFLUENCE reserves the right to withhold payment.</p>';

    // Optional: additional negotiated terms captured by Claude
    if (Array.isArray(d.additionalTerms) && d.additionalTerms.length) {
      html += '<h2 class="section">7. Additional Terms</h2>';
      html += '<ul class="bullets">';
      d.additionalTerms.forEach(function (t) { html += '<li>- ' + esc(t) + '</li>'; });
      html += '</ul>';
    }
    if (d.specialNotes) {
      html += '<p class="clause"><em>' + esc(d.specialNotes) + '</em></p>';
    }

    $('sections').innerHTML = html;
  }

  // ── Signature pad ────────────────────────────────────────────────────────
  function initSigPad(canvas) {
    var ctx = canvas.getContext('2d');
    // Match the internal resolution to the CSS box for crisp strokes on any DPR.
    function resize() {
      var dpr = Math.max(1, window.devicePixelRatio || 1);
      var box = canvas.getBoundingClientRect();
      canvas.width = Math.floor(box.width * dpr);
      canvas.height = Math.floor(box.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.strokeStyle = '#101010';
    }
    resize();
    window.addEventListener('resize', resize);
    var drawing = false, last = null, dirty = false;
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
    canvas.addEventListener('mousemove', move);
    window.addEventListener('mouseup', end);
    canvas.addEventListener('touchstart', start, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    canvas.addEventListener('touchend', end);

    return {
      isEmpty: function () { return !dirty; },
      clear: function () { ctx.clearRect(0, 0, canvas.width, canvas.height); dirty = false; },
      toDataUrl: function () { return dirty ? canvas.toDataURL('image/png') : null; },
    };
  }

  // ── Bank-section visibility depending on the address country ────────────
  function updateBankVisibility(country) {
    var isUS = country === 'United States';
    var isIN = country === 'India';
    var isIBAN = IBAN_COUNTRIES.has(country);
    $('routingBlock').hidden = !isUS;
    $('ifscBlock').hidden = !isIN;
    $('panBlock').hidden = !isIN;
    $('swiftBlock').hidden = isIN; // India uses IFSC/PAN instead
    $('ibanBlock').hidden = !isIBAN;
  }

  // ── Load + wire everything up ───────────────────────────────────────────
  function markSigned() {
    $('page1').hidden = true; $('page2').hidden = true; $('done').hidden = false;
  }

  function load() {
    if (!token) { $('loading').hidden = true; $('notfound').hidden = false; return; }
    fetch('/api/contracts/' + encodeURIComponent(token))
      .then(function (r) { if (!r.ok) throw new Error('not found'); return r.json(); })
      .then(function (c) {
        var d = c.data || {};
        // Title: "Influencer Agreement: INFLUENCE x <creator> for <brand>"
        $('title').textContent = 'Influencer Agreement: INFLUENCE x ' + (d.creatorName || 'Creator Name') + ' for ' + (d.brandName || 'Brand Name');
        // Intro line with company legal name + address.
        $('intro').innerHTML = 'This agreement is between <strong>' + esc(d.companyLegalName || 'Influence Inc.') + '</strong>, located at ' + esc(d.companyLegalAddress || '8 The Green, STE R, Dover, Delaware, 19901, United States') + ' (the "Company"), and the creator listed below (the "Creator").';
        // Static header lines
        $('hdrIg').textContent = d.instagramUsername ? '@' + String(d.instagramUsername).replace(/^@/, '') : '—';
        $('hdrBrand').textContent = d.brandLegalName || d.brandName || '—';
        $('hdrCampaign').textContent = d.campaignName || '—';
        // Prefill identity fields
        if (d.creatorName) $('legalName').value = d.creatorName;
        if (d.email) $('contactEmail').value = d.email;
        // Numbered sections
        renderSections(d);
        // Payment currency label on page 2
        $('payCurrency').textContent = d.currency || 'USD';

        // Country dropdown
        var sel = $('addrCountry');
        sel.innerHTML = '<option value="">Country</option>' +
          COUNTRIES.map(function (c) { return '<option value="' + esc(c) + '">' + esc(c) + '</option>'; }).join('');
        sel.addEventListener('change', function () { updateBankVisibility(sel.value); });
        updateBankVisibility('');

        // Default the signed date to today
        $('signedDate').value = new Date().toISOString().slice(0, 10);

        $('loading').hidden = true;
        if (c.status && c.status !== 'pending') { markSigned(); return; }
        $('page1').hidden = false;
      })
      .catch(function () { $('loading').hidden = true; $('notfound').hidden = false; });
  }

  var sig;

  function goToPage2(e) {
    e.preventDefault();
    var errEl = $('err1');
    errEl.textContent = '';

    var name = ($('legalName').value || '').trim();
    if (!name) { errEl.textContent = 'Please type the creator\'s full legal name.'; return; }
    if (sig.isEmpty()) { errEl.textContent = 'Please sign in the signature box above.'; return; }
    if (!$('agree').checked) { errEl.textContent = 'Please confirm you understand and accept all terms.'; return; }

    $('page1').hidden = true;
    $('page2').hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

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
        contactEmail: $('contactEmail').value || null,
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
        btn.disabled = false; btn.textContent = 'Submit →';
      });
  }

  document.addEventListener('DOMContentLoaded', function () {
    sig = initSigPad($('sig'));
    $('sig-clear').addEventListener('click', function () { sig.clear(); });
    $('page1').addEventListener('submit', goToPage2);
    $('page2').addEventListener('submit', finalSubmit);
    load();
  });
})();
