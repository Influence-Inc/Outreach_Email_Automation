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

  // Cadence / posting-rhythm clauses ("posted at a cadence of 1-2 videos per
  // week", ", 2 per week") sometimes rode along on the extracted deliverables
  // string. They already have their own Cadence row in the Timeline section,
  // so keep them out of the Deliverables value. Mirrors the server-side
  // stripCadenceFromDeliverables applied at extraction time — this is the
  // defensive read-side pass that fixes contracts stored before that change.
  function stripCadenceFromDeliverables(text) {
    if (text == null) return text;
    var s = String(text);
    var out = s
      .replace(/\s*[,;—–\-]\s*(?:posted\s+)?(?:at\s+)?(?:a\s+)?(?:cadence|rhythm|frequency)\s+of[^.,;]*$/i, '')
      .replace(/\s*[,;—–\-]\s*posted\s+[^,;]*\bper\s+(?:week|day|month)\b[^.,;]*$/i, '')
      .replace(/\s*[,;—–\-]\s*(?:posted\s+)?(?:weekly|bi-?weekly|monthly|daily)\b[^.,;]*$/i, '')
      .replace(/\s*[,;—–\-]\s*[^,;]*\bper\s+(?:week|day|month)\b[^.,;]*$/i, '')
      .replace(/\s*[,;]+\s*$/, '')
      .trim();
    return out || s;
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
  // `combined` is the server's ready-made Additional Terms list (see the
  // /api/contracts/:token payload); the local merge below is only the fallback
  // for a page served alongside an older API response.
  function renderSections(d, combined) {
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
    // Optional minimum-video floor — a view-based-only term that is USUALLY
    // absent (the creator posts as many videos as needed to hit the guaranteed
    // view total, with no minimum count). Only render a "Minimum videos" row
    // when the negotiation actually set one; a null / zero minimum shows nothing.
    var minVideos = d.minVideos != null ? Number(d.minVideos) : null;
    var hasMinVideos = isViewBased && Number.isFinite(minVideos) && minVideos > 0;
    // For flat video-based deals the base extraction always writes the count
    // into the deliverables string itself ("1 short-form video", "3 short-form
    // videos"), so a separate "Number of deliverables: N" row just repeats
    // what's directly above it. Only show the row when the deliverables text
    // doesn't already carry a number — the edge case where a Claude
    // extraction produced a count-less description like "Instagram Reel and
    // TikTok short" and the numeric count is genuinely extra information.
    // Cadence lives in the Timeline section only — never inside the Deliverables
    // value. Strip any "posted at a cadence of 1-2 videos per week" tail that
    // was stitched onto deliverables by an older extraction so already-stored
    // contracts stop duplicating the Cadence row inside this value.
    var deliverablesText = stripCadenceFromDeliverables(String(d.deliverables || ''));
    d.deliverables = deliverablesText;
    var deliverablesHasCount = /\d/.test(deliverablesText);
    // View-based deals are priced by a guaranteed TOTAL Instagram view count
    // aggregated across every post the creator publishes on Instagram — the
    // fee doesn't buy a fixed number of videos, it buys that view total. The
    // creator's obligation is therefore to KEEP publishing on Instagram until
    // the combined view count across their Instagram posts meets or exceeds
    // the guaranteed number. Spell that out as its own row (using ongoing-
    // obligation phrasing rather than a static "floor") and label the number
    // itself so it can't be misread as a per-post minimum.
    var guaranteedViewsLabel = isViewBased ? 'Guaranteed total views' : 'Min. guaranteed views';
    var guaranteedViewsValue = isViewBased && minViews
      ? fmtNum(minViews) + ' — combined across all posts on Instagram'
      : (minViews ? fmtNum(minViews) : null);
    // View-counting window: how many days from each post's publish date its
    // views count toward the deal's view target / bonus. Legacy contracts carry
    // only bonusWindowDays, so fall back to it, then to the standing 30-day
    // default, so every view-requirement deal reads a definite window.
    var viewDays = d.viewCountingDays != null
      ? Number(d.viewCountingDays)
      : (d.bonusWindowDays != null ? Number(d.bonusWindowDays) : 30);
    // A full, self-contained sentence spelling the window out as PER-POST — each
    // post has its own count starting the day it goes live, NOT one shared
    // window across every post — so a multi-post deal can't be misread (e.g.
    // "in 14 days" sounds like 14 days total). Reused verbatim as the view-based
    // counting-window row and as the second sentence of the bonus row, so it
    // starts with a capital and reads correctly in either place.
    var countingWindowText =
      'Views for each post are counted for ' + viewDays + ' days from the day it is posted.';
    html += section('Campaign & Deliverables', rowsWrap(
      row('Campaign', d.campaignName) +
      (platforms ? '<div class="k">Platforms</div><div class="v">' + platforms + '</div>' : '') +
      row('Deliverables', d.deliverables) +
      (isViewBased || deliverablesHasCount
        ? ''
        : row('Number of deliverables', fmtNum(d.numberOfDeliverables || d.numberOfVideos))) +
      // Minimum-video floor: only shown for a view-based deal that actually set
      // one (the usual case has none). It's a floor on the number of posts, on
      // top of the guaranteed view total below.
      (hasMinVideos
        ? row('Minimum videos', 'At least ' + fmtNum(minVideos) + ' video' + (minVideos === 1 ? '' : 's'))
        : '') +
      // Min. guaranteed views is a view-based term — a flat video-based deal is
      // priced per video and promises no view floor, so never show it there.
      (!isVideoBased && minViews ? row(guaranteedViewsLabel, guaranteedViewsValue) : '') +
      // Posting commitment for view-based deals: the deal isn't complete when a
      // single video is posted — the creator must continue publishing short-
      // form video content on Instagram until the total combined view count
      // across all of their Instagram posts meets or exceeds the guaranteed
      // number above. Called out as its own row so it's impossible to miss.
      (isViewBased && minViews
        ? row(
            'Posting commitment',
            'The creator keeps posting short-form videos on Instagram until the combined views across all their posts reach at least ' +
              fmtNum(minViews) +
              '. The deliverable is complete only once that combined total is reached.'
          )
        : '') +
      // View-counting window for a view-based deal: the time bound on the views
      // above — each post's views count for this many days from when it goes
      // live. A bonus deal shows the same window inline in its Performance bonus
      // row below, so it isn't repeated here.
      (isViewBased && minViews
        ? row('View counting window', countingWindowText)
        : '')
      // The performance bonus is a payment term — it renders in full (with the
      // base / bonus / total breakdown) in the Compensation & Payment section
      // below, so it's intentionally NOT repeated here.
    ));

    // Cadence only makes sense when there's more than one video to pace out.
    // A single-video deal has one drop date, not a rhythm.
    var deliverableCount = Number(d.numberOfDeliverables != null ? d.numberOfDeliverables : d.numberOfVideos);
    var showCadence = !(Number.isFinite(deliverableCount) && deliverableCount <= 1);
    html += section('Timeline', rowsWrap(
      (showCadence ? row('Cadence', d.timeline) : '') +
      row('Deadline', d.postingDeadline || d.deadline)
    ));

    // On a video+bonus deal the stored `compensation` is the GUARANTEED BASE and
    // the performance bonus is paid ON TOP, so the total incl. bonus is base +
    // bonus. Read the base straight off `compensation` — never derive it by
    // subtracting the bonus, which drove a negative "Compensation" when the
    // bonus was larger than an out-of-date total. Fall back to totalPayment only
    // when compensation is absent (older rows that stored just the one figure).
    var baseComp = d.compensation != null ? Number(d.compensation)
      : (d.totalPayment != null ? Number(d.totalPayment) : null);
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
    var hasBonus = d.bonusAmount && d.bonusThresholdViews;
    var totalIncl = hasBonus && baseComp != null ? baseComp + Number(d.bonusAmount) : baseComp;
    html += section('Compensation & Payment', rowsWrap(
      row('Compensation', fmtMoney(baseComp, d.currency), { big: true }) +
      (hasBonus
        ? row('Performance bonus', fmtMoney(d.bonusAmount, d.currency) + ' if total views reach ' + fmtNum(d.bonusThresholdViews) + '. ' + countingWindowText)
        : '') +
      (hasBonus
        ? row('Total (incl. bonus)', fmtMoney(totalIncl, d.currency))
        : '') +
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

    // Additional terms — any extra points on THIS contract: the terms the
    // extraction pulled from the email thread (additionalTerms) plus the points
    // the team added by hand from the dashboard (manualTerms), which live in
    // their own field so a re-extraction never wipes them. The server merges the
    // two (dropping the extraction's paraphrase of a hand-pasted clause, which
    // otherwise put the same point on the contract twice) and sends the finished
    // list as `combinedTerms`; the local merge below is the fallback for an older
    // API response that carries only the two raw fields. Rendered as a bulleted
    // list under its own section — shown ONLY when there is at least one point,
    // so a contract with none shows nothing here.
    var extraTerms = Array.isArray(combined) ? combined : (function () {
      var norm = function (arr) {
        return (Array.isArray(arr) ? arr : []).map(function (t) {
          return String(t == null ? '' : t).trim();
        }).filter(Boolean);
      };
      // The deal's standing perks — "full creative freedom / no overly
      // promotional feel", "no paid ad rights required / organic use only", and
      // "no exclusivity required" — are pitched in every template, so the thread
      // extraction echoes them into additionalTerms. They must NEVER show
      // automatically (mirrors contracts.js isAutoSuppressedTerm; kept in sync by
      // hand since this browser script can't require the backend module). The
      // hand-added manual points (the Deals-column "Extra" field) are left
      // untouched, so the team can still add any of them explicitly. A genuinely
      // negotiated exclusivity WINDOW is kept — only the standing "no
      // exclusivity" perk is dropped.
      var suppressed = function (t) {
        var s = String(t == null ? '' : t).toLowerCase();
        if (!s.trim()) return false;
        var mentionsAdRights = /\b(?:paid )?ad(?:vertising)? rights?\b|\bpaid ads?\b/.test(s);
        var negated = /\b(?:no|not|without|only|organic)\b/.test(s);
        var organicOnly = /\borganic\b[^.]*\bonly\b|\borganic use\b/.test(s);
        if ((mentionsAdRights && negated) || organicOnly) return true;
        if (/\bcreative freedom\b/.test(s)) return true;
        if (/\boverly promotional\b|\bpromotional feel\b|\bfeel(?:ing)? like an ad\b/.test(s)) return true;
        var noExclusivity =
          /\bno\s+exclusivity\b/.test(s) ||
          /\bwithout\s+exclusivity\b/.test(s) ||
          /\bnon-?exclusiv/.test(s) ||
          /\bnot\s+exclusiv/.test(s) ||
          /\bexclusivity\s*[:=-]\s*(?:none|not required|no\b)/.test(s);
        if (noExclusivity) return true;
        return false;
      };
      var extracted = norm(d.additionalTerms).filter(function (t) { return !suppressed(t); });
      var list = [], seen = {};
      extracted.concat(norm(d.manualTerms)).forEach(function (t) {
        var key = t.toLowerCase();
        if (seen[key]) return;
        seen[key] = true;
        list.push(t);
      });
      return list;
    })();
    if (extraTerms.length) {
      html += '<div class="section"><h2>Additional Terms</h2><ul class="term-list">' +
        extraTerms.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') +
        '</ul></div>';
    }

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
  // Rendered as type=password so characters are masked at rest. Every secret
  // field reveals its value (type=text) while focused so the creator can read
  // back what they entered, and re-masks on blur. copy / cut / drag /
  // right-click stay blocked so the value can't be lifted back out even when
  // it's visible on screen.
  //
  // Paste is blocked by default — the account number must be typed, and the
  // confirm field can't just be pasted to match. IBANs opt out with
  // .secret-pastable: they're long, structured, and easy to mistype, so
  // pasting is the safer path; the confirm field still guards against a bad
  // paste on either side.
  function lockSecretFields() {
    var nodes = document.querySelectorAll('input.secret');
    for (var i = 0; i < nodes.length; i += 1) {
      var el = nodes[i];
      var allowPaste = el.classList.contains('secret-pastable');
      el.addEventListener('copy', function (e) { e.preventDefault(); });
      el.addEventListener('cut', function (e) { e.preventDefault(); });
      el.addEventListener('dragstart', function (e) { e.preventDefault(); });
      el.addEventListener('drop', function (e) { e.preventDefault(); });
      el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
      el.addEventListener('focus', function (e) { e.target.type = 'text'; });
      el.addEventListener('blur', function (e) { e.target.type = 'password'; });
      if (!allowPaste) {
        el.addEventListener('paste', function (e) { e.preventDefault(); });
      }
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
  // Takes the submit response itself, since two independent parts of the
  // confirmation depend on it:
  //   `whatsappOptIn` — { number, link } when the creator hasn't subscribed to
  //     our WhatsApp yet, null when they already have (or opted out, or the
  //     channel isn't configured), in which case the card stays hidden rather
  //     than inviting them to a chat they're already in.
  //   `copyEmailed` — true only when the executed PDF was actually emailed, so
  //     the confirmation never claims an inbox copy that didn't send.
  function markSigned(res) {
    var r = res || {};
    var optIn = r.whatsappOptIn;
    $('page1').hidden = true; $('page2').hidden = true; $('done').hidden = false;
    if (r.copyEmailed) $('done-copy').hidden = false;
    if (optIn && optIn.link) {
      $('wa-link').href = optIn.link;
      $('wa-num').textContent = optIn.number || '';
      $('wa-optin').hidden = false;
    }
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
    page1.hidden = false;
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
        renderSections(d, c.combinedTerms);


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
      { id: 'bankIbanConfirm', label: 'the confirmation IBAN', block: 'ibanBlock' },
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

    var iban = ($('bankIban').value || '').trim();
    var iban2 = ($('bankIbanConfirm').value || '').trim();
    if (blockVisible('ibanBlock') && iban !== iban2) {
      errEl.textContent = 'IBAN and confirmation do not match.';
      highlight('bankIbanConfirm');
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
          iban: iban || null,
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
        markSigned(res.j);
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
