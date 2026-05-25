// Bridges the Outreach dashboard page <-> the extension service worker.
//
// The dashboard cannot talk to the extension directly. It posts window.message
// events; this content script forwards them to background.js, and forwards
// background progress messages back to the page.
(function () {
  'use strict';

  const PAGE_TO_BG = {
    OEA_RUN_SCRAPE_QUEUE: 'runScrapeQueue',
    OEA_ABORT_SCRAPE_QUEUE: 'abortScrapeQueue',
  };

  // Announce extension presence so the page can tell whether it's installed.
  window.postMessage({ type: 'OEA_EXTENSION_READY' }, window.location.origin);

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;
    const msg = event.data;
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;

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
  });

  console.log('[OEA] dashboard bridge loaded');
})();
