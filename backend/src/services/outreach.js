const db = require('../db');
const { renderOutreach, renderFollowup } = require('./templates');
const { sendEmail, threadHasReply, newTrackingId } = require('./gmail');
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

async function sendOutreach(creatorId) {
  const creator = await loadCreatorContext(creatorId);
  if (!creator) throw new Error(`Creator ${creatorId} not found`);
  if (!creator.email) throw new Error(`Creator ${creatorId} has no email`);
  if (creator.outreach_sent_at) throw new Error(`Outreach already sent to creator ${creatorId}`);

  // Suppression check. Any address that has unsubscribed / bounced / been
  // manually flagged is silently skipped — re-mailing them is the fastest
  // way to wreck domain reputation.
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
    throw new Error(`email is on suppression list (${suppressed.reason})`);
  }

  // Pre-send deliverability check — skip + flag undeliverable scraped addresses
  // so they don't bounce (bounces wreck sender reputation). Flagged invalids
  // leave 'email_found', so a re-run won't keep retrying them; fixing the email
  // in the dashboard re-arms the creator (status resets to 'email_found').
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
      throw new Error(`email failed verification: ${verdict.reason}`);
    }
  }

  const { unsubUrl, unsubMailto } = buildUnsubscribe(creatorId);
  const rendered = renderOutreach(
    activeTemplate(creator),
    templateVars(creator, { unsubscribeUrl: unsubUrl }),
  );
  const { subject, body } = await varyOutreach(rendered);
  const trackingId = newTrackingId();

  try {
    const sent = await sendEmail({
      to: creator.email,
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

module.exports = { sendOutreach, sendFollowup, markReplied, resolveFollowupSteps };
