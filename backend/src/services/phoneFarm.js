'use strict';

// Phone farming: which way each phone's Instagram account scouts, decided for it.
//
// A phone's own reel feed is the cheapest place to find creators — but only once
// Instagram serves that account the creators we want, and a new account's feed
// serves nothing of the kind. So every account moves through two phases, in a
// loop, and the Scout page no longer asks which "discovery mode" to use:
//
//   PHASE 1  WARM-UP  Search the run's keywords and scout the creators whose
//                     reels come up (sourcingNavigator.scout). Every creator
//                     shortlisted is warmed — their reel liked
//                     (services/creatorWarmup.js) — which teaches Instagram what
//                     this account watches. After `goal` creators are warmed the
//                     account moves to phase 2.
//
//   PHASE 2  FEED     Scout the account's own reel feed
//                     (sourcingReelsNavigator.scoutReels), still warming every
//                     creator shortlisted. The feed is watched as it goes: when
//                     too few of its reels are on-niche, or it stops producing
//                     creators we shortlist, it is UNRELIABLE and the account goes
//                     back to phase 1 for a top-up warm-up.
//
// A new account (a newly paired phone) starts in phase 1. The phase and the
// count warmed towards the goal live on sourcing_hosts, so they carry over from
// run to run; every warm-up is logged in sourcing_warm_events.
//
// A run ends when it has its target, when it is stopped, or when both ways have
// run dry in the same run (the keywords' search results are used up AND the feed
// is unreliable), rather than looping between two empty sources.
//
// Env (optional):
//   SOURCING_WARMUP_GOAL        creators warmed before a new account's first feed run (15)
//   SOURCING_WARMUP_TOPUP       creators warmed when the feed goes back to warm-up (8)
//   SOURCING_FEED_WINDOW        feed reels the on-niche share is measured over (30)
//   SOURCING_FEED_MIN_ON_NICHE  share of those that must be on-niche (0.3)
//   SOURCING_FEED_DRY_LIMIT     feed creators judged in a row with none shortlisted (40)

const DEFAULTS = {
  warmupGoal: 15,
  topUpGoal: 8,
  feedWindow: 30,
  minOnNiche: 0.3,
  dryLimit: 40,
};

const PHASES = ['warmup', 'feed'];

function num(v, fallback, { min = 0 } = {}) {
  if (v === '' || v == null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

function loadSettings(env = process.env) {
  return {
    warmupGoal: Math.round(num(env.SOURCING_WARMUP_GOAL, DEFAULTS.warmupGoal, { min: 1 })),
    topUpGoal: Math.round(num(env.SOURCING_WARMUP_TOPUP, DEFAULTS.topUpGoal, { min: 1 })),
    feedWindow: Math.round(num(env.SOURCING_FEED_WINDOW, DEFAULTS.feedWindow, { min: 5 })),
    minOnNiche: Math.min(1, num(env.SOURCING_FEED_MIN_ON_NICHE, DEFAULTS.minOnNiche)),
    dryLimit: Math.round(num(env.SOURCING_FEED_DRY_LIMIT, DEFAULTS.dryLimit, { min: 5 })),
  };
}

// ── is the feed still worth scouting? ───────────────────────────────────────

/**
 * Watches the feed while phase 2 runs. Two ways to be unreliable:
 *   - of the last `feedWindow` reels, under `minOnNiche` were on-niche (an
 *     off-niche caption skipped on sight, or a creator Jev placed off target);
 *   - `dryLimit` creators judged in a row and none shortlisted — on-niche
 *     content, but not the creators we need.
 * Pure: fed by the caller, never looks at anything itself.
 */
function createFeedMonitor(settings = DEFAULTS) {
  const window = settings.feedWindow || DEFAULTS.feedWindow;
  const minOnNiche = settings.minOnNiche != null ? settings.minOnNiche : DEFAULTS.minOnNiche;
  const dryLimit = settings.dryLimit || DEFAULTS.dryLimit;
  const recent = [];
  let sinceShortlist = 0;
  return {
    /** One feed reel: on-niche or not. */
    reel(onNiche) {
      recent.push(!!onNiche);
      if (recent.length > window) recent.shift();
    },
    /** One creator from the feed was decided. */
    creator({ shortlisted }) {
      sinceShortlist = shortlisted ? 0 : sinceShortlist + 1;
    },
    verdict() {
      const on = recent.filter(Boolean).length;
      const share = recent.length ? on / recent.length : null;
      if (recent.length >= window && share < minOnNiche) {
        return { reliable: false, share, reason: `only ${on} of the last ${recent.length} feed reels were on-niche` };
      }
      if (sinceShortlist >= dryLimit) {
        return { reliable: false, share, reason: `none of the last ${sinceShortlist} creators from the feed was shortlisted` };
      }
      return { reliable: true, share, seen: recent.length, sinceShortlist };
    },
  };
}

/** Jev's call on a candidate, from the result or the verdict the feed carried. */
function jevDecisionOf(candidate, res) {
  if (res && res.jevDecision) return res.jevDecision;
  const v = candidate && candidate._nicheVerdict;
  return (v && v.evidence && v.evidence.jev && v.evidence.jev.decision) || null;
}

// ── the source a run scouts from ────────────────────────────────────────────

/**
 * A candidate source (`next(lastResult)`, `finish(lastResult)`) that scouts in
 * whichever phase the account is in and switches when it should.
 *
 * Navigators are async generators that take the previous candidate's result
 * back through `next(result)`: they warm a creator that was shortlisted, and
 * return when the result says `stop`. That is how a phase ends cleanly — the
 * last creator still gets warmed — before the other phase starts.
 *
 * @param {object} o
 * @param {object} o.state        { phase, warmed, goal } as loaded for the host
 * @param {Function} o.startSearch () => async generator (phase 1)
 * @param {Function} o.startFeed   () => async generator (phase 2)
 * @param {Function} [o.persist]   async (patch) => void   — writes the host's farm columns
 */
function createFarmSource({
  state = {}, startSearch, startFeed, persist = async () => {},
  settings = loadSettings(), log = () => {}, now = () => new Date(),
}) {
  const farm = {
    phase: PHASES.includes(state.phase) ? state.phase : 'warmup',
    warmed: Number(state.warmed) || 0,
    goal: Number(state.goal) || settings.warmupGoal,
  };
  const switches = [];
  let gen = null;
  let running = null; // the phase `gen` scouts in
  let started = false; // whether `gen` has yielded (and so is paused at a yield)
  let monitor = null;
  let lastCandidate = null;
  let searchDry = false;
  let feedFailed = false;
  let endReason = null;

  const save = async (patch) => {
    try { await persist(patch); } catch (err) { log(`[farm] could not save the account's phase: ${(err && err.message) || err}`); }
  };

  async function enter(phase, reason) {
    const from = farm.phase;
    farm.phase = phase;
    const patch = { phase, note: reason || null, phaseAt: now() };
    if (phase === 'warmup') {
      farm.warmed = 0;
      farm.goal = settings.topUpGoal;
      Object.assign(patch, { warmed: 0, goal: farm.goal });
    }
    switches.push({ from, to: phase, reason: reason || null, at: now().toISOString() });
    log(`[farm] ${from} → ${phase}${reason ? `: ${reason}` : ''}`);
    await save(patch);
  }

  /** End the running generator: let it warm `last` (if shortlisted) and return. */
  async function stopRunning(last) {
    const g = gen;
    gen = null;
    if (!g) return;
    try {
      if (started) await g.next({ ...(last || {}), stop: true });
      await g.return();
    } catch (err) {
      log(`[farm] stopping the ${running} scout failed: ${(err && err.message) || err}`);
    }
  }

  /** Account for the previous candidate's result while the feed runs. */
  function observe(last) {
    if (running !== 'feed' || !monitor || !last || last.decision === 'skipped') return;
    const decision = jevDecisionOf(lastCandidate, last);
    if (decision) monitor.reel(decision !== 'reject');
    monitor.creator({ shortlisted: !!last.added });
  }

  /** Why the account's phase should end now, or null. */
  function shouldLeave() {
    if (farm.phase === 'warmup' && farm.warmed >= farm.goal) {
      return { to: 'feed', reason: `${farm.warmed} shortlisted creators warmed` };
    }
    if (gen && running === 'feed' && monitor) {
      const v = monitor.verdict();
      if (!v.reliable) return { to: 'warmup', reason: `feed unreliable — ${v.reason}` };
    }
    return null;
  }

  async function next(last) {
    observe(last);
    let pending = last;
    for (let guard = 0; guard < 6; guard += 1) {
      const leave = shouldLeave();
      if (leave) {
        await stopRunning(pending);
        pending = undefined;
        // A failed feed gets another chance once a warm-up has been completed.
        if (leave.to === 'warmup') feedFailed = true;
        else feedFailed = false;
        // eslint-disable-next-line no-await-in-loop
        await enter(leave.to, leave.reason);
        continue;
      }
      if (!gen) {
        // Both ways ran dry in this run: stop rather than loop between them.
        if (farm.phase === 'warmup' && searchDry) {
          if (feedFailed) return end('the keywords\' search results are used up and the reel feed is not serving on-target reels');
          await enter('feed', 'the keywords\' search results are used up');
          continue;
        }
        if (farm.phase === 'feed' && feedFailed && searchDry) return end('the keywords\' search results are used up and the reel feed is not serving on-target reels');
        running = farm.phase;
        gen = running === 'warmup' ? startSearch() : startFeed();
        started = false;
        monitor = running === 'feed' ? createFeedMonitor(settings) : null;
        log(`[farm] scouting in ${running === 'warmup' ? 'warm-up (search + reels)' : 'the reel feed'}`
          + `${running === 'warmup' ? ` — ${farm.warmed}/${farm.goal} creators warmed` : ''}`);
      }

      const r = await gen.next(pending);
      pending = undefined;
      if (!r.done) {
        started = true;
        lastCandidate = r.value;
        return r.value;
      }
      // The phase ran out on its own.
      gen = null;
      if (running === 'warmup') {
        searchDry = true;
        if (feedFailed) return end('the keywords\' search results are used up and the reel feed is not serving on-target reels');
        await enter('feed', 'the keywords\' search results are used up');
      } else {
        // Saved as warm-up even when the run ends here, so the next run starts
        // by warming the account rather than on the feed that just ran dry.
        feedFailed = true;
        await enter('warmup', 'the reel feed stopped serving reels');
        if (searchDry) return end('the reel feed stopped serving reels and the keywords\' search results are used up');
      }
    }
    log('[farm] switched phases too often in a row — ending the run');
    return end('it switched between search and the feed too often in a row');
  }

  /** The run is over: say why, for the run card. */
  function end(reason) {
    endReason = reason;
    log(`[farm] ending the run: ${reason}`);
    return null;
  }

  return {
    next,
    /** The run has its target: let the last creator be warmed, then stop. */
    async finish(last) {
      observe(last);
      await stopRunning(last);
    },
    /** The run is over: shut down whatever is scouting. */
    async close() {
      const g = gen;
      gen = null;
      if (g) await g.return();
    },
    /** A creator was warmed (their reel liked). */
    onWarmed(out) {
      if (!out || !out.liked) return;
      farm.warmed += 1;
      save({ warmed: farm.warmed });
    },
    /** A feed reel skipped on sight for an off-niche caption. */
    feedReel({ onNiche }) {
      if (running === 'feed' && monitor) monitor.reel(onNiche);
    },
    /** For the run's stats: where the account is, and how it got there. */
    info() {
      const v = monitor ? monitor.verdict() : null;
      return {
        mode: 'auto',
        phase: farm.phase,
        warmed: farm.warmed,
        goal: farm.goal,
        feedOnNiche: v && v.share != null ? Math.round(v.share * 100) / 100 : null,
        switches,
        endReason: endReason || undefined,
      };
    },
  };
}

// ── the host's farm state ───────────────────────────────────────────────────

async function loadState(db, hostId) {
  if (hostId == null) return {};
  const row = await db.one(
    `SELECT farm_phase, farm_warmed, farm_goal FROM sourcing_hosts WHERE id = $1`,
    [hostId],
  );
  return row ? { phase: row.farm_phase, warmed: row.farm_warmed, goal: row.farm_goal } : {};
}

const COLUMNS = {
  phase: 'farm_phase', warmed: 'farm_warmed', goal: 'farm_goal', note: 'farm_note', phaseAt: 'farm_phase_at',
};

async function saveState(db, hostId, patch = {}) {
  if (hostId == null) return;
  const sets = [];
  const vals = [hostId];
  for (const [key, col] of Object.entries(COLUMNS)) {
    if (!(key in patch)) continue;
    vals.push(patch[key]);
    sets.push(`${col} = $${vals.length}`);
  }
  if (!sets.length) return;
  await db.query(`UPDATE sourcing_hosts SET ${sets.join(', ')} WHERE id = $1`, vals);
}

/** Log one creator whose reel the phone liked to warm its feed. */
async function recordWarm(db, { hostId = null, runId = null, username }) {
  const handle = String(username || '').trim().replace(/^@/, '').toLowerCase();
  if (!handle) return;
  await db.query(
    `INSERT INTO sourcing_warm_events (host_id, run_id, username) VALUES ($1, $2, $3)`,
    [hostId, runId, handle],
  );
}

/** Back to phase 1 from the start: a new account was signed in on the phone. */
async function restart(db, hostId, { settings = loadSettings(), note = 'restarted' } = {}) {
  await db.query(
    `UPDATE sourcing_hosts
        SET farm_phase = 'warmup', farm_warmed = 0, farm_goal = $2, farm_note = $3,
            farm_phase_at = NOW()
      WHERE id = $1`,
    [hostId, settings.warmupGoal, note],
  );
}

module.exports = {
  createFarmSource,
  createFeedMonitor,
  jevDecisionOf,
  loadSettings,
  loadState,
  saveState,
  recordWarm,
  restart,
  DEFAULTS,
  PHASES,
};
