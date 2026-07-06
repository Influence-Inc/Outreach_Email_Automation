(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  var token = (location.pathname.match(/\/contracts\/([^/?#]+)/) || [])[1] || '';

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

  function show(id) {
    ['loading', 'notfound', 'contract', 'done'].forEach(function (x) { $(x).hidden = x !== id; });
  }

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

  function renderSections(d) {
    var html = '';

    html += section('Parties', rowsWrap(
      row('Creator', d.creatorName, { big: true }) +
      row('Instagram', d.instagramUsername ? '@' + String(d.instagramUsername).replace(/^@/, '') : null) +
      row('Email', d.email) +
      row('Brand', d.brandName, { big: true })
    ));

    var platforms = pills(Array.isArray(d.platforms) ? d.platforms : (d.platforms ? [d.platforms] : []));
    html += section('Campaign & Deliverables', rowsWrap(
      row('Campaign', d.campaignName) +
      (platforms ? '<div class="k">Platforms</div><div class="v">' + platforms + '</div>' : '') +
      row('Deliverables', d.deliverables) +
      row('Number of deliverables', fmtNum(d.numberOfDeliverables)) +
      (d.guaranteedViews ? row('Guaranteed views', fmtNum(d.guaranteedViews)) : '')
    ));

    html += section('Timeline', rowsWrap(
      row('Timeline', d.timeline) + row('Deadline', d.deadline)
    ));

    html += section('Compensation & Payment', rowsWrap(
      row('Compensation', fmtMoney(d.compensation, d.currency), { big: true }) +
      row('Currency', d.currency) +
      row('Payment terms', d.paymentTerms)
    ));

    html += section('Usage Rights & Exclusivity', rowsWrap(
      row('Usage rights', d.usageRights) + row('Exclusivity', d.exclusivity)
    ));

    var extra = '';
    if (d.specialNotes) extra += '<p class="prose">' + esc(d.specialNotes) + '</p>';
    if (Array.isArray(d.additionalTerms) && d.additionalTerms.length) {
      extra += '<ul class="terms">' + d.additionalTerms.map(function (t) {
        return '<li>' + esc(t) + '</li>';
      }).join('') + '</ul>';
    }
    html += section('Additional Terms', extra);

    $('sections').innerHTML = html;
  }

  function markSigned(name) {
    $('sign').hidden = true;
    $('signed-banner').hidden = false;
    $('signed-banner-text').textContent =
      'This contract has been signed' + (name ? ' by ' + name : '') + '.';
  }

  function load() {
    if (!token) { show('notfound'); return; }
    fetch('/api/contracts/' + encodeURIComponent(token))
      .then(function (r) { if (!r.ok) throw new Error('not found'); return r.json(); })
      .then(function (c) {
        var d = c.data || {};
        $('eyebrow').textContent =
          [d.brandName, d.campaignName].filter(Boolean).join(' · ') || 'Collaboration';
        $('subhead').textContent = d.creatorName ? 'Prepared for ' + d.creatorName : '';
        renderSections(d);
        if ($('full-name')) $('full-name').value = d.creatorName || '';
        show('contract');
        if (c.status && c.status !== 'pending') markSigned(c.signerName);
      })
      .catch(function () { show('notfound'); });
  }

  function submit(e) {
    e.preventDefault();
    var btn = $('sign-btn');
    var errEl = $('sign-error');
    errEl.textContent = '';
    var name = ($('full-name').value || '').trim();
    if (!name) { errEl.textContent = 'Please type your full legal name to sign.'; return; }
    if (!$('agree').checked) {
      errEl.textContent = 'Please confirm you have read and agree to the terms.';
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Submitting…';
    fetch('/api/contracts/' + encodeURIComponent(token) + '/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signerName: name, agree: true }),
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error((res.j && res.j.error) || 'Something went wrong.');
        show('done');
      })
      .catch(function (err) {
        errEl.textContent = err.message || 'Something went wrong. Please try again.';
        btn.disabled = false;
        btn.textContent = 'Sign & submit contract';
      });
  }

  document.addEventListener('DOMContentLoaded', function () {
    var form = $('sign');
    if (form) form.addEventListener('submit', submit);
    load();
  });
})();
