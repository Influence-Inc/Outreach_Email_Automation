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
//                     shortlisted is warmed — their reel liked and shared
//                     (services/creatorWarmup.js) — which teaches Instagram what
//                     this account watches. After `goal` creators are warmed the
//                     account moves to phase 2, and is labelled with the viewer
//                     it has been warmed into (services/audienceLabels.js).
//
//   PHASE 2  FEED     Scout the account's own reel feed
//                     (sourcingReelsNavigator.scoutReels), still warming every
//                     creator shortlisted. The feed is watched as it goes: when
//                     too few of its reels are on-niche, or it stops producing
//                     creators we shortlist, it is UNRELIABLE and the account goes
//                     back to phase 1 for a top-up warm-up.
//
// A new account (a newly paired phone) starts in phase 1. The phase, the count
// warmed towards the goal and the persona live on sourcing_hosts, so they carry
// over from run to run; every warm-up is logged in sourcing_warm_events.
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
 * @param {object} o.state        { phase, warmed, goal, persona } as loaded for the host
 * @param {Function} o.startSearch () => async generator (phase 1)
 * @param {Function} o.startFeed   () => async generator (phase 2)
 * @param {Function} [o.persist]   async (patch) => void   — writes the host's farm columns
 * @param {Function} [o.labelAccount] async () => persona|null — the warmed-into viewer
 */
function createFarmSource({
  state = {}, startSearch, startFeed, persist = async () => {}, labelAccount = async () => null,
  settings = loadSettings(), log = () => {}, now = () => new Date(),
}) {
  const farm = {
    phase: PHASES.includes(state.phase) ? state.phase : 'warmup',
    warmed: Number(state.warmed) || 0,
    goal: Number(state.goal) || settings.warmupGoal,
    persona: state.persona || null,
  };
  const switches = [];
  let gen = null;
  let running = null; // the phase `gen` scouts in
  let started = false; // whether `gen` has yielded (and so is paused at a yield)
  let monitor = null;
  let lastCandidate = null;
  let searchDry = false;
  let feedFailed = false;

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
    if (phase === 'feed') {
      const persona = await labelAccount().catch(() => null);
      if (persona) {
        farm.persona = persona;
        patch.persona = persona;
      }
    }
    switches.push({ from, to: phase, reason: reason || null, at: now().toISOString() });
    log(`[farm] ${from} → ${phase}${reason ? `: ${reason}` : ''}${phase === 'feed' && farm.persona ? ` (warmed for: ${farm.persona})` : ''}`);
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
          if (feedFailed) return null;
          await enter('feed', 'the keywords\' search results are used up');
          continue;
        }
        if (farm.phase === 'feed' && feedFailed && searchDry) return null;
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
        if (feedFailed) return null;
        await enter('feed', 'the keywords\' search results are used up');
      } else {
        // Saved as warm-up even when the run ends here, so the next run starts
        // by warming the account rather than on the feed that just ran dry.
        feedFailed = true;
        await enter('warmup', 'the reel feed stopped serving reels');
        if (searchDry) return null;
      }
    }
    log('[farm] switched phases too often in a row — ending the run');
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
    /** A creator was warmed (liked and/or shared). */
    onWarmed(out) {
      if (!out || !(out.liked || out.shared)) return;
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
        persona: farm.persona,
        feedOnNiche: v && v.share != null ? Math.round(v.share * 100) / 100 : null,
        switches,
      };
    },
  };
}

// ── the host's farm state ───────────────────────────────────────────────────

async function loadState(db, hostId) {
  if (hostId == null) return {};
  const row = await db.one(
    `SELECT farm_phase, farm_warmed, farm_goal, persona FROM sourcing_hosts WHERE id = $1`,
    [hostId],
  );
  return row ? { phase: row.farm_phase, warmed: row.farm_warmed, goal: row.farm_goal, persona: row.persona } : {};
}

const COLUMNS = {
  phase: 'farm_phase', warmed: 'farm_warmed', goal: 'farm_goal', note: 'farm_note', phaseAt: 'farm_phase_at', persona: 'persona',
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
  if ('persona' in patch) sets.push('persona_at = NOW()');
  if (!sets.length) return;
  await db.query(`UPDATE sourcing_hosts SET ${sets.join(', ')} WHERE id = $1`, vals);
}

/** Log one warmed creator, with who their viewers are when that was labelled. */
async function recordWarm(db, { hostId = null, runId = null, username, liked, shared, how = null }) {
  const handle = String(username || '').trim().replace(/^@/, '').toLowerCase();
  if (!handle) return;
  await db.query(
    `INSERT INTO sourcing_warm_events (host_id, run_id, username, liked, shared, how, target_viewer)
     VALUES ($1, $2, $3, $4, $5, $6,
       (SELECT evidence->>'targetViewer' FROM sourced_candidates
         WHERE LOWER(username) = $3 AND evidence ? 'targetViewer'
         ORDER BY id DESC LIMIT 1))`,
    [hostId, runId, handle, !!liked, !!shared, how],
  );
}

/** Who the creators this account warmed make reels for, newest first. */
async function recentViewers(db, hostId, limit = 30) {
  if (hostId == null) return [];
  const rows = await db.many(
    `SELECT target_viewer FROM sourcing_warm_events
      WHERE host_id = $1 AND target_viewer IS NOT NULL
      ORDER BY at DESC LIMIT $2`,
    [hostId, limit],
  );
  return rows.map((r) => r.target_viewer).filter(Boolean);
}

/** Back to phase 1 from the start: a new account was signed in on the phone. */
async function restart(db, hostId, { settings = loadSettings(), note = 'restarted' } = {}) {
  await db.query(
    `UPDATE sourcing_hosts
        SET farm_phase = 'warmup', farm_warmed = 0, farm_goal = $2, farm_note = $3,
            farm_phase_at = NOW(), persona = NULL, persona_at = NULL
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
  recentViewers,
  restart,
  DEFAULTS,
  PHASES,
};
