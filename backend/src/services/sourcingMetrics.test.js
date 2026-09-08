'use strict';

const test = require('node:test');
const assert = require('node:assert');
const m = require('./sourcingMetrics');

test('rate is a percentage, and refuses to divide by nothing', () => {
  assert.strictEqual(m.rate(1, 4), 25);
  assert.strictEqual(m.rate(1, 3), 33.3);
  assert.strictEqual(m.rate(0, 5), 0);
  assert.strictEqual(m.rate(3, 0), null, 'no denominator is unknown, not 0%');
  assert.strictEqual(m.rate(null, 5), null);
});

test('summarise reports the funnel and the rates that matter', () => {
  const s = m.summarise({
    scanned: 200, added: 20, review: 10, rejected: 160, skipped: 10,
    autoAdded: 16, humanApproved: 4, humanRejected: 2,
    contacted: 15, replied: 3,
  });
  assert.deepStrictEqual(s.funnel, {
    scanned: 200, added: 20, review: 10, rejected: 160, skipped: 10, contacted: 15, replied: 3,
  });
  assert.strictEqual(s.yieldRate, 10);       // 20/200
  assert.strictEqual(s.contactRate, 75);     // 15/20
  assert.strictEqual(s.replyRate, 20);       // 3/15
  assert.strictEqual(s.reviewApprovalRate, 40); // 4/10
  assert.strictEqual(s.overturnRate, 33.3);  // 2 of 6 human calls went against the machine
});

// The number to drive down: creators the RULES added on their own that a human
// then threw out. That is the false-positive rate the whole gate exists to keep
// low, and nothing measured it before.
test('overturn rate counts human disagreement, not human effort', () => {
  const agreed = m.summarise({ humanApproved: 10, humanRejected: 0 });
  const disagreed = m.summarise({ humanApproved: 0, humanRejected: 10 });
  assert.strictEqual(agreed.overturnRate, 0);
  assert.strictEqual(disagreed.overturnRate, 100);
  assert.strictEqual(m.summarise({}).overturnRate, null, 'no decisions yet is unknown');
});

// Not "higher is better": a queue the human always approves is asking about
// creators the rules should have added themselves.
test('a review queue nobody disagrees with is reported, not celebrated', () => {
  assert.strictEqual(m.summarise({ review: 20, humanApproved: 20 }).reviewApprovalRate, 100);
  assert.strictEqual(m.summarise({ review: 20, humanApproved: 0 }).reviewApprovalRate, 0);
});

test('an empty campaign reports zeroes and nulls rather than throwing', () => {
  const s = m.summarise({});
  assert.deepStrictEqual(s.funnel, { scanned: 0, added: 0, review: 0, rejected: 0, skipped: 0, contacted: 0, replied: 0 });
  assert.strictEqual(s.yieldRate, null);
  assert.strictEqual(s.replyRate, null);
});

// A keyword that sources twenty creators nobody answers is worse than one that
// sources three who do.
test('keywords rank by replies, not by volume', () => {
  const ranked = m.rankKeywords([
    { keyword: 'homegym', added: 20, contacted: 20, replied: 1 },
    { keyword: 'protein', added: 3, contacted: 3, replied: 3 },
    { keyword: null, added: 5, contacted: 0, replied: 0 },
  ]);
  assert.deepStrictEqual(ranked.map((r) => r.keyword), ['protein', 'homegym', '(none)']);
  assert.strictEqual(ranked[0].replyRate, 100);
  assert.strictEqual(ranked[1].replyRate, 5);
  assert.strictEqual(ranked[2].replyRate, null, 'nobody contacted yet');
});

test('campaignReport joins the candidate funnel to the outreach outcome', async () => {
  const db = {
    one: async (sql) => (/FROM sourced_candidates/.test(sql)
      ? { scanned: 100, added: 10, auto_added: 8, human_approved: 2, human_rejected: 1, review: 5, rejected: 80, skipped: 5 }
      : { added: 10, contacted: 8, replied: 2 }),
    many: async () => [{ keyword: 'homegym', added: 10, contacted: 8, replied: 2 }],
  };
  const r = await m.campaignReport({ db, campaignId: 'camp-1' });
  assert.strictEqual(r.campaignId, 'camp-1');
  assert.strictEqual(r.funnel.scanned, 100);
  assert.strictEqual(r.funnel.replied, 2);
  assert.strictEqual(r.replyRate, 25);
  assert.strictEqual(r.keywords[0].keyword, 'homegym');
});
