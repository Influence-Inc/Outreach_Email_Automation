'use strict';

// Render the offer-portal MINI contract as a PDF — the counterpart of
// contractPdf.js for creators who sign at /o/:token instead of /contract/:token.
//
// A used creator's portal signature IS their contract (see offers.signMiniContract):
// there's no separate full contract to follow, so without this they'd be the
// only signers with nothing to keep. It uses the same frame as the full
// agreement (pdf/agreementLayout.js) so both read as one family of document.
//
// IMPORTANT: this mirrors contractTermsBlock() in public/offer.js — the terms
// the creator actually reads and signs on the portal — the same way
// contractTerms.js mirrors contract.js for the full contract. The rows here are
// exactly those rows, in that order, and nothing else: the copy has to be the
// document that was signed, not a fuller one. That deliberately leaves out the
// rate, which the portal shows on the offer view before acceptance but never
// inside the agreement itself.

const { PdfDocument } = require('./pdf/document');
const {
  LABEL_WIDTH,
  str,
  longDate,
  nameSlug,
  titleBlock,
  signatureBlock,
  addFooters,
} = require('./pdf/agreementLayout');

function list(value) {
  if (Array.isArray(value)) return value.map(str).filter(Boolean);
  const single = str(value);
  return single ? [single] : [];
}

// Who signed, for the greeting-free parts of the document: the name recorded at
// signing wins (it's what the creator saw on their own signed view), then the
// snapshot, then the creator row.
function signerNameOf(offer) {
  const terms = (offer && offer.contract_terms) || {};
  return (
    str(offer && offer.contract_signer_name) ||
    str(terms.creatorName) ||
    str(offer && offer.full_name) ||
    str(offer && offer.first_name) ||
    'Creator'
  );
}

// "Rachel-Ly-Agreement-Signed.pdf" — deliberately distinct from the full
// contract's "-Contract-Signed.pdf" so a creator who has both can tell them
// apart in their inbox.
function miniContractFilename(offer) {
  return `${nameSlug(signerNameOf(offer)) || 'Creator'}-Agreement-Signed.pdf`;
}

/**
 * Build the PDF from an offers row (o.* plus the creator/campaign columns the
 * portal query joins: first_name, full_name, email, instagram_username,
 * campaign_name). The immutable `contract_terms` snapshot is preferred for
 * every term it carries; live columns only fill what it doesn't.
 */
function renderMiniContractPdf(offer) {
  const o = offer || {};
  const terms = (o.contract_terms && typeof o.contract_terms === 'object') ? o.contract_terms : {};

  const creatorName = str(terms.creatorName) || signerNameOf(o);
  const signerName = signerNameOf(o);
  const brand = str(terms.brandName) || str(o.brand_name);
  const campaignName = str(terms.campaignName) || str(o.campaign_name);
  const signedOn = longDate(o.contract_signed_at);
  const executed = !!o.contract_signed_at;

  const doc = new PdfDocument({ title: `${creatorName || 'Creator'} — Collaboration Agreement` });

  titleBlock(doc, {
    title: 'COLLABORATION AGREEMENT',
    creatorName: signerName,
    brand,
    campaignName,
    executed,
    signedOn,
  });

  const kv = (label, value, opts = {}) =>
    doc.keyValue(label, value, { labelWidth: LABEL_WIDTH, ...opts });

  doc.heading('Parties');
  kv('Creator', creatorName, { size: 11, valueFont: 'bold' });
  if (str(o.instagram_username)) kv('Instagram', `@${str(o.instagram_username).replace(/^@/, '')}`);
  if (str(o.email)) kv('Email', str(o.email));
  kv('Brand', brand, { size: 11, valueFont: 'bold' });

  doc.heading('Campaign & Deliverables');
  kv('Campaign', campaignName);
  // Platforms and deliverables are lists on the portal (rendered as pills);
  // here they become one row each — platforms comma-joined, deliverables one
  // per line, since each is its own commitment.
  kv('Platforms', list(terms.platforms || o.contract_platforms).join(', '));
  kv('Deliverables', list(terms.deliverables || o.deliverables).join('\n'));

  const timeline = str(terms.timeline);
  if (timeline) {
    doc.heading('Timeline');
    kv('Timeline', timeline);
  }

  signatureBlock(doc, {
    signatureDataUrl: o.contract_signature,
    creatorName: signerName,
    signedOn,
    executed,
    agreedAt: o.contract_signed_at,
    signerIp: o.contract_signer_ip,
  });

  addFooters(doc, { brand, creatorName: signerName, kind: 'Collaboration Agreement' });
  return doc.end();
}

module.exports = { renderMiniContractPdf, miniContractFilename, signerNameOf };
