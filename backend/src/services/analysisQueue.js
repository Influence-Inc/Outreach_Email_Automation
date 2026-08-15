'use strict';

// Fire-and-forget queue for reel analysis.
//
// The scout used to record a reel and then WAIT for the model's verdict before
// doing anything else, so a slow (or briefly down) analysis service throttled
// the phone: scrolling stopped while nothing was happening on screen. Judging a
// reel has nothing to do with driving Instagram, so it should not be able to
// hold the device up.
//
// [submit] starts the work and returns immediately — synchronously, so a caller
// physically cannot await it by accident. [take] collects a verdict later, and
// gives up rather than blocking if it is not ready: by the time the batch
// handler reaches a creator the analysis has usually had a profile visit's worth
// of time to finish, and a creator whose verdict is still in flight is kept with
// the analysis marked incomplete rather than stalling the run.
//
// Nothing here touches the network or the phone, so the whole queue is testable
// with plain promises.

const DEFAULT_MAX_CONCURRENT = 3;

// [take] does not wait by default. By the time the batch handler reaches a
// creator, that analysis has had a whole profile visit to finish — so anything
// still in flight is genuinely slow, and waiting on it would put the run back
// on the model's clock, which is the thing this queue exists to prevent. A
// caller that truly needs a verdict (engagement, which must not like an
// off-brand reel) asks for a wait explicitly.
const DEFAULT_TAKE_TIMEOUT_MS = 0;

function createAnalysisQueue({
  maxConcurrent = DEFAULT_MAX_CONCURRENT,
  timeoutMs = DEFAULT_TAKE_TIMEOUT_MS,
  logger = console,
} = {}) {
  const results = new Map(); // key -> settled value (or null when it failed)
  const inFlight = new Map(); // key -> promise that always resolves
  const waiting = []; // queued starters, held back by maxConcurrent
  let running = 0;

  const warn = (...a) => (logger.warn || logger.log || (() => {})).call(logger, ...a);

  function pump() {
    while (running < maxConcurrent && waiting.length) {
      const next = waiting.shift();
      next();
    }
  }

  /**
   * Start analysing, and return control immediately.
   *
   * Deliberately returns nothing: a caller that wanted to await this would be
   * reintroducing exactly the stall the queue exists to remove.
   */
  function submit(key, work) {
    if (!key || typeof work !== 'function') return;
    if (results.has(key) || inFlight.has(key)) return; // already done or running

    let settle;
    const promise = new Promise((resolve) => { settle = resolve; });
    inFlight.set(key, promise);

    const start = () => {
      running += 1;
      Promise.resolve()
        .then(work)
        .then(
          (value) => {
            results.set(key, value == null ? null : value);
          },
          (err) => {
            warn('[analysis] failed for', key, '-', (err && err.message) || err);
            results.set(key, null);
          },
        )
        .then(() => {
          running -= 1;
          inFlight.delete(key);
          settle(results.get(key) ?? null);
          pump();
        });
    };

    waiting.push(start);
    pump();
  }

  /**
   * Collect a verdict.
   *
   * Returns it if ready, waits only `timeoutMs` for one still in flight, and
   * returns null rather than blocking any longer. A null means "no verdict yet",
   * not "rejected" — the caller keeps the creator and marks the analysis
   * incomplete.
   */
  async function take(key, { timeoutMs: wait = timeoutMs } = {}) {
    if (results.has(key)) {
      const value = results.get(key);
      results.delete(key);
      return value;
    }
    const pending = inFlight.get(key);
    if (!pending) return null;
    if (!(wait > 0)) return null; // still running, and we are not waiting

    let timer;
    const expired = Symbol('timeout');
    const raced = await Promise.race([
      pending,
      new Promise((resolve) => { timer = setTimeout(() => resolve(expired), wait); }),
    ]);
    clearTimeout(timer);

    if (raced === expired) return null;
    results.delete(key);
    return raced ?? null;
  }

  /** Analyses started but not yet finished — for logging and tests. */
  function pendingCount() {
    return inFlight.size;
  }

  /** Wait for everything in flight; used when a run is winding down. */
  async function drain() {
    while (inFlight.size) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.all([...inFlight.values()]);
    }
  }

  return { submit, take, pendingCount, drain };
}

module.exports = {
  createAnalysisQueue,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_TAKE_TIMEOUT_MS,
};
