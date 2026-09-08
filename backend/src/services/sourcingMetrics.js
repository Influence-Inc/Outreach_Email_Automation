'use strict';

// Did the scout actually find good creators?
//
// Everything upstream of this file is a guess until someone can answer that.
// Weights, thresholds, prompts and calibration are all tuned against an
// intuition about quality that nothing measures — so a change that helps one
// campaign and quietly ruins another looks identical from the dashboard.
//
// The funnel is already in the database; it has simply never been read end to
// end. `sourced_candidates` records what the rules decided and whether a human
// overrode it, `creators.sourced_via` records which keyword found them, and
// `creators.outreach_sent_at` / `replied_at` record what came of it. Joining
// those three is the whole measurement.
//
// The SQL lives here; the arithmetic lives in pure functions below it, so the
// numbers that matter are unit-tested without a database.

/** Percentage, to one decimal, or null when there is nothing to divide by. */
function rate(numerator, denominator) {
  // Number(null) is 0 and 0 is finite, so coercing first would report a count we
  // never measured as a confident 0% — the same trap creatorScore guards its
  // components against. Reject the absent value before coercing.
  if (numerator == null || denominator == null) return null;
  const n = Number(numerator);
  const d = Number(denominator);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) return null;
  return Math.round((n / d) * 1000) / 10;
}

/**
 * How well the automatic decisions held up.
 *
 * Two numbers say almost everything:
 *
 *   overturnRate — of the creators the RULES added on their own, how many did a
 *   human later reject. This is false-positive rate, and it is the number to
 *   drive down. High means the bar is too low.
 *
 *   reviewApprovalRate — of the creators parked in the review queue, how many
 *   the human approved. This one is not "higher is better": near 100% means the
 *   queue is asking about creators the rules should have added on their own, and
 *   near 0% means it is asking about creators they should have rejected. Either
 *   way the human is doing work the gate could have done.
 */
function summarise(rows = {}) {
  const {
    added = 0, autoAdded = 0, humanApproved = 0, humanRejected = 0,
    review = 0, rejected = 0, skipped = 0, scanned = 0,
    contacted = 0, replied = 0,
  } = rows;

  const decidedByHuman = humanApproved + humanRejected;
  return {
    funnel: { scanned, added, review, rejected, skipped, contacted, replied },
    // Of everything looked at, how much survived to be worth contacting.
    yieldRate: rate(added, scanned),
    // Of what was added, how far it actually got.
    contactRate: rate(contacted, added),
    replyRate: rate(replied, contacted),
    // Of what a human reviewed, how often they agreed with the machine.
    reviewApprovalRate: rate(humanApproved, review),
    overturnRate: rate(humanRejected, decidedByHuman),
    humanDecisions: decidedByHuman,
  };
}

/**
 * Which searches actually produced creators who replied.
 *
 * A keyword that sources twenty creators nobody answers is worse than one that
 * sources three who do, and nothing before this could tell them apart. Sorted by
 * replies, because that is the outcome being bought.
 */
function rankKeywords(rows = []) {
  return (rows || [])
    .map((r) => ({
      keyword: r.keyword || '(none)',
      added: Number(r.added) || 0,
      contacted: Number(r.contacted) || 0,
      replied: Number(r.replied) || 0,
      replyRate: rate(r.replied, r.contacted),
    }))
    .sort((a, b) => b.replied - a.replied || b.added - a.added);
}

/** Campaign-wide funnel counts, joined across candidates and creators. */
async function campaignFunnel({ db, campaignId }) {
  const row = await db.one(
    `SELECT
       COUNT(*)                                                        AS scanned,
       COUNT(*) FILTER (WHERE decision = 'added')                      AS added,
       COUNT(*) FILTER (WHERE decision = 'added'  AND decided_by = 'rule')  AS auto_added,
       COUNT(*) FILTER (WHERE decision = 'added'  AND decided_by = 'human') AS human_approved,
       COUNT(*) FILTER (WHERE decision = 'rejected' AND decided_by = 'human') AS human_rejected,
       COUNT(*) FILTER (WHERE decision = 'review')                     AS review,
       COUNT(*) FILTER (WHERE decision = 'rejected')                   AS rejected,
       COUNT(*) FILTER (WHERE decision = 'skipped')                    AS skipped
     FROM sourced_candidates
     WHERE ($1::text IS NULL OR campaign_id = $1)`,
    [campaignId || null],
  );

  // Outreach outcomes come from the creators the scout actually created, which
  // is what `sourced_via` marks — a creator added by hand is not the scout's to
  // claim credit or blame for.
  const out = await db.one(
    `SELECT
       COUNT(*)                                          AS added,
       COUNT(*) FILTER (WHERE outreach_sent_at IS NOT NULL) AS contacted,
       COUNT(*) FILTER (WHERE replied_at IS NOT NULL)       AS replied
     FROM creators
     WHERE sourced_via IS NOT NULL
       AND ($1::text IS NULL OR campaign_id = $1)`,
    [campaignId || null],
  );

  return summarise({
    scanned: Number(row?.scanned) || 0,
    added: Number(row?.added) || 0,
    autoAdded: Number(row?.auto_added) || 0,
    humanApproved: Number(row?.human_approved) || 0,
    humanRejected: Number(row?.human_rejected) || 0,
    review: Number(row?.review) || 0,
    rejected: Number(row?.rejected) || 0,
    skipped: Number(row?.skipped) || 0,
    contacted: Number(out?.contacted) || 0,
    replied: Number(out?.replied) || 0,
  });
}

/** Per-keyword yield, straight off the provenance stamped at insert time. */
async function keywordYield({ db, campaignId }) {
  const rows = await db.many(
    `SELECT
       sourced_via->>'keyword'                              AS keyword,
       COUNT(*)                                             AS added,
       COUNT(*) FILTER (WHERE outreach_sent_at IS NOT NULL) AS contacted,
       COUNT(*) FILTER (WHERE replied_at IS NOT NULL)       AS replied
     FROM creators
     WHERE sourced_via IS NOT NULL
       AND ($1::text IS NULL OR campaign_id = $1)
     GROUP BY 1`,
    [campaignId || null],
  );
  return rankKeywords(rows);
}

async function campaignReport({ db, campaignId = null }) {
  const [summary, keywords] = await Promise.all([
    campaignFunnel({ db, campaignId }),
    keywordYield({ db, campaignId }),
  ]);
  return { campaignId, ...summary, keywords };
}

module.exports = { campaignReport, campaignFunnel, keywordYield, summarise, rankKeywords, rate };
