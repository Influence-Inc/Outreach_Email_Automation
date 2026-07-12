// Latches the Influence "Decide offer" panel to the right of an Instagram
// profile. The panel itself is an extension-origin iframe (panel.html) — using
// an extension frame keeps it isolated from Instagram's CSS and, unlike a
// dashboard-origin frame, isn't blocked by Instagram's page CSP. The iframe
// talks to the dashboard API directly (CORS is open server-side).
//
// Two ways the panel opens:
//   1. Auto — the dashboard "Decide offer" button opens this profile AND stores
//      a one-shot target (creator id + dashboard URL) that we pick up here.
//   2. Manual — a slim "Deal" tab on the right edge of any profile; clicking it
//      opens the panel resolved by the profile's @username.
(function () {
  'use strict';

  if (window.__infDealPanelLoaded) return;
  window.__infDealPanelLoaded = true;

  const PANEL_WIDTH = 390;
  const RESERVED = new Set(['reels', 'reel', 'p', 'tagged', 'explore', 'stories', 'tv', 'direct', 'accounts', 'about']);

  const state = {
    open: false,
    username: null,
    // The target currently shown in the iframe, so SPA nav only re-posts when it
    // actually changes.
    shownKey: null,
    apiBase: null,
  };

  // ---- Profile detection --------------------------------------------------
  function currentUsername() {
    const seg = (location.pathname || '/').split('/').filter(Boolean);
    if (!seg.length) return null;
    const first = seg[0].toLowerCase();
    if (RESERVED.has(first)) return null;
    // A profile URL is a single segment (/username/) or a profile sub-tab
    // (/username/reels/). Deep post URLs (/p/..., /reel/...) are excluded above.
    return seg[0];
  }

  // ---- Storage: dashboard URL + one-shot decide-offer targets -------------
  function storageGet(keys) {
    return new Promise((resolve) => {
      try { chrome.storage.local.get(keys, (v) => resolve(v || {})); }
      catch { resolve({}); }
    });
  }
  function storageSet(obj) {
    return new Promise((resolve) => {
      try { chrome.storage.local.set(obj, () => resolve()); }
      catch { resolve(); }
    });
  }

  // Resolve what the panel should show for the current profile. A pending
  // decide-offer target (keyed by username) wins and is consumed one-shot so it
  // doesn't re-fire on later manual visits. Returns null if we can't build a
  // target (no username).
  async function resolveTarget(username) {
    if (!username) return null;
    const { infDashboardApiBase, infPendingOffers } = await storageGet([
      'infDashboardApiBase',
      'infPendingOffers',
    ]);
    const pending = infPendingOffers && infPendingOffers[username.toLowerCase()];
    if (pending) {
      // Consume it so a later manual visit to the same profile doesn't auto-open.
      const map = { ...(infPendingOffers || {}) };
      delete map[username.toLowerCase()];
      await storageSet({ infPendingOffers: map });
      const apiBase = pending.apiBase || infDashboardApiBase || null;
      if (apiBase) await storageSet({ infDashboardApiBase: apiBase });
      return {
        auto: true,
        apiBase,
        creatorId: pending.creatorId || null,
        campaignId: pending.campaignId || null,
        username,
      };
    }
    return { auto: false, apiBase: infDashboardApiBase || null, creatorId: null, campaignId: null, username };
  }

  // ---- DOM: style, container, iframe, launcher ----------------------------
  function injectStyle() {
    if (document.getElementById('inf-deal-panel-style')) return;
    const style = document.createElement('style');
    style.id = 'inf-deal-panel-style';
    style.textContent = `
      #inf-deal-panel {
        position: fixed; top: 0; right: 0; height: 100vh; width: ${PANEL_WIDTH}px;
        z-index: 2147483000; background: #f5f4f0; border-left: 1px solid #dcdad3;
        box-shadow: -8px 0 24px rgba(20,18,15,0.10); display: flex; flex-direction: column;
        transform: translateX(100%); transition: transform 0.22s ease;
      }
      #inf-deal-panel.open { transform: translateX(0); }
      #inf-deal-panel .inf-bar {
        display: flex; align-items: center; gap: 8px; padding: 9px 12px;
        background: #191817; color: #fff; flex-shrink: 0;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      }
      #inf-deal-panel .inf-bar .inf-title { font-size: 13px; font-weight: 600; flex: 1; letter-spacing: 0.01em; }
      #inf-deal-panel .inf-bar button {
        background: rgba(255,255,255,0.12); border: none; color: #fff; cursor: pointer;
        width: 26px; height: 26px; border-radius: 7px; font-size: 15px; line-height: 1;
        display: flex; align-items: center; justify-content: center;
      }
      #inf-deal-panel .inf-bar button:hover { background: rgba(255,255,255,0.24); }
      #inf-deal-panel iframe { flex: 1; width: 100%; border: 0; background: #f5f4f0; }

      #inf-deal-launcher {
        position: fixed; top: 50%; right: 0; transform: translateY(-50%);
        z-index: 2147482999; background: #191817; color: #fff; cursor: pointer;
        writing-mode: vertical-rl; text-orientation: mixed; padding: 14px 7px;
        border-radius: 10px 0 0 10px; font-family: 'Inter', -apple-system, sans-serif;
        font-size: 12px; font-weight: 600; letter-spacing: 0.04em; border: none;
        box-shadow: -3px 0 12px rgba(20,18,15,0.18); display: none;
      }
      #inf-deal-launcher:hover { background: #000; }
      #inf-deal-launcher.hidden { display: none !important; }

      body.inf-panel-open main,
      body.inf-panel-open section[role='region'] { margin-right: ${PANEL_WIDTH}px !important; }
      @media (max-width: 1100px) {
        #inf-deal-panel { width: 340px; }
        body.inf-panel-open main, body.inf-panel-open section[role='region'] { margin-right: 340px !important; }
      }
    `;
    document.documentElement.appendChild(style);
  }

  function buildPanelUrl(target) {
    const url = new URL(chrome.runtime.getURL('panel.html'));
    if (target.apiBase) url.searchParams.set('apiBase', target.apiBase);
    if (target.creatorId) url.searchParams.set('creatorId', target.creatorId);
    else {
      url.searchParams.set('username', target.username);
      if (target.campaignId) url.searchParams.set('campaignId', target.campaignId);
    }
    return url.toString();
  }

  function targetKey(target) {
    return target.creatorId ? `id:${target.creatorId}` : `user:${(target.username || '').toLowerCase()}`;
  }

  function ensurePanel() {
    let panel = document.getElementById('inf-deal-panel');
    if (panel) return panel;
    injectStyle();
    panel = document.createElement('div');
    panel.id = 'inf-deal-panel';
    panel.innerHTML = `
      <div class="inf-bar">
        <span class="inf-title">Influence · Decide offer</span>
        <button class="inf-reload" title="Reload">↻</button>
        <button class="inf-close" title="Close">✕</button>
      </div>
      <iframe title="Influence offer panel" allow=""></iframe>`;
    document.documentElement.appendChild(panel);
    panel.querySelector('.inf-close').addEventListener('click', () => closePanel());
    panel.querySelector('.inf-reload').addEventListener('click', () => {
      const iframe = panel.querySelector('iframe');
      if (iframe && iframe.src) iframe.src = iframe.src; // eslint-disable-line no-self-assign
    });
    return panel;
  }

  function ensureLauncher() {
    let el = document.getElementById('inf-deal-launcher');
    if (el) return el;
    el = document.createElement('button');
    el.id = 'inf-deal-launcher';
    el.type = 'button';
    el.textContent = 'Deal ▸';
    el.title = 'Open the Influence offer panel for this creator';
    el.addEventListener('click', () => openForCurrentProfile(true));
    document.documentElement.appendChild(el);
    return el;
  }

  function setLauncherVisible(visible) {
    const el = ensureLauncher();
    el.style.display = visible ? 'block' : 'none';
  }

  // ---- Open / close -------------------------------------------------------
  function openPanel(target) {
    const panel = ensurePanel();
    const iframe = panel.querySelector('iframe');
    const key = targetKey(target);
    if (state.shownKey !== key) {
      // New target: (re)point the iframe. If it's already loaded on the same
      // apiBase, a lightweight postMessage retargets without a reload flash;
      // otherwise set src.
      if (iframe.src && state.apiBase === target.apiBase && iframe.contentWindow) {
        iframe.contentWindow.postMessage(
          {
            type: 'INF_PANEL_TARGET',
            creatorId: target.creatorId || null,
            username: target.creatorId ? null : target.username,
            campaignId: target.campaignId || null,
          },
          '*',
        );
      } else {
        iframe.src = buildPanelUrl(target);
      }
      state.shownKey = key;
      state.apiBase = target.apiBase;
    }
    panel.classList.add('open');
    document.body.classList.add('inf-panel-open');
    state.open = true;
    setLauncherVisible(false);
  }

  function closePanel() {
    const panel = document.getElementById('inf-deal-panel');
    if (panel) panel.classList.remove('open');
    document.body.classList.remove('inf-panel-open');
    state.open = false;
    // Forget the shown target so reopening reloads fresh data (a new timeline
    // entry may have landed while the panel was closed).
    state.shownKey = null;
    // Re-offer the launcher if we're still on a profile.
    setLauncherVisible(!!currentUsername());
  }

  async function openForCurrentProfile(manual) {
    const username = currentUsername();
    if (!username) return;
    const target = await resolveTarget(username);
    if (!target) return;
    openPanel(target);
  }

  // ---- Navigation handling (Instagram is a SPA) ---------------------------
  async function onNavigate() {
    const username = currentUsername();
    if (!username) {
      // Left a profile: close the panel and hide the launcher.
      if (state.open) closePanel();
      setLauncherVisible(false);
      state.username = null;
      return;
    }
    const changed = username !== state.username;
    state.username = username;
    setLauncherVisible(!state.open);

    const target = await resolveTarget(username);
    if (!target) return;

    // Auto-open on a fresh decide-offer hand-off.
    if (target.auto) {
      openPanel(target);
      return;
    }
    // Panel already open and we navigated to a different profile: retarget it.
    if (state.open && changed) {
      openPanel(target);
    }
  }

  // Watch SPA URL changes. Instagram mutates the DOM heavily, so debounce.
  let lastUrl = location.href;
  let navTimer = null;
  const scheduleNav = () => {
    clearTimeout(navTimer);
    navTimer = setTimeout(onNavigate, 250);
  };
  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      scheduleNav();
    }
  });
  observer.observe(document, { subtree: true, childList: true });
  window.addEventListener('popstate', scheduleNav);

  // First run.
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    onNavigate();
  } else {
    window.addEventListener('DOMContentLoaded', onNavigate);
  }

  console.log('[Influence] deal panel content script loaded');
})();
