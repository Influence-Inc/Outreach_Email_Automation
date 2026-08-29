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
const { contractSections } = require('./contractTerms');
const {
  LABEL_WIDTH,
  str,
  longDate,
  nameSlug,
  titleBlock,
  signatureBlock,
  addFooters,
} = require('./pdf/agreementLayout');

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

// A filesystem-safe name built from the creator, e.g.
// "Rachel-Ly-Contract-Signed.pdf".
function contractFilename(row) {
  const data = (row && row.data) || {};
  const who = str(row && row.signer_name) || str(data.creatorName) || 'Creator';
  return `${nameSlug(who) || 'Creator'}-Contract-Signed.pdf`;
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
  const executed = row && row.status && row.status !== 'pending';
  titleBlock(doc, {
    title: 'INFLUENCER AGREEMENT',
    creatorName,
    brand,
    campaignName: str(data.campaignName),
    executed,
    signedOn,
  });

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
  signatureBlock(doc, {
    signatureDataUrl: fields.signatureDataUrl,
    creatorName,
    signedOn,
    executed,
    agreedAt: submission.agreedAt,
    signerIp: row && row.signer_ip,
  });

  addFooters(doc, { brand, creatorName, kind: 'Influencer Agreement' });
  return doc.end();
}

module.exports = { renderContractPdf, contractFilename, maskTail, formatAddress };
