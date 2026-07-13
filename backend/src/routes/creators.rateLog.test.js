'use strict';

// Timeline label composition for the Rate column. rateLogEntry is pure (no DB),
// exposed on the router the same way routes/webhook.js exposes its helpers.

const test = require('node:test');
const assert = require('node:assert');

const { rateLogEntry } = require('./creators');

// ── replies summarize what was said, never a bare "Creator replied" ─────────

test('replied quotes a super-short gist of the creator message', () => {
  const entry = rateLogEntry('replied', null, "Hi Jennifer, this sounds great! When can we start?");
  assert.strictEqual(entry.text, 'Replied: “this sounds great!”');
  assert.strictEqual(entry.tone, 'done');
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
