'use strict';

// Render a signed contract as a PDF the team can send back to the creator.
//
// Creators regularly ask for "a copy of what I signed", and until now the only
// artefact was the signing page itself — which hides the details form once the
// contract is executed, so there was nothing to send. This produces the
// executed copy: the same terms the creator read, plus the identity details
// they submitted and the signature they drew.
//
// On bank details: the submission carries full account credentials (account
// number / IBAN, and tax identifiers like PAN). A contract copy travels by
// email and gets forwarded, so those are masked to their last four digits by
// default. `unmaskBankDetails` produces an internal, unmasked copy for the rare
// case the team needs one — it is never the default.

const { PdfDocument } = require('./pdf/document');
const { decodeSignature } = require('./pdf/png');
const { contractSections } = require('./contractTerms');

const LABEL_WIDTH = 148;

function str(value) {
  return value == null ? '' : String(value).trim();
}

// "Signed on 4 August 2026" — a spelled-out date so there's no DD/MM vs MM/DD
// ambiguity on a document crossing borders.
function longDate(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return str(value);
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

// Keep the last four characters of an identifier, masking the rest. Short
// values are masked entirely rather than half-revealed.
function maskTail(value) {
  const s = str(value).replace(/\s+/g, '');
  if (!s) return '';
  if (s.length <= 4) return '•'.repeat(s.length);
  return `${'•'.repeat(Math.min(s.length - 4, 12))}${s.slice(-4)}`;
}

function formatAddress(address) {
  if (!address || typeof address !== 'object') return '';
  return [
    str(address.line1),
    str(address.line2),
    [str(address.city), str(address.state)].filter(Boolean).join(', '),
    str(address.zip),
    str(address.country),
  ]
    .filter(Boolean)
    .join('\n');
}

// The bank rows, in the order the signing page collects them. `mask` decides
// whether the secret identifiers are redacted.
function bankRows(bank, mask) {
  if (!bank || typeof bank !== 'object') return [];
  const secret = (v) => (mask ? maskTail(v) : str(v));
  return [
    { label: 'Account holder', value: str(bank.accountHolderName) },
    { label: 'Bank', value: str(bank.bankName) },
    { label: 'Account number', value: secret(bank.accountNumber) },
    { label: 'IBAN', value: secret(bank.iban) },
    // Routing / SWIFT / IFSC identify the bank branch, not the account — they
    // are published directory data, so they stay readable even when masked.
    { label: 'Routing number', value: str(bank.routingNumber) },
    { label: 'SWIFT / BIC', value: str(bank.swiftCode) },
    { label: 'IFSC code', value: str(bank.ifscCode) },
    { label: 'PAN number', value: secret(bank.panNumber) },
    { label: 'Tax ID', value: secret(bank.taxIdNumber) },
  ].filter((r) => r.value);
}

// A filesystem-safe name built from the creator and campaign, e.g.
// "Rachel-Ly-Contract-Signed.pdf".
function contractFilename(row) {
  const data = (row && row.data) || {};
  const who = str(row && row.signer_name) || str(data.creatorName) || 'Creator';
  const slug = who
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60);
  return `${slug || 'Creator'}-Contract-Signed.pdf`;
}

// Build the PDF. `row` is a contracts table row (see contracts.getByToken).
function renderContractPdf(row, { unmaskBankDetails = false } = {}) {
  const data = (row && row.data) || {};
  const submission = (row && row.submission) || {};
  const fields = submission.fields || {};
  const bank = fields.bankAccount || {};
  const mask = !unmaskBankDetails;

  const creatorName = str(row && row.signer_name) || str(fields.legalName) || str(data.creatorName);
  const brand = str(data.brandLegalName) || str(data.brandName);
  const signedOn = longDate((row && row.signed_at) || fields.signedDate || submission.agreedAt);

  const doc = new PdfDocument({ title: `${creatorName || 'Creator'} — Influencer Agreement` });

  // ── Title block ─────────────────────────────────────────────────────────
  doc.y -= 4;
  doc.drawText('INFLUENCER AGREEMENT', doc.margin, doc.y, { font: 'bold', size: 19 });
  doc.y -= 18;
  const eyebrow = [brand, str(data.campaignName)].filter(Boolean).join(' · ');
  if (eyebrow) {
    doc.drawText(eyebrow, doc.margin, doc.y, { size: 10.5, gray: 0.42 });
    doc.y -= 14;
  }

  // Execution banner — the first thing a reader should see is that this copy
  // is the executed one, and who executed it.
  const executed = row && row.status && row.status !== 'pending';
  const banner = executed
    ? `Signed by ${creatorName || 'the creator'}${signedOn ? ` on ${signedOn}` : ''}.`
    : 'This contract has not been signed yet.';
  doc.y -= 6;
  doc.rule({ gray: 0.82 });
  doc.y -= 14;
  doc.drawText(banner, doc.margin, doc.y, { font: 'bold', size: 10, gray: 0.1 });
  doc.y -= 6;
  doc.rule({ gray: 0.82 });
  doc.y -= 2;

  // ── The agreed terms ────────────────────────────────────────────────────
  for (const section of contractSections(data)) {
    doc.heading(section.title);
    for (const r of section.rows || []) {
      doc.keyValue(r.label, r.value, {
        labelWidth: LABEL_WIDTH,
        size: r.big ? 11 : 10,
        valueFont: r.big ? 'bold' : 'helvetica',
      });
    }
    for (const bullet of section.bullets || []) doc.bullet(bullet);
  }

  // ── What the creator submitted when signing ─────────────────────────────
  const address = formatAddress(fields.address);
  const detailRows = [
    { label: 'Full legal name', value: str(fields.legalName) },
    { label: 'Gender', value: str(fields.gender) },
    { label: 'Email', value: str(row && row.signer_email) || str(data.email) },
    { label: 'Phone', value: str(fields.phone) },
  ].filter((r) => r.value);

  if (detailRows.length || address) {
    doc.heading('Creator Details');
    for (const r of detailRows) doc.keyValue(r.label, r.value, { labelWidth: LABEL_WIDTH });
    // formatAddress returns newline-separated lines; keyValue keeps them as
    // hard breaks under a single label.
    if (address) doc.keyValue('Address', address, { labelWidth: LABEL_WIDTH });
  }

  const bankDetail = bankRows(bank, mask);
  if (bankDetail.length) {
    doc.heading('Payment Details');
    for (const r of bankDetail) doc.keyValue(r.label, r.value, { labelWidth: LABEL_WIDTH });
    if (mask) {
      doc.space(2);
      doc.text('Account and tax identifiers are partially masked on this copy.', {
        size: 8.5,
        gray: 0.5,
        spaceAfter: 6,
      });
    }
  }

  // ── Signature block ─────────────────────────────────────────────────────
  const signature = decodeSignature(fields.signatureDataUrl);
  // Keep the whole block on one page — a signature stranded from its name is
  // exactly the kind of thing that makes a countersigned copy look doctored.
  doc.ensureSpace(150);
  doc.heading('Signature', { keepWith: 110 });

  doc.space(4);
  if (signature) {
    doc.image(signature, { boxWidth: 230, boxHeight: 62 });
  } else {
    // No drawn signature captured (an older submission, or an unreadable
    // canvas) — say so plainly rather than leaving a blank space that reads
    // like the contract was never signed.
    doc.space(30);
    doc.text(
      executed ? 'Signed electronically — no drawn signature was captured.' : '',
      { size: 9, gray: 0.5 },
    );
  }
  doc.space(4);
  doc.rule({ gray: 0.6, width: 240 });
  doc.space(12);
  doc.drawText(creatorName || 'Creator', doc.margin, doc.y, { font: 'bold', size: 10.5 });
  doc.space(13);
  if (signedOn) {
    doc.drawText(`Date signed: ${signedOn}`, doc.margin, doc.y, { size: 9.5, gray: 0.42 });
    doc.space(12);
  }

  // Audit trail — the electronic-signature evidence that makes the copy
  // meaningful if it is ever questioned.
  const agreedAt = submission.agreedAt ? new Date(submission.agreedAt) : null;
  const auditBits = [];
  if (agreedAt && !Number.isNaN(agreedAt.getTime())) {
    auditBits.push(`Submitted ${agreedAt.toISOString().replace('T', ' ').slice(0, 19)} UTC`);
  }
  if (str(row && row.signer_ip)) auditBits.push(`IP ${str(row.signer_ip)}`);
  if (auditBits.length) {
    doc.space(4);
    doc.text(auditBits.join('  ·  '), { size: 8, gray: 0.55 });
  }

  doc.addFooters(
    [brand, creatorName, 'Influencer Agreement'].filter(Boolean).join(' — '),
  );
  return doc.end();
}

module.exports = { renderContractPdf, contractFilename, maskTail, formatAddress };
