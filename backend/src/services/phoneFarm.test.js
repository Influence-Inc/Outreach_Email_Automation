'use strict';

const test = require('node:test');
const assert = require('node:assert');
const farmLib = require('./phoneFarm');

const settings = { warmupGoal: 2, topUpGoal: 1, feedWindow: 5, minOnNiche: 0.4, dryLimit: 6 };

// A navigator like the real ones: each yield gets the previous result back, and
// `stop` ends it.
function nav(name, handles, seen) {
  return async function* scouting() {
    for (const h of handles) {
      const outcome = yield { username: h, from: name };
      seen.push([name, h, outcome && outcome.added ? 'added' : 'not', outcome && outcome.stop ? 'stop' : '']);
      if (outcome && outcome.stop) return;
    }
  };
}

function farmWith({ state = {}, search = ['s1', 's2', 's3', 's4', 's5'], feed = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'], persona = 'viewer' } = {}) {
  const seen = [];
  const saved = [];
  const farm = farmLib.createFarmSource({
    state,
    settings,
    startSearch: () => nav('search', search, seen)(),
    startFeed: () => nav('feed', feed, seen)(),
    persist: async (p) => { saved.push(p); },
    labelAccount: async () => persona,
  });
  return { farm, seen, saved };
}

test('a new account warms up through search, then moves to its feed at the goal', async () => {
  const { farm, seen, saved } = farmWith();
  let c = await farm.next();
  assert.strictEqual(c.from, 'search', 'a new account starts in warm-up');
  c = await farm.next({ decision: 'added', added: true });
  farm.onWarmed({ liked: true, shared: true }); // the navigator warmed s1
  c = await farm.next({ decision: 'added', added: true });
  farm.onWarmed({ liked: true, shared: false }); // s2
  assert.strictEqual(c.from, 'search');
  c = await farm.next({ decision: 'rejected', added: false });
  assert.strictEqual(c.from, 'feed', 'at 2 warmed creators the account scouts its feed');
  assert.deepStrictEqual(seen.at(-1), ['search', 's3', 'not', 'stop'], 'the search scout was told to stop, after its last result');
  const moved = saved.find((p) => p.phase === 'feed');
  assert.strictEqual(moved.persona, 'viewer', 'labelled with the viewer it was warmed into');
  assert.match(moved.note, /2 shortlisted creators warmed/);
  assert.strictEqual(farm.info().phase, 'feed');
  assert.strictEqual(farm.info().switches.length, 1);
});

test('a warm-up that does not like or share anything does not count', async () => {
  const { farm } = farmWith();
  await farm.next();
  farm.onWarmed({ liked: false, shared: false, reason: 'no reel' });
  assert.strictEqual(farm.info().warmed, 0);
});

test('an account already in its feed phase starts there', async () => {
  const { farm } = farmWith({ state: { phase: 'feed', persona: 'old viewer' } });
  const c = await farm.next();
  assert.strictEqual(c.from, 'feed');
  assert.strictEqual(farm.info().persona, 'old viewer');
});

test('an unreliable feed sends the account back to a top-up warm-up', async () => {
  const { farm, saved } = farmWith({ state: { phase: 'feed' } });
  // Five feed creators Jev placed off target: 0 of 5 on-niche.
  let c = await farm.next();
  for (let i = 0; i < 5; i += 1) {
    c = await farm.next({ decision: 'rejected', added: false, jevDecision: 'reject' });
  }
  assert.strictEqual(c.from, 'search', 'back to warm-up');
  const back = saved.find((p) => p.phase === 'warmup');
  assert.match(back.note, /feed unreliable — only 0 of the last 5 feed reels were on-niche/);
  assert.strictEqual(back.goal, 1, 'a top-up, not a full warm-up');
  assert.strictEqual(back.warmed, 0);
});

test('off-niche feed reels skipped on sight count against the feed', async () => {
  const { farm } = farmWith({ state: { phase: 'feed' } });
  await farm.next();
  for (let i = 0; i < 5; i += 1) farm.feedReel({ onNiche: false });
  const c = await farm.next({ decision: 'rejected', added: false });
  assert.strictEqual(c.from, 'search');
});

test('a feed that keeps serving creators we never shortlist is unreliable too', async () => {
  const { farm } = farmWith({ state: { phase: 'feed' } });
  let c = await farm.next();
  // On-niche (review), never shortlisted: 6 in a row hits the dry limit.
  for (let i = 0; i < 6; i += 1) c = await farm.next({ decision: 'review', added: false, jevDecision: 'review' });
  assert.strictEqual(c.from, 'search');
  assert.match(farm.info().switches[0].reason, /none of the last 6 creators from the feed was shortlisted/);
});

test('when the search runs dry the feed gets a go, and when both are dry the run ends', async () => {
  const { farm, saved } = farmWith({ search: ['s1'], feed: [] });
  let c = await farm.next();
  assert.strictEqual(c.from, 'search');
  c = await farm.next({ decision: 'rejected', added: false });
  assert.strictEqual(c, null, 'search used up, then the feed served nothing: done');
  const reasons = farm.info().switches.map((s) => s.reason);
  assert.match(reasons[0], /search results are used up/);
  assert.match(reasons[1], /stopped serving reels/);
  assert.strictEqual(saved.at(-1).phase, 'warmup', 'the next run starts by warming up');
});

test('reaching the target lets the last creator be warmed before the scout stops', async () => {
  const { farm, seen } = farmWith();
  await farm.next();
  await farm.finish({ decision: 'added', added: true });
  assert.deepStrictEqual(seen, [['search', 's1', 'added', 'stop']]);
});

test('the feed monitor measures the last window of reels', () => {
  const m = farmLib.createFeedMonitor({ feedWindow: 4, minOnNiche: 0.5, dryLimit: 10 });
  [true, false, true, false].forEach((b) => m.reel(b));
  assert.strictEqual(m.verdict().reliable, true, '2 of 4 is the minimum');
  m.reel(false);
  assert.strictEqual(m.verdict().reliable, false, 'the window moved: 1 of 4');
  const fresh = farmLib.createFeedMonitor({ feedWindow: 4, minOnNiche: 0.5, dryLimit: 10 });
  fresh.reel(false);
  assert.strictEqual(fresh.verdict().reliable, true, 'too few reels to call it yet');
});

test('settings come from env, with safe defaults', () => {
  assert.deepStrictEqual(farmLib.loadSettings({}), farmLib.DEFAULTS);
  const s = farmLib.loadSettings({ SOURCING_WARMUP_GOAL: '20', SOURCING_FEED_MIN_ON_NICHE: '0.5', SOURCING_FEED_WINDOW: '2' });
  assert.strictEqual(s.warmupGoal, 20);
  assert.strictEqual(s.minOnNiche, 0.5);
  assert.strictEqual(s.feedWindow, farmLib.DEFAULTS.feedWindow, 'a window under 5 reels is ignored');
});

test('Jev\'s call is read from the result, else from the verdict the feed carried', () => {
  assert.strictEqual(farmLib.jevDecisionOf({}, { jevDecision: 'shortlist' }), 'shortlist');
  const cand = { _nicheVerdict: { evidence: { jev: { decision: 'reject' } } } };
  assert.strictEqual(farmLib.jevDecisionOf(cand, { decision: 'rejected' }), 'reject');
  assert.strictEqual(farmLib.jevDecisionOf({}, {}), null);
});
