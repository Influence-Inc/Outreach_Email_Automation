const crypto = require('crypto');
const db = require('../db');
const { verifyEmail } = require('./emailVerify');
const { formatFirstName } = require('./nameFormat');
const instantly = require('./instantly');
const offers = require('./offers');
const { offerPortalConfigIssues } = require('./offerPortal/config');

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
  // Already enrolled? outreach_queued_at is stamped the moment the lead is added
  // to Instantly (before the email actually sends), and outreach_sent_at once
  // Instantly confirms the send. Either one means this creator is already in the
  // outreach pipeline — re-enrolling would add a duplicate lead / double-send.
  if (creator.outreach_queued_at || creator.outreach_sent_at) {
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

  // USED (old-segment) creators negotiate over WhatsApp/iMessage, not email — so
  // their outreach is the messaging INVITE ("text Hi to this number"), not the
  // Instantly cold-email sequence. New/unused creators keep the email path below
  // unchanged. Falls back to that same email path when a used creator has no
  // usable messaging channel (no phone on file / opted out / vendor
  // unconfigured), so they're never left uncontacted.
  if (creator.creator_segment === 'old') {
    const invite = await offers.sendUsedCreatorInvite(creatorId);
    if (invite.sent) {
      // The invite email is sent synchronously via Resend (unlike the Instantly
      // path, which only queues), so mark it sent outright.
      await db.query(
        `UPDATE creators
            SET status = 'outreach_sent',
                outreach_queued_at = NOW(),
                outreach_sent_at = NOW(),
                outreach_message_id = $2,
                updated_at = NOW()
          WHERE id = $1`,
        [creatorId, trackingId],
      );
      await db.query(
        `INSERT INTO email_events (creator_id, type, message_id, detail)
         VALUES ($1, 'sent_outreach', $2, $3)`,
        [creatorId, trackingId, { via: 'portal_invite', channels: invite.channels }],
      );
      console.log(
        `[outreach] used creator ${creatorId} sent messaging invite (${invite.channels.join(' / ')})`,
      );
      return { ok: true, trackingId, via: 'portal_invite', channels: invite.channels };
    }
    // Falling back to the plain Instantly cold email means this Used creator
    // will NOT be asked to text us on WhatsApp/iMessage. Spell out why: a
    // deploy-level config gap (Resend/AiSensy/Linq not set) is very different
    // from a per-creator gap (no phone on file / opted out), and the two need
    // different fixes. The config issues below are global (same for everyone);
    // if there are none, it's a per-creator reason.
    const configIssues = offerPortalConfigIssues();
    const why = configIssues.length
      ? `offer-portal not fully configured: ${configIssues.join('; ')}`
      : 'creator has no WhatsApp/iMessage number on file or has opted out';
    console.warn(
      `[outreach] used creator ${creatorId}: messaging invite not sent (${invite.reason}) — ` +
        `falling back to Instantly cold email. Reason: ${why}.`,
    );
  }

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

    // Enrolling the lead is NOT the same as the outreach email going out —
    // Instantly queues the Step 1 send and dispatches it later on its own
    // schedule. So we park the creator in 'outreach_queued' now and only advance
    // to 'outreach_sent' (stamping outreach_sent_at) when Instantly's email_sent
    // webhook confirms the actual send (see markOutreachSent). This is what keeps
    // the dashboard from showing "Outreach sent" while Instantly still reads
    // "Not yet contacted". outreach_sent_at is deliberately left NULL here.
    await db.query(
      `UPDATE creators
       SET status = 'outreach_queued',
           outreach_message_id = $2,
           outreach_queued_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [creatorId, trackingId],
    );

    // Audit the enrollment (distinct from the 'sent_outreach' event, which is
    // logged only once the send is confirmed). Carries the template context here
    // since the webhook that later confirms the send doesn't have it on hand.
    await db.query(
      `INSERT INTO email_events (creator_id, type, message_id, detail)
       VALUES ($1, 'outreach_queued', $2, $3)`,
      [creatorId, trackingId, {
        via: 'instantly',
        instantlyCampaignId,
        templateId: creator.template_id || null,
        templateName: creator.template_name || null,
      }],
    );

    console.log(`[outreach] creator ${creatorId} enrolled in Instantly campaign ${instantlyCampaignId} (queued — awaiting email_sent confirmation)`);
    return { ok: true, trackingId, queued: true };
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

// Advance a creator from 'outreach_queued' → 'outreach_sent' when Instantly's
// email_sent webhook confirms the Step 1 outreach actually went out. Enrollment
// (sendOutreach) only queues the send; THIS is the point at which the dashboard
// is allowed to show "Outreach sent", so outreach_sent_at is stamped here — the
// real send time, not the enrollment time.
//
// Disambiguation is free: while a creator is still 'outreach_queued', Instantly
// cannot have sent any later sequence step yet, so the first email_sent event we
// see for it is necessarily the Step 1 outreach. We therefore gate purely on the
// status ('outreach_queued'), sidestepping the unreliable `step`/`is_first`
// fields entirely for this transition. Returns true when the row actually
// advanced (so a re-delivered webhook doesn't double-log the timeline entry).
async function markOutreachSent(creatorId, { messageId = null } = {}) {
  const res = await db.query(
    `UPDATE creators
        SET status = 'outreach_sent',
            outreach_sent_at = NOW(),
            outreach_message_id = COALESCE($2, outreach_message_id),
            updated_at = NOW()
      WHERE id = $1
        AND status = 'outreach_queued'`,
    [creatorId, messageId],
  );
  if (res.rowCount > 0) {
    await db.query(
      `INSERT INTO email_events (creator_id, type, message_id, detail)
       VALUES ($1, 'sent_outreach', $2, $3)`,
      [creatorId, messageId, { via: 'instantly' }],
    );
  }
  return res.rowCount > 0;
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
// directly from the connected mailbox. Idempotent on messageId, and echo-safe:
// if ANY prior event already carries this messageId — the outreach send, a
// follow-up, an earlier manual reply, an app-initiated send — this webhook is a
// re-fire of a message we've already logged, not a new manual send, so it's
// skipped and the timeline never doubles up or sprouts a phantom "Manual reply
// sent". Also skipped when an app-initiated send (delegate reply, priced offer,
// negotiation reply, contract) was just logged for this creator. Returns true
// when a fresh row was inserted. Does NOT change the creator's funnel status —
// a manual reply is a response, not a transition.
async function markManualReplySent(creatorId, { messageId = null, subject = null, body = null, source = null } = {}) {
  if (messageId) {
    // Dedupe against EVERY prior event for this message, not just prior manual
    // replies: a messageId uniquely identifies one send, so if we've recorded
    // anything for it (outreach, follow-up, a previous manual reply), this fire
    // is that send's echo — never a distinct manual reply.
    const existing = await db.one(
      `SELECT id FROM email_events
       WHERE creator_id = $1 AND message_id = $2
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

// Trusting Instantly's `step` field outright (Step 2+ advances "no matter how
// long after enrollment its webhook arrives") turned out NOT to be safe: in
// production the initial outreach send kept getting mislabeled a follow-up
// even after that change shipped, which means `step` is not the unimpeachable
// signal it was assumed to be for every campaign. So this is now defense in
// depth rather than a single trusted source:
//   • An explicit step is still required to be >= 2, AND must ALSO clear this
//     floor since outreach_sent_at — i.e. the two signals have to agree.
//   • When the step is entirely absent, this floor is the only signal.
// 180 minutes is comfortably above any observed Instantly send-batching delay
// for the initial email, and comfortably below the hours/days delay of a real
// configured follow-up step (follow_up_sequences defaults to 48h).
const FOLLOWUP_MIN_GAP_MINUTES = 180;

// Advance a creator from 'outreach_sent' → 'followup_sent' when Instantly sends
// a later sequence step (the follow-up). Instantly owns the sending; this just
// records that it happened so the dashboard status progresses instead of being
// stuck on "outreach sent" until the creator replies.
//
// Guards that keep the INITIAL outreach send — which ALSO fires an email_sent
// webhook — from being mislabeled as a follow-up:
//   1. status must still be 'outreach_sent' (so we never regress a creator who
//      has already replied / is negotiating / accepted),
//   2. `is_first` (when Instantly sends it) hard-blocks unconditionally — it is
//      an unambiguous "this is the very first send for this lead" signal, unlike
//      `step`, and
//   3. the send must actually be a follow-up: a known Step 1 hard-blocks
//      regardless of timing; a known Step 2+ or an entirely unknown step must
//      ALSO clear FOLLOWUP_MIN_GAP_MINUTES since outreach_sent_at.
// Returns true when the row actually advanced.
async function markFollowupSent(creatorId, { step = null, messageId = null, isFirst = null } = {}) {
  const stepNum = Number(step);
  // Number(null) is 0 (finite), so an absent step must be excluded explicitly —
  // otherwise a missing step would look like a known Step 0 and wrongly block the
  // gap fallback.
  const stepKnown = step != null && step !== '' && Number.isFinite(stepNum);
  const stepForStore = stepKnown ? stepNum : 0;
  const byStep = isExplicitFollowupStep(step);
  // Gap-eligible: either an explicit step >= 2 (still needs corroboration) or
  // the step is entirely unknown (the gap is the only signal left). A known
  // Step 1 is neither and falls through to false, hard-blocking it.
  const gapEligible = byStep || !stepKnown;
  // Unambiguous hard block regardless of step/timing.
  const hardBlock = isFirst === true;
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
        AND NOT $5
        AND $4
        AND outreach_sent_at < NOW() - INTERVAL '${FOLLOWUP_MIN_GAP_MINUTES} minutes'`,
    [creatorId, stepForStore, messageId, gapEligible, hardBlock],
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
    return true;
  }
  // The initial outreach_sent → followup_sent advance didn't happen. That does
  // NOT mean the send is a manual reply: a campaign with 3+ sequence steps keeps
  // firing email_sent events for a creator already at 'followup_sent' (Step 3,
  // Step 4, …), and a retried webhook re-fires the very step that already
  // advanced them. Both are AUTOMATED follow-ups — but the caller's fallback
  // treats any non-advancing send from a past-outreach creator as a human manual
  // reply, so without this they get mislabeled "Manual reply sent" on the
  // timeline. An explicit Step 2+ (a human typing from the unibox never carries a
  // sequence step) recorded as a subsequent follow-up short-circuits that path.
  if (byStep) {
    return markSubsequentFollowupSent(creatorId, { step: stepForStore, messageId });
  }
  return false;
}

// Record a further automated sequence step for a creator already at
// 'followup_sent' — the second/third/… follow-up in a multi-step Instantly
// campaign. Returns true when the send is (or already was) an automated
// follow-up, so the webhook does NOT fall through to logging it as a manual
// reply; false only when this isn't that case (leaving the manual-reply path
// intact for genuine human sends). Idempotent on message_id: a re-delivered
// webhook — even the redelivery of the earlier step that first advanced the
// creator — is recognized as an already-recorded follow-up, never doubled and
// never demoted to a manual reply.
async function markSubsequentFollowupSent(creatorId, { step = 0, messageId = null } = {}) {
  if (messageId) {
    const existing = await db.one(
      `SELECT id FROM email_events
       WHERE creator_id = $1 AND type = 'sent_followup' AND message_id = $2
       LIMIT 1`,
      [creatorId, messageId],
    );
    if (existing) return true;
  }
  const res = await db.query(
    `UPDATE creators
        SET followup_sent_at = NOW(),
            followup_message_id = COALESCE($3, followup_message_id),
            followup_step = GREATEST(followup_step, $2),
            updated_at = NOW()
      WHERE id = $1
        AND status = 'followup_sent'`,
    [creatorId, step, messageId],
  );
  if (res.rowCount === 0) return false;
  await db.query(
    `INSERT INTO email_events (creator_id, type, message_id, detail)
     VALUES ($1, 'sent_followup', $2, $3)`,
    [creatorId, messageId, { via: 'instantly', step: step || null }],
  );
  return true;
}

module.exports = {
  sendOutreach,
  markOutreachSent,
  markReplied,
  markFollowupSent,
  markSubsequentFollowupSent,
  markManualReplySent,
  markOpened,
  prepareOutreach,
  // Exposed for tests.
  outreachFirstName,
  isExplicitFollowupStep,
};
