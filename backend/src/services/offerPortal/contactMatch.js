'use strict';

// Single source of truth for "which creator row does this inbound number belong
// to?" Both the live inbound webhook (routes/offerWebhook.js) and the diagnostic
// endpoint (GET /api/debug/messaging-inbound, see diagnose.js) resolve senders
// through here, so a diagnosis can never disagree with what the webhook would
// actually do with the same number.

const db = require('../../db');
const { normalizePhone } = require('./whatsapp');

// The only columns a sender can be matched on. Whitelisted because the column
// name is interpolated into SQL below and diagnose.js exposes the channel over
// HTTP.
const CONTACT_COLUMNS = new Set(['whatsapp', 'imessage']);

function assertContactColumn(column) {
  if (!CONTACT_COLUMNS.has(column)) throw new Error(`unsupported contact column: ${column}`);
  return column;
}

// Providers report the sender with or without a country code depending on how
// the creator's number is registered, so an exact bare-digits compare alone
// misses real matches. The last-10 fallback is deliberately loose for that
// reason — `matchedOn` records which rule fired, so a fragile suffix-only match
// stays visible in diagnostics instead of looking like a clean hit.
const tailOf = (digits) => String(digits || '').slice(-10);

// Pick the row whose `contact` matches fromDigits, reporting HOW it matched: an
// exact bare-digits hit wins immediately, else the first last-10-digits suffix
// hit. Returns { row, matchedOn: 'exact' | 'suffix' } or null.
function pickMatchDetailed(rows, fromDigits) {
  const wanted = normalizePhone(fromDigits);
  if (!wanted) return null;
  const wantedTail = tailOf(wanted);
  let suffix = null;
  for (const r of rows || []) {
    const digits = normalizePhone(r.contact);
    if (!digits) continue;
    if (digits === wanted) return { row: r, matchedOn: 'exact' };
    if (wantedTail && tailOf(digits) === wantedTail) suffix = suffix || { row: r, matchedOn: 'suffix' };
  }
  return suffix;
}

// Row-only form — the shape offerWebhook.js has always used.
function pickMatch(rows, fromDigits) {
  const hit = pickMatchDetailed(rows, fromDigits);
  return hit ? hit.row : null;
}

// Every creator carrying a number on the given channel column. Kept here rather
// than inline in the webhook so the diagnostic reads the SAME candidate set —
// notably the `IS NOT NULL` filter, which is why a creator with no number on
// file is invisible to inbound matching however correct the rest of the setup is.
function loadContactRows(contactColumn) {
  const column = assertContactColumn(contactColumn);
  return db.many(
    `SELECT id, whatsapp, imessage, first_name, full_name, established_channel, instagram_url,
            messaging_opted_out, campaign_id, ${column} AS contact
     FROM creators WHERE ${column} IS NOT NULL`,
  );
}

// Step 2 of resolution: re-point a matched row to the row carrying the LIVE
// offer. This is what makes Used creators work. A Used creator has ONE ROW PER
// CAMPAIGN (schema: UNIQUE (campaign_id, instagram_url)) — same person, same
// phone, N rows — and the phone scan is unordered, so step 1 returns an
// arbitrary one, in practice an OLDER, finished campaign. The new campaign's
// pending offer hangs off a DIFFERENT creator_id, so it stays invisible: the
// brief never fires and "Hi" falls through to the generic support deflection.
//
// `persist` is what separates the live path from the diagnostic: the webhook
// backfills the number onto the live row, the read-only diagnosis does not.
// Returns { row, repointed } — `row` is the matched row when there's nothing to
// re-point to.
async function resolveLiveOfferRow(contactColumn, matched, { persist = true } = {}) {
  const column = assertContactColumn(contactColumn);
  if (!matched || !matched.instagram_url) return { row: matched, repointed: false };

  // Same person (same Instagram profile), whichever campaign row holds the
  // newest live offer. Nothing pending anywhere → keep the matched row.
  const live = await db.one(
    `SELECT c.id, c.whatsapp, c.imessage, c.first_name, c.full_name, c.established_channel,
            c.instagram_url, c.messaging_opted_out, c.campaign_id
       FROM creators c
       JOIN offers o ON o.creator_id = c.id AND o.status = 'pending'
      WHERE c.instagram_url = $1
      ORDER BY o.created_at DESC
      LIMIT 1`,
    [matched.instagram_url],
  );
  if (!live || live.id === matched.id) return { row: matched, repointed: false };

  // The live row may not have the phone yet — the Creator-DB backfill that fills
  // it is TTL-gated (see segmentation.segmentCreators), so a freshly added
  // campaign row can be blank for hours. Carry the number over (and persist it,
  // so later inbounds match this row directly) or the reply has no destination
  // and sendOfferBriefing bails with no_contact_for_channel.
  if (!live[column] && matched[column]) {
    live[column] = matched[column];
    if (persist) {
      try {
        await db.query(
          `UPDATE creators SET ${column} = COALESCE(${column}, $2), updated_at = NOW()
           WHERE id = $1`,
          [live.id, matched[column]],
        );
      } catch (err) {
        console.error('[offer-webhook] contact backfill failed', err.message);
      }
    }
  }
  return { row: live, repointed: true };
}

// Resolve the inbound number to the creator ROW the conversation is actually
// about. Two steps, because one person can own several rows:
//   1. Identify the PERSON by phone (pickMatch over every row that has a number).
//   2. Re-point to the row carrying their LIVE offer (resolveLiveOfferRow).
async function matchCreator(contactColumn, fromDigits) {
  const matched = pickMatch(await loadContactRows(contactColumn), fromDigits);
  if (!matched) return matched;
  const { row } = await resolveLiveOfferRow(contactColumn, matched);
  return row;
}

module.exports = {
  CONTACT_COLUMNS,
  assertContactColumn,
  tailOf,
  pickMatch,
  pickMatchDetailed,
  loadContactRows,
  resolveLiveOfferRow,
  matchCreator,
};
