'use strict';

// Run with: npm test  (node --test)
//
// Guards duplicate-creator detection — the check that keeps a creator already
// being reached out to in a campaign from being enrolled a SECOND time (which
// would send the outreach email twice). Behaviours that matter:
//   1. Matches an existing row case-insensitively by Instagram handle.
//   2. Matches by email when the handle differs.
//   3. Ignores the exact same URL (that's an idempotent re-add, not a dup) and
//      rows already flagged 'duplicate'.
//   4. Returns null with nothing to match on.
const test = require('node:test');
const assert = require('node:assert');
const db = require('../db');
const { findDuplicateCreator, duplicateMatchReason } = require('./duplicateGuard');

const origOne = db.one;
function restore() {
  db.one = origOne;
}

test('findDuplicateCreator matches an existing handle case-insensitively and excludes the exact URL', async () => {
  let captured;
  db.one = async (sql, params) => {
    captured = { sql, params };
    return { id: 11, instagram_username: 'JohnDoe', email: null, instagram_url: 'https://www.instagram.com/JohnDoe/' };
  };
  try {
    const dup = await findDuplicateCreator({
      campaignId: 'camp-1',
      username: 'johndoe',
      email: null,
      excludeUrl: 'https://www.instagram.com/johndoe/',
    });
    assert.ok(dup, 'a duplicate is returned');
    assert.strictEqual(dup.id, 11);
    // The query filters out rows already flagged duplicate and the exact URL.
    assert.match(captured.sql, /status <> 'duplicate'/);
    assert.match(captured.sql, /instagram_url <> \$2/);
    assert.strictEqual(captured.params[0], 'camp-1');
    assert.strictEqual(captured.params[1], 'https://www.instagram.com/johndoe/');
    assert.strictEqual(captured.params[2], 'johndoe');
  } finally {
    restore();
  }
});

test('findDuplicateCreator returns null when there is nothing to match on', async () => {
  let called = false;
  db.one = async () => {
    called = true;
    return null;
  };
  try {
    const dup = await findDuplicateCreator({ campaignId: 'camp-1', username: null, email: null });
    assert.strictEqual(dup, null);
    assert.strictEqual(called, false, 'no DB query is issued without a handle or email');
  } finally {
    restore();
  }
});

test('findDuplicateCreator returns null without a campaign id', async () => {
  db.one = async () => ({ id: 1 });
  try {
    const dup = await findDuplicateCreator({ campaignId: null, username: 'x', email: 'x@y.com' });
    assert.strictEqual(dup, null);
  } finally {
    restore();
  }
});

test('duplicateMatchReason reports handle vs email', () => {
  assert.strictEqual(
    duplicateMatchReason({ username: 'johndoe', dup: { instagram_username: 'JohnDoe' } }),
    'handle',
  );
  assert.strictEqual(
    duplicateMatchReason({ username: 'someoneelse', dup: { instagram_username: 'JohnDoe' } }),
    'email',
  );
  assert.strictEqual(
    duplicateMatchReason({ username: null, dup: { instagram_username: null } }),
    'email',
  );
});
