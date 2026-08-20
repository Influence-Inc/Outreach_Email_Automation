'use strict';

// Creator-Database owns the creator's NAME. A creator imported as "cockroach
// janta party" was showing in the Deal Studio — and being greeted in offer
// emails and WhatsApp messages — as "Jafar", the name on their Instagram
// profile, because the profile scrape overwrote the imported value. These pin
// the reconciliation that repairs such rows from the Creator-DB record the
// categorize pass already fetched. DB is stubbed; no Postgres.

const test = require('node:test');
const assert = require('node:assert');
const db = require('../db');
const { namesFromCreatorDb, nameDrift, syncCreatorNames } = require('./creatorNameSync');

const origQuery = db.query;

function install() {
  const writes = [];
  db.query = async (sql, params) => {
    writes.push({ sql, params });
    return { rows: [], rowCount: 1 };
  };
  return writes;
}
function restore() {
  db.query = origQuery;
}

test('namesFromCreatorDb splits the master name into full + leading token', () => {
  assert.deepStrictEqual(namesFromCreatorDb('cockroach janta party'), {
    fullName: 'cockroach janta party',
    firstName: 'cockroach',
  });
  // Collapsed whitespace, so a padded master record doesn't look like drift.
  assert.deepStrictEqual(namesFromCreatorDb('  Ana   Maria  '), {
    fullName: 'Ana Maria',
    firstName: 'Ana',
  });
  assert.strictEqual(namesFromCreatorDb(''), null);
  assert.strictEqual(namesFromCreatorDb(null), null);
});

test('nameDrift reports a correction only when the row actually disagrees', () => {
  const master = 'cockroach janta party';
  assert.deepStrictEqual(nameDrift({ full_name: 'Jafar', first_name: 'Jafar' }, master), {
    fullName: master,
    firstName: 'cockroach',
  });
  // Already correct → no write.
  assert.strictEqual(nameDrift({ full_name: master, first_name: 'cockroach' }, master), null);
  // Case and padding are cosmetic, not drift — otherwise every list load writes.
  assert.strictEqual(
    nameDrift({ full_name: 'Cockroach Janta Party', first_name: 'COCKROACH' }, master),
    null,
  );
});

test('the reported case: an IG-scraped name is replaced by the Creator-DB name', async () => {
  const writes = install();
  try {
    const rows = [
      {
        id: 1093,
        full_name: 'Jafar',
        first_name: 'Jafar',
        creator_db_ref: { id: 'cdb_1', creatorName: 'cockroach janta party' },
      },
    ];
    const fixed = await syncCreatorNames(rows);
    assert.strictEqual(fixed, 1);
    assert.strictEqual(writes.length, 1, 'one batched UPDATE');
    assert.match(writes[0].sql, /UPDATE creators/i);
    assert.deepStrictEqual(writes[0].params[0], [1093]);
    assert.deepStrictEqual(writes[0].params[1], ['cockroach janta party']);
    assert.deepStrictEqual(writes[0].params[2], ['cockroach']);
    // The row the dashboard renders is corrected too, not left stale.
    assert.strictEqual(rows[0].full_name, 'cockroach janta party');
    assert.strictEqual(rows[0].first_name, 'cockroach');
  } finally {
    restore();
  }
});

test('a creator with no Creator-DB match is left alone', async () => {
  const writes = install();
  try {
    const rows = [{ id: 7, full_name: 'Jafar', first_name: 'Jafar', creator_db_ref: null }];
    assert.strictEqual(await syncCreatorNames(rows), 0);
    assert.strictEqual(writes.length, 0, 'no write for a creator we do not own a master record for');
    assert.strictEqual(rows[0].full_name, 'Jafar');
  } finally {
    restore();
  }
});

test('a master record with no name never blanks a row', async () => {
  const writes = install();
  try {
    const rows = [
      { id: 8, full_name: 'Jafar', first_name: 'Jafar', creator_db_ref: { id: 'x', creatorName: null } },
      { id: 9, full_name: 'Ana', first_name: 'Ana', creator_db_ref: { id: 'y', creatorName: '   ' } },
    ];
    assert.strictEqual(await syncCreatorNames(rows), 0);
    assert.strictEqual(writes.length, 0);
  } finally {
    restore();
  }
});

test('rows already in sync cost no write at all', async () => {
  const writes = install();
  try {
    const rows = [
      { id: 1, full_name: 'Ana Maria', first_name: 'Ana', creator_db_ref: { creatorName: 'Ana Maria' } },
      { id: 2, full_name: 'Bo Li', first_name: 'Bo', creator_db_ref: { creatorName: 'Bo Li' } },
    ];
    assert.strictEqual(await syncCreatorNames(rows), 0);
    assert.strictEqual(writes.length, 0);
  } finally {
    restore();
  }
});

test('several drifted rows are corrected in one statement', async () => {
  const writes = install();
  try {
    const rows = [
      { id: 1, full_name: 'Wrong', first_name: 'Wrong', creator_db_ref: { creatorName: 'Ana Maria' } },
      { id: 2, full_name: 'Bo Li', first_name: 'Bo', creator_db_ref: { creatorName: 'Bo Li' } },
      { id: 3, full_name: null, first_name: null, creator_db_ref: { creatorName: 'Chen Wu' } },
    ];
    assert.strictEqual(await syncCreatorNames(rows), 2);
    assert.strictEqual(writes.length, 1, 'batched, not one query per row');
    assert.deepStrictEqual(writes[0].params[0], [1, 3]);
    assert.deepStrictEqual(writes[0].params[1], ['Ana Maria', 'Chen Wu']);
    assert.deepStrictEqual(writes[0].params[2], ['Ana', 'Chen']);
  } finally {
    restore();
  }
});

test('an empty batch does no work', async () => {
  const writes = install();
  try {
    assert.strictEqual(await syncCreatorNames([]), 0);
    assert.strictEqual(await syncCreatorNames(null), 0);
    assert.strictEqual(writes.length, 0);
  } finally {
    restore();
  }
});
