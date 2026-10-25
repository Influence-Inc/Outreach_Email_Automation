'use strict';

// How sure Jev must be before it decides a creator on its own — learned from the
// review queue instead of typed into the Scout page.
//
// Jev (services/jevJudge.js) shortlists a creator when every label it was asked
// about matches the run's targets with at least `shortlistAt` confidence, and
// rejects one when a label is off target with at least `rejectAt` confidence.
// Anything less sure goes to the review queue, where an admin decides. Those
// decisions are exactly the evidence the two bars need:
//
//   SHORTLIST BAR. Creators held because Jev was "unsure" of a label that DID
//     match carry the confidence it had (`unsureAt`). If admins keep shortlisting
//     them, Jev's "fairly sure" is good enough, and the bar comes down to the
//     lowest confidence admins approve at least APPROVE_SHARE of the time.
//
//   REJECT BAR. Creators held as "probably off-target" carry the confidence of
//     that off-target label (`probablyOffAt`). If admins keep rejecting them,
//     the bar comes down to the lowest confidence they reject at least
//     REJECT_SHARE of the time.
//
// Either bar only ever comes DOWN from the default, and only on evidence: no
// history, too few decisions, or mixed ones leave it at 0.6. It never goes below
// FLOOR — a guess is not a decision, however often the guesses were right. And
// it is learned across every campaign: how far Jev's confidence can be trusted
// is a property of the model, not of one brand.
//
// Decisions made before `unsureAt` / `probablyOffAt` were recorded are read from
// the reasons Jev wrote ("unsure of the subject: topic Fitness (55%)"), so the
// review history that already exists counts from the first run.

const { DEFAULT_AUTO_CONFIDENCE, DEFAULT_REJECT_CONFIDENCE } = require('./jevJudge');

const STEP = 0.05;
const FLOOR = 0.45;
// Decisions needed at or above a bar before it may move there.
const MIN_DECISIONS = 5;
// How consistently admins must agree with what the lower bar would have done.
const APPROVE_SHARE = 0.8;
const REJECT_SHARE = 0.85;
// Plenty for a few months of review; keeps the read cheap.
const HISTORY_LIMIT = 1000;

const round2 = (n) => Math.round(n * 100) / 100;

/** The percentage in a Jev reason that starts with `prefix`, as 0-1, or null. */
function confidenceIn(reasons, prefix) {
  let out = null;
  for (const r of Array.isArray(reasons) ? reasons : []) {
    if (!String(r).startsWith(prefix)) continue;
    const m = /\((\d{1,3})%\)/.exec(String(r));
    if (m) out = out == null ? Number(m[1]) / 100 : Math.max(out, Number(m[1]) / 100);
  }
  return out;
}

/** One reviewed creator as calibration needs it, or null when it says nothing. */
function sampleOf(row) {
  const jev = row && row.jev;
  if (!jev || !['added', 'rejected'].includes(row.decision)) return null;
  const unsureAt = typeof jev.unsureAt === 'number' ? jev.unsureAt : confidenceIn(jev.reasons, 'unsure of the');
  const probablyOffAt = typeof jev.probablyOffAt === 'number'
    ? jev.probablyOffAt : confidenceIn(jev.reasons, 'probably off-target');
  if (unsureAt == null && probablyOffAt == null) return null;
  return { approved: row.decision === 'added', unsureAt, probablyOffAt };
}

/**
 * The lowest bar between FLOOR and `start` at which `agrees` holds for at least
 * `share` of the samples at or above it (and there are MIN_DECISIONS of them),
 * or `start` when no lower bar is supported.
 *
 * A bar only moves to a level admins actually saw: some of the samples must sit
 * in the step it would open up. Approvals at 55% say nothing about 45%.
 */
function lowestSupported(samples, valueOf, agrees, share, start) {
  for (let bar = FLOOR; bar < start - 1e-9; bar = round2(bar + STEP)) {
    const above = samples.filter((s) => valueOf(s) >= bar - 1e-9);
    if (above.length < MIN_DECISIONS) continue;
    if (!above.some((s) => valueOf(s) < bar + STEP - 1e-9)) continue;
    if (above.filter(agrees).length / above.length >= share) return bar;
  }
  return start;
}

/**
 * The two bars from reviewed creators. Pure.
 *
 * Only creators held for ONE kind of doubt count: one held both as unsure of a
 * matching label and as probably off on another says nothing clean about
 * either bar.
 */
function calibrate(rows = []) {
  const samples = rows.map(sampleOf).filter(Boolean);
  const unsure = samples.filter((s) => s.unsureAt != null && s.probablyOffAt == null);
  const off = samples.filter((s) => s.probablyOffAt != null && s.unsureAt == null);

  const shortlistAt = lowestSupported(unsure, (s) => s.unsureAt, (s) => s.approved, APPROVE_SHARE, DEFAULT_AUTO_CONFIDENCE);
  const rejectAt = lowestSupported(off, (s) => s.probablyOffAt, (s) => !s.approved, REJECT_SHARE, DEFAULT_REJECT_CONFIDENCE);

  return {
    shortlistAt,
    rejectAt,
    basis: {
      unsure: { decisions: unsure.length, shortlisted: unsure.filter((s) => s.approved).length },
      probablyOff: { decisions: off.length, rejected: off.filter((s) => !s.approved).length },
    },
  };
}

/** One line for the Scout page and the run log. */
function describe(cal) {
  const pct = (n) => `${Math.round(n * 100)}%`;
  const learned = cal.shortlistAt !== DEFAULT_AUTO_CONFIDENCE || cal.rejectAt !== DEFAULT_REJECT_CONFIDENCE;
  const reviewed = cal.basis.unsure.decisions + cal.basis.probablyOff.decisions;
  return `Jev shortlists at ${pct(cal.shortlistAt)} sure and rejects at ${pct(cal.rejectAt)} sure — `
    + (learned
      ? `learned from ${reviewed} review decision${reviewed === 1 ? '' : 's'}`
      : `the starting point${reviewed ? ` (${reviewed} review decision${reviewed === 1 ? '' : 's'} so far — not enough to move it)` : ' until there are review decisions to learn from'}`);
}

/**
 * Read the review history and calibrate. Never throws: a failed read means the
 * default bars, which is how every run worked before this existed.
 */
async function load({ db, logger = console } = {}) {
  try {
    const rows = await db.many(
      `SELECT decision, evidence->'niche'->'jev' AS jev
         FROM sourced_candidates
        WHERE decided_by = 'human'
          AND decision IN ('added', 'rejected')
          AND evidence->'niche'->'jev' IS NOT NULL
        ORDER BY id DESC
        LIMIT ${HISTORY_LIMIT}`,
    );
    return calibrate(rows);
  } catch (err) {
    const warn = logger.warn || logger.log || (() => {});
    warn.call(logger, '[jev-calibration] could not read review history -', (err && err.message) || err);
    return calibrate([]);
  }
}

module.exports = {
  calibrate, load, describe, sampleOf, confidenceIn, FLOOR, MIN_DECISIONS, APPROVE_SHARE, REJECT_SHARE,
};
