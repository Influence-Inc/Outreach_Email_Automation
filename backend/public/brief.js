(function () {
  'use strict';

  // Resolve the brief by its unguessable token from the path (/brief/{token},
  // including when proxied through campaigns.influence.technology).
  var token = (location.pathname.match(/\/brief\/([^/?#]+)/) || [])[1] || '';

  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function link(url, label) {
    if (!url) return esc(label || '');
    return '<a href="' + esc(url) + '" target="_blank" rel="noopener nofollow">' + esc(label || url) + '</a>';
  }
  function has(v) { return v != null && String(v).trim() !== ''; }

  function showState(which) {
    $('loading').hidden = which !== 'loading';
    $('notfound').hidden = which !== 'notfound';
    $('root').hidden = which !== 'root';
  }

  if (!token) { showState('notfound'); return; }

  fetch('/api/briefs/' + encodeURIComponent(token))
    .then(function (r) { if (!r.ok) throw new Error('not found'); return r.json(); })
    .then(function (payload) { render(payload && payload.data); })
    .catch(function () { showState('notfound'); });

  function render(d) {
    if (!d) { showState('notfound'); return; }
    var brand = d.brand || {};
    var post = d.posting || {};
    var cap = post.caption || {};
    var dm = post.dmAutomation || {};
    var creator = d.creator || {};
    var html = '';

    // ── Header ──────────────────────────────────────────────────────────────
    html += '<div class="brandbar">INFLUENCE</div>';
    html += '<h1>Content Brief &amp; Guidelines</h1>';
    html += '<p class="prepared">Prepared by INFLUENCE</p>';
    if (has(creator.handle) || has(creator.firstName)) {
      html += '<p class="for">For ' + esc(creator.handle || creator.firstName) + '</p>';
    }

    // ── Quick info ──────────────────────────────────────────────────────────
    var q = [];
    if (has(brand.name)) {
      var brandLine = '<b>Brand:</b> ' + esc(brand.name);
      if (has(brand.pronunciation)) brandLine += ' (pronounced “' + esc(brand.pronunciation) + '”)';
      q.push(brandLine);
    }
    if (has(brand.whatIsIt)) q.push('<b>What is it:</b> ' + esc(brand.whatIsIt));
    if (has(brand.websiteUrl) || has(brand.website)) {
      q.push('<b>Website:</b> ' + link(brand.websiteUrl, brand.website || brand.websiteUrl));
    }
    if (has(brand.demoLink)) q.push('<b>Quick demo:</b> ' + link(brand.demoLink));
    if (has(brand.freeAccountLink)) q.push('<b>Free account:</b> ' + link(brand.freeAccountLink));
    if (q.length) {
      html += '<div class="callout star"><div class="c-title">★ Quick info</div><ul class="kv">';
      q.forEach(function (item) { html += '<li>' + item + '</li>'; });
      html += '</ul></div>';
    }

    // ── Expected views ──────────────────────────────────────────────────────
    if (d.expectedViews && has(d.expectedViews.display)) {
      html += '<div class="callout"><div class="c-title">Expected views</div>' +
        '<div class="views"><span class="big num">' + esc(d.expectedViews.display) + '</span>' +
        '<span class="sub">No pressure :)</span></div></div>';
    }

    // ── Content direction (per creator) ─────────────────────────────────────
    if (has(d.contentDirection)) {
      html += '<section class="blk"><h2>Content direction</h2>' +
        '<p class="prose">' + esc(d.contentDirection) + '</p></section>';
    }

    // ── Top performing videos (per creator) ─────────────────────────────────
    if (Array.isArray(d.topVideos) && d.topVideos.length) {
      html += '<section class="blk"><h2>Top performing videos</h2>' +
        '<p class="lead-in">A few references to show the direction we love:</p><ul class="vids">';
      d.topVideos.forEach(function (v, i) {
        var label = has(v.label) ? v.label : 'Example ' + (i + 1);
        html += '<li>' + link(v.url, label) + '</li>';
      });
      html += '</ul></section>';
    }

    // ── Filming & posting rules (universal boilerplate) ─────────────────────
    if (has(d.rules)) {
      html += '<section class="blk"><h2>Guidelines</h2><div class="rules">' + esc(d.rules) + '</div></section>';
    }

    // ── Usage rights ────────────────────────────────────────────────────────
    if (has(d.usageRights)) {
      html += '<section class="blk"><h2>Usage rights</h2><div class="usage">' + esc(d.usageRights) + '</div></section>';
    }

    // ── Posting checklist (campaign specifics) ──────────────────────────────
    var items = [];
    var capBits = [];
    if (has(cap.mentionHandle)) capBits.push('Mention ' + esc(cap.mentionHandle));
    if (has(cap.commentWord)) capBits.push('ask viewers to comment <span class="chip">' + esc(cap.commentWord) + '</span> for the link');
    if (has(cap.viaTag)) capBits.push('include ' + esc(cap.viaTag));
    if (has(cap.hashtags)) capBits.push('add ' + esc(cap.hashtags));
    if (capBits.length) items.push({ t: 'Caption', b: capBits.join('; ') + '.' });

    if (has(dm.keyword) || has(dm.link)) {
      var dmb = '';
      if (has(dm.keyword)) dmb += 'Set viewers to comment <span class="chip">' + esc(dm.keyword) + '</span> and auto-DM them ';
      else dmb += 'DM viewers ';
      dmb += 'your unique link' + (has(dm.link) ? ': ' + link(dm.link) : '.') ;
      items.push({ t: 'DM automation', b: dmb });
    }
    if (has(post.reviewUploadLink)) {
      items.push({ t: 'Upload for review', b: 'Before posting, upload your video for a quick brand review: ' + link(post.reviewUploadLink) + ' (24-hour turnaround).' });
    }
    if (has(post.submitLinksUrl)) {
      items.push({ t: 'Share your posted links', b: 'After posting, share your link(s) here: ' + link(post.submitLinksUrl) + '.' });
    }
    if (items.length) {
      html += '<section class="blk"><h2>After you post</h2><ul class="checklist">';
      items.forEach(function (it) {
        html += '<li><span class="box"></span><span class="ci"><b>' + esc(it.t) + '</b>' + it.b + '</span></li>';
      });
      html += '</ul></section>';
    }

    // ── Footer ──────────────────────────────────────────────────────────────
    html += '<div class="foot">We’re excited to see what you create :)<br><b>— The INFLUENCE Team</b></div>';

    $('root').innerHTML = html;
    showState('root');
  }
})();
