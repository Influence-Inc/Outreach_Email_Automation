// Instagram DM sender — drives Instagram's Direct composer to send a message
// as a Priority Message Request so it lands in the recipient's main inbox
// instead of the general Requests folder.
//
// Message shape (from background.js):
//   { action: 'sendInstagramDm', body: '<pre-rendered text>', username: 'foo' }
// Reply:
//   { ok: true }              — DM sent successfully
//   { ok: false, error: '…' } — could not send (e.g. Message button not found,
//                                text field never appeared, Send button disabled)
//
// This is intentionally a separate content script from instagram-content.js
// (which handles scrape reads). Runs on every instagram.com page.

(function () {
  'use strict';

  if (window.__infIgDmLoaded) return;
  window.__infIgDmLoaded = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Wait until predicate returns truthy OR the timeout elapses. Returns the
  // truthy result (or null on timeout).
  async function waitFor(predicate, { timeout = 15000, interval = 250 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        const v = predicate();
        if (v) return v;
      } catch {
        /* keep polling */
      }
      await sleep(interval);
    }
    return null;
  }

  // Case-insensitive visible-text match on a leaf element. Instagram's UI is
  // rebuilt frequently — we deliberately match on the localized button label
  // rather than a specific class or aria attribute so this survives most
  // reskin cycles.
  function findElByText(root, tags, texts) {
    const wanted = texts.map((t) => t.toLowerCase());
    const list = root.querySelectorAll(tags);
    for (const el of list) {
      const text = (el.innerText || el.textContent || '').trim().toLowerCase();
      if (!text) continue;
      if (wanted.some((w) => text === w || text.startsWith(w + ' ') || text.endsWith(' ' + w))) {
        return el;
      }
    }
    return null;
  }

  // A visible button/link whose accessible name contains one of the phrases.
  // Broader than findElByText — matches when the button contains an icon +
  // aria-label like "Message" or a nested span with the label.
  function findClickableByAria(phrases) {
    const wanted = phrases.map((p) => p.toLowerCase());
    const nodes = document.querySelectorAll(
      'button, a[role="link"], div[role="button"], a',
    );
    for (const n of nodes) {
      const aria = (n.getAttribute('aria-label') || '').toLowerCase();
      const text = (n.innerText || '').trim().toLowerCase();
      const label = aria || text;
      if (!label) continue;
      if (wanted.some((w) => label === w || label.includes(w))) {
        // Skip elements that are hidden.
        const rect = n.getBoundingClientRect();
        if (rect.width < 4 || rect.height < 4) continue;
        return n;
      }
    }
    return null;
  }

  // The DM composer's text field. Instagram builds it as a contenteditable
  // <div role="textbox"> inside the message drawer. Falls back to a real
  // <textarea> if a future Instagram redesign switches back.
  function findMessageField() {
    const boxes = document.querySelectorAll(
      'div[role="textbox"][contenteditable="true"], div[contenteditable="true"][aria-label], textarea[placeholder]',
    );
    for (const el of boxes) {
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
      if (
        aria.includes('message') ||
        placeholder.includes('message') ||
        aria.includes('write') ||
        placeholder.includes('write')
      ) {
        return el;
      }
    }
    // If nothing labelled matched, return the first contenteditable in the
    // dialog — the composer often ends up first once opened.
    const dialog = document.querySelector('div[role="dialog"]') || document.body;
    const anyEditable = dialog.querySelector('div[role="textbox"][contenteditable="true"]');
    return anyEditable || null;
  }

  // Type the message body into the composer. Uses execCommand('insertText')
  // which is what Instagram's own paste path fires, so its React state
  // controller registers the change and enables the Send button. Falls back
  // to setting textContent + dispatching an input event for older builds.
  function typeIntoField(field, text) {
    field.focus();
    // Clear existing content first.
    try {
      const range = document.createRange();
      range.selectNodeContents(field);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('delete', false);
    } catch {
      field.textContent = '';
    }
    if (field.tagName === 'TEXTAREA') {
      field.value = text;
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    // contenteditable path — insertText fires the beforeinput + input events
    // that React's onChange listener consumes.
    let inserted = false;
    try {
      inserted = document.execCommand('insertText', false, text);
    } catch {
      inserted = false;
    }
    if (!inserted) {
      field.textContent = text;
      field.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    }
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Instagram surfaces the "Send priority message request" affordance
  // differently depending on whether the recipient follows the sender. For
  // creators we've cold-messaged, the message drawer shows a small "Send as
  // Priority" (or "Priority Message Request") button/checkbox next to Send.
  // We look for anything whose accessible name mentions "priority" and click
  // it if present. Absent = the send is already going to the main inbox (we
  // follow each other, or the account has already accepted a prior request),
  // so we skip silently. Never a hard error.
  async function togglePriorityIfOffered() {
    // Give Instagram a moment to render the priority option (it usually
    // appears right after focusing the composer).
    for (let attempt = 0; attempt < 6; attempt++) {
      const el = findClickableByAria(['priority', 'send priority', 'send as priority', 'priority message']);
      if (el) {
        // Some builds render this as a checkbox; others as a toggle button.
        // Clicking it activates it; if it was already active we would toggle
        // it OFF — mitigate by checking aria-pressed / aria-checked.
        const pressed =
          el.getAttribute('aria-pressed') === 'true' ||
          el.getAttribute('aria-checked') === 'true';
        if (!pressed) {
          try { el.click(); } catch { /* keep going */ }
          await sleep(300);
        }
        return true;
      }
      await sleep(400);
    }
    return false;
  }

  // Click Instagram's Send button in the DM composer. Prefers a button whose
  // accessible name is exactly "Send" and is inside the dialog / drawer.
  async function clickSend() {
    const dialog = document.querySelector('div[role="dialog"]') || document.body;
    // Prefer buttons with an explicit accessible name of "Send".
    const scoped = dialog.querySelectorAll('button, div[role="button"]');
    for (const el of scoped) {
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const text = (el.innerText || '').trim().toLowerCase();
      if (aria === 'send' || text === 'send') {
        if (el.disabled) return false;
        el.click();
        return true;
      }
    }
    // Fallback: any element in the drawer that says "Send".
    const anySend = findElByText(dialog, 'button, div[role="button"], span', ['send']);
    if (anySend) {
      const btn = anySend.closest('button, div[role="button"]') || anySend;
      if (btn.disabled) return false;
      btn.click();
      return true;
    }
    return false;
  }

  // Opens the DM composer for the profile currently loaded in the tab, types
  // the templated body, flips on the Priority option if offered, and clicks
  // Send. Throws with a specific reason on each failure mode so the dashboard
  // shows the operator which step failed.
  async function sendPriorityDm({ body, username }) {
    if (!body || !String(body).trim()) throw new Error('empty body');
    // Sanity check: we should already be on the correct profile page (background
    // navigated us here). If Instagram bounced us to a login wall, bail early.
    if (/^\/accounts\/login/.test(location.pathname)) {
      throw new Error('not signed in to Instagram');
    }
    if (username && !location.pathname.toLowerCase().includes(username.toLowerCase())) {
      // Best-effort check — Instagram sometimes rewrites the URL, so this is a
      // warning path rather than a hard failure.
      console.warn(`[Influence DM] URL doesn't match @${username}`, location.pathname);
    }

    // 1. Click the "Message" button on the profile header.
    const msgBtn = await waitFor(
      () =>
        findClickableByAria(['message', 'send message']) ||
        findElByText(document.body, 'button, div[role="button"], a', ['message']),
      { timeout: 15000 },
    );
    if (!msgBtn) throw new Error('Message button not found on profile');
    // Some IG variants render a menu opener that expands to "Message" — walking
    // up to a real button/link ensures the click lands.
    const clickTarget = msgBtn.closest('button, a, div[role="button"]') || msgBtn;
    clickTarget.click();

    // 2. Wait for the composer text field to appear. Instagram either navigates
    //    to /direct/t/<thread> (full DM view) or opens an in-page drawer.
    const field = await waitFor(findMessageField, { timeout: 20000 });
    if (!field) throw new Error('Message composer never opened');

    // 3. Type the body.
    typeIntoField(field, String(body));
    // Small settle: React needs a tick to enable the Send button.
    await sleep(500);

    // 4. Toggle Priority Message Request if Instagram offers it. Silent no-op
    //    when the option isn't shown (mutual follow, or already an open thread).
    await togglePriorityIfOffered();

    // 5. Click Send. Give React a moment to update the button state after the
    //    priority toggle.
    const sent = await waitFor(async () => {
      const ok = await clickSend();
      return ok || null;
    }, { timeout: 8000, interval: 400 });
    if (!sent) throw new Error('Send button did not fire (disabled or not found)');

    // 6. Wait for the composer to acknowledge the send — the message either
    //    appears in the thread or the drawer closes.
    await sleep(1500);

    return { ok: true };
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request && request.action === 'sendInstagramDm') {
      sendPriorityDm({ body: request.body, username: request.username })
        .then((res) => sendResponse(res))
        .catch((err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }));
      return true; // keep the channel open for the async reply
    }
    return false;
  });

  console.log('[Influence] Instagram DM sender loaded');
})();
