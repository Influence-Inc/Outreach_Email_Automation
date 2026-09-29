'use strict';

// Run with: npm test  (node --test)
const test = require('node:test');
const assert = require('node:assert');
const db = require('../db');
const { listCampaigns, addScoutedCreator, buildNote } = require('./scoutedCreators');

const origOne = db.one;
const origMany = db.many;

// A fake db.one that answers by SQL shape, recording every call. `campaign` is
// the campaigns row (or null), `existing` the creators row an earlier add left.
function fakeDb({ campaign = { id: 'camp-1', name: 'Summer', brand_name: 'Acme' }, existing = null } = {}) {
  const calls = [];
  db.one = async (sql, params) => {
    calls.push({ sql, params });
    if (/FROM campaigns WHERE id/.test(sql)) return campaign;
    if (/FROM creators/.test(sql) && /SELECT id, status/.test(sql)) return existing;
    if (/INSERT INTO creators/.test(sql)) return { id: 42, status: 'pending_extraction' };
    throw new Error(`unexpected SQL: ${sql}`);
  };
  return calls;
}

test.afterEach(() => {
  db.one = origOne;
  db.many = origMany;
});

test('adds a new scouted creator to the campaign as pending_extraction', async () => {
  const calls = fakeDb();
  const out = await addScoutedCreator({
    campaignId: 'camp-1',
    username: '@Mery.Creates',
    fullName: 'Mery',
    scoutName: 'Priya',
    reelLinks: ['https://www.instagram.com/reel/abc'],
    sourceRef: 'entry-9',
  });

  assert.strictEqual(out.created, true);
  assert.strictEqual(out.creator.id, 42);
  assert.strictEqual(out.campaign.brand_name, 'Acme');

  const insert = calls.find((c) => /INSERT INTO creators/.test(c.sql));
  // Same shape the manual add produces, so the existing pipeline takes over.
  assert.match(insert.sql, /pending_extraction/);
  assert.strictEqual(insert.params[0], 'camp-1');
  assert.strictEqual(insert.params[1], 'https://www.instagram.com/Mery.Creates/');
  assert.match(insert.params[5], /Scouted by Priya/);
  assert.match(insert.params[5], /reel\/abc/);
  const via = JSON.parse(insert.params[6]);
  assert.deepStrictEqual(via, {
    mode: 'scouting',
    scout: 'Priya',
    reelLinks: ['https://www.instagram.com/reel/abc'],
    creatorDbEntryId: 'entry-9',
  });
});

test('returns the existing row instead of adding a second one', async () => {
  const calls = fakeDb({ existing: { id: 7, status: 'outreach_sent', instagram_username: 'mery' } });
  const out = await addScoutedCreator({ campaignId: 'camp-1', username: 'MERY' });

  // A re-promote or a retry is a success, and must never touch the row the
  // campaign is already working — least of all reset its outreach status.
  assert.strictEqual(out.created, false);
  assert.strictEqual(out.creator.id, 7);
  assert.strictEqual(out.creator.status, 'outreach_sent');
  assert.ok(!calls.some((c) => /INSERT INTO creators/.test(c.sql)));

  const lookup = calls.find((c) => /FROM creators/.test(c.sql));
  // Matched on handle case-insensitively as well as exact URL, and ignoring
  // rows already flagged as duplicates.
  assert.match(lookup.sql, /LOWER\(instagram_username\) = LOWER\(\$3\)/);
  assert.match(lookup.sql, /status <> 'duplicate'/);
});

test('refuses an unknown campaign with a distinguishable error', async () => {
  fakeDb({ campaign: null });
  await assert.rejects(
    () => addScoutedCreator({ campaignId: 'gone', username: 'mery' }),
    (err) => err.code === 'NO_CAMPAIGN',
  );
});

test('requires both a campaign and a handle', async () => {
  fakeDb();
  await assert.rejects(
    () => addScoutedCreator({ campaignId: 'camp-1', username: '  @ ' }),
    (err) => err.code === 'BAD_REQUEST',
  );
  await assert.rejects(
    () => addScoutedCreator({ campaignId: '', username: 'mery' }),
    (err) => err.code === 'BAD_REQUEST',
  );
});

test('lists every campaign, ordered for a picker', async () => {
  let sql;
  db.many = async (s) => {
    sql = s;
    return [{ id: 'c1', name: 'Summer', brand_name: 'Acme' }];
  };
  const rows = await listCampaigns();
  assert.strictEqual(rows.length, 1);
  assert.match(sql, /ORDER BY LOWER\(brand_name\), LOWER\(name\)/);
});

test('the note names the scout and carries the reel to replicate', () => {
  assert.strictEqual(
    buildNote({ scoutName: 'Priya', reelLinks: [] }),
    'Scouted by Priya via the Creator Database',
  );
  assert.strictEqual(
    buildNote({ scoutName: null, reelLinks: ['https://x/reel/1', ''] }),
    'Scouted by a scout via the Creator Database · Reel to replicate: https://x/reel/1',
  );
});
