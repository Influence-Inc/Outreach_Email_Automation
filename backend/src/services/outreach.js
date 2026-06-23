const db = require('../db');
const { renderOutreach } = require('./templates');
const { newTrackingId } = require('./gmail');
const { verifyEmail } = require('./emailVerify');
const { unsubscribeUrl, unsubscribeMailto } = require('./unsubscribe');
const { varyOutreach } = require('./outreachVary');
const instantly = require('./instantly');

// Pre-send verification is on by default; set EMAIL_VERIFY=0 to disable.
const verifyEnabled = !/^(0|false|no|off)$/i.test(process.env.EMAIL_VERIFY || '');

// Suppression list lookup. Returns the row (or null). Anyone on this list is
// silently skipped — they've unsubscribed, bounced, or been manually flagged.
async function lookupSuppression(email) {
  if (!email) return null;
  return db.one(
    `SELECT email, reason FROM email_suppressions WHERE LOWER(email) = LOWER($1)`,
    [email],
  );
}

// Tracking subdomain (for unsubscribe URL). Same fallback chain as the
// pixel host in gmail.js: TRACKING_BASE_URL → PUBLIC_BASE_URL.
function trackingBaseUrl() {
  const base = process.env.TRACKING_BASE_URL || process.env.PUBLIC_BASE_URL || '';
  return base.replace(/\/$/, '');
}

// Build the per-creator List-Unsubscribe / footer values. Returns nullish
// if UNSUBSCRIBE_SECRET isn't set — the email still sends, just without the
// unsubscribe affordance (better to deliver than to error out at boot).
function buildUnsubscribe(creatorId) {
  if (!process.env.UNSUBSCRIBE_SECRET) return {};
  const base = trackingBaseUrl();
  const senderEmail = process.env.SENDER_EMAIL;
  return {
    unsubUrl: base ? unsubscribeUrl(base, creatorId) : null,
    unsubMailto: senderEmail ? unsubscribeMailto(senderEmail, creatorId) : null,
  };
}

// Joins each creator with the active template for their campaign: that
// campaign's template_id, or whichever template is marked is_default, or
// null (in which case render* will fall back to hardcoded copy).
async function loadCreatorContext(creatorId) {
  return db.one(
    `SELECT c.*,
            ca.name AS campaign_name,
            ca.brand_name AS brand_name,
            et.id AS template_id,
            et.name AS template_name,
            et.outreach AS template_outreach,
            et.followups AS template_followups
     FROM creators c
     JOIN campaigns ca ON ca.id = c.campaign_id
     LEFT JOIN email_templates et
       ON et.id = COALESCE(
         ca.template_id,
         (SELECT id FROM email_templates WHERE is_default LIMIT 1)
       )
     WHERE c.id = $1`,
    [creatorId],
  );
}

function templateVars(creator, extras = {}) {
  return {
    firstName: creator.first_name || 'there',
    brandName: creator.brand_name,
    campaignName: creator.campaign_name,
    creatorId: creator.id,
    ...extras,
  };
}

function activeTemplate(creator) {
  return {
    outreach: creator.template_outreach || null,
    followups: Array.isArray(creator.template_followups) ? creator.template_followups : [],
  };
}

// Render + pre-send checks, without actually sending. Used by both sendOutreach
// (the Gmail-API path) and the /prepare-outreach route (the extension path).
// Returns { ok: true, ...payload } when the recipient is sendable, or
// { ok: false, skipReason, message } when suppression or email-verification
// rejects the recipient. Side effects on rejection match the API path
// (status flip + email_event row) so a bulk run leaves the same trail no
// matter which transport sent the batch.
async function prepareOutreach(creatorId) {
  const creator = await loadCreatorContext(creatorId);
  if (!creator) throw new Error(`Creator ${creatorId} not found`);
  if (!creator.email) throw new Error(`Creator ${creatorId} has no email`);
  if (creator.outreach_sent_at) {
    return { ok: false, skipReason: 'already_sent', message: `Outreach already sent to creator ${creatorId}` };
  }

  const suppressed = await lookupSuppression(creator.email);
  if (suppressed) {
    await db.query(
      `UPDATE creators SET status = 'suppressed', notes = $2, updated_at = NOW() WHERE id = $1`,
      [creatorId, `suppressed (${suppressed.reason})`],
    );
    await db.query(
      `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'suppressed', $2)`,
      [creatorId, { email: creator.email, reason: suppressed.reason }],
    );
    return { ok: false, skipReason: 'suppressed', message: `email is on suppression list (${suppressed.reason})` };
  }

  if (verifyEnabled) {
    const verdict = await verifyEmail(creator.email);
    if (!verdict.valid) {
      await db.query(
        `UPDATE creators SET status = 'invalid_email', notes = $2, updated_at = NOW() WHERE id = $1`,
        [creatorId, `invalid email (${verdict.reason})`],
      );
      await db.query(
        `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'invalid_email', $2)`,
        [creatorId, { email: creator.email, reason: verdict.reason }],
      );
      return { ok: false, skipReason: 'invalid_email', message: `email failed verification: ${verdict.reason}` };
    }
  }

  const { unsubUrl, unsubMailto } = buildUnsubscribe(creatorId);
  const rendered = renderOutreach(
    activeTemplate(creator),
    templateVars(creator, { unsubscribeUrl: unsubUrl }),
  );
  const { subject, body } = await varyOutreach(rendered);
  const trackingId = newTrackingId();
  const base = trackingBaseUrl();
  const trackingPixelUrl = base ? `${base}/o/${trackingId}.gif` : null;

  return {
    ok: true,
    creator,
    to: creator.email,
    subject,
    body,
    trackingId,
    trackingPixelUrl,
    unsubUrl,
    unsubMailto,
  };
}

async function sendOutreach(creatorId) {
  const prep = await prepareOutreach(creatorId);
  if (!prep.ok) throw new Error(prep.message);
  const { creator, to, trackingId } = prep;

  try {
    await instantly.addLeadToCampaign({
      email: to,
      firstName: creator.first_name || '',
      campaignId: process.env.INSTANTLY_CAMPAIGN_ID,
    });

    // outreach_message_id stores the trackingId for audit trail;
    // outreach_thread_id is null — Instantly owns threading for outreach + follow-ups.
    await db.query(
      `UPDATE creators
       SET status = 'outreach_sent',
           outreach_message_id = $2,
           outreach_thread_id = NULL,
           outreach_sent_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [creatorId, trackingId],
    );

    await db.query(
      `INSERT INTO email_events (creator_id, type, message_id, detail)
       VALUES ($1, 'sent_outreach', $2, $3)`,
      [creatorId, trackingId, {
        via: 'instantly',
        templateId: creator.template_id || null,
        templateName: creator.template_name || null,
      }],
    );

    return { ok: true, trackingId };
  } catch (err) {
    await db.query(
      `INSERT INTO email_events (creator_id, type, detail)
       VALUES ($1, 'failed', $2)`,
      [creatorId, { phase: 'outreach', error: err.message }],
    );
    await db.query(
      `UPDATE creators SET status = 'failed', notes = $2, updated_at = NOW() WHERE id = $1`,
      [creatorId, `outreach failed: ${err.message}`],
    );
    throw err;
  }
}

// Locate a Gmail Sent message by the unique trackingId baked into the body's
// pixel <img src=…> URL. Gmail's full-text index covers HTML content (including
// URL text), and the 24-hex trackingId is unique per send, so this returns at
// most one match. Used by the extension path: after the user's local Gmail UI
// sends the message, we read the Sent folder via the API (same OAuth mailbox)
// to recover the gmailMessageId / threadId / rfc822MessageId — which the
// follow-up + negotiation flows already use for threading.
//
// Gmail's Sent indexing can lag a few seconds after a UI send, so this is
// meant to be polled with backoff by the caller.
async function locateExtensionSent({ trackingId, sentAfterEpochMs }) {
  if (!trackingId) throw new Error('trackingId required');
  const auth = await getAuthorizedClient();
  const gmail = google.gmail({ version: 'v1', auth });
  // `after:` takes seconds since epoch. Subtract 60s of slack so a clock skew
  // between the backend and the browser doesn't push our message out of range.
  const afterSec = sentAfterEpochMs
    ? Math.max(0, Math.floor(sentAfterEpochMs / 1000) - 60)
    : 0;
  const q = afterSec
    ? `in:sent "${trackingId}" after:${afterSec}`
    : `in:sent "${trackingId}"`;
  const list = await gmail.users.messages.list({ userId: 'me', q, maxResults: 5 });
  const messages = list.data.messages || [];
  if (!messages.length) return { found: false };
  // Pick the newest match (closest to "just now"). messages.list returns
  // newest-first by default.
  const msgId = messages[0].id;
  const full = await gmail.users.messages.get({
    userId: 'me',
    id: msgId,
    format: 'metadata',
    metadataHeaders: ['Message-ID'],
  });
  const headers = (full.data.payload && full.data.payload.headers) || [];
  const rfc822 = headers.find((h) => /^Message-ID$/i.test(h.name));
  return {
    found: true,
    gmailMessageId: full.data.id,
    threadId: full.data.threadId,
    rfc822MessageId: rfc822 ? rfc822.value : null,
  };
}

// Record an extension-sent outreach after the locate succeeded (or timed out).
// Mirrors the DB writes sendOutreach does on the API path so follow-ups and
// negotiation reuse the same threading + tracking-pixel plumbing. When the
// locate timed out, gmailMessageId/threadId/rfc822MessageId are null; the row
// still flips to outreach_sent (so we don't double-send), but we also emit a
// 'thread_unmatched' event so the admin can see threading was lost on this one.
async function markExtensionOutreachSent(creatorId, { trackingId, gmailMessageId, threadId, rfc822MessageId, subject }) {
  if (!trackingId) throw new Error('trackingId required');
  const creator = await loadCreatorContext(creatorId);
  if (!creator) throw new Error(`Creator ${creatorId} not found`);
  if (creator.outreach_sent_at) {
    return { ok: true, alreadyMarked: true };
  }

  await db.query(
    `UPDATE creators
     SET status = 'outreach_sent',
         outreach_message_id = $2,
         outreach_thread_id = $3,
         outreach_sent_at = NOW(),
         updated_at = NOW()
     WHERE id = $1`,
    [creatorId, trackingId, threadId || null],
  );

  await db.query(
    `INSERT INTO email_events (creator_id, type, message_id, detail)
     VALUES ($1, 'sent_outreach', $2, $3)`,
    [creatorId, trackingId, {
      via: 'extension',
      gmailMessageId: gmailMessageId || null,
      threadId: threadId || null,
      rfc822MessageId: rfc822MessageId || null,
      subject: subject || null,
      templateId: creator.template_id || null,
      templateName: creator.template_name || null,
    }],
  );

  if (!threadId) {
    await db.query(
      `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'thread_unmatched', $2)`,
      [creatorId, { trackingId, reason: 'gmail_sent_lookup_failed' }],
    );
  }

  return { ok: true, threadId: threadId || null };
}

async function markReplied(creatorId) {
  await db.query(
    `UPDATE creators
     SET status = 'replied', replied_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND status <> 'replied'`,
    [creatorId],
  );
  await db.query(
    `INSERT INTO email_events (creator_id, type) VALUES ($1, 'replied')`,
    [creatorId],
  );
}

module.exports = {
  sendOutreach,
  markReplied,
  prepareOutreach,
  locateExtensionSent,
  markExtensionOutreachSent,
};
