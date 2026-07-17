#!/usr/bin/env node
'use strict';

// One-off repair: promote reopened creators who came back with an OFFER but were
// stranded as a plain reply-box hand-off in the Delegate window.
//
// Background: when a creator dismissed from Delegate (dismiss-offer → CLOSED),
// declined, or timed out replies AGAIN, surfaceReopenedReply re-opens the deal.
// An earlier build surfaced every such reply as a bare reply box, even when the
// creator was proposing a rate / asking us to price — which should open the OFFER
// CONFIGURATOR instead. The code now routes rate/offer replies to the
// configurator; this script retro-fixes the rows the old build already stranded.
//
// Signal used: the reopened hand-off stamps an exact, unique delegate_reason
// (negotiation.REOPENED_HANDOFF_REASON). Among those, we only touch creators
// whose parked message (delegate_question) actually reads as an offer — it names
// a dollar amount, or it asks US to quote first. A reopened creator who asked a
// genuine QUESTION carries the same reason but no rate, so it is left alone as a
// reply box. We also skip any creator we can't price (no view stats AND no offers
// already on the row) — there'd be nothing to configure, so the hand-off stays.
//
// For each promotable creator we compute (or keep) the priced offers, record the
// creator's quoted rate, move them to AWAITING_APPROVAL, and clear the hand-off
// flags — exactly the state the offer configurator renders from.
//
// Prereqs:  DATABASE_URL   (same env the backend uses)
//
// Usage:
//   node backend/scripts/fix-reopened-offer-delegates.js --dry-run   # preview
//   node backend/scripts/fix-reopened-offer-delegates.js             # apply

require('dotenv').config();
const db = require('../src/db');
const pricing = require('../src/services/pricing');
const negotiation = require('../src/services/negotiation');

function parseArgs(argv) {
  const args = { dryRun: false };
  for (const a of argv) {
    if (a === '--dry-run' || a === '-n') args.dryRun = true;
  }
  return args;
}

// Does this parked message read as an offer we should re-price, rather than a
// plain question? Either it names a dollar amount, or it turns the price back on
// us ("make me an offer", "what's your budget?").
function looksLikeOffer(text) {
  if (!text) return false;
  return negotiation.parseRateFromText(text) != null || negotiation.asksUsToQuoteFirst(text);
}

async function main() {
  const { dryRun } = parseArgs(process.argv.slice(2));

  // Reopened hand-offs (unique reason marker) still sitting in the reply box.
  const stranded = await db.many(
    `SELECT c.id,
            c.instagram_username,
            c.negotiation_status,
            c.delegate_question,
            c.quoted_rate,
            c.suggested_offers,
            c.ig_scraped_data,
            ca.max_cpm
       FROM creators c
       JOIN campaigns ca ON ca.id = c.campaign_id
      WHERE c.needs_human = TRUE
        AND c.delegate_reason = $1
        AND c.negotiation_status = 'AWAITING_RATE'
      ORDER BY c.id`,
    [negotiation.REOPENED_HANDOFF_REASON],
  );

  const promote = [];
  const skip = [];
  for (const c of stranded) {
    const offerLike = looksLikeOffer(c.delegate_question);
    const hasOffers = Array.isArray(c.suggested_offers) && c.suggested_offers.length > 0;
    const canPrice = !!c.ig_scraped_data || hasOffers;
    if (offerLike && canPrice) promote.push(c);
    else skip.push({ c, reason: !offerLike ? 'not an offer (plain question)' : 'nothing to price with' });
  }

  console.log(
    `Found ${stranded.length} reopened reply-box hand-off(s); ${promote.length} to promote to the offer configurator, ${skip.length} left as-is.`,
  );
  for (const s of skip) {
    console.log(
      `  · skip creator ${s.c.id} @${s.c.instagram_username || '?'} — ${s.reason}`,
    );
  }
  for (const c of promote) {
    const rate = negotiation.parseRateFromText(c.delegate_question);
    console.log(
      `  → promote creator ${c.id} @${c.instagram_username || '?'} — rate ${rate != null ? `$${rate}` : '(ask us to price)'}: "${String(c.delegate_question).slice(0, 60)}"`,
    );
  }

  if (!promote.length) {
    console.log('Nothing to promote.');
    process.exit(0);
  }
  if (dryRun) {
    console.log('\n--dry-run: no changes written.');
    process.exit(0);
  }

  let done = 0;
  for (const c of promote) {
    const rate = negotiation.parseRateFromText(c.delegate_question);
    // Prefer fresh offers computed from view stats (reflecting the new rate);
    // fall back to the offers already on the row (kept through the dismiss).
    let offers = Array.isArray(c.suggested_offers) ? c.suggested_offers : null;
    if (c.ig_scraped_data) {
      const maxCpm = c.max_cpm != null ? Number(c.max_cpm) : Number(process.env.TARGET_CPM || 15);
      offers = pricing.computeOffers(c.ig_scraped_data, maxCpm, rate != null ? Number(rate) : null);
    }
    if (!offers || !offers.length) {
      console.log(`  ! creator ${c.id}: no offers to stage after all — leaving as a hand-off.`);
      continue;
    }
    await db.query(
      `UPDATE creators
          SET suggested_offers = $2::jsonb,
              quoted_rate = COALESCE($3, quoted_rate),
              negotiation_status = 'AWAITING_APPROVAL',
              needs_human = FALSE,
              delegate_reason = NULL,
              delegate_question = NULL,
              updated_at = NOW()
        WHERE id = $1`,
      [c.id, JSON.stringify(offers), rate != null ? rate : null],
    );
    await db.query(
      `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'offer_requested', $2)`,
      [c.id, { note: 'reopened offer promoted to configurator (backfill)', rate: rate != null ? rate : null }],
    );
    done += 1;
  }
  console.log(`\n✓ Promoted ${done} reopened creator(s) to the offer configurator.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[fix-reopened-offer-delegates] fatal:', err);
  process.exit(1);
});
