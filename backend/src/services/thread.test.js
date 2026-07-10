'use strict';

// Run with: npm test  (node --test)
// Covers the pure transcript rendering. recordMessage / loadThread are DB-backed
// and exercised by the end-to-end verification against a real Postgres.
const test = require('node:test');
const assert = require('node:assert');

const thread = require('./thread');

test('renderTranscript labels each turn by speaker, oldest first', () => {
  const out = thread.renderTranscript([
    { direction: 'outbound', body: 'We cross-post to Instagram, TikTok & YouTube Shorts.' },
    { direction: 'inbound', body: "I'll post on Reels, TikTok and YouTube Shorts." },
  ]);
  assert.match(out, /\[MANAGER\]\n.*Instagram, TikTok & YouTube Shorts/);
  assert.match(out, /\[CREATOR\]\n.*Reels, TikTok and YouTube Shorts/);
  // Manager turn comes before the creator turn (order preserved).
  assert.ok(out.indexOf('[MANAGER]') < out.indexOf('[CREATOR]'));
});

test('renderTranscript skips blank bodies and handles an empty thread', () => {
  assert.strictEqual(thread.renderTranscript([]), '');
  assert.strictEqual(thread.renderTranscript(null), '');
  const out = thread.renderTranscript([
    { direction: 'inbound', body: '   ' },
    { direction: 'inbound', body: 'Real message' },
  ]);
  assert.strictEqual(out, '[CREATOR]\nReal message');
});

test('renderTranscript keeps the most recent messages when over budget', () => {
  const messages = [
    { direction: 'inbound', body: 'OLDEST-MARKER ' + 'x'.repeat(200) },
    { direction: 'inbound', body: 'NEWEST-MARKER latest terms here' },
  ];
  const out = thread.renderTranscript(messages, { maxChars: 60 });
  assert.ok(out.length <= 60 + 40, 'stays within budget (plus the elision note)');
  assert.match(out, /NEWEST-MARKER/, 'keeps the newest turn');
  assert.doesNotMatch(out, /OLDEST-MARKER/, 'drops the oldest turn');
  assert.match(out, /earlier messages omitted/);
});
