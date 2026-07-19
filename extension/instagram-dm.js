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

  // Type the message body into the composer. Instagram's DM composer is a
  // Lexical-based contenteditable (Meta's editor), and its beforeinput handler
  // silently strips '\n' characters from a single execCommand('insertText',
  // whole-body) call — the result is a run-on paragraph with all newlines
  // collapsed, which is what we saw in QA.
  //
  // The reliable fix is to feed the composer one line at a time, inserting a
  // real line break between lines with execCommand('insertLineBreak'). That
  // yields the exact DOM shape Lexical produces for a user's Shift+Enter, so
  // the sent message preserves the paragraph breaks the template was written
  // with. Empty lines still trigger a break (they're the blank paragraphs
  // between sentences), and a single-line body degrades to a single insertText
  // call — same as before.
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

    // Normalize any \r\n line endings so the split below yields the same
    // number of lines regardless of the template's source OS.
    const normalized = String(text).replace(/\r\n?/g, '\n');
    const lines = normalized.split('\n');

    // Line-by-line contenteditable insertion path. insertLineBreak is what
    // Lexical uses internally for a soft newline; it emits the same
    // beforeinput/input event shape Instagram's React state listener
    // consumes, so the Send button stays enabled and the DOM matches what a
    // human typing Shift+Enter would produce.
    let allOk = true;
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) {
        let brOk = false;
        try { brOk = document.execCommand('insertLineBreak'); } catch { brOk = false; }
        if (!brOk) {
          // Older/quirky builds: fall back to a literal <br>. Same visible
          // outcome — a hard line break in the paragraph.
          try { brOk = document.execCommand('insertHTML', false, '<br>'); } catch { brOk = false; }
        }
        if (!brOk) allOk = false;
      }
      if (lines[i].length) {
        let txtOk = false;
        try { txtOk = document.execCommand('insertText', false, lines[i]); } catch { txtOk = false; }
        if (!txtOk) allOk = false;
      }
    }

    if (!allOk) {
      // Ultimate fallback: replace the whole field's text and dispatch input.
      // Loses paragraph structure but at least gets the body across.
      field.textContent = normalized;
      field.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        data: normalized,
        inputType: 'insertText',
      }));
    }
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Immediately after clicking Message on a cold profile, Instagram opens a
  // modal dialog with two buttons:
  //   • "Send prioritized message" (primary) — lands in the recipient's main
  //     inbox as a Partnership / Priority message.
  //   • "Send message request" (secondary) — the ordinary Requests-folder flow.
  // The composer does not open until one of them is clicked, so we have to
  // click "Send prioritized message" HERE before waiting for the message field.
  // On a warm profile (mutual follow, or an already-open thread) the modal is
  // skipped and the composer opens directly — so returning `null` after a
  // short poll is a normal path, not a failure.
  async function clickPrioritizedMessageIfOffered() {
    // Support both American ("prioritized") and British ("prioritised")
    // spellings — Instagram's UI localizes and either can appear.
    const wanted = ['send prioritized message', 'send prioritised message', 'prioritized message', 'prioritised message'];
    // Poll for ~4s. When the modal never appears, that's the warm-profile path
    // and we skip silently.
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      // Scoped to a role="dialog" when possible so we don't misfire on some
      // other on-page element that happens to contain the word "prioritized".
      const dialog = document.querySelector('div[role="dialog"]');
      const scope = dialog || document.body;
      // Match the exact button text first — this is the primary CTA in the
      // modal — then fall back to any clickable with a matching aria label.
      const exact = findElByText(scope, 'button, div[role="button"], span', wanted);
      const target = exact
        ? (exact.closest('button, div[role="button"], a') || exact)
        : findClickableByAria(wanted);
      if (target) {
        try { target.click(); } catch { /* fall through */ }
        return true;
      }
      await sleep(200);
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

  // Drives Instagram's DM flow end-to-end for a cold-profile Priority Message
  // Request. The order matters and is different from what a normal DM to a
  // mutual would look like:
  //
  //   1. click Message on the profile
  //   2. Instagram opens a "Messaging <handle>" modal with two buttons:
  //        "Send prioritized message" (primary)  ← we click this
  //        "Send message request"    (secondary)
  //      Clicking either dismisses the modal; ONLY THEN does the composer open.
  //   3. wait for the composer text field
  //   4. type the templated body
  //   5. click Send
  //
  // A warm profile (mutual follow, or an existing thread) skips step 2 — the
  // composer opens directly. We handle that transparently by treating the
  // priority-modal wait as best-effort and moving on when it never appears.
  //
  // Throws with a specific reason on each failure mode so the dashboard
  // timeline shows the operator which step broke.
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

    // 2. Click "Send prioritized message" in the modal that IG shows for cold
    //    profiles. When the modal never appears (warm profile / open thread)
    //    this returns false and we fall straight through to the composer wait.
    const clickedPriority = await clickPrioritizedMessageIfOffered();

    // 3. Wait for the composer text field to appear. Instagram either opens an
    //    in-page drawer or navigates to /direct/t/<thread>. Give the priority
    //    click a bit longer to unwind since it kicks off a network round-trip.
    const composerTimeout = clickedPriority ? 25000 : 20000;
    const field = await waitFor(findMessageField, { timeout: composerTimeout });
    if (!field) {
      throw new Error(
        clickedPriority
          ? 'Message composer never opened after Send prioritized message'
          : 'Message composer never opened',
      );
    }

    // 4. Type the body.
    typeIntoField(field, String(body));
    // Small settle: React needs a tick to enable the Send button.
    await sleep(600);

    // 5. Click Send. Poll — React can take a moment to enable the button after
    //    the input event.
    const sent = await waitFor(async () => {
      const ok = await clickSend();
      return ok || null;
    }, { timeout: 8000, interval: 400 });
    if (!sent) throw new Error('Send button did not fire (disabled or not found)');

    // 6. Wait for the composer to acknowledge the send — the message either
    //    appears in the thread or the drawer closes.
    await sleep(1500);

    return { ok: true, prioritized: clickedPriority };
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
