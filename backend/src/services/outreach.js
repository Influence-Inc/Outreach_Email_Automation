const crypto = require('crypto');
const db = require('../db');
const { verifyEmail } = require('./emailVerify');
const { formatFirstName } = require('./nameFormat');
const instantly = require('./instantly');

// The name that flows into Instantly's {{firstName}} merge tag for the
// outreach email. The stored first_name is run through formatFirstName so the
// greeting always reads the way a person would write it ("Hi Pear,", not "Hi
// PEAR,"; "Hi Vermosa,", not "Hi ᴠᴇʀᴍᴏꜱᴀ,") — decorative casing, stylized
// fonts, and emoji get normalized out. Some Instagram profiles have no scraped
// display name at send time (bio hides it, private account, extraction miss);
// in that case we fall back to the creator's @handle so the greeting reads
// "Hi @rabin," instead of a jarring "Hi ,". The @ is included verbatim per the
// ask.
function outreachFirstName(creator) {
  const first = formatFirstName(creator.first_name);
  if (first) return first;
  const handle = String(creator.instagram_username || '').trim().replace(/^@+/, '');
  return handle ? `@${handle}` : '';
}

// Pre-send verification is on by default; set EMAIL_VERIFY=0 to disable.
const verifyEnabled = !/^(0|false|no|off)$/i.test(process.env.EMAIL_VERIFY || '');

// Audit-trail identifier for each outbound send. Instantly owns delivery +
// threading; this id just lets us correlate creators with email_events rows.
function newTrackingId() {
  return crypto.randomBytes(12).toString('hex');
}

// Suppression list lookup. Returns the row (or null). Anyone on this list is
// silently skipped — they've bounced or been manually flagged. Instantly owns
// recipient-driven unsubscribes via its own blocklist.
async function lookupSuppression(email) {
  if (!email) return null;
  return db.one(
    `SELECT email, reason FROM email_suppressions WHERE LOWER(email) = LOWER($1)`,
    [email],
  );
}

async function loadCreatorContext(creatorId) {
  return db.one(
    `SELECT c.*,
            ca.name AS campaign_name,
            ca.brand_name AS brand_name,
            ca.instantly_campaign_id AS instantly_campaign_id,
            et.id AS template_id,
            et.name AS template_name
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

// Render + pre-send checks, without actually sending. Returns
// { ok: true, ...payload } when the recipient is sendable, or
// { ok: false, skipReason, message } when suppression or email-verification
// rejects the recipient.
async function prepareOutreach(creatorId) {
  const creator = await loadCreatorContext(creatorId);
  if (!creator) throw new Error(`Creator ${creatorId} not found`);
  if (!creator.email) throw new Error(`Creator ${creatorId} has no email`);
  if (creator.outreach_sent_at) {
    return { ok: false, skipReason: 'already_sent', message: `Outreach already sent to creator ${creatorId}` };
  }
  // A creator flagged as a duplicate of another row in the campaign never gets
  // its own outreach — the original row carries the conversation. This also
  // guards a stray single-row "Send outreach" click (the bulk sender already
  // filters on status = 'email_found').
  if (creator.status === 'duplicate') {
    return { ok: false, skipReason: 'duplicate', message: `Creator ${creatorId} is a duplicate — outreach skipped so it isn't sent twice` };
  }
  // Outreach was explicitly stopped for this creator in this campaign (see the
  // stop-outreach route — the lead is removed from this Instantly campaign).
  // Never re-enroll this row; the same email in other campaigns is unaffected.
  if (creator.status === 'stopped') {
    return { ok: false, skipReason: 'stopped', message: `Outreach was stopped for creator ${creatorId}` };
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

  const trackingId = newTrackingId();

  return {
    ok: true,
    creator,
    to: creator.email,
    trackingId,
  };
}

async function sendOutreach(creatorId) {
  const prep = await prepareOutreach(creatorId);
  if (!prep.ok) throw new Error(prep.message);
  const { creator, to, trackingId } = prep;

  // Route to this campaign's own Instantly campaign (its own outreach copy +
  // follow-up sequence), falling back to the global env default when unmapped.
  const instantlyCampaignId = creator.instantly_campaign_id || process.env.INSTANTLY_CAMPAIGN_ID;
  if (!instantlyCampaignId) {
    throw new Error(
      `No Instantly campaign mapped for campaign "${creator.campaign_name}" and INSTANTLY_CAMPAIGN_ID is unset — ` +
        'set the campaign\'s Instantly campaign ID in the dashboard or the env fallback',
    );
  }

  try {
    const resp = await instantly.addLeadToCampaign({
      email: to,
      firstName: outreachFirstName(creator),
      campaignId: instantlyCampaignId,
      // Populates Instantly's {{companyName}} merge tag with the brand so the
      // outreach subject ("Paid Partnership with {{companyName}}") renders the
      // brand and matches the negotiation reply subject (same thread).
      companyName: creator.brand_name || process.env.BRAND_NAME || '',
    });
    // Log the brand we sent as company_name + Instantly's response, so we can
    // see both that the right per-campaign brand was sent AND whether the lead
    // was actually ADDED vs SKIPPED (the call returns 200 even when nothing is
    // enrolled).
    console.log(
      `[outreach] creator ${creatorId} company_name="${creator.brand_name || ''}" (campaign "${creator.campaign_name}") Instantly /leads/add response: ${JSON.stringify(resp).slice(0, 400)}`,
    );

    // Instantly returns success with leads_uploaded=0 when the lead was not
    // actually enrolled (blocklist, invalid, duplicate, or skipped). Treat that
    // as a failure so the creator isn't falsely marked 'outreach_sent'.
    if (resp && typeof resp.leads_uploaded === 'number' && resp.leads_uploaded < 1) {
      const why = [];
      if (resp.skipped_count) why.push('skipped (already in workspace)');
      if (resp.in_blocklist) why.push('in blocklist');
      if (resp.invalid_email_count) why.push('invalid email');
      if (resp.duplicate_email_count) why.push('duplicate in campaign');
      throw new Error(
        `Instantly enrolled 0 leads${why.length ? `: ${why.join(', ')}` : ' (no reason given)'}`,
      );
    }

    await db.query(
      `UPDATE creators
       SET status = 'outreach_sent',
           outreach_message_id = $2,
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
        instantlyCampaignId,
        templateId: creator.template_id || null,
        templateName: creator.template_name || null,
      }],
    );

    console.log(`[outreach] creator ${creatorId} added to Instantly campaign ${instantlyCampaignId}`);
    return { ok: true, trackingId };
  } catch (err) {
    console.error(`[outreach] creator ${creatorId} send failed:`, err.message);
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

// Types of outbound sends the app has ALREADY logged for a creator. When an
// Instantly email_sent webhook fires as the echo of one of these (a delegate
// reply, a priced offer, a negotiation reply, a contract send — all routed
// through /emails/reply), we must not also log it as a manual reply or the
// timeline shows the same send twice.
const APP_OUTBOUND_TYPES = [
  'sent_delegate_reply',
  'sent_negotiation',
  'rate_offer_sent',
  'contract_sent',
];

// Record a manual reply sent by a human — either from Instantly's unibox or
// directly from the connected mailbox. Idempotent on messageId: a re-delivered
// webhook logs the event exactly once, so the timeline never doubles up.
// Also skipped when an app-initiated send (delegate reply, priced offer,
// negotiation reply, contract) was just logged for this creator — that
// webhook fire is the echo of a send we already recorded, not a new manual
// send. Returns true when a fresh row was inserted. Does NOT change the
// creator's funnel status — a manual reply is a response, not a transition.
async function markManualReplySent(creatorId, { messageId = null, subject = null, body = null, source = null } = {}) {
  if (messageId) {
    const existing = await db.one(
      `SELECT id FROM email_events
       WHERE creator_id = $1 AND type = 'sent_manual_reply' AND message_id = $2
       LIMIT 1`,
      [creatorId, messageId],
    );
    if (existing) return false;
  }
  // A send the app itself just made through Instantly (delegate reply, offer,
  // negotiation reply, contract) fires an email_sent webhook too — those are
  // NOT a distinct manual reply, they're the echo of an event we already
  // logged. Suppress the manual-reply row when one of them was logged in the
  // last few minutes.
  const recent = await db.one(
    `SELECT 1 AS hit FROM email_events
     WHERE creator_id = $1
       AND type = ANY($2::text[])
       AND created_at > NOW() - INTERVAL '5 minutes'
     LIMIT 1`,
    [creatorId, APP_OUTBOUND_TYPES],
  );
  if (recent) return false;
  const detail = { source: source || 'manual' };
  if (subject) detail.subject = String(subject).slice(0, 500);
  if (body) detail.snippet = String(body).slice(0, 500);
  await db.query(
    `INSERT INTO email_events (creator_id, type, message_id, detail)
     VALUES ($1, 'sent_manual_reply', $2, $3)`,
    [creatorId, messageId, detail],
  );
  // A human just answered — clear the delegate flags so the next inbound is
  // processed by the automated flow instead of sitting in the Delegate queue.
  // Idempotent: no-op if the flags were already clear.
  await db.query(
    `UPDATE creators
       SET needs_human = FALSE,
           delegate_reason = NULL,
           delegate_question = NULL,
           updated_at = NOW()
     WHERE id = $1`,
    [creatorId],
  );
  return true;
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

// Record an email open reported by Instantly (the email_opened webhook). Bumps
// the open counter + timestamp so the dashboard's outreach ticks can turn green
// once the creator has seen an email. Never changes the funnel status — an open
// is a read receipt, not a reply. Safe to call on every open event.
async function markOpened(creatorId) {
  await db.query(
    `UPDATE creators
        SET open_count = open_count + 1,
            last_open_at = NOW(),
            updated_at = NOW()
      WHERE id = $1`,
    [creatorId],
  );
}

// A follow-up (Step 2+) is anything past the first sequence step. Instantly is
// 1-indexed, so the outreach email is Step 1 and every follow-up is Step >= 2.
// Exported so the value can be unit-tested without a DB.
function isExplicitFollowupStep(step) {
  const n = Number(step);
  return Number.isFinite(n) && n >= 2;
}

// Fallback ONLY for sends where Instantly omits the step: a genuine follow-up
// lands hours/days later, so a large gap since outreach_sent_at is our only
// remaining clue. It is NOT reliable on its own — outreach_sent_at marks when we
// ENROLLED the lead, not when Instantly actually sent. Instantly batches/schedules
// the initial send on its own cadence, so the Step 1 outreach's own email_sent
// webhook can land well past this gap. That is why an explicit step always wins
// over this heuristic (see markFollowupSent).
const FOLLOWUP_MIN_GAP_MINUTES = 10;

// Advance a creator from 'outreach_sent' → 'followup_sent' when Instantly sends
// a later sequence step (the follow-up). Instantly owns the sending; this just
// records that it happened so the dashboard status progresses instead of being
// stuck on "outreach sent" until the creator replies.
//
// Guards that keep the INITIAL outreach send — which ALSO fires an email_sent
// webhook — from being mislabeled as a follow-up:
//   1. status must still be 'outreach_sent' (so we never regress a creator who
//      has already replied / is negotiating / accepted), and
//   2. the send must actually be a follow-up:
//        • If Instantly gives us the step, trust it OUTRIGHT — Step 2+ advances,
//          Step 1 (the initial outreach) never does, no matter how long after
//          enrollment its webhook arrives. Instantly delays/batches the first
//          send, so a Step 1 webhook landing >10 min after outreach_sent_at is
//          normal and must NOT be read as a follow-up.
//        • Only when the step is entirely absent do we fall back to the elapsed-
//          time heuristic to tell the initial send from a real follow-up.
// Returns true when the row actually advanced.
async function markFollowupSent(creatorId, { step = null, messageId = null } = {}) {
  const stepNum = Number(step);
  // Number(null) is 0 (finite), so an absent step must be excluded explicitly —
  // otherwise a missing step would look like a known Step 0 and wrongly block the
  // gap fallback.
  const stepKnown = step != null && step !== '' && Number.isFinite(stepNum);
  const stepForStore = stepKnown ? stepNum : 0;
  const byStep = isExplicitFollowupStep(step);
  // The time-gap fallback is permitted ONLY when the step is unknown. A known
  // Step 1 is the initial outreach and must hard-block, never leaking through
  // the gap path.
  const allowGapFallback = !stepKnown;
  const res = await db.query(
    `UPDATE creators
        SET status = 'followup_sent',
            followup_sent_at = NOW(),
            followup_message_id = COALESCE($3, followup_message_id),
            followup_step = GREATEST(followup_step, $2),
            updated_at = NOW()
      WHERE id = $1
        AND status = 'outreach_sent'
        AND outreach_sent_at IS NOT NULL
        AND ($4 OR ($5 AND outreach_sent_at < NOW() - INTERVAL '${FOLLOWUP_MIN_GAP_MINUTES} minutes'))`,
    [creatorId, stepForStore, messageId, byStep, allowGapFallback],
  );
  if (res.rowCount > 0) {
    // Only log the event when the status actually advanced, so a retried
    // webhook (status already 'followup_sent') doesn't duplicate the timeline
    // entry.
    await db.query(
      `INSERT INTO email_events (creator_id, type, message_id, detail)
       VALUES ($1, 'sent_followup', $2, $3)`,
      [creatorId, messageId, { via: 'instantly', step: Number.isFinite(stepNum) ? stepNum : null }],
    );
  }
  return res.rowCount > 0;
}

module.exports = {
  sendOutreach,
  markReplied,
  markFollowupSent,
  markManualReplySent,
  markOpened,
  prepareOutreach,
  // Exposed for tests.
  outreachFirstName,
  isExplicitFollowupStep,
};
