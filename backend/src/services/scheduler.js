const db = require('../db');
const { sendFollowup, markReplied, resolveFollowupSteps } = require('./outreach');
const { threadHasReply } = require('./gmail');

const legacyDelayHours = () => Number(process.env.FOLLOWUP_DELAY_HOURS || 48);
const intervalMs = () =>
  Number(process.env.SCHEDULER_INTERVAL_MINUTES || 15) * 60 * 1000;

let timer = null;
let running = false;

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

function start() {
  if (timer) return;
  console.log(
    `Scheduler started: every ${process.env.SCHEDULER_INTERVAL_MINUTES || 15} min, ` +
      `legacy follow-up delay ${legacyDelayHours()}h (per-template followups override this)`,
  );
  timer = setInterval(() => {
    checkRepliesAndFollowups().catch((err) => console.error('scheduler tick failed:', err));
  }, intervalMs());
  // Run once on boot, but don't block startup.
  setTimeout(() => {
    checkRepliesAndFollowups().catch((err) => console.error('scheduler boot tick failed:', err));
  }, 5000);
}

module.exports = { start, checkRepliesAndFollowups };
