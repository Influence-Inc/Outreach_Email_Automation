'use strict';

// Run with: npm test  (node --test)
//
// End-to-end sourcing pipeline WITHOUT any phone: an array "mock driver" feeds
// captured candidates through the orchestrator, which scores them with the real
// scouting rules, dedupes, and "adds" the passers via injected in-memory stores.
const test = require('node:test');
const assert = require('node:assert');
const { runWithSource, arraySource, processCandidate, reviewDecision } = require('./sourcingOrchestrator');

// In-memory implementation of the injected side effects.
function memStore(seedCreators = []) {
  const candidates = [];
  const creators = seedCreators.map((c, i) => ({ id: i + 1, ...c }));
  const seen = new Set(); // enforces the (campaign, username) unique index
  const deps = {
    // Force the deterministic keyword path so tests never hit the network.
    nicheClassify: async () => null,
    async persistCandidate(rec) {
      const key = `${rec.campaign_id}/${rec.username.toLowerCase()}`;
      if (seen.has(key)) return null;
      seen.add(key);
      const row = { id: candidates.length + 1, ...rec };
      candidates.push(row);
      return row;
    },
    async updateCandidate(id, patch) {
      const row = candidates.find((c) => c.id === id);
      if (row) Object.assign(row, patch);
    },
    async findDuplicate({ username }) {
      return creators.find((c) => c.username.toLowerCase() === username.toLowerCase()) || null;
    },
    async insertCreator({ campaignId, username, fullName }) {
      const row = { id: creators.length + 1, campaignId, username, fullName };
      creators.push(row);
      return row;
    },
  };
  return { candidates, creators, deps };
}

const run = { id: 1, campaign_id: 'camp-1' };
const goodCfg = {
  floor: 15000,
  ceiling: 500000,
  risk: 'high',
  niche: 'fitness',
  keywords: ['gym'],
  nicheThreshold: 0.4,
};
const fitReels = (v = 100000) => Array(12).fill(0).map(() => ({ views: v, caption: 'gym day' }));

test('run adds passing creators and stops at the target count', async () => {
  const { creators, candidates, deps } = memStore();
  const source = arraySource([
    { username: 'coachA', bio: 'fitness', reels: fitReels() }, // passes
    { username: 'chefB', bio: 'cooking', reels: Array(12).fill({ views: 100000, caption: 'recipe' }) }, // off-niche
    { username: 'coachC', bio: 'fitness', reels: fitReels() }, // passes -> reaches target
    { username: 'coachD', bio: 'fitness', reels: fitReels() }, // never reached
  ]);

  const { status, stats } = await runWithSource(run, { ...goodCfg, targetCount: 2 }, source, deps);

  assert.strictEqual(status, 'done');
  assert.strictEqual(stats.added, 2);
  assert.strictEqual(stats.scanned, 3, 'stops after the 2nd add, never scans coachD');
  assert.deepStrictEqual(
    creators.map((c) => c.username),
    ['coachA', 'coachC'],
  );
  // chefB persisted + rejected on niche
  const chef = candidates.find((c) => c.username === 'chefB');
  assert.strictEqual(chef.decision, 'rejected');
  assert.match(chef.reject_reason, /niche score/);
});

test('a creator already in the campaign is rejected, not re-added', async () => {
  const { creators, candidates, deps } = memStore([{ username: 'CoachA', campaignId: 'camp-1' }]);
  const source = arraySource([{ username: 'coacha', bio: 'fitness', reels: fitReels() }]);

  const { stats } = await runWithSource(run, { ...goodCfg, targetCount: 5 }, source, deps);

  assert.strictEqual(stats.added, 0);
  assert.strictEqual(stats.rejected, 1);
  assert.strictEqual(creators.length, 1, 'no new creator inserted');
  assert.match(candidates[0].reject_reason, /already in campaign/);
});

test('the same handle captured twice is skipped the second time', async () => {
  const { deps } = memStore();
  const source = arraySource([
    { username: 'coachA', bio: 'fitness', reels: fitReels() },
    { username: 'CoachA', bio: 'fitness', reels: fitReels() }, // same handle, different case
  ]);

  const { stats } = await runWithSource(run, { ...goodCfg, targetCount: 5 }, source, deps);

  assert.strictEqual(stats.added, 1);
  assert.strictEqual(stats.skipped, 1);
});

test('the injected AI classifier can rescue an off-keyword creator', async () => {
  const { creators, deps } = memStore();
  deps.nicheClassify = async () => ({ score: 0.95, reason: 'clearly on-brand' });
  // bio/captions contain none of the keywords, so only the AI score lets it pass.
  const source = arraySource([
    { username: 'vibes', bio: 'lifestyle', reels: Array(12).fill({ views: 100000, caption: 'my day' }) },
  ]);

  const { stats } = await runWithSource(run, { ...goodCfg, targetCount: 1 }, source, deps);

  assert.strictEqual(stats.added, 1);
  assert.strictEqual(creators[0].username, 'vibes');
});

test('a multimodal classifier verdict is persisted as candidate evidence', async () => {
  const { candidates, deps } = memStore();
  deps.nicheClassify = async () => ({
    score: 0.9,
    reason: 'clearly on-brand',
    source: 'gemini-video',
    evidence: { source: 'gemini-video', genre: 'home fitness', audienceMatch: 0.8, spokenTopic: 'home workout' },
  });
  await processCandidate(
    run,
    { ...goodCfg, targetCount: 1 },
    { username: 'mia', bio: 'lifestyle', reels: fitReels() },
    deps,
  );
  assert.strictEqual(candidates[0].evidence.niche.genre, 'home fitness');
  assert.strictEqual(candidates[0].evidence.niche.audienceMatch, 0.8);
});

test('reviewDecision: off by default; borderline -> review, clear -> add', () => {
  assert.strictEqual(reviewDecision({ nicheScore: 0.5 }, {}), 'add'); // reviewBorderline off
  const cfg = { reviewBorderline: true, nicheThreshold: 0.4, reviewBand: 0.15 };
  assert.strictEqual(reviewDecision({ nicheScore: 0.5 }, cfg), 'review'); // 0.5 < 0.55
  assert.strictEqual(reviewDecision({ nicheScore: 0.9 }, cfg), 'add');
  assert.strictEqual(reviewDecision({ nicheScore: null }, cfg), 'add'); // unassessed niche
});

test('a borderline passer is held for review, not auto-added', async () => {
  const { candidates, creators, deps } = memStore();
  deps.nicheClassify = async () => ({ score: 0.5, reason: 'borderline' });
  const cfg = { floor: 15000, risk: 'high', niche: 'fitness', keywords: ['gym'], nicheThreshold: 0.4, reviewBorderline: true, reviewBand: 0.15, targetCount: 5 };
  const res = await processCandidate(run, cfg, { username: 'maybe', bio: 'x', reels: fitReels() }, deps);
  assert.strictEqual(res.decision, 'review');
  assert.strictEqual(res.added, false);
  assert.strictEqual(candidates[0].decision, 'review');
  assert.strictEqual(creators.length, 0, 'not promoted into the campaign');
});

test('a clear passer above the review band is still auto-added', async () => {
  const { creators, deps } = memStore();
  deps.nicheClassify = async () => ({ score: 0.95, reason: 'clear' });
  const cfg = { floor: 15000, risk: 'high', niche: 'fitness', keywords: ['gym'], nicheThreshold: 0.4, reviewBorderline: true, reviewBand: 0.15, targetCount: 5 };
  const res = await processCandidate(run, cfg, { username: 'clear', bio: 'x', reels: fitReels() }, deps);
  assert.strictEqual(res.decision, 'added');
  assert.strictEqual(creators.length, 1);
});

test('processCandidate records a floor rejection', async () => {
  const { candidates, deps } = memStore();
  const res = await processCandidate(
    run,
    { floor: 15000, risk: 'high' },
    { username: 'lowviews', reels: [...Array(11).fill({ views: 100000 }), { views: 9000 }] },
    deps,
  );
  assert.strictEqual(res.added, false);
  assert.strictEqual(res.decision, 'rejected');
  assert.match(candidates[0].reject_reason, /below floor/);
});
