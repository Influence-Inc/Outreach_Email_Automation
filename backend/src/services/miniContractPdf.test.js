'use strict';

// Run with: npm test  (node --test)
//
// Guards the offer-portal mini contract's PDF copy: it carries exactly the rows
// the creator read on the portal (contractTermsBlock in public/offer.js), it
// prefers the immutable signed snapshot over the live offer columns, and it
// frames them the same way the full contract does.
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');

const { renderMiniContractPdf, miniContractFilename, signerNameOf } = require('./miniContractPdf');

function signedOffer(overrides = {}) {
  return {
    id: 12,
    creator_id: 88,
    token: 'offertok',
    status: 'accepted',
    brand_name: 'Netflix',
    campaign_name: 'Summer Launch',
    rate: '2500.00',
    currency: 'USD',
    deliverables: ['2 Reels'],
    first_name: 'Sam',
    full_name: 'Sam Rivera',
    email: 'sam@example.com',
    instagram_username: 'samrivera',
    contract_signed_at: '2026-08-25T10:15:00Z',
    contract_signer_name: 'Sam Rivera',
    contract_signer_ip: '9.9.9.9',
    contract_signature: null,
    contract_terms: {
      creatorName: 'Sam Rivera',
      brandName: 'Netflix',
      campaignName: 'Summer Launch',
      deliverables: ['2 Reels', '1 Story set'],
      platforms: ['Instagram', 'TikTok'],
      timeline: 'Content to be posted around 5 September 2026.',
    },
    ...overrides,
  };
}

// Inflate every page-content stream and return the concatenated text operators.
function pdfText(buf) {
  let out = '';
  const open = Buffer.from('stream\n');
  const close = Buffer.from('\nendstream');
  let i = 0;
  while ((i = buf.indexOf(open, i)) !== -1) {
    const start = i + open.length;
    const end = buf.indexOf(close, start);
    if (end === -1) break;
    try {
      out += `${zlib.inflateSync(buf.subarray(start, end)).toString('latin1')}\n`;
    } catch {
      // Image streams are greyscale samples, not page text — skip them.
    }
    i = end + close.length;
  }
  return out;
}

test('renderMiniContractPdf carries the portal terms and the execution banner', () => {
  const text = pdfText(renderMiniContractPdf(signedOffer()));

  assert.match(text, /COLLABORATION AGREEMENT/);
  assert.match(text, /Signed by Sam Rivera on 25 August 2026/);
  assert.match(text, /Netflix/);
  assert.match(text, /Summer Launch/);
  assert.match(text, /Instagram, TikTok/);
  assert.match(text, /2 Reels/);
  assert.match(text, /1 Story set/);
  assert.match(text, /Content to be posted around 5 September 2026/);
  // The rate is NOT on the portal's agreement block, so it must not appear on
  // the copy either — the document has to be the one that was signed.
  assert.doesNotMatch(text, /2,500/);
  assert.doesNotMatch(text, /Compensation/);
  // Electronic-signature evidence, same as the full contract's copy.
  assert.match(text, /Submitted 2026-08-25 10:15:00 UTC/);
  assert.match(text, /IP 9\.9\.9\.9/);
});

test('renderMiniContractPdf prefers the signed snapshot over the live offer row', () => {
  // The picker was changed on the offer row AFTER signing — the copy must show
  // what was signed, not what the row says now.
  const text = pdfText(
    renderMiniContractPdf(
      signedOffer({ contract_platforms: ['Instagram', 'TikTok', 'YouTube Shorts'], deliverables: ['9 Reels'] }),
    ),
  );
  assert.match(text, /Instagram, TikTok/);
  assert.doesNotMatch(text, /YouTube Shorts/);
  assert.doesNotMatch(text, /9 Reels/);
});

test('renderMiniContractPdf falls back to the live row for a legacy offer with no snapshot', () => {
  const text = pdfText(
    renderMiniContractPdf(
      signedOffer({ contract_terms: null, contract_platforms: ['Instagram'], deliverables: ['3 Reels'] }),
    ),
  );
  assert.match(text, /Sam Rivera/);
  assert.match(text, /Netflix/);
  assert.match(text, /3 Reels/);
  assert.match(text, /Instagram/);
});

test('renderMiniContractPdf states plainly when no drawn signature was captured', () => {
  const text = pdfText(renderMiniContractPdf(signedOffer({ contract_signature: null })));
  assert.match(text, /Signed electronically/);
});

test('renderMiniContractPdf survives a threadbare offer row', () => {
  const buf = renderMiniContractPdf({ token: 'x', creator_id: 1 });
  assert.strictEqual(buf.subarray(0, 5).toString('latin1'), '%PDF-');
  const text = pdfText(buf);
  assert.match(text, /COLLABORATION AGREEMENT/);
  assert.match(text, /has not been signed yet/);
});

test('miniContractFilename is distinct from the full contract download', () => {
  assert.strictEqual(miniContractFilename(signedOffer()), 'Sam-Rivera-Agreement-Signed.pdf');
  // Decorated display names still produce a safe filename.
  assert.strictEqual(
    miniContractFilename(signedOffer({ contract_signer_name: '★ Najwa Q ♡', contract_terms: null })),
    'Najwa-Q-Agreement-Signed.pdf',
  );
  assert.strictEqual(miniContractFilename({}), 'Creator-Agreement-Signed.pdf');
});

test('signerNameOf prefers the recorded signature name, then the snapshot', () => {
  assert.strictEqual(signerNameOf(signedOffer()), 'Sam Rivera');
  assert.strictEqual(
    signerNameOf(signedOffer({ contract_signer_name: null, contract_terms: { creatorName: 'Snapshot Name' } })),
    'Snapshot Name',
  );
  assert.strictEqual(
    signerNameOf({ full_name: 'Row Name', contract_terms: null }),
    'Row Name',
  );
});
