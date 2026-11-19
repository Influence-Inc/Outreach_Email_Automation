// TikTok DM sender — the TikTok twin of instagram-dm.js. Sends the campaign's
// DM template to a creator the dashboard couldn't find an email for.
//
// Clicking "Message" on a TikTok profile moves the tab to TikTok's /messages
// page (sometimes a full page load, which restarts this content script), so
// background.js drives the send in two steps:
//
//   { action: 'tiktokOpenDm', username }        — on the profile page: click
//       "Message". Reply { ok: true } or { ok: false, error }.
//   { action: 'tiktokSendDm', body, username }  — on the /messages page: wait
//       for the composer, check the open conversation is this creator's, type
//       the body, send, and confirm it went out. Reply { ok } / { ok, error }.
//
// Each failure carries a specific reason (not signed in, no Message button —
// the creator only accepts messages from people they follow back, composer
// never opened, TikTok refused the send …) so the dashboard timeline shows
// what happened.
(function () {
  'use strict';

  if (window.__infTikTokDmLoaded) return;
  window.__infTikTokDmLoaded = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(predicate, { timeout = 15000, interval = 250 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        const v = await predicate();
        if (v) return v;
      } catch {
        /* keep polling */
      }
      await sleep(interval);
    }
    return null;
  }

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  }

  function textOf(el) {
    return ((el && (el.innerText || el.textContent)) || '').trim();
  }

  // A visible clickable whose own text or aria-label is exactly one of `labels`.
  function findClickable(labels, root = document) {
    const wanted = labels.map((l) => l.toLowerCase());
    for (const el of root.querySelectorAll('button, a, div[role="button"]')) {
      if (!visible(el)) continue;
      const label = (el.getAttribute('aria-label') || textOf(el)).toLowerCase();
      if (wanted.includes(label)) return el;
    }
    return null;
  }

  // TikTok shows a "Log in" button in the top bar (and opens a login modal on
  // actions) when the browser isn't signed in.
  function signedOut() {
    if (document.querySelector('[data-e2e="nav-login-button"], [data-e2e="top-login-button"]')) return true;
    const loginBtn = findClickable(['log in']);
    const avatar = document.querySelector('[data-e2e="profile-icon"], [data-e2e="nav-profile"] img, header img[alt*="avatar" i]');
    return !!loginBtn && !avatar;
  }

  // ---- Step 1: profile page → click Message --------------------------------

  async function openDm({ username }) {
    if (signedOut()) throw new Error('not signed in to TikTok — sign in in this Chrome profile and retry');
    const msgBtn = await waitFor(
      () => {
        const byHook = document.querySelector('[data-e2e="message-button"], [data-e2e="message-icon"]');
        if (byHook && visible(byHook)) return byHook.closest('button, a, div[role="button"]') || byHook;
        return findClickable(['message', 'send message']);
      },
      { timeout: 15000 },
    );
    if (!msgBtn) {
      if (signedOut()) throw new Error('not signed in to TikTok — sign in in this Chrome profile and retry');
      const followBtn = document.querySelector('[data-e2e="follow-button"]') || findClickable(['follow', 'follow back']);
      throw new Error(
        followBtn
          ? `TikTok shows no Message button for @${username} — they only accept messages from people they follow (or from friends)`
          : `Message button not found on @${username}'s TikTok profile`,
      );
    }
    msgBtn.click();
    return { ok: true };
  }

  // ---- Step 2: /messages page → type + send ---------------------------------

  function findComposer() {
    const candidates = document.querySelectorAll(
      '[data-e2e="message-input-area"] [contenteditable="true"], ' +
        '.public-DraftEditor-content[contenteditable="true"], ' +
        'div[contenteditable="true"][role="textbox"], ' +
        '[data-e2e="message-input-area"] textarea',
    );
    for (const el of candidates) if (visible(el)) return el;
    return null;
  }

  // The @handle of the conversation that's open, when TikTok shows it.
  function openConversationHandle() {
    const el = document.querySelector('[data-e2e="chat-uniqueid"]');
    const t = textOf(el).replace(/^@/, '');
    return t || null;
  }

  // A notice TikTok shows in place of / above the composer when it won't let
  // you message this account.
  const BLOCKED_RE = /(can'?t|cannot|unable to|not able to) (send|message)|doesn'?t (accept|allow) messages|only (friends|mutual|people)[^.]{0,40}(can )?message|messag(e|ing) (is )?(turned off|unavailable|restricted)/i;
  function blockedNotice() {
    const scope = document.querySelector('[data-e2e="chat-main"], main') || document.body;
    const m = textOf(scope).match(new RegExp(`[^.\\n]{0,80}${BLOCKED_RE.source}[^.\\n]{0,80}`, 'i'));
    return m ? m[0].trim() : null;
  }

  function composerText(field) {
    return field.tagName === 'TEXTAREA' ? field.value : textOf(field);
  }

  // TikTok's composer is a Draft.js editor. Like Instagram's Lexical editor it
  // drops newlines typed through execCommand, and Enter SENDS, so a synthesized
  // paste (which Draft's onPaste reads from clipboardData) is the one path that
  // keeps the paragraphs. Falls back to a plain insertText so the words still
  // go through if the paste is ignored.
  async function typeBody(field, body) {
    const text = String(body).replace(/\r\n?/g, '\n');
    field.focus();
    await sleep(80);
    if (field.tagName === 'TEXTAREA') {
      field.value = text;
      field.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      field.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
    } catch (e) {
      console.warn('[Influence TikTok DM] paste insertion failed:', e && e.message);
    }
    await sleep(400);
    const lastLine = text.trim().split('\n').filter(Boolean).pop() || text.trim();
    const needle = lastLine.slice(0, 24).toLowerCase();
    if (needle && composerText(field).toLowerCase().includes(needle)) return;

    console.warn('[Influence TikTok DM] paste did not populate the composer; falling back to insertText (line breaks will be lost)');
    field.focus();
    let ok = false;
    try {
      ok = document.execCommand('insertText', false, text.replace(/\n+/g, ' '));
    } catch {
      ok = false;
    }
    if (!ok) {
      field.textContent = text;
      field.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    }
    await sleep(300);
  }

  function clickSend(field) {
    const btn =
      document.querySelector('[data-e2e="message-send"]') ||
      findClickable(['send'], document.querySelector('[data-e2e="message-input-area"]')?.parentElement || document);
    if (btn && visible(btn) && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
      btn.click();
      return true;
    }
    // No send button: Enter sends in TikTok's composer (React handles the
    // dispatched keydown like a real one).
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    field.dispatchEvent(new KeyboardEvent('keydown', opts));
    field.dispatchEvent(new KeyboardEvent('keyup', opts));
    return true;
  }

  async function sendDm({ body, username }) {
    if (!body || !String(body).trim()) throw new Error('empty body');
    if (signedOut()) throw new Error('not signed in to TikTok — sign in in this Chrome profile and retry');

    const field = await waitFor(findComposer, { timeout: 25000 });
    if (!field) {
      const notice = blockedNotice();
      throw new Error(notice ? `TikTok won't let you message @${username}: "${notice}"` : 'TikTok message composer never opened');
    }

    // Make sure we're about to message the right person.
    const handle = await waitFor(openConversationHandle, { timeout: 4000 });
    if (handle && username && handle.toLowerCase() !== String(username).replace(/^@/, '').toLowerCase()) {
      throw new Error(`TikTok opened a conversation with @${handle}, not @${username} — nothing was sent`);
    }

    await typeBody(field, body);
    if (!composerText(field).trim()) throw new Error('could not type into the TikTok message composer');
    await sleep(400);
    clickSend(field);

    // Sent = the composer clears (TikTok empties it once the message posts).
    // A failure notice in the chat means TikTok refused it.
    const firstLine = String(body).trim().split('\n')[0].slice(0, 30).toLowerCase();
    const outcome = await waitFor(
      () => {
        const failed = document.querySelector('[data-e2e="message-failed"], [data-e2e="chat-message-failed"]');
        if (failed && visible(failed)) return { ok: false, error: 'TikTok marked the message as failed to send' };
        const notice = blockedNotice();
        if (notice) return { ok: false, error: `TikTok refused the message: "${notice}"` };
        const live = findComposer() || field;
        if (!composerText(live).trim()) return { ok: true };
        return null;
      },
      { timeout: 10000, interval: 300 },
    );
    if (!outcome) {
      const chat = document.querySelector('[data-e2e="chat-main"], main');
      if (firstLine && textOf(chat).toLowerCase().includes(firstLine) && !composerText(findComposer() || field).trim()) {
        return { ok: true };
      }
      throw new Error('TikTok did not confirm the message was sent (composer still full)');
    }
    if (!outcome.ok) throw new Error(outcome.error);
    await sleep(800);
    return { ok: true };
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!request) return false;
    if (request.action === 'tiktokOpenDm' || request.action === 'tiktokSendDm') {
      const run = request.action === 'tiktokOpenDm' ? openDm(request) : sendDm(request);
      run
        .then((res) => sendResponse(res))
        .catch((err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }));
      return true;
    }
    return false;
  });

  console.log('[Influence] TikTok DM sender loaded');
})();
