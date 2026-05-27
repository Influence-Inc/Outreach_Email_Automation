const db = require('../db');
const { renderOutreach, renderFollowup } = require('./templates');
const { sendEmail, threadHasReply, newTrackingId } = require('./gmail');

async function loadCreatorContext(creatorId) {
  return db.one(
    `SELECT c.*,
            ca.name AS campaign_name,
            ca.brand_name AS brand_name,
            ca.templates AS campaign_templates,
            ca.sequence_id AS campaign_sequence_id,
            seq.steps AS sequence_steps
     FROM creators c
     JOIN campaigns ca ON ca.id = c.campaign_id
     LEFT JOIN follow_up_sequences seq ON seq.id = ca.sequence_id
     WHERE c.id = $1`,
    [creatorId],
  );
}

function templateVars(creator) {
  return {
    firstName: creator.first_name || 'there',
    brandName: creator.brand_name,
    campaignName: creator.campaign_name,
  };
}

async function sendOutreach(creatorId) {
  const creator = await loadCreatorContext(creatorId);
  if (!creator) throw new Error(`Creator ${creatorId} not found`);
  if (!creator.email) throw new Error(`Creator ${creatorId} has no email`);
  if (creator.outreach_sent_at) throw new Error(`Outreach already sent to creator ${creatorId}`);

  const { subject, body } = renderOutreach(templateVars(creator), creator.campaign_templates);

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

// Resolves the sequence the creator's campaign uses. Falls back to a
// single-step sequence with FOLLOWUP_DELAY_HOURS so legacy campaigns
// (no sequence_id, no templates) keep their old behavior.
function resolveSequenceSteps(creator) {
  if (Array.isArray(creator.sequence_steps) && creator.sequence_steps.length) {
    return creator.sequence_steps;
  }
  const legacyDelay = Number(process.env.FOLLOWUP_DELAY_HOURS || 48);
  return [{ delayHours: legacyDelay }];
}

async function sendFollowup(creatorId) {
  const creator = await loadCreatorContext(creatorId);
  if (!creator) throw new Error(`Creator ${creatorId} not found`);
  if (!creator.outreach_sent_at) throw new Error(`Cannot follow up before outreach`);

  const steps = resolveSequenceSteps(creator);
  const nextStepIndex = creator.followup_step || 0;
  if (nextStepIndex >= steps.length) {
    throw new Error(`No more follow-up steps for creator ${creatorId}`);
  }

  // Re-check for reply via Gmail before sending.
  if (creator.outreach_thread_id) {
    const hasReply = await threadHasReply(creator.outreach_thread_id);
    if (hasReply) {
      await markReplied(creatorId);
      return { ok: false, reason: 'replied' };
    }
  }

  const { subject, body } = renderFollowup(
    templateVars(creator),
    creator.campaign_templates,
    nextStepIndex,
  );

  const trackingId = newTrackingId();

  try {
    // Thread on the most recent prior send (outreach or previous follow-up).
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

module.exports = { sendOutreach, sendFollowup, markReplied, resolveSequenceSteps };
