const db = require('../db');
const { renderOutreach, renderFollowup } = require('./templates');
const { sendEmail, threadHasReply, newTrackingId } = require('./gmail');

async function loadCreatorContext(creatorId) {
  return db.one(
    `SELECT c.*, ca.name AS campaign_name, ca.brand_name AS brand_name
     FROM creators c
     JOIN campaigns ca ON ca.id = c.campaign_id
     WHERE c.id = $1`,
    [creatorId],
  );
}

async function sendOutreach(creatorId) {
  const creator = await loadCreatorContext(creatorId);
  if (!creator) throw new Error(`Creator ${creatorId} not found`);
  if (!creator.email) throw new Error(`Creator ${creatorId} has no email`);
  if (creator.outreach_sent_at) throw new Error(`Outreach already sent to creator ${creatorId}`);

  const firstName = creator.first_name || 'there';
  const { subject, body } = renderOutreach({
    firstName,
    brandName: creator.brand_name,
    campaignName: creator.campaign_name,
  });

  const trackingId = newTrackingId();

  try {
    const sent = await sendEmail({
      to: creator.email,
      subject,
      body,
      trackingId,
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
      [
        creatorId,
        trackingId,
        {
          gmailMessageId: sent.gmailMessageId,
          threadId: sent.threadId,
          rfc822MessageId: sent.rfc822MessageId,
          subject,
        },
      ],
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

async function sendFollowup(creatorId) {
  const creator = await loadCreatorContext(creatorId);
  if (!creator) throw new Error(`Creator ${creatorId} not found`);
  if (!creator.outreach_sent_at) throw new Error(`Cannot follow up before outreach`);
  if (creator.followup_sent_at) throw new Error(`Follow-up already sent`);

  // Re-check for reply via Gmail before sending.
  if (creator.outreach_thread_id) {
    const hasReply = await threadHasReply(creator.outreach_thread_id);
    if (hasReply) {
      await markReplied(creatorId);
      return { ok: false, reason: 'replied' };
    }
  }

  const firstName = creator.first_name || 'there';
  const { subject, body } = renderFollowup({
    firstName,
    brandName: creator.brand_name,
    campaignName: creator.campaign_name,
  });

  const trackingId = newTrackingId();

  try {
    // Need a Message-Id from the original outreach to thread properly.
    const lastEvent = await db.one(
      `SELECT detail FROM email_events
       WHERE creator_id = $1 AND type = 'sent_outreach'
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
    });

    await db.query(
      `UPDATE creators
       SET status = 'followup_sent',
           followup_message_id = $2,
           followup_sent_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [creatorId, trackingId],
    );

    await db.query(
      `INSERT INTO email_events (creator_id, type, message_id, detail)
       VALUES ($1, 'sent_followup', $2, $3)`,
      [creatorId, trackingId, {
        gmailMessageId: sent.gmailMessageId,
        threadId: sent.threadId,
        rfc822MessageId: sent.rfc822MessageId,
        subject,
      }],
    );

    return { ok: true, trackingId };
  } catch (err) {
    await db.query(
      `INSERT INTO email_events (creator_id, type, detail)
       VALUES ($1, 'failed', $2)`,
      [creatorId, { phase: 'followup', error: err.message }],
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

module.exports = { sendOutreach, sendFollowup, markReplied };
