'use strict';

// Run with: npm test  (node --test)
const test = require('node:test');
const assert = require('node:assert');
const {
  loadAll,
  pickExamplesFor,
  examplesAsMessages,
  exampleToAssistantJson,
  similarity,
  ACTIONS,
} = require('./replyExamples');

test('loadAll returns the seed bank with normalized fields', () => {
  const all = loadAll();
  assert.ok(all.length >= 10, `expected ≥10 seed examples, got ${all.length}`);
  for (const ex of all) {
    assert.ok(ex.id, 'every example has an id');
    assert.ok(ex.inbound, 'every example has an inbound message');
    assert.ok(ACTIONS.includes(ex.expected_action), `unknown action ${ex.expected_action}`);
  }
  // REPLY1 template references get expanded so the assistant turn shows
  // Claude the actual canonical body, not a literal "REPLY1" string.
  const askingDetails = all.find((x) => x.id === 'seed_asking_details_01');
  assert.ok(askingDetails, 'seed bank includes the asking_details example');
  assert.ok(askingDetails.outbound_body.includes('Content Style'), 'REPLY1 body was expanded');
});

test('similarity is symmetric and non-negative; identical strings score 1', () => {
  assert.strictEqual(similarity('hello world', 'hello world'), 1);
  assert.ok(similarity('hello world', 'world hello') === 1, 'order-independent');
  assert.strictEqual(similarity('', 'anything'), 0);
  assert.ok(similarity('totally unrelated apples', 'rate is one thousand') < 0.05);
});

test('pickExamplesFor surfaces topically similar examples first', () => {
  // A rate-shaped message should land at least one shared_rate / counter shot
  // in the top results.
  const picked = pickExamplesFor('my rate is $1500 per Reel', { k: 4 });
  assert.ok(picked.length > 0, 'returns at least one example');
  const labels = picked.map((p) => p.expected_action);
  assert.ok(
    labels.includes('shared_rate') || labels.includes('counter'),
    `expected a rate-related action in ${labels.join(',')}`,
  );
});

test('pickExamplesFor caps per-action to keep the few-shot diverse', () => {
  // Even when the inbound looks like one action, we should not return 4 shots
  // of the same label — that would bias the model toward it.
  const picked = pickExamplesFor('my rate is $1500 per Reel', { k: 4, maxPerAction: 2 });
  const counts = {};
  for (const p of picked) counts[p.expected_action] = (counts[p.expected_action] || 0) + 1;
  for (const [action, n] of Object.entries(counts)) {
    assert.ok(n <= 2, `action ${action} appeared ${n} times — exceeded maxPerAction`);
  }
});

test('pickExamplesFor lightly prefers examples whose stage matches', () => {
  const inbound = 'can you do better on the rate?';
  const withStage = pickExamplesFor(inbound, { k: 4, stage: 'AWAITING_DECISION' });
  // request_counter_rate examples live at AWAITING_DECISION; at least one
  // should appear in the picks for this kind of inbound.
  const labels = withStage.map((p) => p.expected_action);
  assert.ok(
    labels.includes('request_counter_rate') || labels.includes('counter'),
    `expected counter-rate in stage-aware pick, got ${labels.join(',')}`,
  );
});

test('exampleToAssistantJson emits valid JSON in the schema handleCreatorReply expects', () => {
  const all = loadAll();
  const sample = all.find((x) => x.expected_action === 'shared_rate');
  const parsed = JSON.parse(exampleToAssistantJson(sample));
  assert.strictEqual(parsed.action, 'shared_rate');
  assert.strictEqual(typeof parsed.quoted_rate, 'number');
  assert.strictEqual(parsed.email, null, 'shared_rate sends no email');
  assert.strictEqual(parsed.send_now, false);
});

test('examplesAsMessages alternates user/assistant turns and ends on assistant', () => {
  const all = loadAll();
  const shots = pickExamplesFor('what is your rate', { k: 3 });
  const msgs = examplesAsMessages(shots);
  assert.strictEqual(msgs.length, shots.length * 2);
  for (let i = 0; i < msgs.length; i++) {
    assert.strictEqual(msgs[i].role, i % 2 === 0 ? 'user' : 'assistant');
  }
  // Assistant turns parse as JSON — that's what Claude is being shown as the
  // "correct" output for the preceding user turn.
  for (let i = 1; i < msgs.length; i += 2) {
    JSON.parse(msgs[i].content);
  }
});
