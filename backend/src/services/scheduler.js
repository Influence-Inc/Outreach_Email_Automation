const db = require('../db');
const { sendFollowup, markReplied } = require('./outreach');
const { threadHasReply } = require('./gmail');

const followupDelayHours = () => Number(process.env.FOLLOWUP_DELAY_HOURS || 48);
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

    // Find creators due for follow-up.
    const due = await db.many(
      `SELECT id FROM creators
       WHERE status = 'outreach_sent'
       AND followup_sent_at IS NULL
       AND outreach_sent_at < NOW() - ($1::text || ' hours')::interval`,
      [String(followupDelayHours())],
    );
    for (const c of due) {
      try {
        const result = await sendFollowup(c.id);
        console.log(`follow-up for ${c.id}:`, result);
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
      `follow-up after ${followupDelayHours()}h`,
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
