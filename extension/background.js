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
    composeEmailInGmail(request.data).then(success => {
      sendResponse({ success });
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
  const summary = { total, processed: 0, emailFound: 0, noEmail: 0, errors: 0 };

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
        const url =
          creator.instagramUrl ||
          (creator.instagramUsername
            ? `https://www.instagram.com/${creator.instagramUsername}/`
            : null);
        if (!url) throw new Error('no instagram url');

        const tab = await chrome.tabs.create({ url, active: false });
        tabId = tab.id;
        await waitForTabComplete(tabId, 30000);
        // Settle: let document_idle + IG SPA hydration finish.
        await sleep(jittered(1500, 1500));
        // Longer timeout: the content script surfaces the Reels tab and scrolls
        // to harvest recent reel view counts before replying.
        scraped = await sendMessageToTab(tabId, { action: 'extractInstagramData' }, 25000);
      } catch (err) {
        error = err.message;
      } finally {
        if (tabId != null) {
          try { await chrome.tabs.remove(tabId); } catch {}
        }
      }

      let outcome = 'error';
      if (!error && scraped) {
        const patchBody = {};
        if (scraped.email) patchBody.email = scraped.email;
        if (scraped.firstName) patchBody.first_name = scraped.firstName;
        if (scraped.fullName) patchBody.full_name = scraped.fullName;
        if (Array.isArray(scraped.reelViews) && scraped.reelViews.length) {
          patchBody.reel_views = scraped.reelViews;
        }

        if (Object.keys(patchBody).length > 0) {
          try {
            await patchCreator(apiBase, creator.id, patchBody);
            outcome = scraped.email ? 'email_found' : 'no_email';
          } catch (err) {
            error = `patch failed: ${err.message}`;
            outcome = 'error';
          }
        } else {
          outcome = 'no_email';
        }
      }

      summary.processed += 1;
      if (outcome === 'email_found') summary.emailFound += 1;
      else if (outcome === 'no_email') summary.noEmail += 1;
      else summary.errors += 1;

      await emitProgress(senderTabId, {
        event: 'creator-done',
        index,
        total,
        creatorId: creator.id,
        username: creator.instagramUsername,
        outcome,
        email: scraped ? scraped.email : null,
        firstName: scraped ? scraped.firstName : null,
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
    
    // Inject and execute content script to compose email
    try {
      await chrome.scripting.executeScript({
        target: { tabId: gmailTab.id },
        func: composeEmailFromData,
        args: [emailData]
      });
    } catch (err) {
      console.error('Script injection failed, trying alternative method:', err);
      // Alternative: send message to existing content script
      await chrome.tabs.sendMessage(gmailTab.id, {
        action: 'composeEmail',
        data: emailData
      });
    }
    
    return true;
  } catch (error) {
    console.error('Error composing in Gmail:', error);
    return false;
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
        
        // Insert HTML content
        bodyField.innerHTML = processedBody;
        
        // Trigger input event
        bodyField.dispatchEvent(new Event('input', { bubbles: true }));
        
        console.log('Email composed successfully!');
      } else {
        console.error('Body field not found');
      }
      
    } catch (error) {
      console.error('Error in compose execution:', error);
    }
  }
  
  // Execute with delay to ensure page is ready
  setTimeout(() => {
    executeCompose();
  }, 1000);
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