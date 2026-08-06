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

const { nicheMatch, decide } = require('./sourcingFilters');

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

  // Rules 2/4/5 + niche threshold.
  const verdict = decide(candidate, config);

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

  const creator = await deps.insertCreator({
    campaignId,
    username,
    fullName: candidate.full_name || candidate.fullName || null,
    firstName: candidate.first_name || candidate.firstName || null,
  });
  await deps.updateCandidate(row.id, { decision: 'added', creator_id: creator.id });
  return { decision: 'added', added: true, candidateId: row.id, creatorId: creator.id };
}

// Drive a run to completion off a candidate source. `source.next()` resolves to a
// candidate or null when exhausted. Stops at targetCount, exhaustion, or when
// deps.shouldStop() returns true. Returns { status, stats }.
async function runWithSource(run, config, source, deps) {
  const targetCount = Number(config.targetCount || run.target_count || 0);
  const stats = { scanned: 0, added: 0, rejected: 0, skipped: 0, byReason: {} };
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

module.exports = { processCandidate, runWithSource, arraySource };
