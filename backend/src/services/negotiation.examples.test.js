'use strict';

// Reply-bank regression suite.
//
// For every labeled example in the seed (+ harvested) bank, replays its
// inbound through handleCreatorReply and asserts the predicted action +
// quoted_rate match the label. This is the "test cases from past threads"
// loop the team uses to verify a prompt change didn't regress on real
// historical replies.
//
// Two modes:
//   - stubbed (default): a fake Anthropic client returns the labeled JSON
//     for each example. This proves the wiring around the Claude call
//     (prompt build, JSON parse, action routing) is correct without
//     burning API credits.
//   - live (RUN_LIVE_CLAUDE=1 + ANTHROPIC_API_KEY): actually round-trips
//     through Claude using the labeled inbound as the user turn and the
//     other examples as few-shot context. Reports per-action accuracy.
//
// Run with:   npm test
//             RUN_LIVE_CLAUDE=1 ANTHROPIC_API_KEY=... npm test

const test = require('node:test');
const assert = require('node:assert');
const negotiation = require('./negotiation');
const replyExamples = require('./replyExamples');

function fakeClientReturning(jsonStr) {
  return {
    messages: {
      create: async () => ({
        content: [{ type: 'text', text: jsonStr }],
      }),
    },
  };
}

// Minimal creator + ctx so handleCreatorReply has what it needs.
function ctxFor(stage) {
  return {
    firstName: 'Alex',
    brandName: 'Acme',
    campaignName: 'Acme Q3',
    cadence: '1-2 videos per week',
    managerName: 'Jennifer',
    refs: '@a, @b',
    maxCpm: 15,
    stage,
    hasStats: true,
    approvedOffer: null,
    guidelines: '',
  };
}

test('every seed example replays cleanly through handleCreatorReply (stubbed)', async () => {
  const examples = replyExamples.loadAll();
  assert.ok(examples.length > 0, 'seed bank must be populated');

  let passed = 0;
  const failures = [];

  for (const ex of examples) {
    negotiation._setClient(fakeClientReturning(replyExamples.exampleToAssistantJson(ex)));
    try {
      const result = await negotiation.handleCreatorReply(
        { id: 'test', first_name: 'Alex' },
        ex.inbound,
        ctxFor(ex.stage),
      );
      assert.strictEqual(
        result.action,
        ex.expected_action,
        `${ex.id}: expected action=${ex.expected_action}, got ${result.action}`,
      );
      assert.strictEqual(
        result.quoted_rate,
        ex.expected_quoted_rate,
        `${ex.id}: expected quoted_rate=${ex.expected_quoted_rate}, got ${result.quoted_rate}`,
      );
      passed += 1;
    } catch (err) {
      failures.push(`${ex.id}: ${err.message}`);
    }
  }

  negotiation._setClient(undefined); // restore lazy init for any later tests
  if (failures.length) assert.fail(`${failures.length} example(s) failed:\n${failures.join('\n')}`);
  assert.strictEqual(passed, examples.length);
});

// Live mode — runs only when explicitly requested. Useful for "did the prompt
// change actually improve / regress accuracy?" sweeps.
test('live: action prediction accuracy on seed bank', { skip: !process.env.RUN_LIVE_CLAUDE }, async () => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return assert.fail('RUN_LIVE_CLAUDE=1 requires ANTHROPIC_API_KEY');
  }
  negotiation._setClient(undefined); // real client

  const examples = replyExamples.loadAll();
  let correct = 0;
  let total = 0;
  const perAction = new Map();
  const wrong = [];

  for (const ex of examples) {
    // Hold out the current example from the few-shot pool so it can't see its
    // own label. Done by mutating the in-memory cache for the duration of the
    // call, then restoring.
    const pool = examples.filter((e) => e.id !== ex.id);
    const origPick = replyExamples.pickExamplesFor;
    replyExamples.pickExamplesFor = (text, opts) =>
      origPick.call(replyExamples, text, { ...opts, pool });

    let predicted = null;
    try {
      const result = await negotiation.handleCreatorReply(
        { id: 'test', first_name: 'Alex' },
        ex.inbound,
        ctxFor(ex.stage),
      );
      predicted = result.action;
    } finally {
      replyExamples.pickExamplesFor = origPick;
    }

    total += 1;
    const ok = predicted === ex.expected_action;
    if (ok) correct += 1;
    else wrong.push(`${ex.id}: expected=${ex.expected_action} got=${predicted}`);
    const rec = perAction.get(ex.expected_action) || { ok: 0, n: 0 };
    rec.n += 1;
    if (ok) rec.ok += 1;
    perAction.set(ex.expected_action, rec);
  }

  console.log(`\n[live eval] overall: ${correct}/${total} (${Math.round((correct / total) * 100)}%)`);
  for (const [action, { ok, n }] of perAction) {
    console.log(`[live eval]   ${action}: ${ok}/${n}`);
  }
  if (wrong.length) console.log(`[live eval] misses:\n  ${wrong.join('\n  ')}`);

  // Treat <70% as a regression. Tune as the bank grows.
  assert.ok(correct / total >= 0.7, `accuracy ${correct}/${total} below 70% threshold`);
});
