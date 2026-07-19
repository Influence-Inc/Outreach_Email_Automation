// Bridges the Outreach dashboard page <-> the extension service worker.
//
// The dashboard cannot talk to the extension directly. It posts window.message
// events; this content script forwards them to background.js, and forwards
// background progress messages back to the page.
//
// This script is injected on every http/https page (so it works wherever the
// dashboard is hosted — Railway, a custom domain, localhost — without per-domain
// manifest edits). The marker check below keeps it completely inert on any page
// that isn't the Outreach dashboard.
(function () {
  'use strict';

  // Only the dashboard has these elements — bail immediately on every other site.
  const isDashboard =
    document.getElementById('brand-tree') ||
    document.getElementById('run-extension-btn');
  if (!isDashboard) return;

  const PAGE_TO_BG = {
    OEA_RUN_SCRAPE_QUEUE: 'runScrapeQueue',
    OEA_ABORT_SCRAPE_QUEUE: 'abortScrapeQueue',
    OEA_OPEN_DECIDE_OFFER: 'openDecideOffer',
    OEA_RUN_IG_DM_QUEUE: 'runIgDmQueue',
    OEA_ABORT_IG_DM_QUEUE: 'abortIgDmQueue',
  };

  // Remember this dashboard's origin as the API base so the Instagram side
  // panel can reach the API even when opened standalone (before any "Decide
  // offer" hand-off has run). Best-effort — storage may be unavailable.
  try {
    chrome.storage.local.set({ infDashboardApiBase: window.location.origin });
  } catch (e) {
    /* ignore */
  }

  // Announce extension presence so the page can tell whether it's installed.
  function announce() {
    window.postMessage({ type: 'OEA_EXTENSION_READY' }, window.location.origin);
  }
  announce();

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;
    const msg = event.data;
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;

    // Re-announce on demand. The page may ask at any time (e.g. when the user
    // clicks "Scrape Via Extension") in case the initial announcement was missed.
    if (msg.type === 'OEA_PING') {
      announce();
      return;
    }

    const action = PAGE_TO_BG[msg.type];
    if (!action) return;

    chrome.runtime.sendMessage({ action, payload: msg.payload || {} }, (resp) => {
      if (chrome.runtime.lastError) {
        window.postMessage(
          {
            type: 'OEA_SCRAPE_PROGRESS',
            event: 'error',
            error: chrome.runtime.lastError.message,
          },
          window.location.origin,
        );
      }
    });
  });

  // Forward progress events from background to the page.
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.action === 'scrapeQueueProgress') {
      window.postMessage(
        { type: 'OEA_SCRAPE_PROGRESS', ...msg.payload },
        window.location.origin,
      );
    }
    if (msg.action === 'igDmQueueProgress') {
      window.postMessage(
        { type: 'OEA_IG_DM_PROGRESS', ...msg.payload },
        window.location.origin,
      );
    }
  });

  console.log('[OEA] dashboard bridge loaded');
})();
