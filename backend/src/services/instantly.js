'use strict';

const BASE = 'https://api.instantly.ai/api/v2';

function apiKey() {
  const k = process.env.INSTANTLY_API_KEY;
  if (!k) throw new Error('INSTANTLY_API_KEY is not set');
  return k;
}

async function request(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey()}`,
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Instantly ${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

// Add a single lead to the outreach campaign. Instantly will send the
// campaign's Step 1 email (outreach) and any configured follow-up steps
// automatically. skip_if_in_workspace prevents double-adding on retry.
async function addLeadToCampaign({ email, firstName, campaignId }) {
  const id = campaignId || process.env.INSTANTLY_CAMPAIGN_ID;
  if (!id) throw new Error('INSTANTLY_CAMPAIGN_ID is not set');
  return request('POST', '/leads/add', {
    campaign_id: id,
    skip_if_in_workspace: true,
    leads: [{ email, first_name: firstName }],
  });
}

// Send a threaded reply within an existing Instantly conversation. reply_to_uuid
// comes from the reply_received webhook payload and routes the reply into the
// correct inbox + thread automatically.
async function replyToEmail({ replyToUuid, subject, body }) {
  return request('POST', '/emails/reply', {
    reply_to_uuid: replyToUuid,
    subject,
    body: { text: body, html: body },
  });
}

module.exports = { addLeadToCampaign, replyToEmail };
