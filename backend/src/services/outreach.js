const crypto = require('crypto');
const db = require('../db');
const { verifyEmail } = require('./emailVerify');
const instantly = require('./instantly');

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
      firstName: creator.first_name || '',
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
};
