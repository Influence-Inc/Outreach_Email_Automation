'use strict';

// The parts of an executed-agreement PDF that are the same whichever agreement
// it is: the title block with its "signed by … on …" banner, the signature
// block with its audit trail, the running footer, and the filename.
//
// Two documents use them — the full contract (services/contractPdf.js, signed
// at /contract/:token) and the offer-portal mini contract
// (services/miniContractPdf.js, signed at /o/:token). They carry different
// terms, but a creator who gets both should recognise the second as the same
// kind of document, so the frame around the terms lives here once rather than
// being re-typed (and drifting) per renderer.

const { decodeSignature } = require('./png');

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

// A filesystem-safe name built from whoever signed, e.g. "Rachel-Ly".
function nameSlug(who) {
  return str(who)
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60);
}

// Title, campaign eyebrow, and the execution banner — the first thing a reader
// should see is that this copy is the executed one, and who executed it.
function titleBlock(doc, { title, creatorName, brand, campaignName, executed, signedOn }) {
  doc.y -= 4;
  doc.drawText(title, doc.margin, doc.y, { font: 'bold', size: 19 });
  doc.y -= 18;
  const eyebrow = [str(brand), str(campaignName)].filter(Boolean).join(' · ');
  if (eyebrow) {
    doc.drawText(eyebrow, doc.margin, doc.y, { size: 10.5, gray: 0.42 });
    doc.y -= 14;
  }

  const banner = executed
    ? `Signed by ${str(creatorName) || 'the creator'}${signedOn ? ` on ${signedOn}` : ''}.`
    : 'This contract has not been signed yet.';
  doc.y -= 6;
  doc.rule({ gray: 0.82 });
  doc.y -= 14;
  doc.drawText(banner, doc.margin, doc.y, { font: 'bold', size: 10, gray: 0.1 });
  doc.y -= 6;
  doc.rule({ gray: 0.82 });
  doc.y -= 2;
}

// The drawn signature, the signer's name and date, and the electronic-signature
// evidence that makes the copy meaningful if it is ever questioned.
function signatureBlock(doc, { signatureDataUrl, creatorName, signedOn, executed, agreedAt, signerIp }) {
  const signature = decodeSignature(signatureDataUrl);
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
    doc.text(executed ? 'Signed electronically — no drawn signature was captured.' : '', {
      size: 9,
      gray: 0.5,
    });
  }
  doc.space(4);
  doc.rule({ gray: 0.6, width: 240 });
  doc.space(12);
  doc.drawText(str(creatorName) || 'Creator', doc.margin, doc.y, { font: 'bold', size: 10.5 });
  doc.space(13);
  if (signedOn) {
    doc.drawText(`Date signed: ${signedOn}`, doc.margin, doc.y, { size: 9.5, gray: 0.42 });
    doc.space(12);
  }

  const submitted = agreedAt ? new Date(agreedAt) : null;
  const auditBits = [];
  if (submitted && !Number.isNaN(submitted.getTime())) {
    auditBits.push(`Submitted ${submitted.toISOString().replace('T', ' ').slice(0, 19)} UTC`);
  }
  if (str(signerIp)) auditBits.push(`IP ${str(signerIp)}`);
  if (auditBits.length) {
    doc.space(4);
    doc.text(auditBits.join('  ·  '), { size: 8, gray: 0.55 });
  }
}

// Running footer on every page: who this agreement is between, and what it is.
function addFooters(doc, { brand, creatorName, kind }) {
  doc.addFooters([str(brand), str(creatorName), kind].filter(Boolean).join(' — '));
}

module.exports = { LABEL_WIDTH, str, longDate, nameSlug, titleBlock, signatureBlock, addFooters };
