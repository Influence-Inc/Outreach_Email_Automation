// Background service worker for Gmail Follow-up Automator

// Initialize default settings on install
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(['rules', 'defaultDelay', 'templates', 'sequences'], (data) => {
    if (!data.sequences) {
      chrome.storage.sync.set({
        rules: data.rules || [
          {
            sentCount: 1,
            template: "Hi {firstName},\n\nJust following up on my previous email. Would love to hear your thoughts.\n\nBest regards"
          }
        ],
        defaultDelay: data.defaultDelay || 24,
        templates: data.templates || [
          {
            name: "Introduction",
            subject: "Quick introduction",
            body: "Hi {firstName},\n\nI hope this email finds you well. I wanted to reach out regarding...\n\nBest regards",
            lastModified: Date.now()
          }
        ],
        sequences: [
          {
            name: "Standard Follow-up",
            steps: [
              {
                delayHours: 48,
                message: "Hi {firstName},\n\nJust following up on my previous email. Would love to hear your thoughts.\n\nBest regards"
              },
              {
                delayHours: 72,
                message: "Hi {firstName},\n\nI wanted to check in one more time. Let me know if you have any questions.\n\nThanks"
              }
            ]
          },
          {
            name: "Aggressive Follow-up",
            steps: [
              {
                delayHours: 24,
                message: "Hi {firstName},\n\nQuick follow-up on this. Any thoughts?\n\nBest"
              },
              {
                delayHours: 48,
                message: "Hi {firstName},\n\nStill interested in hearing from you on this.\n\nThanks"
              },
              {
                delayHours: 72,
                message: "Hi {firstName},\n\nLast follow-up from me. Please let me know if you're interested.\n\nCheers"
              }
            ]
          }
        ]
      });
    }
  });
});

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'composeInGmail') {
    composeEmailInGmail(request.data).then((result) => {
      // result is {success, error?}; unwrap so popup.js's response.success
      // check still gets a plain boolean.
      sendResponse({ success: !!(result && result.success), error: result && result.error });
    });
    return true; // Keep channel open for async response
  }
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
  if (request.action === 'runSendQueue') {
    runSendQueue(request.payload || {}, sender)
      .then((summary) => sendResponse({ ok: true, summary }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (request.action === 'abortSendQueue') {
    sendQueueState.abort = true;
    sendResponse({ ok: true });
    return true;
  }
});

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
        if (scraped.email) patchBody.email = scraped.email;
        if (scraped.firstName) patchBody.first_name = scraped.firstName;
        if (scraped.fullName) patchBody.full_name = scraped.fullName;
        if (viewCount) patchBody.reel_views = cleanViews;

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
// Send queue runner: for each pending creator, ask the backend for a rendered
// outreach (subject + body + trackingId), drive Gmail's compose+send UI, then
// poll the backend's Gmail-API search to recover the threadId / message-id so
// follow-ups and negotiation can thread normally. Random jitter between sends.
// ---------------------------------------------------------------------------

const sendQueueState = {
  running: false,
  abort: false,
};

async function emitSendProgress(senderTabId, payload) {
  if (senderTabId == null) return;
  try {
    await chrome.tabs.sendMessage(senderTabId, {
      action: 'sendQueueProgress',
      payload,
    });
  } catch (err) {
    // Dashboard tab closed; not fatal.
  }
}

async function backendPost(apiBase, path, body) {
  const resp = await fetch(`${apiBase}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  let json = null;
  try { json = await resp.json(); } catch {}
  if (!resp.ok) {
    const detail = (json && (json.error || json.message)) || `HTTP ${resp.status}`;
    throw new Error(detail);
  }
  return json || {};
}

// Gmail's Sent indexing lags a few seconds after a UI send. Poll the backend's
// locate endpoint with backoff until it finds the message (so we can record
// the threadId for future follow-ups) or until we give up.
async function locateSentWithBackoff(apiBase, creatorId, trackingId, sentAfter) {
  const delays = [2000, 3000, 5000, 8000, 12000]; // ~30s total
  let lastResult = { found: false };
  for (const d of delays) {
    await sleep(d);
    try {
      lastResult = await backendPost(
        apiBase,
        `/api/creators/${creatorId}/locate-extension-sent`,
        { trackingId, sentAfter },
      );
    } catch (err) {
      lastResult = { found: false, error: err.message };
    }
    if (lastResult && lastResult.found) return lastResult;
    if (sendQueueState.abort) return lastResult;
  }
  return lastResult;
}

async function runSendQueue(payload, sender) {
  const { apiBase, creators, pacingMs, spreadMs } = payload;
  const senderTabId = sender && sender.tab && sender.tab.id;

  if (!apiBase || !Array.isArray(creators) || !creators.length) {
    throw new Error('invalid payload: apiBase + non-empty creators[] required');
  }
  if (sendQueueState.running) {
    throw new Error('send queue already running');
  }

  sendQueueState.running = true;
  sendQueueState.abort = false;

  // 90s ± 60s default → uniform random 60-150s between sends. Caller can
  // override per-batch from the dashboard.
  const pace = Number.isFinite(pacingMs) ? pacingMs : 90_000;
  const spread = Number.isFinite(spreadMs) ? spreadMs : 60_000;
  const total = creators.length;
  const summary = { total, processed: 0, sent: 0, skipped: 0, errors: 0 };

  await emitSendProgress(senderTabId, { event: 'start', total });

  try {
    for (let i = 0; i < creators.length; i++) {
      if (sendQueueState.abort) {
        await emitSendProgress(senderTabId, { event: 'aborted', index: i, total });
        break;
      }
      const creator = creators[i];
      const index = i + 1;
      await emitSendProgress(senderTabId, {
        event: 'creator-start',
        index,
        total,
        creatorId: creator.id,
        label: creator.label || `creator ${creator.id}`,
      });

      let outcome = 'error';
      let error = null;
      let sentMeta = null;
      let burnDelay = true;

      try {
        // 1. Render + suppression/verify on the backend; we get back the
        //    subject/body/pixel URL/trackingId — no DB writes yet.
        const prep = await backendPost(apiBase, `/api/creators/${creator.id}/prepare-outreach`, {});
        if (!prep.ok) {
          outcome = 'skipped';
          error = prep.skipReason || 'unknown skip';
          burnDelay = false; // skipped creators shouldn't burn the inter-send delay
        } else {
          // 2. Open / focus Gmail, fill compose with the rendered email +
          //    tracking pixel, click Send, confirm the dialog closed.
          const sentAt = Date.now();
          const composeResult = await composeEmailInGmail({
            to: prep.to,
            subject: prep.subject,
            body: prep.body,
            trackingPixelUrl: prep.trackingPixelUrl || null,
            autoSend: true,
          });
          if (!composeResult || !composeResult.success) {
            throw new Error((composeResult && composeResult.error) || 'compose/send failed');
          }

          // 3. Poll Gmail's Sent folder (via the backend's API search) by the
          //    unique trackingId to recover the threadId + message-ids so the
          //    follow-up + negotiation scheduler can thread later replies.
          const located = await locateSentWithBackoff(apiBase, creator.id, prep.trackingId, sentAt);

          // 4. Mark the creator as outreach_sent regardless of whether locate
          //    succeeded — we don't want a doubly-charged delivery. If locate
          //    timed out, mark-outreach-sent records 'thread_unmatched' so the
          //    admin can see threading was lost on this one.
          await backendPost(apiBase, `/api/creators/${creator.id}/mark-outreach-sent`, {
            trackingId: prep.trackingId,
            gmailMessageId: located && located.found ? located.gmailMessageId : null,
            threadId: located && located.found ? located.threadId : null,
            rfc822MessageId: located && located.found ? located.rfc822MessageId : null,
            subject: prep.subject,
          });

          outcome = 'sent';
          sentMeta = {
            trackingId: prep.trackingId,
            threaded: !!(located && located.found),
          };
        }
      } catch (err) {
        error = err.message;
        outcome = 'error';
      }

      summary.processed += 1;
      if (outcome === 'sent') summary.sent += 1;
      else if (outcome === 'skipped') summary.skipped += 1;
      else summary.errors += 1;

      await emitSendProgress(senderTabId, {
        event: 'creator-done',
        index,
        total,
        creatorId: creator.id,
        label: creator.label || `creator ${creator.id}`,
        outcome,
        error,
        sentMeta,
      });

      if (i < creators.length - 1 && !sendQueueState.abort && burnDelay) {
        await sleep(jittered(pace, spread));
      }
    }

    await emitSendProgress(senderTabId, { event: 'done', summary });
  } finally {
    sendQueueState.running = false;
    sendQueueState.abort = false;
  }

  return summary;
}

// Open Gmail and compose email
async function composeEmailInGmail(emailData) {
  try {
    // Find existing Gmail tab or create new one
    const tabs = await chrome.tabs.query({ url: 'https://mail.google.com/*' });
    
    let gmailTab;
    let isNewTab = false;
    
    if (tabs.length > 0) {
      // Use existing Gmail tab
      gmailTab = tabs[0];
      await chrome.tabs.update(gmailTab.id, { active: true });
      // Wait a bit for tab to activate
      await new Promise(resolve => setTimeout(resolve, 500));
    } else {
      // Create new Gmail tab
      isNewTab = true;
      gmailTab = await chrome.tabs.create({ 
        url: 'https://mail.google.com/mail/u/0/#inbox',
        active: true 
      });
      
      // Wait for Gmail to fully load (longer for new tabs)
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    
    // Store email data and follow-up sequence for content script to access
    await chrome.storage.local.set({ 
      pendingCompose: {
        to: emailData.to,
        subject: emailData.subject,
        body: emailData.body,
        followupSequenceIndex: emailData.followupSequenceIndex
      },
      composeTimestamp: Date.now()
    });
    
    // Wait a bit more to ensure storage is saved
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // Inject and execute content script to compose email. The injected
    // function returns {success, error} — we propagate that so callers (the
    // popup as well as the send queue) can react to compose / auto-send
    // failures instead of silently treating every attempt as a success.
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: gmailTab.id },
        func: composeEmailFromData,
        args: [emailData],
      });
      const r = results && results[0] && results[0].result;
      if (r && typeof r === 'object') return r;
      return { success: true };
    } catch (err) {
      console.error('Script injection failed, trying alternative method:', err);
      // Alternative: send message to existing content script. The content-script
      // fallback path doesn't yet do autoSend; only the popup flow uses it.
      try {
        await chrome.tabs.sendMessage(gmailTab.id, {
          action: 'composeEmail',
          data: emailData,
        });
        return { success: true, viaFallback: true };
      } catch (e2) {
        return { success: false, error: 'inject + fallback both failed: ' + e2.message };
      }
    }
  } catch (error) {
    console.error('Error composing in Gmail:', error);
    return { success: false, error: error.message };
  }
}

// This function runs in the Gmail tab context
function composeEmailFromData(emailData) {
  console.log('Compose function started with data:', emailData);
  
  // Function to wait for element
  function waitForElement(selector, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      
      const checkElement = () => {
        const element = document.querySelector(selector);
        if (element) {
          resolve(element);
        } else if (Date.now() - startTime > timeout) {
          reject(new Error(`Element ${selector} not found within ${timeout}ms`));
        } else {
          setTimeout(checkElement, 100);
        }
      };
      
      checkElement();
    });
  }
  
  // Simulate typing into an element
  function simulateTyping(element, text) {
    element.focus();
    element.value = text;
    
    // Dispatch multiple events to ensure Gmail detects the input
    element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true }));
  }
  
  // Main compose logic
  async function executeCompose() {
    try {
      const { to, subject, body } = emailData;
      
      console.log('Looking for compose button...');
      
      // Try multiple selectors for compose button
      const composeSelectors = [
        'div[gh="cm"]',
        'div[role="button"][gh="cm"]',
        '.T-I.T-I-KE.L3',
        'div.T-I.T-I-KE.L3'
      ];
      
      let composeBtn = null;
      for (const selector of composeSelectors) {
        composeBtn = document.querySelector(selector);
        if (composeBtn) {
          console.log('Found compose button with selector:', selector);
          break;
        }
      }
      
      if (!composeBtn) {
        console.error('Compose button not found, trying to wait for it...');
        composeBtn = await waitForElement('div[gh="cm"]', 5000);
      }
      
      console.log('Clicking compose button...');
      composeBtn.click();
      
      // Wait for compose window to appear
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      console.log('Filling in recipient:', to);
      // Fill in recipient - try multiple selectors
      const toSelectors = [
        'textarea[name="to"]',
        'input[name="to"]',
        'textarea[aria-label="To"]',
        'input[aria-label="To"]',
        'div[aria-label="To"] textarea',
        'div[aria-label="To"] input'
      ];
      
      let toField = null;
      for (const selector of toSelectors) {
        toField = document.querySelector(selector);
        if (toField) {
          console.log('Found To field with selector:', selector);
          break;
        }
      }
      
      if (toField) {
        // Focus and clear first
        toField.focus();
        await new Promise(resolve => setTimeout(resolve, 200));
        
        // Type the email
        simulateTyping(toField, to);
        await new Promise(resolve => setTimeout(resolve, 300));
        
        // Try clicking the email suggestion dropdown if it appears
        setTimeout(() => {
          const suggestion = document.querySelector('div[role="option"]');
          if (suggestion) {
            suggestion.click();
            console.log('Clicked email suggestion');
          } else {
            // If no dropdown, press Tab to confirm
            const tabEvent = new KeyboardEvent('keydown', {
              key: 'Tab',
              code: 'Tab',
              keyCode: 9,
              bubbles: true
            });
            toField.dispatchEvent(tabEvent);
            console.log('Pressed Tab to confirm recipient');
          }
        }, 500);
        
        await new Promise(resolve => setTimeout(resolve, 800));
      } else {
        console.error('To field not found');
      }
      
      console.log('Filling in subject:', subject);
      // Fill in subject
      const subjectSelectors = [
        'input[name="subjectbox"]',
        'input[aria-label="Subject"]',
        'input[placeholder*="Subject"]',
        'div.aoD.az6 input'
      ];
      
      let subjectField = null;
      for (const selector of subjectSelectors) {
        subjectField = document.querySelector(selector);
        if (subjectField) {
          console.log('Found Subject field with selector:', selector);
          break;
        }
      }
      
      if (subjectField) {
        subjectField.focus();
        await new Promise(resolve => setTimeout(resolve, 200));
        simulateTyping(subjectField, subject);
        await new Promise(resolve => setTimeout(resolve, 500));
      } else {
        console.error('Subject field not found');
      }
      
      console.log('Filling in body...');
      // Fill in body - try multiple selectors
      const bodySelectors = [
        'div[aria-label="Message Body"]',
        'div[role="textbox"][aria-label*="Message"]',
        'div[g_editable="true"]',
        'div.Am.Al.editable',
        'div[contenteditable="true"][aria-label*="Message"]'
      ];
      
      let bodyField = null;
      for (const selector of bodySelectors) {
        bodyField = document.querySelector(selector);
        if (bodyField) {
          console.log('Found Body field with selector:', selector);
          break;
        }
      }
      
      if (bodyField) {
        bodyField.focus();
        await new Promise(resolve => setTimeout(resolve, 300));

        // Clear any existing content
        bodyField.innerHTML = '';

        // Convert markdown-style links to HTML
        let processedBody = body;
        // Match [text](url) pattern and convert to <a href="url">text</a>
        processedBody = processedBody.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

        // Convert newlines to <br> tags
        processedBody = processedBody.replace(/\n/g, '<br>');

        // Append the tracking pixel so opens still get logged on extension-sent
        // outreach. The backend's /o/<trackingId>.gif endpoint is the same one
        // the Gmail-API path uses; the pixel here just rides along inside the
        // body that the recipient's mail client renders.
        if (emailData.trackingPixelUrl) {
          processedBody += `<img src="${emailData.trackingPixelUrl}" width="1" height="1" alt="" style="display:block;border:0;outline:none;" />`;
        }

        // Insert HTML content
        bodyField.innerHTML = processedBody;

        // Trigger input event
        bodyField.dispatchEvent(new Event('input', { bubbles: true }));

        console.log('Email composed successfully!');
      } else {
        console.error('Body field not found');
        return { success: false, error: 'body field not found' };
      }

      // Auto-send path (extension queue). Click Gmail's Send button, handle the
      // "send without subject?" / similar confirmation modals, then wait for the
      // compose dialog to disappear as the sent signal.
      if (emailData.autoSend) {
        await new Promise((resolve) => setTimeout(resolve, 700));
        // Scope the search to the compose dialog so we can't accidentally match
        // "Send feedback" in the sidebar or a "Send & Archive" reply button.
        let composeDialog = null;
        for (const d of document.querySelectorAll('div[role="dialog"]')) {
          if (d.querySelector('input[name="subjectbox"]')) {
            composeDialog = d;
            break;
          }
        }
        if (!composeDialog) {
          return { success: false, error: 'compose dialog not found at send time' };
        }
        const sendSelectors = [
          'div[role="button"][data-tooltip^="Send"]',
          'div[role="button"][aria-label^="Send"]',
          'div[role="button"][data-tooltip*="(Ctrl-Enter)"]',
          'div[aria-label*="Send"]',
        ];
        let sendBtn = null;
        for (const sel of sendSelectors) {
          sendBtn = composeDialog.querySelector(sel);
          if (sendBtn) break;
        }
        if (!sendBtn) {
          return { success: false, error: 'send button not found' };
        }
        sendBtn.click();

        // If Gmail pops a confirmation modal (no subject, attached-files warning,
        // etc.), click its primary "OK" / "Send" button.
        await new Promise((r) => setTimeout(r, 400));
        const modal = document.querySelector('div[role="alertdialog"]');
        if (modal) {
          const primaryBtn = modal.querySelector('button[name="ok"], button[name="default"], div[role="button"]');
          if (primaryBtn) primaryBtn.click();
        }

        // Wait up to 8s for the compose dialog to disappear (sent confirmation).
        const dialogSelector = 'div[role="dialog"]';
        const start = Date.now();
        while (Date.now() - start < 8000) {
          await new Promise((r) => setTimeout(r, 200));
          const dialogs = document.querySelectorAll(dialogSelector);
          // Compose dialogs contain a Subject input. Filter to those, since
          // Gmail also opens transient dialogs (notifications, etc.).
          let composeStillOpen = false;
          for (const d of dialogs) {
            if (d.querySelector('input[name="subjectbox"]')) {
              composeStillOpen = true;
              break;
            }
          }
          if (!composeStillOpen) {
            return { success: true };
          }
        }
        return { success: false, error: 'compose dialog still open 8s after send click' };
      }

      return { success: true };
    } catch (error) {
      console.error('Error in compose execution:', error);
      return { success: false, error: String(error && error.message || error) };
    }
  }

  // Wrap so executeScript() awaits the full compose+send sequence and the
  // background queue gets a structured result back instead of a bare boolean.
  return new Promise((resolve) => {
    setTimeout(() => {
      executeCompose().then(resolve).catch((err) => resolve({ success: false, error: String(err && err.message || err) }));
    }, 1000);
  });
}

// Listen for alarms to check for pending follow-ups
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'checkFollowups') {
    console.log('Alarm triggered: checking for pending follow-ups');
    processFollowupsInBackground();
  }
});

// Create alarm to check every 30 minutes
chrome.alarms.create('checkFollowups', { periodInMinutes: 30 });

// Process follow-ups in background by sending message to Gmail tabs
async function processFollowupsInBackground() {
  try {
    // Find all Gmail tabs
    const tabs = await chrome.tabs.query({ url: 'https://mail.google.com/*' });
    
    if (tabs.length === 0) {
      console.log('No Gmail tabs open, skipping follow-up check');
      return;
    }
    
    console.log(`Found ${tabs.length} Gmail tab(s), processing follow-ups...`);
    
    // Use the first Gmail tab to process follow-ups
    const gmailTab = tabs[0];
    
    // Send message to content script to process follow-ups
    chrome.tabs.sendMessage(gmailTab.id, { 
      action: 'processFollowups' 
    }, (response) => {
      if (chrome.runtime.lastError) {
        console.log('Could not send message to Gmail tab:', chrome.runtime.lastError.message);
      } else {
        console.log('Follow-up processing initiated');
      }
    });
    
  } catch (error) {
    console.error('Error in background follow-up processing:', error);
  }
}

console.log('Gmail Follow-up Automator background script loaded');