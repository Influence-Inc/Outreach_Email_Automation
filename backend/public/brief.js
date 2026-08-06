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

  // Return an embeddable iframe src for known providers (Google Drive files,
  // YouTube), else null so the link renders as a plain link instead.
  function embedSrc(url) {
    if (!url) return null;
    var m = url.match(/drive\.google\.com\/file\/d\/([^/?#]+)/);
    if (m) return 'https://drive.google.com/file/d/' + m[1] + '/preview';
    m = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
    if (m) return 'https://www.youtube.com/embed/' + m[1];
    return null;
  }
  // A single media reference — embedded when we recognise it, else a link.
  function media(url, label) {
    var src = embedSrc(url);
    if (src) {
      return '<figure class="embed"><iframe src="' + esc(src) +
        '" loading="lazy" allow="autoplay; encrypted-media; fullscreen" allowfullscreen referrerpolicy="no-referrer"></iframe>' +
        (has(label) ? '<figcaption>' + esc(label) + '</figcaption>' : '') + '</figure>';
    }
    return '<div class="media-link">' + link(url, has(label) ? label : url) + '</div>';
  }
  function mediaList(items) {
    return '<div class="media-list">' + items.map(function (it) { return media(it.url, it.label); }).join('') + '</div>';
  }
  function section(title, inner) { return '<section class="blk"><h2>' + esc(title) + '</h2>' + inner + '</section>'; }
  function prose(text) { return '<p class="prose">' + esc(text) + '</p>'; }

  function render(d) {
    if (!d) { showState('notfound'); return; }
    var brand = d.brand || {};
    var post = d.posting || {};
    var cap = post.caption || {};
    var dm = post.dmAutomation || {};
    var creator = d.creator || {};
    var html = '';

    // ── Header ──────────────────────────────────────────────────────────────
    // (The INFLUENCE logo lives in the page masthead — see brief.html.)
    html += '<h1>Content Brief &amp; Guidelines</h1>';
    html += '<p class="prepared">Prepared by INFLUENCE</p>';
    if (has(creator.handle) || has(creator.firstName)) {
      html += '<p class="for">For ' + esc(creator.handle || creator.firstName) + '</p>';
    }

    // ── Quick info ──────────────────────────────────────────────────────────
    var q = [];
    if (has(brand.name)) q.push('<b>Brand:</b> ' + esc(brand.name));
    if (has(d.campaignNarrative)) q.push('<b>What is it:</b> ' + esc(d.campaignNarrative));
    if (has(brand.websiteUrl) || has(brand.website)) q.push('<b>Website:</b> ' + link(brand.websiteUrl, brand.website || brand.websiteUrl));
    if (has(brand.freeAccountLink)) q.push('<b>Free account:</b> ' + link(brand.freeAccountLink));
    if (q.length) {
      html += '<div class="callout star"><div class="c-title">★ Quick info</div><ul class="kv">' +
        q.map(function (i) { return '<li>' + i + '</li>'; }).join('') + '</ul></div>';
    }

    // ── Expected views ──────────────────────────────────────────────────────
    if (d.expectedViews && has(d.expectedViews.display)) {
      html += '<div class="callout"><div class="c-title">Expected views</div>' +
        '<div class="views"><span class="big num">' + esc(d.expectedViews.display) + '</span>' +
        '<span class="sub">No pressure :)</span></div></div>';
    }

    // ── 1. Before you film ──────────────────────────────────────────────────
    var pre = '';
    if (has(d.contentDirection)) pre += section('Content direction', prose(d.contentDirection));
    if (has(d.screenFlowInstructions)) pre += section('Features to use', prose(d.screenFlowInstructions));
    if (has(d.whyViral)) pre += section('Why it works', prose(d.whyViral));
    if (Array.isArray(brand.demoLinks) && brand.demoLinks.length) {
      pre += section('Demos', mediaList(brand.demoLinks.map(function (u) { return { url: u, label: '' }; })));
    }
    if (Array.isArray(d.topVideos) && d.topVideos.length) {
      pre += section('Top performing videos', '<p class="lead-in">References that show the direction we love:</p>' + mediaList(d.topVideos));
    }
    if (has(d.restrictions)) pre += section('Restrictions', '<ul class="bullets"><li>' + esc(d.restrictions) + '</li></ul>');
    if (has(d.targetAudience)) pre += section('Target audience', prose(d.targetAudience));
    if (has(d.rules)) pre += section('Guidelines', '<div class="rules">' + esc(d.rules) + '</div>');
    if (has(d.usageRights)) pre += section('Usage rights', '<div class="usage">' + esc(d.usageRights) + '</div>');
    if (pre) html += '<h3 class="phase-h">1 · Before you film</h3>' + pre;

    // ── 2. After you post ───────────────────────────────────────────────────
    var items = [];
    var capBits = [];
    if (has(cap.mentionHandle)) capBits.push('Mention ' + esc(cap.mentionHandle));
    if (has(cap.commentWord)) capBits.push('ask viewers to comment <span class="chip">' + esc(cap.commentWord) + '</span> for the link');
    if (has(cap.viaTag)) capBits.push('include ' + esc(cap.viaTag));
    if (has(cap.hashtags)) capBits.push('add ' + esc(cap.hashtags));
    if (capBits.length) items.push({ t: 'Caption', b: capBits.join('; ') + '.' });
    if (has(dm.keyword) || has(dm.link)) {
      var dmb = has(dm.keyword)
        ? 'Set viewers to comment <span class="chip">' + esc(dm.keyword) + '</span> and auto-DM them '
        : 'DM viewers ';
      dmb += 'your unique link' + (has(dm.link) ? ': ' + link(dm.link) : '.');
      items.push({ t: 'DM automation', b: dmb });
    }
    if (items.length) {
      html += '<h3 class="phase-h">2 · After you post</h3>' +
        '<section class="blk"><ul class="checklist">' +
        items.map(function (it) {
          return '<li><span class="box"></span><span class="ci"><b>' + esc(it.t) + '</b>' + it.b + '</span></li>';
        }).join('') + '</ul></section>';
    }

    // ── Footer ──────────────────────────────────────────────────────────────
    html += '<div class="foot">We’re excited to see what you create :)<br><b>— The INFLUENCE Team</b></div>';

    $('root').innerHTML = html;
    showState('root');
  }
})();
