'use strict';

const test = require('node:test');
const assert = require('node:assert');
const labels = require('./audienceLabels');

test('a creator\'s target viewer comes from Claude, tidied to one line', async () => {
  let asked = null;
  const call = async (system, messages) => { asked = messages[0].content; return '"27 y/o AI developer in New York."'; };
  const line = await labels.targetViewer({ username: 'ai.dev', summary: 'Technology · AI', caption: 'building agents', transcript: 'today we ship' }, { call });
  assert.strictEqual(line, '27 y/o AI developer in New York');
  assert.match(asked, /Technology · AI/);
  assert.match(asked, /building agents/);
});

test('without Claude it falls back to Jev\'s labels, and to nothing when there is nothing', async () => {
  const call = async () => null;
  assert.strictEqual(await labels.targetViewer({ summary: 'Fitness · Gym & strength' }, { call }), 'Viewers into Fitness · Gym & strength');
  assert.strictEqual(await labels.targetViewer({ username: 'x' }, { call }), null);
  const boom = async () => { throw new Error('down'); };
  assert.strictEqual(await labels.targetViewer({ summary: 'Food' }, { call: boom }), 'Viewers into Food');
});
