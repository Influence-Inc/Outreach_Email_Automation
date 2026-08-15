'use strict';

// Orchestrates a creator-sourcing run: pull captured candidates from a source
// (the paired host in production, a mock/array in tests), score each against the
// campaign's scouting rules (services/sourcingFilters.js), dedupe against creators
// we already contact or have used, and add the ones that pass into the campaign —
// stopping once the admin's target count is reached.
//
// Every side effect (persist / dedupe / insert / progress) is injected via `deps`,
// so this module has NO direct DB or network coupling and is fully unit-testable.
// routes/sourcing.js builds the production `deps` from db, duplicateGuard,
// creatorDb and the shared creator-insert helper.

const { nicheMatch, decide, decideReel } = require('./sourcingFilters');
const { scoreCreator } = require('./creatorScore');

const REVIEW_BAND_DEFAULT = 0.15;

// A passing candidate is either auto-added or held for human review. When the
// admin turned on reviewBorderline, creators whose niche score is only just over
// the threshold (within reviewBand) go to the review queue instead of straight
// into the campaign — a trust dial for AI-sourced adds. Pure + exported for tests.
function reviewDecision(verdict, config = {}) {
  if (!config.reviewBorderline) return 'add';
  const score = verdict && verdict.nicheScore;
  if (typeof score !== 'number') return 'add'; // niche unassessed -> unchanged behavior
  const threshold = config.nicheThreshold != null ? config.nicheThreshold : 0.5;
  const band = config.reviewBand != null ? config.reviewBand : REVIEW_BAND_DEFAULT;
  return score < threshold + band ? 'review' : 'add';
}

// Provenance for a creator we actually added: which mode found them, and which
// keyword or genre it was following at the time.
//
// Two modes surface creators very differently — the warmed reels feed serves
// whoever Instagram thinks we like, while search follows a keyword we chose —
// and without this stamp a campaign's creator list gives no way to tell which
// keyword (or which mode) is worth running again.
function sourceTag(run, config, candidate, { niche, gate } = {}) {
  const evidence = (niche && niche.evidence) || {};
  const tag = {
    mode: candidate.discovery || config.discovery || 'search',
    keyword: candidate.sourceTerm || null,
    genre: evidence.genre || (evidence.clip && evidence.clip.niche) || null,
    nicheScore: typeof niche?.nicheScore === 'number' ? niche.nicheScore : null,
    creatorScore: gate ? gate.score : null,
    runId: run && run.id != null ? run.id : null,
    sourcedAt: new Date().toISOString(),
  };
  return tag;
}

/** One human-readable line for the creators.notes column. */
function sourceNote(tag) {
  const where = tag.mode === 'reels' ? 'the reels feed' : 'Instagram search';
  const what = tag.keyword ? ` for "${tag.keyword}"` : '';
  const genre = tag.genre ? ` — ${tag.genre}` : '';
  return `Sourced from ${where}${what}${genre}`;
}

// Evaluate ONE captured candidate; if it clears the rules and isn't a duplicate,
// add it to the campaign. Returns { decision, added, candidateId, creatorId?, rejectReason? }.
async function processCandidate(run, config, candidate, deps) {
  const campaignId = run.campaign_id;
  const username = String(candidate.username || '')
    .replace(/^@/, '')
    .trim();
  if (!username) return { decision: 'rejected', added: false, rejectReason: 'no username' };

  // Rule 1/3: niche score (AI when available, deterministic keyword fallback).
  const niche = await nicheMatch(candidate, config, { classify: deps.nicheClassify });
  candidate.nicheScore = niche.nicheScore;
  candidate.nicheReason = niche.nicheReason;
  // Preserve the multimodal verdict (genre / audience match / spoken topic) on the
  // candidate's evidence so an admin can audit why it was matched.
  if (niche.evidence) {
    candidate.evidence = { ...(candidate.evidence || {}), niche: niche.evidence };
  }

  // Reels mode used to mean "no reach data": a single reel off the feed carries
  // no view counts, so it got a niche-only verdict and was always parked in the
  // review queue for a human to confirm reach by hand.
  //
  // The feed navigator now opens each creator and reads their Reels grid, so
  // when that reach IS present the full deterministic rules apply and the
  // candidate can be decided like any other. Falling back to the niche-only
  // path only when the grid gave us nothing keeps the old behaviour for the
  // cases it was written for.
  const reelsMode = String(config.discovery || '').toLowerCase() === 'reels';
  const hasReach = Array.isArray(candidate.reels)
    && candidate.reels.some((r) => r && Number.isFinite(Number(r.views)));
  const reachUnverified = reelsMode && !hasReach;
  const verdict = reachUnverified ? decideReel(candidate, config) : decide(candidate, config);

  // The model's fit_score is an INPUT, never the decision. When the analyses are
  // present, a deterministic gate combines it with reach steadiness, the
  // follower band, and the creativity/hook of the actual reels — so the same
  // numbers always produce the same answer and the bar is tunable from config
  // without touching a prompt. See services/creatorScore.js.
  // nicheMatch normalises the classifier's reply, carrying the richer per-clip
  // analysis through under `evidence` — the classifier's own top-level `clip`
  // does not survive that hop.
  const clipAnalyses = [
    niche && niche.evidence && niche.evidence.clip,
    ...(candidate.clipAnalyses || []),
  ].filter(Boolean);
  const creatorAnalysis = candidate.creatorAnalysis || null;
  const gate = (creatorAnalysis || clipAnalyses.length)
    ? scoreCreator({
      creator: creatorAnalysis || {},
      clips: clipAnalyses,
      reels: candidate.reels || [],
      followers: candidate.followers,
    }, config)
    : null;

  if (gate) {
    candidate.evidence = {
      ...(candidate.evidence || {}),
      creatorScore: {
        pass: gate.pass,
        score: gate.score,
        rejectReason: gate.rejectReason,
        components: gate.components,
        stats: gate.stats,
      },
    };
    // A hard reject from the gate stands regardless of what the niche rules made
    // of the same creator — a repost page or an unsafe brand context is not a
    // borderline call.
    if (!gate.pass) {
      verdict.pass = false;
      verdict.reasons = [...(verdict.reasons || []), gate.rejectReason].filter(Boolean);
    }
  }

  // Persist the candidate + its evaluation. persistCandidate returns the row, or
  // null when this handle was already scouted for the campaign (unique index).
  const row = await deps.persistCandidate({
    run_id: run.id,
    campaign_id: campaignId,
    username,
    full_name: candidate.full_name || candidate.fullName || null,
    followers: candidate.followers ?? null,
    bio: candidate.bio || null,
    reels: candidate.reels || [],
    niche_score: verdict.nicheScore,
    niche_reason: candidate.nicheReason,
    view_floor_pass: verdict.viewFloorPass,
    risk_profile: verdict.riskProfile,
    stability_score: verdict.stabilityScore,
    growth_trend: verdict.growthTrend,
    evidence: candidate.evidence || null,
    decision: 'pending',
  });
  if (!row) return { decision: 'skipped', added: false, rejectReason: 'already scouted' };

  if (!verdict.pass) {
    await deps.updateCandidate(row.id, { decision: 'rejected', reject_reason: verdict.rejectReason });
    return { decision: 'rejected', added: false, candidateId: row.id, rejectReason: verdict.rejectReason };
  }

  // Passed the rules — guard against creators we're already contacting in this
  // campaign (reuses the same duplicateGuard the manual add path uses)...
  const dup = await deps.findDuplicate({ campaignId, username, email: null });
  if (dup) {
    await deps.updateCandidate(row.id, { decision: 'rejected', reject_reason: 'already in campaign' });
    return { decision: 'rejected', added: false, candidateId: row.id, rejectReason: 'already in campaign' };
  }
  // ...and (best-effort) against creators already USED in the Creator-DB.
  if (deps.isUsed) {
    try {
      if (await deps.isUsed(username)) {
        await deps.updateCandidate(row.id, { decision: 'rejected', reject_reason: 'used creator' });
        return { decision: 'rejected', added: false, candidateId: row.id, rejectReason: 'used creator' };
      }
    } catch (_) {
      /* Creator-DB unreachable — don't block sourcing on it */
    }
  }

  // Trust dial: a passer whose reach we never measured still goes to review for
  // a human to confirm. Once the creator's Reels grid has been read, the
  // borderline dial decides, same as profiles mode — otherwise every reels-mode
  // creator sat in review forever with no decision made.
  const disposition = reachUnverified ? 'review' : reviewDecision(verdict, config);
  if (disposition === 'review') {
    await deps.updateCandidate(row.id, { decision: 'review' });
    return { decision: 'review', added: false, candidateId: row.id };
  }

  const creator = await deps.insertCreator({
    campaignId,
    username,
    fullName: candidate.full_name || candidate.fullName || null,
    firstName: candidate.first_name || candidate.firstName || null,
    sourcedVia: sourceTag(run, config, candidate, { niche, gate }),
  });
  await deps.updateCandidate(row.id, { decision: 'added', creator_id: creator.id });
  return { decision: 'added', added: true, candidateId: row.id, creatorId: creator.id };
}

// Drive a run to completion off a candidate source. `source.next()` resolves to a
// candidate or null when exhausted. Stops at targetCount, exhaustion, or when
// deps.shouldStop() returns true. Returns { status, stats }.
async function runWithSource(run, config, source, deps) {
  const targetCount = Number(config.targetCount || run.target_count || 0);
  const stats = { scanned: 0, added: 0, rejected: 0, skipped: 0, review: 0, byReason: {} };
  let stopped = false;

  while (!targetCount || stats.added < targetCount) {
    if (deps.shouldStop && (await deps.shouldStop())) {
      stopped = true;
      break;
    }
    const candidate = await source.next();
    if (!candidate) break;
    stats.scanned += 1;

    let res;
    try {
      res = await processCandidate(run, config, candidate, deps);
    } catch (err) {
      res = { decision: 'error', added: false, rejectReason: err.message };
    }

    if (res.added) {
      stats.added += 1;
    } else if (res.decision === 'skipped') {
      stats.skipped += 1;
    } else if (res.decision === 'review') {
      stats.review += 1;
    } else {
      stats.rejected += 1;
      const reason = res.rejectReason || 'unknown';
      stats.byReason[reason] = (stats.byReason[reason] || 0) + 1;
    }

    if (deps.onProgress) await deps.onProgress({ ...stats, targetCount, last: res });
    if (deps.updateRun) await deps.updateRun({ found_count: stats.added, stats });
  }

  const status = stopped ? 'stopped' : 'done';
  if (deps.updateRun) await deps.updateRun({ status, found_count: stats.added, stats });
  return { status, stats };
}

// Simple in-order candidate source backed by an array (used by the mock runner and
// tests). Real runs feed candidates from the paired host instead.
function arraySource(list) {
  let i = 0;
  const arr = Array.isArray(list) ? list : [];
  return {
    async next() {
      return i < arr.length ? arr[i++] : null;
    },
  };
}

module.exports = {
  processCandidate, runWithSource, arraySource, reviewDecision, sourceTag, sourceNote,
};
