const db = require('../db');
const { sendFollowup, markReplied, resolveFollowupSteps } = require('./outreach');
const { threadHasReply } = require('./gmail');
const negotiation = require('./negotiation');

const legacyDelayHours = () => Number(process.env.FOLLOWUP_DELAY_HOURS || 48);
const intervalMs = () =>
  Number(process.env.SCHEDULER_INTERVAL_MINUTES || 15) * 60 * 1000;
const negotiationFollowupDays = () => Number(process.env.NEGOTIATION_FOLLOWUP_DAYS || 2);

let timer = null;
let running = false;
let negRunning = false;

async function checkRepliesAndFollowups() {
  if (running) return;
  running = true;
  try {
    // Refresh reply status for anything still in outreach_sent.
    const sentOutreach = await db.many(
      `SELECT id, outreach_thread_id FROM creators
       WHERE status IN ('outreach_sent', 'followup_sent')
       AND outreach_thread_id IS NOT NULL`,
    );
    for (const c of sentOutreach) {
      try {
        const replied = await threadHasReply(c.outreach_thread_id);
        if (replied) await markReplied(c.id);
      } catch (err) {
        console.error(`reply-check failed for creator ${c.id}:`, err.message);
      }
    }

    // Multi-step follow-up due check. We pull every creator still in the
    // outreach/follow-up flow that hasn't replied, then decide per-row whether
    // the next step is due based on their campaign's active template
    // (campaign template_id, or the row marked is_default).
    const candidates = await db.many(
      `SELECT c.id, c.followup_step, c.outreach_sent_at, c.followup_sent_at,
              et.followups AS template_followups
       FROM creators c
       JOIN campaigns ca ON ca.id = c.campaign_id
       LEFT JOIN email_templates et
         ON et.id = COALESCE(
           ca.template_id,
           (SELECT id FROM email_templates WHERE is_default LIMIT 1)
         )
       WHERE c.status IN ('outreach_sent', 'followup_sent')`,
    );

    const now = Date.now();
    for (const c of candidates) {
      try {
        const steps = resolveFollowupSteps({ template_followups: c.template_followups });
        const nextIndex = c.followup_step || 0;
        if (nextIndex >= steps.length) continue;

        const step = steps[nextIndex] || {};
        const delayHours = Number(step.delayHours) > 0
          ? Number(step.delayHours)
          : legacyDelayHours();
        const lastSentAt = c.followup_sent_at || c.outreach_sent_at;
        if (!lastSentAt) continue;
        const dueAt = new Date(lastSentAt).getTime() + delayHours * 3600_000;
        if (now < dueAt) continue;

        const result = await sendFollowup(c.id);
        console.log(`follow-up for ${c.id} (step ${nextIndex + 1}/${steps.length}):`, result);
      } catch (err) {
        console.error(`follow-up failed for creator ${c.id}:`, err.message);
      }
    }
  } finally {
    running = false;
  }
}

// Drive the in-app negotiation flow. Runs every tick after the outreach
// reply/follow-up check. Each step is best-effort and isolated per creator so
// one failure never blocks the rest.
async function pollNegotiations() {
  if (negRunning) return;
  negRunning = true;
  try {
    // 1. First replies: outreach replied, negotiation not started yet.
    const fresh = await db.many(
      `SELECT id FROM creators
       WHERE status = 'replied' AND negotiation_status IS NULL
         AND outreach_thread_id IS NOT NULL
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
    const ongoing = await db.many(
      `SELECT id FROM creators
       WHERE negotiation_status IN ('AWAITING_RATE', 'AWAITING_DECISION')
         AND outreach_thread_id IS NOT NULL`,
    );
    for (const c of ongoing) {
      try {
        await negotiation.processReply(c.id);
      } catch (err) {
        console.error(`negotiation reply poll failed for creator ${c.id}:`, err.message);
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
    // conversation that's waiting on the Delegate window.
    const waiting = await db.many(
      `SELECT id, last_negotiation_email_at, replied_at, updated_at
       FROM creators
       WHERE negotiation_status IN ('AWAITING_RATE', 'AWAITING_DECISION')
         AND needs_human = FALSE`,
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
  } finally {
    negRunning = false;
  }
}

async function tick() {
  await checkRepliesAndFollowups().catch((err) => console.error('scheduler tick failed:', err));
  await pollNegotiations().catch((err) => console.error('negotiation tick failed:', err));
}

function start() {
  if (timer) return;
  const claudeConfigured = !!process.env.ANTHROPIC_API_KEY;
  const claudeModel = process.env.CLAUDE_MODEL || 'claude-haiku-4-5';
  console.log(
    `Scheduler started: every ${process.env.SCHEDULER_INTERVAL_MINUTES || 15} min, ` +
      `legacy follow-up delay ${legacyDelayHours()}h (per-template followups override this); ` +
      `negotiation follow-up idle ${negotiationFollowupDays()}d; ` +
      `Claude ${claudeConfigured ? `configured (model=${claudeModel})` : 'NOT configured (ANTHROPIC_API_KEY unset — replies will fall back to static templates)'}`,
  );
  timer = setInterval(() => {
    tick();
  }, intervalMs());
  // Run once on boot, but don't block startup.
  setTimeout(() => {
    tick();
  }, 5000);
}

module.exports = { start, checkRepliesAndFollowups, pollNegotiations };
