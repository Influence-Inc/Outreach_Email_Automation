const { google } = require('googleapis');
const db = require('../db');
const { renderOutreach, renderFollowup } = require('./templates');
const { sendEmail, threadHasReply, newTrackingId } = require('./gmail');
const { getAuthorizedClient } = require('./oauth');
const { verifyEmail } = require('./emailVerify');
const { unsubscribeUrl, unsubscribeMailto } = require('./unsubscribe');
const { varyOutreach } = require('./outreachVary');

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
  const { creator, to, subject, body, trackingId, unsubUrl, unsubMailto } = prep;

  try {
    const sent = await sendEmail({
      to,
      subject,
      body,
      trackingId,
      listUnsubscribeUrl: unsubUrl,
      listUnsubscribeMailto: unsubMailto,
    });

    await db.query(
      `UPDATE creators
       SET status = 'outreach_sent',
           outreach_message_id = $2,
           outreach_thread_id = $3,
           outreach_sent_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [creatorId, trackingId, sent.threadId],
    );

    await db.query(
      `INSERT INTO email_events (creator_id, type, message_id, detail)
       VALUES ($1, 'sent_outreach', $2, $3)`,
      [creatorId, trackingId, {
        gmailMessageId: sent.gmailMessageId,
        threadId: sent.threadId,
        rfc822MessageId: sent.rfc822MessageId,
        subject,
        templateId: creator.template_id || null,
        templateName: creator.template_name || null,
      }],
    );

    return { ok: true, trackingId, threadId: sent.threadId };
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

// Self-heal for the extension-send path. When the post-send Gmail Sent-folder
// lookup times out, a creator is left with outreach_thread_id = NULL — which
// makes them invisible to the scheduler's reply detection (and therefore to the
// Claude negotiation flow). Gmail's Sent indexing always catches up eventually,
// so the scheduler calls this every tick for stuck creators to recover the
// thread id and re-arm reply detection. Idempotent: the UPDATE is guarded on
// outreach_thread_id IS NULL, and a found thread writes a 'thread_recovered'
// audit event. Returns { ok, threadId } on success, { ok: false } otherwise.
async function backfillExtensionThread(creatorId) {
  const creator = await db.one(
    `SELECT id, outreach_message_id, outreach_thread_id, outreach_sent_at
     FROM creators WHERE id = $1`,
    [creatorId],
  );
  if (!creator) return { ok: false, reason: 'gone' };
  if (creator.outreach_thread_id) return { ok: false, reason: 'already_threaded' };
  if (!creator.outreach_message_id) return { ok: false, reason: 'no_tracking_id' };

  const located = await locateExtensionSent({
    trackingId: creator.outreach_message_id,
    sentAfterEpochMs: creator.outreach_sent_at
      ? new Date(creator.outreach_sent_at).getTime()
      : null,
  });
  if (!located.found) return { ok: false, reason: 'not_indexed_yet' };

  await db.query(
    `UPDATE creators
     SET outreach_thread_id = $2, updated_at = NOW()
     WHERE id = $1 AND outreach_thread_id IS NULL`,
    [creatorId, located.threadId],
  );
  await db.query(
    `INSERT INTO email_events (creator_id, type, message_id, detail)
     VALUES ($1, 'thread_recovered', $2, $3)`,
    [creatorId, creator.outreach_message_id, {
      threadId: located.threadId,
      gmailMessageId: located.gmailMessageId,
      rfc822MessageId: located.rfc822MessageId,
    }],
  );
  return { ok: true, threadId: located.threadId };
}

// Returns the list of follow-up steps the campaign should run. Falls back
// to one step at FOLLOWUP_DELAY_HOURS if the active template has none —
// matches the pre-template behaviour.
function resolveFollowupSteps(creator) {
  const list = activeTemplate(creator).followups;
  if (list.length) return list;
  const legacyDelay = Number(process.env.FOLLOWUP_DELAY_HOURS || 48);
  return [{ delayHours: legacyDelay }];
}

async function sendFollowup(creatorId) {
  const creator = await loadCreatorContext(creatorId);
  if (!creator) throw new Error(`Creator ${creatorId} not found`);
  if (!creator.outreach_sent_at) throw new Error(`Cannot follow up before outreach`);

  // Same suppression check as outreach — if the recipient has unsubscribed
  // since the original send, do not follow up.
  const suppressed = await lookupSuppression(creator.email);
  if (suppressed) {
    await db.query(
      `UPDATE creators SET status = 'suppressed', notes = $2, updated_at = NOW() WHERE id = $1`,
      [creatorId, `suppressed (${suppressed.reason})`],
    );
    await db.query(
      `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'suppressed', $2)`,
      [creatorId, { email: creator.email, reason: suppressed.reason, phase: 'followup' }],
    );
    return { ok: false, reason: 'suppressed' };
  }

  const steps = resolveFollowupSteps(creator);
  const nextStepIndex = creator.followup_step || 0;
  if (nextStepIndex >= steps.length) {
    throw new Error(`No more follow-up steps for creator ${creatorId}`);
  }

  if (creator.outreach_thread_id) {
    const hasReply = await threadHasReply(creator.outreach_thread_id);
    if (hasReply) {
      await markReplied(creatorId);
      return { ok: false, reason: 'replied' };
    }
  }

  const { unsubUrl, unsubMailto } = buildUnsubscribe(creatorId);
  const { subject, body } = renderFollowup(
    activeTemplate(creator),
    templateVars(creator, { unsubscribeUrl: unsubUrl }),
    nextStepIndex,
  );

  const trackingId = newTrackingId();

  try {
    const lastEvent = await db.one(
      `SELECT detail FROM email_events
       WHERE creator_id = $1 AND type IN ('sent_outreach', 'sent_followup')
       ORDER BY created_at DESC LIMIT 1`,
      [creatorId],
    );
    const rfc822 = lastEvent && lastEvent.detail ? lastEvent.detail.rfc822MessageId : null;

    const sent = await sendEmail({
      to: creator.email,
      subject,
      body,
      threadId: creator.outreach_thread_id,
      inReplyTo: rfc822,
      references: rfc822,
      trackingId,
      listUnsubscribeUrl: unsubUrl,
      listUnsubscribeMailto: unsubMailto,
    });

    const newStep = nextStepIndex + 1;
    await db.query(
      `UPDATE creators
       SET status = 'followup_sent',
           followup_message_id = $2,
           followup_sent_at = NOW(),
           followup_step = $3,
           updated_at = NOW()
       WHERE id = $1`,
      [creatorId, trackingId, newStep],
    );

    await db.query(
      `INSERT INTO email_events (creator_id, type, message_id, detail)
       VALUES ($1, 'sent_followup', $2, $3)`,
      [creatorId, trackingId, {
        gmailMessageId: sent.gmailMessageId,
        threadId: sent.threadId,
        rfc822MessageId: sent.rfc822MessageId,
        subject,
        step: newStep,
        totalSteps: steps.length,
        templateId: creator.template_id || null,
        templateName: creator.template_name || null,
      }],
    );

    return { ok: true, trackingId, step: newStep, totalSteps: steps.length };
  } catch (err) {
    await db.query(
      `INSERT INTO email_events (creator_id, type, detail)
       VALUES ($1, 'failed', $2)`,
      [creatorId, { phase: 'followup', step: nextStepIndex + 1, error: err.message }],
    );
    throw err;
  }
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
  sendFollowup,
  markReplied,
  resolveFollowupSteps,
  prepareOutreach,
  locateExtensionSent,
  markExtensionOutreachSent,
  backfillExtensionThread,
};
