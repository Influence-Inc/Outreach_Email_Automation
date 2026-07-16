'use strict';

// One-off repair: clear off-Instagram *enrichment* emails that are actually a
// third-party brand's, not the creator's.
//
// Background: the email-enrichment fallback follows a creator's bio links to
// find a contact address. Some of those links are SPONSORED third-party brands
// the creator promotes, so enrichment sometimes scraped the brand's address
// instead of the creator's — e.g. support@higgsfield.ai, support@mail.pippit.ai,
// pxvbusiness@gmail.com (off a promoted brand's page). The scrape/enrich code
// now filters these out (see services/emailEnrich.js: isCreatorContactEmail),
// but rows enriched BEFORE that fix still carry the bad address.
//
// This script re-runs the same gate over already-stored enrichment emails and
// clears the ones that no longer pass, moving the creator back to 'no_email' so
// the corrected enrichment (or a manual entry) can fill it in. It is
// deliberately conservative:
//   • only rows whose email_source is a URL (i.e. found by enrichment — the "via
//     <site>" link). Instagram-bio / contact-button / manual emails are never
//     touched.
//   • only creators who have NOT been contacted yet (outreach_sent_at IS NULL)
//     and aren't mid-deal, so we never yank an address out from under a live
//     conversation.
//   • only emails the new gate rejects (support/role mailboxes, unrelated
//     free-mail). A creator's own-brand address — even on a differently-named
//     site, e.g. yushika@birdsofparadyes.com — passes the gate and is kept.
//
// Usage:
//   node backend/scripts/fix-third-party-enriched-emails.js --dry-run   # preview
//   node backend/scripts/fix-third-party-enriched-emails.js             # apply

require('dotenv').config();
const db = require('../src/db');
const { isCreatorContactEmail, creatorTokens } = require('../src/services/emailEnrich');

function parseArgs(argv) {
  const args = { dryRun: false };
  for (const a of argv) {
    if (a === '--dry-run' || a === '-n') args.dryRun = true;
  }
  return args;
}

// Enrichment stores the exact page URL as the source (rendered as a "via <site>"
// link). Anything starting with http(s) is an enrichment email; Instagram /
// manual sources are short keywords ('instagram_contact', 'manual', …).
const ENRICHED_WHERE = `
      email IS NOT NULL
      AND email <> ''
      AND email_source ILIKE 'http%'
      AND outreach_sent_at IS NULL
      AND status IN ('email_found', 'no_email', 'invalid_email')`;

async function main() {
  const { dryRun } = parseArgs(process.argv.slice(2));

  const rows = await db.many(
    `SELECT id, instagram_username, full_name, email, email_source, status
       FROM creators
      WHERE ${ENRICHED_WHERE}
      ORDER BY id`,
    [],
  );

  const bad = rows.filter((r) => {
    const tokens = creatorTokens({
      fullName: r.full_name,
      instagramUsername: r.instagram_username,
    });
    return !isCreatorContactEmail(r.email, { tokens });
  });

  console.log(
    `Scanned ${rows.length} enrichment-sourced, un-contacted creator(s); ` +
      `${bad.length} carry a third-party / role address:`,
  );
  for (const r of bad) {
    let via = r.email_source;
    try { via = new URL(r.email_source).hostname.replace(/^www\./, ''); } catch { /* keep raw */ }
    console.log(
      `  creator ${r.id} @${r.instagram_username || '?'} — ${r.email} (via ${via}), status=${r.status}`,
    );
  }

  if (!bad.length) {
    console.log('Nothing to clean up.');
    process.exit(0);
  }

  if (dryRun) {
    console.log('\n--dry-run: no changes written.');
    process.exit(0);
  }

  let cleared = 0;
  for (const r of bad) {
    await db.query(
      `UPDATE creators
          SET email = NULL,
              email_source = NULL,
              status = CASE WHEN status = 'email_found' THEN 'no_email' ELSE status END,
              updated_at = NOW()
        WHERE id = $1`,
      [r.id],
    );
    await db.query(
      `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'email_cleared', $2)`,
      [r.id, { reason: 'third_party_enriched', email: r.email, source: r.email_source }],
    );
    cleared += 1;
  }

  console.log(`\n✓ Cleared ${cleared} third-party enrichment email(s); those creators are back to no_email.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[fix-third-party-enriched-emails] fatal:', err);
  process.exit(1);
});
