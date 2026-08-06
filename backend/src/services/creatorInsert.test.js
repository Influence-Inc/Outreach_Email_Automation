'use strict';

// Run with: npm test  (node --test)
const test = require('node:test');
const assert = require('node:assert');
const db = require('../db');
const { insertPendingCreator } = require('./creatorInsert');

const origOne = db.one;

test('insertPendingCreator normalizes the handle into an IG URL + pending status', async () => {
  let captured;
  db.one = async (sql, params) => {
    captured = { sql, params };
    return { id: 7 };
  };
  try {
    const row = await insertPendingCreator({
      campaignId: 'camp-1',
      username: '@CoachA',
      fullName: 'Coach A',
    });
    assert.strictEqual(row.id, 7);
    assert.strictEqual(captured.params[0], 'camp-1');
    assert.strictEqual(captured.params[1], 'https://www.instagram.com/CoachA/');
    assert.strictEqual(captured.params[2], 'CoachA');
    assert.strictEqual(captured.params[4], 'Coach A');
    assert.match(captured.sql, /pending_extraction/);
    assert.match(captured.sql, /ON CONFLICT \(campaign_id, instagram_url\)/);
  } finally {
    db.one = origOne;
  }
});

test('insertPendingCreator requires campaign + username', async () => {
  await assert.rejects(() => insertPendingCreator({ campaignId: 'c', username: '' }));
});
