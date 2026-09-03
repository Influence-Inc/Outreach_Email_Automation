'use strict';

// Email the creator their executed agreement, the moment they sign it.
//
// Covers BOTH signing flows: the full contract at /contract/:token (the
// contracts table, rendered by contractPdf.js) and the offer-portal mini
// contract at /o/:token (offers.contract_terms, rendered by miniContractPdf.js).
// A used creator's portal signature IS their contract, so they need the copy
// just as much — the two differ only in which row and renderer they come from.
//
// Until now the signed PDF (services/contractPdf.js) only existed behind the
// team's authenticated download endpoint — the creator signed, the page said
// thank you, and the copy of what they signed reached them only if someone
// remembered to download it and send it on. Creators ask for that copy days
// later, and a signature with no counter-copy is exactly the kind of loose end
// that turns into a support thread. So the signing flow now attaches the same
// PDF the team downloads and mails it straight to the signer.
//
// Two rules the rest of this file exists to keep:
//   1. Never block the signature. Everything here is best-effort and wrapped by
//      the caller — a Resend outage must not fail a POST the creator already
//      completed. The retry sweep (scheduler) picks up what the send missed.
//   2. Send the MASKED copy. renderContractPdf masks account/tax identifiers by
//      default; this copy travels by email and gets forwarded, so the default
//      is what goes out — never the `unmaskBankDetails` internal variant.

const db = require('../db');
const email = require('./offerPortal/email');
const { renderContractPdf, contractFilename } = require('./contractPdf');
const { renderMiniContractPdf, miniContractFilename, signerNameOf } = require('./miniContractPdf');

// How far back the retry sweep looks. A contract that has gone unsent for
// longer than this is not a transient failure any more (no address on file, a
// long-dead Resend key) and re-rendering it every 5 minutes forever just burns
// cycles — the team can still send it by hand from the download endpoint.
const RETRY_WINDOW_DAYS = 14;
const RETRY_BATCH = 10;
// Every attempt is audited, so a permanently unsendable contract (no address on
// file, a PDF that won't render) would otherwise log a failure row every tick
// for two weeks. Cap the attempts per contract instead: five passes is far more
// than any transient outage needs, and after that the copy is a manual send.
const MAX_ATTEMPTS = 5;

function str(value) {
  return value == null ? '' : String(value).trim();
}

// Where the copy goes. The address the creator signed with wins: it's the one
// they just typed (or confirmed) on the signing page, so it's the freshest and
// the one they expect the copy at. The contract's extracted email and the
// creator row are the fallbacks, in that order.
function recipientFor(row, creator) {
  const data = (row && row.data) || {};
  return (
    str(row && row.signer_email) ||
    str(data.email) ||
    str(creator && creator.email) ||
    ''
  );
}

// Greeting name. The creator row's own first/full name comes first — it's what
// every other email to this creator greets them by (firstNameOf in offers.js /
// graduation.js), and a copy that suddenly greets them by their full legal name
// would read as machine-generated. The signed name is the fallback.
function firstNameFor(row, creator) {
  const fromCreator =
    str(creator && creator.first_name) ||
    (str(creator && creator.full_name) ? str(creator.full_name).split(/\s+/)[0] : '');
  if (fromCreator) return fromCreator;
  const signed = str(row && row.signer_name);
  if (signed) return signed.split(/\s+/)[0];
  const data = (row && row.data) || {};
  const fromData = str(data.creatorName);
  return fromData ? fromData.split(/\s+/)[0] : 'there';
}

// Everything the send needs, resolved from the contract row (+ the creator row
// when we have it). Pure — no DB, no network — so the resolution rules above
// are testable on their own.
function buildContractCopyEmail(row, creator) {
  const data = (row && row.data) || {};
  return {
    to: recipientFor(row, creator),
    firstName: firstNameFor(row, creator),
    brandName: str(data.brandName) || str(data.brandLegalName) || str(creator && creator.brand_name) || '',
    campaignName: str(data.campaignName) || str(creator && creator.campaign_name) || '',
    filename: contractFilename(row),
  };
}

// Audit every attempt, successful or not, the way markSynced / markDashboardSynced
// do — a failure has to be findable, and the sweep below reads these rows to
// decide what still needs sending.
async function logAttempt(creatorId, token, ok, detail = {}) {
  // `kind` distinguishes the full contract from the portal mini contract on the
  // timeline and in the sweeps below; callers always set it.
  try {
    await db.query(`INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'contract_copy_emailed', $2)`, [
      creatorId,
      { token, ok: !!ok, ...detail },
    ]);
  } catch (err) {
    console.error('[contract-copy] event log failed:', err.message);
  }
}

// Has this contract's copy already gone out? Guards the double-send when a
// signing-time send succeeded and the sweep looks at the same row later.
async function alreadyEmailed(creatorId, token) {
  const hit = await db.one(
    `SELECT 1 FROM email_events
      WHERE creator_id = $1 AND type = 'contract_copy_emailed'
        AND detail->>'token' = $2 AND detail->>'ok' = 'true'
      LIMIT 1`,
    [creatorId, token],
  );
  return !!hit;
}

/**
 * Render the signed contract and email it to the creator.
 *
 * @param {object} row      a contracts row (contracts.getByToken)
 * @param {object} [creator] the creators row, when the caller already has it
 * @param {object} [opts]
 * @param {boolean} [opts.force] send even if a copy already went out (manual re-send)
 * @returns {Promise<{sent:boolean, skipped?:boolean, reason?:string, to?:string, error?:string}>}
 */
async function sendSignedContractCopy(row, creator = null, { force = false } = {}) {
  if (!row) return { sent: false, skipped: true, reason: 'no_contract' };
  // Only an executed contract has anything worth sending — a pending row would
  // mail out a document banner-stamped "not been signed yet".
  if (!row.signed_at && row.status === 'pending') {
    return { sent: false, skipped: true, reason: 'not_signed' };
  }
  if (!email.isConfigured()) {
    console.warn(`[contract-copy] RESEND_API_KEY not set — skipping copy for ${row.token}`);
    return { sent: false, skipped: true, reason: 'not_configured' };
  }
  if (!force && (await alreadyEmailed(row.creator_id, row.token))) {
    return { sent: false, skipped: true, reason: 'already_emailed' };
  }

  let c = creator;
  if (!c && row.creator_id) {
    c = await db
      .one(
        `SELECT c.id, c.first_name, c.full_name, c.email, ca.brand_name, ca.name AS campaign_name
           FROM creators c LEFT JOIN campaigns ca ON ca.id = c.campaign_id
          WHERE c.id = $1`,
        [row.creator_id],
      )
      .catch(() => null);
  }

  const { to, firstName, brandName, campaignName, filename } = buildContractCopyEmail(row, c);
  if (!to) {
    await logAttempt(row.creator_id, row.token, false, { kind: 'contract', error: 'no_email_on_file' });
    return { sent: false, skipped: true, reason: 'no_email' };
  }

  let pdf;
  try {
    // Masked copy — see the note at the top of this file.
    pdf = renderContractPdf(row);
  } catch (err) {
    await logAttempt(row.creator_id, row.token, false, { kind: 'contract', to, error: `render: ${err.message}` });
    return { sent: false, error: err.message };
  }

  const result = await email.sendSignedContractEmail({
    to,
    firstName,
    brandName,
    campaignName,
    pdf,
    filename,
  });

  await logAttempt(row.creator_id, row.token, !!result.sent, {
    kind: 'contract',
    to,
    filename,
    ...(result.sent ? { messageId: result.id || null } : { error: result.error || 'send failed' }),
  });
  return { ...result, to };
}

/**
 * Render the signed offer-portal mini contract and email it to the creator.
 *
 * Same contract as sendSignedContractCopy above (best-effort, audited, sent
 * once), against the offers row instead: there is no separate signer address —
 * a used creator is already identified — so the copy goes to the creator row's
 * email, and nothing in this document is masked because the portal never
 * collects bank or tax details.
 *
 * @param {object} offer     an offers row, joined with the creator columns when
 *                           the caller has them (first_name/full_name/email/
 *                           instagram_username/campaign_name)
 * @param {object} [creator] the creators row, when the caller already has it
 * @param {object} [opts]
 * @param {boolean} [opts.force] send even if a copy already went out
 * @returns {Promise<{sent:boolean, skipped?:boolean, reason?:string, to?:string, error?:string}>}
 */
async function sendMiniContractCopy(offer, creator = null, { force = false } = {}) {
  if (!offer) return { sent: false, skipped: true, reason: 'no_offer' };
  if (!offer.contract_signed_at) return { sent: false, skipped: true, reason: 'not_signed' };
  if (!email.isConfigured()) {
    console.warn(`[contract-copy] RESEND_API_KEY not set — skipping mini copy for ${offer.token}`);
    return { sent: false, skipped: true, reason: 'not_configured' };
  }
  if (!force && (await alreadyEmailed(offer.creator_id, offer.token))) {
    return { sent: false, skipped: true, reason: 'already_emailed' };
  }

  // The portal query the caller passes in already carries the creator's name and
  // campaign, but not always their email — fetch what's missing rather than
  // making every call site re-shape its query.
  let c = creator;
  if (!c && !str(offer.email) && offer.creator_id) {
    c = await db
      .one(
        `SELECT c.id, c.first_name, c.full_name, c.email, c.instagram_username,
                ca.name AS campaign_name
           FROM creators c LEFT JOIN campaigns ca ON ca.id = c.campaign_id
          WHERE c.id = $1`,
        [offer.creator_id],
      )
      .catch(() => null);
  }

  // Creator columns fill the gaps in the offers row so the PDF can show the
  // handle / email rows and the campaign name.
  const row = {
    ...offer,
    email: str(offer.email) || str(c && c.email),
    instagram_username: str(offer.instagram_username) || str(c && c.instagram_username),
    campaign_name: str(offer.campaign_name) || str(c && c.campaign_name),
    first_name: str(offer.first_name) || str(c && c.first_name),
    full_name: str(offer.full_name) || str(c && c.full_name),
  };

  const to = row.email;
  if (!to) {
    await logAttempt(offer.creator_id, offer.token, false, { kind: 'mini', error: 'no_email_on_file' });
    return { sent: false, skipped: true, reason: 'no_email' };
  }

  // signerNameOf never returns empty — its own fallback is the literal
  // "Creator", which would greet someone as "Hi Creator," — so drop it here and
  // let the neutral "there" take over.
  const signed = signerNameOf(row);
  const firstName =
    str(row.first_name) ||
    (str(row.full_name) ? str(row.full_name).split(/\s+/)[0] : '') ||
    (signed === 'Creator' ? '' : signed.split(/\s+/)[0]) ||
    'there';
  const filename = miniContractFilename(row);

  let pdf;
  try {
    pdf = renderMiniContractPdf(row);
  } catch (err) {
    await logAttempt(offer.creator_id, offer.token, false, { kind: 'mini', to, error: `render: ${err.message}` });
    return { sent: false, error: err.message };
  }

  const result = await email.sendSignedContractEmail({
    to,
    firstName,
    brandName: str(row.brand_name),
    campaignName: str(row.campaign_name),
    pdf,
    filename,
  });

  await logAttempt(offer.creator_id, offer.token, !!result.sent, {
    kind: 'mini',
    to,
    filename,
    ...(result.sent ? { messageId: result.id || null } : { error: result.error || 'send failed' }),
  });
  return { ...result, to };
}

// The two clauses every sweep query shares: no delivered copy for this token
// yet, and the per-token attempt cap ($2) not yet spent. `alias` is the swept
// table's alias — it must expose `creator_id` and `token` columns.
function unsentClauses(alias) {
  return `AND NOT EXISTS (
          SELECT 1 FROM email_events e
           WHERE e.creator_id = ${alias}.creator_id
             AND e.type = 'contract_copy_emailed'
             AND e.detail->>'token' = ${alias}.token
             AND e.detail->>'ok' = 'true'
        )
        AND (
          SELECT COUNT(*) FROM email_events e2
           WHERE e2.creator_id = ${alias}.creator_id
             AND e2.type = 'contract_copy_emailed'
             AND e2.detail->>'token' = ${alias}.token
        ) < $2`;
}

/**
 * Retry sweep: signed contracts from the last RETRY_WINDOW_DAYS whose copy
 * never made it out (Resend down at signing, the key added later, a creator
 * whose address landed on the row only afterwards). Called from the scheduler
 * tick; normally matches nothing.
 *
 * @returns {Promise<{checked:number, sent:number, failed:number}>}
 */
async function retryUnsentContractCopies({ limit = RETRY_BATCH } = {}) {
  if (!email.isConfigured()) return { checked: 0, sent: 0, failed: 0 };

  const rows = await db.many(
    `SELECT c.* FROM contracts c
      WHERE c.status IN ('signed', 'completed')
        AND c.signed_at IS NOT NULL
        AND c.signed_at > NOW() - ($1 || ' days')::interval
        ${unsentClauses('c')}
      ORDER BY c.signed_at ASC
      LIMIT $3`,
    [String(RETRY_WINDOW_DAYS), MAX_ATTEMPTS, limit],
  );

  const out = { checked: rows.length, sent: 0, failed: 0 };
  for (const row of rows) {
    try {
      const res = await sendSignedContractCopy(row);
      if (res.sent) out.sent += 1;
      else if (!res.skipped) out.failed += 1;
    } catch (err) {
      out.failed += 1;
      console.error(`[contract-copy] retry failed for ${row.token}:`, err.message);
    }
  }
  if (out.sent) console.log(`[contract-copy] retry sweep sent ${out.sent} signed-contract copies`);
  return out;
}

/**
 * The same sweep over offer-portal mini contracts: signed on the portal, no
 * copy delivered. Joins the creator + campaign columns the PDF needs so a
 * retried copy renders exactly like the one sent at signing time.
 *
 * @returns {Promise<{checked:number, sent:number, failed:number}>}
 */
async function retryUnsentMiniContractCopies({ limit = RETRY_BATCH } = {}) {
  if (!email.isConfigured()) return { checked: 0, sent: 0, failed: 0 };

  const rows = await db.many(
    `SELECT o.*, cr.first_name, cr.full_name, cr.email, cr.instagram_username,
            ca.name AS campaign_name
       FROM offers o
       JOIN creators cr ON cr.id = o.creator_id
       LEFT JOIN campaigns ca ON ca.id = o.campaign_id
      WHERE o.contract_signed_at IS NOT NULL
        AND o.contract_signed_at > NOW() - ($1 || ' days')::interval
        ${unsentClauses('o')}
      ORDER BY o.contract_signed_at ASC
      LIMIT $3`,
    [String(RETRY_WINDOW_DAYS), MAX_ATTEMPTS, limit],
  );

  const out = { checked: rows.length, sent: 0, failed: 0 };
  for (const row of rows) {
    try {
      const res = await sendMiniContractCopy(row);
      if (res.sent) out.sent += 1;
      else if (!res.skipped) out.failed += 1;
    } catch (err) {
      out.failed += 1;
      console.error(`[contract-copy] mini retry failed for ${row.token}:`, err.message);
    }
  }
  if (out.sent) console.log(`[contract-copy] retry sweep sent ${out.sent} mini-contract copies`);
  return out;
}

// Both sweeps, for the scheduler tick. Each is isolated: a failure in one never
// stops the other from running.
async function retryUnsentCopies(opts = {}) {
  const full = await retryUnsentContractCopies(opts).catch((err) => {
    console.error('[contract-copy] contract sweep failed:', err.message);
    return { checked: 0, sent: 0, failed: 0 };
  });
  const mini = await retryUnsentMiniContractCopies(opts).catch((err) => {
    console.error('[contract-copy] mini sweep failed:', err.message);
    return { checked: 0, sent: 0, failed: 0 };
  });
  return {
    checked: full.checked + mini.checked,
    sent: full.sent + mini.sent,
    failed: full.failed + mini.failed,
  };
}

module.exports = {
  sendSignedContractCopy,
  sendMiniContractCopy,
  retryUnsentContractCopies,
  retryUnsentMiniContractCopies,
  retryUnsentCopies,
  // exposed for tests / reuse
  recipientFor,
  firstNameFor,
  buildContractCopyEmail,
  RETRY_WINDOW_DAYS,
  MAX_ATTEMPTS,
};
