// Background service worker for Influence Outreach Automator.
// Drives the Instagram scrape queue triggered from the Outreach dashboard.
// All email sending (outreach, follow-ups, negotiation) is handled server-side
// via Instantly.ai — this extension never sends emails.

// Listen for messages from the dashboard bridge and popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'runScrapeQueue') {
    runScrapeQueue(request.payload || {}, sender)
      .then((summary) => sendResponse({ ok: true, summary }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (request.action === 'abortScrapeQueue') {
    scrapeQueueState.abort = true;
    sendResponse({ ok: true });
    return true;
  }
  if (request.action === 'openDecideOffer') {
    openDecideOffer(request.payload || {})
      .then((res) => sendResponse({ ok: true, ...res }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (request.action === 'runIgDmQueue') {
    runIgDmQueue(request.payload || {}, sender)
      .then((summary) => sendResponse({ ok: true, summary }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (request.action === 'abortIgDmQueue') {
    igDmQueueState.abort = true;
    sendResponse({ ok: true });
    return true;
  }
});

// ---------------------------------------------------------------------------
// "Decide offer" launcher. The dashboard hands off a creator (id + username +
// its own origin as apiBase); we remember it as a one-shot target keyed by
// username, persist the dashboard URL so the Instagram side panel can reach the
// API, then open the creator's Reels tab (where per-reel view counts render, so
// you can eyeball recent reach while pricing). The panel content script picks up
// the stored target and opens itself against the right creator.
// ---------------------------------------------------------------------------
async function openDecideOffer(payload) {
  const { creatorId, username, campaignId, apiBase } = payload;
  if (!username) throw new Error('username required');
  const uname = String(username).replace(/^@/, '').trim();
  const base = apiBase ? String(apiBase).replace(/\/+$/, '') : null;

  const store = await chrome.storage.local.get(['infPendingOffers', 'infDashboardApiBase']);
  const pending = { ...(store.infPendingOffers || {}) };
  pending[uname.toLowerCase()] = {
    creatorId: creatorId != null ? String(creatorId) : null,
    campaignId: campaignId != null ? String(campaignId) : null,
    apiBase: base || store.infDashboardApiBase || null,
    ts: Date.now(),
  };
  const set = { infPendingOffers: pending };
  if (base) set.infDashboardApiBase = base;
  await chrome.storage.local.set(set);

  const url = `https://www.instagram.com/${encodeURIComponent(uname)}/reels/`;
  const tab = await chrome.tabs.create({ url, active: true });
  return { tabId: tab.id };
}

// ---------------------------------------------------------------------------
// Scrape queue runner: drives one IG profile tab at a time and PATCHes the
// dashboard with the extracted email + name. Does NOT send outreach — sending
// stays a separate dashboard-triggered action.
// ---------------------------------------------------------------------------

const scrapeQueueState = {
  running: false,
  abort: false,
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function jittered(baseMs, spreadMs) {
  return baseMs + Math.floor(Math.random() * spreadMs);
}

function waitForTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('tab load timeout'));
    }, timeoutMs);
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    // Also resolve immediately if the tab is already complete.
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) return;
      if (tab && tab.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });
  });
}

function sendMessageToTab(tabId, message, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('content-script no reply')), timeoutMs);
    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    } catch (err) {
      clearTimeout(timer);
      reject(err);
    }
  });
}

async function emitProgress(senderTabId, payload) {
  if (senderTabId == null) return;
  try {
    await chrome.tabs.sendMessage(senderTabId, {
      action: 'scrapeQueueProgress',
      payload,
    });
  } catch (err) {
    // Dashboard tab closed; not fatal.
  }
}

async function patchCreator(apiBase, id, body) {
  const url = `${apiBase}/api/creators/${id}`;
  const resp = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    let detail = '';
    try {
      const j = await resp.json();
      detail = j.error || '';
    } catch {}
    throw new Error(`PATCH ${resp.status} ${detail}`);
  }
  return resp.json();
}

async function runScrapeQueue(payload, sender) {
  const { apiBase, creators, pacingMs } = payload;
  const senderTabId = sender && sender.tab && sender.tab.id;

  if (!apiBase || !Array.isArray(creators) || !creators.length) {
    throw new Error('invalid payload: apiBase + non-empty creators[] required');
  }
  if (scrapeQueueState.running) {
    throw new Error('scrape queue already running');
  }

  scrapeQueueState.running = true;
  scrapeQueueState.abort = false;

  const pace = Number.isFinite(pacingMs) ? pacingMs : 5000;
  const total = creators.length;
  const summary = { total, processed: 0, emailFound: 0, noEmail: 0, errors: 0, withViews: 0 };

  await emitProgress(senderTabId, { event: 'start', total });

  try {
    for (let i = 0; i < creators.length; i++) {
      if (scrapeQueueState.abort) {
        await emitProgress(senderTabId, { event: 'aborted', index: i, total });
        break;
      }
      const creator = creators[i];
      const index = i + 1;
      await emitProgress(senderTabId, {
        event: 'creator-start',
        index,
        total,
        creatorId: creator.id,
        username: creator.instagramUsername,
      });

      let tabId = null;
      let scraped = null;
      let error = null;

      try {
        const baseUrl =
          creator.instagramUrl ||
          (creator.instagramUsername
            ? `https://www.instagram.com/${creator.instagramUsername}/`
            : null);
        if (!baseUrl) throw new Error('no instagram url');
        // Open the Reels tab: per-reel view counts render there as persistent
        // overlays (on the main grid they often only appear on hover). The
        // profile header — name, bio and email — is present on this tab too,
        // so we still scrape username + email + views in one pass.
        const url = baseUrl.replace(/\/+$/, '') + '/reels/';

        // Open it FOREGROUND (active). Instagram's reels grid lazy-loads on
        // scroll via IntersectionObserver, and Chrome throttles hidden/occluded
        // tabs — so a background tab often never populates the grid, yielding 0
        // views. A visible tab renders and scrolls reliably (matches what you
        // see opening the profile yourself). The tab is closed right after.
        // Note: keep this scrape tab focused while it runs — switching away
        // re-occludes it and re-throttles the page.
        const tab = await chrome.tabs.create({ url, active: true });
        tabId = tab.id;
        await waitForTabComplete(tabId, 30000);
        // Settle: let document_idle + IG SPA hydration finish.
        await sleep(jittered(1500, 1500));
        // includeReels: scroll-and-collect reel view counts. Allow extra time
        // because the content script scrolls to lazy-load the reels grid.
        scraped = await sendMessageToTab(
          tabId,
          { action: 'extractInstagramData', includeReels: true },
          20000,
        );
      } catch (err) {
        error = err.message;
      } finally {
        if (tabId != null) {
          try { await chrome.tabs.remove(tabId); } catch {}
        }
      }

      // Only send clean, positive numbers — the backend drops anything else,
      // so sending junk would store nothing while still looking "successful".
      const cleanViews = (scraped && Array.isArray(scraped.reelViews) ? scraped.reelViews : [])
        .filter((n) => typeof n === 'number' && Number.isFinite(n) && n > 0);
      const viewCount = cleanViews.length;
      let storedViews = 0;

      let outcome = 'error';
      if (!error && scraped) {
        const patchBody = {};
        if (scraped.email) {
          patchBody.email = scraped.email;
          // The extension only ever reads a profile from Instagram, so a scraped
          // email is never a hand-typed "manual" entry. Send an explicit source
          // (contact-button / bio when known, generic 'instagram' otherwise) so
          // the backend never falls back to labelling it 'manual'.
          patchBody.email_source = scraped.emailSource || 'instagram';
        }
        if (scraped.firstName) patchBody.first_name = scraped.firstName;
        if (scraped.fullName) patchBody.full_name = scraped.fullName;
        if (viewCount) patchBody.reel_views = cleanViews;
        if (scraped.latestReelDate) patchBody.latest_reel_date = scraped.latestReelDate;
        if (Array.isArray(scraped.bioLinks) && scraped.bioLinks.length) {
          patchBody.bio_links = scraped.bioLinks;
        }
        // Mark this as a completed scrape so the backend can move a still-pending
        // creator to no_email when no address was found (the enrichment pass then
        // runs). Also guarantees a non-empty PATCH so that status transition fires.
        patchBody.scraped = true;

        if (Object.keys(patchBody).length > 0) {
          try {
            const updated = await patchCreator(apiBase, creator.id, patchBody);
            // Trust the backend's own count, not what we scraped locally.
            storedViews =
              (updated && updated.ig_scraped_data && Number(updated.ig_scraped_data.reel_count)) || 0;
            outcome = scraped.email ? 'email_found' : 'no_email';
          } catch (err) {
            error = `patch failed: ${err.message}`;
            outcome = 'error';
          }
        } else {
          outcome = 'no_email';
        }
      }

      // Persistent diagnostic (visible in the service-worker console): what we
      // scraped vs what the backend actually stored.
      console.log(
        `[OEA] @${creator.instagramUsername}: scraped ${viewCount} reel views`,
        cleanViews,
        `| backend stored reel_count=${storedViews}`,
      );

      summary.processed += 1;
      if (outcome === 'email_found') summary.emailFound += 1;
      else if (outcome === 'no_email') summary.noEmail += 1;
      else summary.errors += 1;
      if (outcome !== 'error' && storedViews > 0) summary.withViews += 1;

      await emitProgress(senderTabId, {
        event: 'creator-done',
        index,
        total,
        creatorId: creator.id,
        username: creator.instagramUsername,
        outcome,
        email: scraped ? scraped.email : null,
        firstName: scraped ? scraped.firstName : null,
        reelViews: viewCount,
        storedViews,
        error,
      });

      if (i < creators.length - 1 && !scrapeQueueState.abort) {
        await sleep(jittered(pace, Math.floor(pace * 0.6)));
      }
    }

    await emitProgress(senderTabId, { event: 'done', summary });
  } finally {
    scrapeQueueState.running = false;
    scrapeQueueState.abort = false;
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Instagram DM queue runner. For each creator handed to us we open their IG
// profile in a foreground tab, ask the instagram-dm content script to drive
// the Direct composer (type the body, flip on Priority Message Request, send),
// then POST the outcome back to the dashboard so it can log the event and
// refresh the row.
// ---------------------------------------------------------------------------

const igDmQueueState = {
  running: false,
  abort: false,
};

async function postIgDmResult(apiBase, creatorId, { ok, error }) {
  const url = `${apiBase}/api/creators/${creatorId}/ig-dm-result`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ok ? { ok: true } : { ok: false, error: error || 'unknown' }),
  });
  if (!resp.ok) {
    let detail = '';
    try {
      const j = await resp.json();
      detail = j.error || '';
    } catch {}
    throw new Error(`POST ig-dm-result ${resp.status} ${detail}`);
  }
  return resp.json();
}

async function emitIgDmProgress(senderTabId, payload) {
  if (senderTabId == null) return;
  try {
    await chrome.tabs.sendMessage(senderTabId, {
      action: 'igDmQueueProgress',
      payload,
    });
  } catch (err) {
    // Dashboard tab closed; not fatal.
  }
}

async function runIgDmQueue(payload, sender) {
  const { apiBase, jobs, pacingMs } = payload;
  const senderTabId = sender && sender.tab && sender.tab.id;

  if (!apiBase || !Array.isArray(jobs) || !jobs.length) {
    throw new Error('invalid payload: apiBase + non-empty jobs[] required');
  }
  if (igDmQueueState.running) {
    throw new Error('IG DM queue already running');
  }

  igDmQueueState.running = true;
  igDmQueueState.abort = false;

  const pace = Number.isFinite(pacingMs) ? pacingMs : 8000;
  const total = jobs.length;
  const summary = { total, processed: 0, sent: 0, errors: 0 };

  await emitIgDmProgress(senderTabId, { event: 'start', total });

  try {
    for (let i = 0; i < jobs.length; i++) {
      if (igDmQueueState.abort) {
        await emitIgDmProgress(senderTabId, { event: 'aborted', index: i, total });
        break;
      }
      const job = jobs[i];
      const index = i + 1;
      await emitIgDmProgress(senderTabId, {
        event: 'creator-start',
        index,
        total,
        creatorId: job.id,
        username: job.instagramUsername,
      });

      let tabId = null;
      let outcome = 'error';
      let error = null;

      try {
        const baseUrl =
          job.instagramUrl ||
          (job.instagramUsername
            ? `https://www.instagram.com/${job.instagramUsername}/`
            : null);
        if (!baseUrl) throw new Error('no instagram url');
        // Foreground tab: Instagram's Direct composer is heavy and IntersectionObserver-
        // driven. Chrome throttles hidden tabs, and the composer will simply not
        // hydrate when the tab is occluded. Keep the window focused during the run.
        const tab = await chrome.tabs.create({ url: baseUrl, active: true });
        tabId = tab.id;
        await waitForTabComplete(tabId, 30000);
        // Settle: Instagram's SPA hydration + the "Message" button aren't in the
        // DOM at document_idle. A short pause lets the profile header render.
        await sleep(jittered(1800, 1200));

        const resp = await sendMessageToTab(
          tabId,
          {
            action: 'sendInstagramDm',
            body: job.body,
            username: job.instagramUsername,
          },
          90000, // Instagram's DM composer can take a while to open + settle.
        );
        if (resp && resp.ok) {
          outcome = 'sent';
        } else {
          error = (resp && resp.error) || 'content-script returned no result';
          outcome = 'error';
        }
      } catch (err) {
        error = err.message;
        outcome = 'error';
      } finally {
        if (tabId != null) {
          try { await chrome.tabs.remove(tabId); } catch {}
        }
      }

      // Report the outcome upstream. A failure to report is itself a failure
      // (the dashboard would keep showing the DM as queued forever), so we
      // downgrade this creator's outcome accordingly.
      try {
        await postIgDmResult(apiBase, job.id, {
          ok: outcome === 'sent',
          error: outcome === 'sent' ? null : error,
        });
      } catch (err) {
        error = `${error || 'send failed'}; result post also failed: ${err.message}`;
        outcome = 'error';
      }

      summary.processed += 1;
      if (outcome === 'sent') summary.sent += 1;
      else summary.errors += 1;

      await emitIgDmProgress(senderTabId, {
        event: 'creator-done',
        index,
        total,
        creatorId: job.id,
        username: job.instagramUsername,
        outcome,
        error,
      });

      if (i < jobs.length - 1 && !igDmQueueState.abort) {
        // Randomized pacing between DMs so we don't look like a bot cranking
        // through profiles every 8s exactly.
        await sleep(jittered(pace, Math.floor(pace * 0.6)));
      }
    }

    await emitIgDmProgress(senderTabId, { event: 'done', summary });
  } finally {
    igDmQueueState.running = false;
    igDmQueueState.abort = false;
  }

  return summary;
}

console.log('Influence Outreach Automator background script loaded');
