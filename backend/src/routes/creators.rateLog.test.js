'use strict';

// Timeline label composition for the Rate column. rateLogEntry is pure (no DB),
// exposed on the router the same way routes/webhook.js exposes its helpers.

const test = require('node:test');
const assert = require('node:assert');

const { rateLogEntry, collapseSupersededSteps } = require('./creators');

// ── replies summarize what was said, never a bare "Creator replied" ─────────

test('replied quotes a super-short gist of the creator message', () => {
  const entry = rateLogEntry('replied', null, "Hi Jennifer, this sounds great! When can we start?");
  assert.strictEqual(entry.text, 'Replied: “this sounds great!”');
  assert.strictEqual(entry.tone, 'done');
});

test('replied prefers the Claude summary over the deterministic gist', () => {
  const entry = rateLogEntry(
    'replied',
    null,
    'The price is listed in my media kit: $1,600 per video. Unfortunately, my schedule is fully booked for July.',
    '$1,600 per video, available early August, 50% upfront with approval before publishing',
  );
  assert.strictEqual(
    entry.text,
    'Replied: “$1,600 per video, available early August, 50% upfront with approval before publishing”',
  );
});

test('sent replies prefer the Claude summary too', () => {
  assert.strictEqual(
    rateLogEntry('sent_manual_reply', {}, 'Hey! We can do $3,000 for two reels.', 'offered $3,000 for two reels').text,
    'Sent: “offered $3,000 for two reels”',
  );
});

test('replied falls back to the plain label only when no message is on file', () => {
  assert.strictEqual(rateLogEntry('replied', null, null).text, 'Creator replied');
  assert.strictEqual(rateLogEntry('replied', null, '   ').text, 'Creator replied');
});

test('a sent delegate / manual reply quotes what we sent', () => {
  assert.strictEqual(
    rateLogEntry('sent_delegate_reply', {}, 'Hey! We can do $3,000 for two reels.').text,
    'Sent: “We can do $3,000 for two reels.”',
  );
  assert.strictEqual(
    rateLogEntry('sent_manual_reply', {}, null).text,
    'Manual reply sent',
  );
});

// ── quoted rates spell out the deliverable ──────────────────────────────────

test('a single quoted rate names the deliverable it covers', () => {
  const msg = 'Thanks for reaching out! My rate is $3,500 for 300,000 combined views.';
  const entry = rateLogEntry('rate_quoted', { to: 3500, by: 'creator', options: null }, msg);
  assert.strictEqual(entry.text, 'Creator quoted $3,500 for 300,000 combined views');
});

test('a single quoted rate degrades to just the amount when no deliverable is stated', () => {
  const entry = rateLogEntry('rate_quoted', { to: 3500, by: 'creator', options: null }, 'My rate is $3,500.');
  assert.strictEqual(entry.text, 'Creator quoted $3,500');
});

test('multiple quoted rates stay collapsed with their per-option deliverables', () => {
  const detail = {
    to: 3500,
    by: 'creator',
    options: [
      { amount: 3500, label: '$3,500 for 300,000 combined views' },
      { amount: 5000, label: '$5,000 for 600,000 combined views' },
    ],
  };
  const entry = rateLogEntry('rate_quoted', detail, null);
  assert.strictEqual(entry.text, 'Creator quoted rates');
  assert.strictEqual(entry.options.length, 2);
  assert.strictEqual(entry.options[1].label, '$5,000 for 600,000 combined views');
});

// ── "Outreach queued" collapses into "Outreach sent" once the send lands ─────

test('the queued step is dropped once outreach has been sent', () => {
  const log = [
    { type: 'outreach_queued', text: 'Outreach queued' },
    { type: 'sent_outreach', text: 'Outreach sent' },
  ];
  const collapsed = collapseSupersededSteps(log);
  assert.deepStrictEqual(collapsed.map((e) => e.type), ['sent_outreach']);
});

test('the queued step stays while outreach is still pending', () => {
  const log = [{ type: 'outreach_queued', text: 'Outreach queued' }];
  const collapsed = collapseSupersededSteps(log);
  assert.deepStrictEqual(collapsed.map((e) => e.type), ['outreach_queued']);
});

test('collapsing keeps every later step and returns a fresh array', () => {
  const log = [
    { type: 'outreach_queued', text: 'Outreach queued' },
    { type: 'sent_outreach', text: 'Outreach sent' },
    { type: 'sent_followup', text: 'Follow-up sent' },
    { type: 'replied', text: 'Replied: “sounds great”' },
  ];
  const collapsed = collapseSupersededSteps(log);
  assert.deepStrictEqual(collapsed.map((e) => e.type), ['sent_outreach', 'sent_followup', 'replied']);
  assert.notStrictEqual(collapsed, log);
});
