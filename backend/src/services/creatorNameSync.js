'use strict';

// Creator-Database is the source of truth for a creator's NAME.
//
// A creators row can pick a name up from three places: the Creator-DB import,
// the Instagram profile scrape, and a manual dashboard edit. The scrape used to
// win unconditionally (`full_name = COALESCE(scraped, full_name)` takes the
// scraped value whenever there is one), so a creator imported from Creator-DB
// as "cockroach janta party" was silently rewritten to whatever their Instagram
// profile happened to say — and every offer email and WhatsApp message then
// greeted the wrong person, because firstNameOf() reads exactly those columns.
//
// This reconciles dashboard rows against the Creator-DB master records that the
// categorize pass has ALREADY fetched (routes/creators.js attachCategories), so
// a drifted row is repaired during an ordinary list load: no migration, no
// backfill job, and no extra round-trip to Creator-DB.
//
// Rows with no Creator-DB match ('new' creators, whose only name source is the
// scrape) are left untouched.

const db = require('../db');

// Split a Creator-DB creatorName into the pair the creators table stores.
// first_name is the leading token — the same derivation firstNameOf() applies to
// full_name, and the same one the Deal Studio import already sends, so a synced
// row greets identically however the name is read back.
function namesFromCreatorDb(creatorName) {
  const full = String(creatorName || '').trim().replace(/\s+/g, ' ');
  if (!full) return null;
  return { fullName: full, firstName: full.split(' ')[0] };
}

// The corrected names when this row disagrees with the master record, else null.
// Compared case-insensitively on trimmed values so a cosmetic difference doesn't
// trigger a pointless write on every page load.
function nameDrift(row, creatorName) {
  const names = namesFromCreatorDb(creatorName);
  if (!names) return null;
  const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  if (same(row.full_name, names.fullName) && same(row.first_name, names.firstName)) return null;
  return names;
}

// Repair every drifted row in one statement, and mirror the corrected values
// onto the row objects so the payload the dashboard renders matches what was
// just stored (rather than showing the stale name until the next refresh).
// Returns the number of rows corrected.
async function syncCreatorNames(rows) {
  const fixes = [];
  for (const row of rows || []) {
    const ref = row && row.creator_db_ref;
    if (!ref || !ref.creatorName) continue;
    const names = nameDrift(row, ref.creatorName);
    if (names) fixes.push({ row, names });
  }
  if (!fixes.length) return 0;

  await db.query(
    `UPDATE creators AS c
        SET full_name = v.full_name, first_name = v.first_name, updated_at = NOW()
       FROM (SELECT unnest($1::int[]) AS id,
                    unnest($2::text[]) AS full_name,
                    unnest($3::text[]) AS first_name) AS v
      WHERE c.id = v.id`,
    [
      fixes.map((f) => f.row.id),
      fixes.map((f) => f.names.fullName),
      fixes.map((f) => f.names.firstName),
    ],
  );

  for (const { row, names } of fixes) {
    row.full_name = names.fullName;
    row.first_name = names.firstName;
  }
  console.log(
    `[creator-name-sync] corrected ${fixes.length} creator name(s) from Creator-DB: ` +
      fixes.map((f) => `${f.row.id}→"${f.names.fullName}"`).join(', '),
  );
  return fixes.length;
}

module.exports = { namesFromCreatorDb, nameDrift, syncCreatorNames };
