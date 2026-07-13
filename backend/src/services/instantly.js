'use strict';

const BASE = 'https://api.instantly.ai/api/v2';

function apiKey() {
  const k = process.env.INSTANTLY_API_KEY;
  if (!k) throw new Error('INSTANTLY_API_KEY is not set');
  return k;
}

const TIMEOUT_MS = Number(process.env.INSTANTLY_TIMEOUT_MS || 15000);
const MAX_ATTEMPTS = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// `sendOnce` — when true, treat this as a non-idempotent send: a timeout or
// network error (AbortError / TypeError) is AMBIGUOUS (the server may have
// already processed the request and sent the email), so we do NOT retry. We
// still retry on explicit 5xx / 429 because those confirm the server rejected
// the request, so re-sending is safe. Used by /emails/reply to prevent the
// same offer email going out multiple times when the first POST times out
// mid-flight — the exact "showed aborted and failed but 2-3 emails arrived"
// symptom we saw in the dashboard.
async function request(method, path, body, { sendOnce = false } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey()}`,
        },
        body: body != null ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      // Retry transient server errors / rate limits; fail fast on 4xx.
      if (res.status >= 500 || res.status === 429) {
        const text = await res.text().catch(() => '');
        throw Object.assign(new Error(`Instantly ${method} ${path} → ${res.status}: ${text}`), {
          retryable: true,
        });
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Instantly ${method} ${path} → ${res.status}: ${text}`);
      }
      return res.json();
    } catch (err) {
      lastErr = err;
      // Server-signalled retryables (5xx / 429) are always safe to retry — the
      // server confirmed it did NOT process the request. AbortError / TypeError
      // are ambiguous: the server may have processed it and we just missed the
      // response. For non-idempotent sends (`sendOnce`), treat those as fatal
      // — one attempt only — to avoid double-sending an offer email.
      const ambiguous = err.name === 'AbortError' || err.name === 'TypeError';
      const retryable = err.retryable || (!sendOnce && ambiguous);
      if (!retryable || attempt === MAX_ATTEMPTS) throw err;
      await sleep(2 ** attempt * 1000); // 2s, 4s
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

// Render the model's body into HTML for the sent email. Supports a small
// markdown subset the negotiation prompt asks Claude to use:
//   **bold**           → <strong>bold</strong>
//   [label](https://…) → <a href="https://…">label</a>
//   bare https://…     → clickable link
// Everything else stays plain text with <br>-preserved line breaks. HTML
// escape runs first so the model can't inject tags via the body.
function renderMarkdown(text) {
  const esc = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  // 1. Explicit markdown links FIRST so their URL isn't re-linkified next.
  let out = esc.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_m, label, url) => `<a href="${url}">${label}</a>`,
  );
  // 2. Bare URLs — but not the ones already inside an href we just wrote.
  out = out.replace(/(?<![">=])\bhttps?:\/\/[^\s<]+/g, (m) => `<a href="${m}">${m}</a>`);
  // 3. Bold. Non-greedy, single line (avoids gobbling across paragraphs).
  out = out.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
  // 4. Newlines → <br>.
  return out.replace(/\r?\n/g, '<br>\n');
}

// Plain-text counterpart of the HTML body. Strips markdown markers so
// text-only mail clients (Instantly falls back to `text` when the HTML part
// is dropped) don't see raw ** or [label](url). URLs are rendered inline.
function stripMarkdown(text) {
  return String(text)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)')
    .replace(/\*\*([^*\n]+?)\*\*/g, '$1');
}

// Kept for backward compatibility with anything importing the old name.
const textToHtml = renderMarkdown;

// Add a single lead to the outreach campaign. Instantly will send the
// campaign's Step 1 email (outreach) and any configured follow-up steps
// automatically.
//
// skip_if_in_workspace is deliberately FALSE: when true, Instantly silently
// skips any email that already exists ANYWHERE in the workspace (e.g. added to
// a different campaign during testing), returning success with leads_uploaded=0
// and no email ever sent. Our own outreach_sent_at guard already prevents
// re-adding the same creator, so we want the lead enrolled in THIS campaign
// even if the address exists elsewhere.
async function addLeadToCampaign({ email, firstName, campaignId, companyName }) {
  const id = campaignId || process.env.INSTANTLY_CAMPAIGN_ID;
  if (!id) throw new Error('INSTANTLY_CAMPAIGN_ID is not set');
  // company_name populates Instantly's {{companyName}} merge tag. Set it to the
  // brand so subjects/bodies like "Paid Partnership with {{companyName}}" render
  // the brand — which also makes the outreach subject match the negotiation
  // reply subject so the whole exchange stays in one thread.
  const lead = { email, first_name: firstName };
  if (companyName) lead.company_name = companyName;
  return request('POST', '/leads/add', {
    campaign_id: id,
    skip_if_in_workspace: false,
    leads: [lead],
  });
}

// Send a threaded reply within an existing Instantly conversation. reply_to_uuid
// comes from the reply_received webhook payload and routes the reply into the
// correct thread; eaccount is the connected sending mailbox to reply FROM
// (Instantly requires it — it's the email_account from the reply webhook).
async function replyToEmail({ replyToUuid, eaccount, subject, body }) {
  // `sendOnce`: sending an email isn't idempotent — a timeout after the server
  // has already accepted the request produces a real duplicate email in the
  // creator's inbox. Retrying on timeout/network is what caused the "showed
  // aborted, still got 3 emails" bug. We only retry on explicit server-side
  // rejections (5xx / 429), which are safe.
  return request('POST', '/emails/reply', {
    reply_to_uuid: replyToUuid,
    eaccount,
    subject,
    // text = markdown-stripped so text-only clients see clean prose;
    // html = markdown-rendered so bold and links land as formatting.
    body: { text: stripMarkdown(body), html: renderMarkdown(body) },
  }, { sendOnce: true });
}

// Add an address to the workspace block list so Instantly stops emailing it —
// including follow-up steps ALREADY queued for a lead. This is how outreach is
// actually HALTED: Instantly owns the sequence scheduling, so pausing/removing
// our local creator row does nothing to the follow-ups; the address has to be
// blocked on Instantly's side. Idempotent enough for our use — re-blocking an
// address that's already listed returns a 4xx we treat as already-blocked at
// the call site. `bl_value` accepts a full email or a domain.
async function blocklistEmail(email) {
  const value = String(email || '').trim().toLowerCase();
  if (!value) throw new Error('email is required to blocklist');
  return request('POST', '/block-lists-entries', { bl_value: value });
}

// One page of mailbox emails (sent + received) from the Instantly unibox —
// the read side of the connected mailbox (e.g. jennifer@useinfluence.xyz).
// Used by the reply-learning harvest to reconstruct past (creator inbound →
// manager reply) exchanges. Pagination is cursor-based: pass the previous
// page's `next_starting_after` back as `startingAfter`.
async function listEmails({ limit = 100, startingAfter = null, eaccount = null } = {}) {
  const params = new URLSearchParams();
  params.set('limit', String(Math.max(1, Math.min(100, limit))));
  if (startingAfter) params.set('starting_after', String(startingAfter));
  if (eaccount) params.set('eaccount', String(eaccount));
  return request('GET', `/emails?${params.toString()}`);
}

module.exports = {
  addLeadToCampaign,
  replyToEmail,
  blocklistEmail,
  listEmails,
  // Exported for tests and any other caller that needs the same rendering
  // logic outside the reply path.
  renderMarkdown,
  stripMarkdown,
  textToHtml, // legacy alias
};
