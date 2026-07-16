const db = require('../db');
const negotiation = require('./negotiation');
const replyExamples = require('./replyExamples');
const replyLearning = require('./replyLearning');

const intervalMs = () =>
  Number(process.env.SCHEDULER_INTERVAL_MINUTES || 5) * 60 * 1000;
const negotiationFollowupDays = () => Number(process.env.NEGOTIATION_FOLLOWUP_DAYS || 2);

let timer = null;
let negRunning = false;

// Outreach and follow-up sending is now handled by Instantly.ai.
// Reply detection arrives via the /webhook/instantly endpoint (reply_received event).
// The scheduler only drives the negotiation flow once a reply has been received.

// Drive the in-app negotiation flow. Each step is best-effort and isolated per
// creator so one failure never blocks the rest.
async function pollNegotiations() {
  if (negRunning) return;
  negRunning = true;
  try {
    // 1. First replies: outreach replied, negotiation not started yet.
    const fresh = await db.many(
      `SELECT id FROM creators
       WHERE status = 'replied' AND negotiation_status IS NULL
       ORDER BY replied_at ASC NULLS LAST`,
    );
    for (const c of fresh) {
      try {
        await negotiation.processReply(c.id);
      } catch (err) {
        console.error(`negotiation first-reply failed for creator ${c.id}:`, err.message);
      }
    }

    // 2. Ongoing replies: a new inbound while we await a rate or a decision.
    //    processReply de-dupes on last_negotiation_msg_id, so this is cheap.
    //    `status <> 'stopped'` (here and in every step below) drops creators
    //    whose outreach was explicitly stopped — stop halts the automated
    //    conversation at every stage, not just the outreach follow-ups.
    const ongoing = await db.many(
      `SELECT id FROM creators
       WHERE negotiation_status IN ('AWAITING_RATE', 'AWAITING_DECISION')
         AND status <> 'stopped'`,
    );
    for (const c of ongoing) {
      try {
        await negotiation.processReply(c.id);
      } catch (err) {
        console.error(`negotiation reply poll failed for creator ${c.id}:`, err.message);
      }
    }

    // 2b. Mid-approval replies: a creator whose offer is awaiting the admin's
    //     approval (AWAITING_APPROVAL) replied again. Steps 1–2 don't cover that
    //     stage, so the message would otherwise sit unseen in latest_inbound_text
    //     until the offer is sent. Surface it in the Delegate window (as a
    //     hand-off) so the admin sees it next to the offer configurator — we
    //     never auto-reply here; a human is deliberately in the loop at approval.
    const awaitingApprovalReplies = await db.many(
      `SELECT id FROM creators
       WHERE negotiation_status = 'AWAITING_APPROVAL' AND latest_inbound_text IS NOT NULL
         AND status <> 'stopped'`,
    );
    for (const c of awaitingApprovalReplies) {
      try {
        await negotiation.surfaceApprovalReply(c.id);
      } catch (err) {
        console.error(`mid-approval reply surfacing failed for creator ${c.id}:`, err.message);
      }
    }

    // NOTE: Offer emails are sent ONLY when an admin approves an offer in the
    // dashboard (the PATCH /api/creators/:id/offer route). The scheduler does
    // NOT auto-send approved offers — a creator sitting in AWAITING_APPROVAL
    // simply waits for that explicit admin action, so no priced offer ever
    // goes out without a dashboard approval.

    // 3. Idle follow-ups / close-out (re-query so step 1–2 transitions are seen).
    const idleMs = negotiationFollowupDays() * 24 * 3600_000;
    const now = Date.now();
    // Skip creators parked for a human (needs_human) — don't auto-nudge a
    // conversation that's waiting on the Delegate window. Also skip any creator
    // who has already replied: a follow-up is a nudge for SILENCE, so exclude
    // rows with a pending inbound (latest_inbound_text) or whose most recent
    // reply is newer than our last outbound negotiation email (the ball is in
    // our court). runNegotiationFollowup re-checks this on the freshly loaded
    // row, but excluding here avoids even attempting the nudge.
    const waiting = await db.many(
      `SELECT id, last_negotiation_email_at, replied_at, updated_at
       FROM creators
       WHERE negotiation_status IN ('AWAITING_RATE', 'AWAITING_DECISION')
         AND status <> 'stopped'
         AND needs_human = FALSE
         AND latest_inbound_text IS NULL
         AND (
           replied_at IS NULL
           OR (last_negotiation_email_at IS NOT NULL AND replied_at <= last_negotiation_email_at)
         )`,
    );
    for (const c of waiting) {
      const last = c.last_negotiation_email_at || c.replied_at || c.updated_at;
      if (!last) continue;
      if (now < new Date(last).getTime() + idleMs) continue;
      try {
        await negotiation.runNegotiationFollowup(c.id);
      } catch (err) {
        console.error(`negotiation follow-up failed for creator ${c.id}:`, err.message);
      }
    }

    // 4. Contract backfill: an ACCEPTED creator whose contract was APPROVED in
    //    the Delegate window (the brand POC's go-ahead, contract_approved) but
    //    who has no contract yet (e.g. the send at approval time errored).
    //    Deals still awaiting that approval are deliberately excluded — no
    //    contract is ever generated or emailed before the go-ahead.
    //    ensureContractSent is idempotent, so this safely retries generation +
    //    the signing email once per creator.
    const acceptedNoContract = await db.many(
      `SELECT id FROM creators
       WHERE negotiation_status = 'ACCEPTED'
         AND contract_approved
         AND status <> 'stopped'
         AND NOT EXISTS (SELECT 1 FROM contracts ct WHERE ct.creator_id = creators.id)`,
    );
    for (const c of acceptedNoContract) {
      try {
        await negotiation.ensureContractSent(c.id);
      } catch (err) {
        console.error(`contract backfill failed for creator ${c.id}:`, err.message);
      }
    }

    // 5. Post-acceptance replies: an ACCEPTED creator replied again (webhook
    //    already wrote latest_inbound_text) but the scheduler never looks at
    //    ACCEPTED creators otherwise — steps 1-2 only cover negotiation_status
    //    IS NULL / AWAITING_*. handleAcceptedReply answers benign factual
    //    questions and delegates everything else (payment/contract questions,
    //    disputes, usage-rights objections) so no post-signing creator reply is
    //    ever left unattended.
    const acceptedWithReply = await db.many(
      `SELECT id FROM creators
       WHERE negotiation_status = 'ACCEPTED' AND latest_inbound_text IS NOT NULL
         AND status <> 'stopped'`,
    );
    for (const c of acceptedWithReply) {
      try {
        await negotiation.handleAcceptedReply(c.id);
      } catch (err) {
        console.error(`post-acceptance reply handling failed for creator ${c.id}:`, err.message);
      }
    }
  } finally {
    negRunning = false;
  }
}

// Keep the in-memory example bank in sync with the reply_examples table.
// Inserts made by THIS process update the cache directly; the periodic
// refresh picks up rows written by other means (SQL, another instance).
const EXAMPLES_REFRESH_MS = 10 * 60 * 1000;
async function refreshLearning() {
  if (replyExamples.dbCacheAgeMs() > EXAMPLES_REFRESH_MS) {
    await replyExamples
      .refreshFromDb()
      .catch((err) => console.error('reply examples refresh failed:', err.message));
  }
  // Continuous learning: sweep the connected mailbox for new
  // (creator inbound → manager reply) pairs when a harvest is due.
  // No-ops unless LEARN_HARVEST_HOURS elapsed since the last run.
  await replyLearning
    .maybeRunScheduledHarvest()
    .catch((err) => console.error('scheduled harvest failed:', err.message));
}

async function tick() {
  await pollNegotiations().catch((err) => console.error('negotiation tick failed:', err));
  await refreshLearning().catch((err) => console.error('learning tick failed:', err));
}

function start() {
  if (timer) return;
  const claudeConfigured = !!process.env.ANTHROPIC_API_KEY;
  const claudeModel = process.env.CLAUDE_MODEL || 'claude-haiku-4-5';
  const harvestHoursRaw = process.env.LEARN_HARVEST_HOURS;
  const harvestHours = harvestHoursRaw == null || harvestHoursRaw === '' ? 24 : Number(harvestHoursRaw);
  console.log(
    `Scheduler started: every ${process.env.SCHEDULER_INTERVAL_MINUTES || 5} min (negotiation only — outreach/follow-ups via Instantly.ai); ` +
      `negotiation follow-up idle ${negotiationFollowupDays()}d; ` +
      `Claude ${claudeConfigured ? `configured (model=${claudeModel})` : 'NOT configured (ANTHROPIC_API_KEY unset — replies will fall back to static templates)'}; ` +
      `reply learning: delegate capture ${/^(0|false|no)$/i.test(String(process.env.LEARN_FROM_DELEGATE || '')) ? 'OFF' : 'on'}, ` +
      `inbox harvest ${harvestHours > 0 ? `every ${harvestHours}h` : 'OFF'}`,
  );
  timer = setInterval(() => {
    tick();
  }, intervalMs());
  // Run once on boot, but don't block startup. Load the learned example bank
  // first so the first processed reply already benefits from it.
  setTimeout(() => {
    replyExamples
      .refreshFromDb()
      .then((rows) => {
        if (rows.length) console.log(`Loaded ${rows.length} learned reply examples from the DB`);
      })
      .catch((err) => console.error('reply examples initial load failed:', err.message))
      .finally(() => tick());
  }, 5000);
}

module.exports = { start, pollNegotiations };
