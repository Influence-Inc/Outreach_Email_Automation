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

async function request(method, path, body) {
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
      // AbortError (timeout) and network errors are retryable; explicit 4xx is not.
      const retryable = err.retryable || err.name === 'AbortError' || err.name === 'TypeError';
      if (!retryable || attempt === MAX_ATTEMPTS) throw err;
      await sleep(2 ** attempt * 1000); // 2s, 4s
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

// Minimal text→HTML so newlines render as line breaks in the HTML part.
function textToHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, '<br>\n');
}

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
  return request('POST', '/emails/reply', {
    reply_to_uuid: replyToUuid,
    eaccount,
    subject,
    body: { text: body, html: textToHtml(body) },
  });
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

module.exports = { addLeadToCampaign, replyToEmail, listEmails };
