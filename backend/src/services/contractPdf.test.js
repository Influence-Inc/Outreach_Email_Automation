'use strict';

const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');

const { renderContractPdf, contractFilename, maskTail, formatAddress } = require('./contractPdf');
const { contractSections } = require('./contractTerms');
const { stringWidth, wrapText, encodeWinAnsi } = require('./pdf/metrics');
const { decodeSignature } = require('./pdf/png');
const { PdfDocument } = require('./pdf/document');

// ── A canvas-style signature PNG (RGBA, transparent background, dark ink) ──
// Built here rather than checked in as a fixture so the test also proves the
// decoder handles exactly what canvas.toDataURL() produces.
function makeSignaturePng(width = 120, height = 40, { blank = false } = {}) {
  const raw = [];
  for (let y = 0; y < height; y += 1) {
    raw.push(0); // filter: None
    for (let x = 0; x < width; x += 1) {
      const ink = !blank && y > 14 && y < 22 && x > 20 && x < 100;
      raw.push(...(ink ? [16, 16, 16, 255] : [0, 0, 0, 0]));
    }
  }
  const crcTable = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.from(raw))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

function signedRow(overrides = {}) {
  return {
    token: 'tok-123',
    status: 'completed',
    signer_name: 'Rachel Ly',
    signer_email: 'rachel@example.com',
    signer_ip: '203.0.113.42',
    signed_at: '2026-08-04T15:22:31.000Z',
    data: {
      creatorName: 'Rachel Ly',
      instagramUsername: '@rachellyy',
      email: 'rachel@example.com',
      brandName: 'Reve',
      brandLegalName: 'Reve Labs, Inc.',
      campaignName: 'Summer Launch',
      platforms: ['Instagram'],
      offerType: 'video_bonus',
      deliverables: '3 short-form videos, posted at a cadence of 1-2 videos per week',
      numberOfDeliverables: 3,
      timeline: '1-2 videos per week',
      postingDeadline: '30 September 2026',
      compensation: 4500,
      currency: 'USD',
      bonusAmount: 1500,
      bonusThresholdViews: 500000,
      paymentTermsDays: 7,
      paidAdsIncluded: true,
      exclusivity: 'No competing skincare brands for 30 days',
      additionalTerms: ['Full creative freedom', 'Brand tagged in all posts'],
      manualTerms: ['One round of revisions per video'],
    },
    submission: {
      agreedAt: '2026-08-04T15:22:31.000Z',
      fields: {
        legalName: 'Rachel Ly',
        gender: 'Female',
        phone: '+1 (415) 555-0184',
        signedDate: '2026-08-04',
        address: {
          line1: '1180 Folsom Street',
          city: 'San Francisco',
          state: 'CA',
          zip: '94103',
          country: 'United States',
        },
        signatureDataUrl: makeSignaturePng(),
        bankAccount: {
          accountHolderName: 'Rachel Ly',
          bankName: 'Chase Bank',
          accountNumber: '000123456789',
          routingNumber: '021000021',
          taxIdNumber: '123-45-6789',
        },
      },
    },
    ...overrides,
  };
}

// The generated PDF is binary with Flate-compressed content streams, so assert
// against the decompressed text a reader would extract.
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
    // Step past the whole "endstream" keyword: it ends in "stream" itself, so
    // resuming any earlier would re-match it and desynchronise every later
    // stream in the file.
    i = end + close.length;
  }
  return out;
}

// ── metrics ───────────────────────────────────────────────────────────────

test('stringWidth matches the Helvetica AFM advance widths', () => {
  // "A" is 667/1000 em, space is 278/1000 in Helvetica.
  assert.strictEqual(stringWidth('A', 'helvetica', 1000), 667);
  assert.strictEqual(stringWidth(' ', 'helvetica', 1000), 278);
  // Bold "A" is 722; the two tables must not be the same object.
  assert.strictEqual(stringWidth('A', 'bold', 1000), 722);
  assert.strictEqual(stringWidth('', 'helvetica', 10), 0);
});

test('encodeWinAnsi maps typographic punctuation instead of dropping it', () => {
  assert.deepStrictEqual(encodeWinAnsi('—'), [0x97]); // em dash
  assert.deepStrictEqual(encodeWinAnsi('“”'), [0x93, 0x94]);
  assert.deepStrictEqual(encodeWinAnsi('•'), [0x95]);
  assert.deepStrictEqual(encodeWinAnsi('é'), [0xe9]); // Latin-1 passthrough
  assert.deepStrictEqual(encodeWinAnsi(' '), [0x20]); // nbsp → space
  assert.deepStrictEqual(encodeWinAnsi('🎬'), []); // astral: no glyph, dropped
});

test('wrapText keeps every line inside the measure', () => {
  const text = 'The creator keeps posting short-form videos on Instagram until the combined views reach the target.';
  const lines = wrapText(text, 'helvetica', 10, 200);
  assert.ok(lines.length > 1);
  for (const line of lines) assert.ok(stringWidth(line, 'helvetica', 10) <= 200);
  assert.strictEqual(lines.join(' '), text);
});

test('wrapText hard-splits a word longer than the measure', () => {
  const lines = wrapText('A'.repeat(200), 'helvetica', 10, 100);
  assert.ok(lines.length > 1);
  for (const line of lines) assert.ok(stringWidth(line, 'helvetica', 10) <= 100);
});

// ── signature decoding ────────────────────────────────────────────────────

test('decodeSignature reads a canvas RGBA PNG and trims to the ink', () => {
  const img = decodeSignature(makeSignaturePng(120, 40));
  assert.ok(img, 'expected the signature to decode');
  // Ink spans x 21..99 and y 15..21, plus padding — much smaller than 120x40.
  assert.ok(img.width < 120 && img.width > 60, `unexpected width ${img.width}`);
  assert.ok(img.height < 40, `unexpected height ${img.height}`);
  assert.strictEqual(zlib.inflateSync(img.data).length, img.width * img.height);
});

test('decodeSignature returns null for a blank canvas or junk input', () => {
  assert.strictEqual(decodeSignature(makeSignaturePng(120, 40, { blank: true })), null);
  assert.strictEqual(decodeSignature(null), null);
  assert.strictEqual(decodeSignature('data:image/png;base64,not-a-png'), null);
  assert.strictEqual(decodeSignature('https://example.com/sig.png'), null);
});

// ── document ──────────────────────────────────────────────────────────────

test('PdfDocument emits a structurally valid, paginated PDF', () => {
  const doc = new PdfDocument({ title: 'T' });
  for (let i = 0; i < 90; i += 1) doc.text(`Line ${i}`);
  doc.addFooters('caption');
  const buf = doc.end();
  assert.ok(doc.pages.length > 1, 'expected the text to overflow onto a second page');
  assert.strictEqual(buf.subarray(0, 8).toString('latin1'), '%PDF-1.4');
  assert.ok(buf.subarray(-6).toString('latin1').includes('%%EOF'));
  // The xref offset in the trailer must point at the xref table itself.
  const tail = buf.toString('latin1');
  const startxref = Number(/startxref\n(\d+)/.exec(tail)[1]);
  assert.strictEqual(buf.subarray(startxref, startxref + 4).toString('latin1'), 'xref');
});

// ── masking + formatting ──────────────────────────────────────────────────

test('maskTail keeps only the last four characters', () => {
  assert.strictEqual(maskTail('000123456789'), '••••••••6789');
  assert.strictEqual(maskTail('123-45-6789'), '•••••••6789');
  assert.strictEqual(maskTail('1234'), '••••');
  assert.strictEqual(maskTail(''), '');
  // Long IBANs cap the run of dots rather than drawing 30 of them.
  assert.strictEqual(maskTail('GB29NWBK60161331926819'), '••••••••••••6819');
});

test('formatAddress joins the parts the signing page collects', () => {
  assert.strictEqual(
    formatAddress({ line1: '1 A St', line2: 'Apt 2', city: 'SF', state: 'CA', zip: '94103', country: 'United States' }),
    '1 A St\nApt 2\nSF, CA\n94103\nUnited States',
  );
  assert.strictEqual(formatAddress(null), '');
});

test('contractFilename is filesystem-safe and names the creator', () => {
  assert.strictEqual(contractFilename(signedRow()), 'Rachel-Ly-Contract-Signed.pdf');
  assert.strictEqual(
    contractFilename({ signer_name: 'Ana "Nana" Souza/Lima', data: {} }),
    'Ana-Nana-SouzaLima-Contract-Signed.pdf',
  );
  assert.strictEqual(contractFilename({ data: {} }), 'Creator-Contract-Signed.pdf');
});

// ── the rendered contract ─────────────────────────────────────────────────

test('renderContractPdf carries the terms, the details and the signature', () => {
  const row = signedRow();
  const buf = renderContractPdf(row);
  const text = pdfText(buf);

  assert.strictEqual(buf.subarray(0, 8).toString('latin1'), '%PDF-1.4');
  assert.ok(text.includes('INFLUENCER AGREEMENT'));
  assert.ok(text.includes('Signed by Rachel Ly on 4 August 2026.'));
  // Terms
  assert.ok(text.includes('Reve Labs, Inc.'));
  assert.ok(text.includes('$4,500'));
  assert.ok(text.includes('$6,000'), 'total incl. bonus should be base + bonus');
  assert.ok(text.includes('One round of revisions per video'));
  // Submitted details
  assert.ok(text.includes('1180 Folsom Street'));
  assert.ok(text.includes('+1 \\(415\\) 555-0184'), 'parens are escaped in PDF strings');
  // Audit trail
  assert.ok(text.includes('203.0.113.42'));
  // The drawn signature is embedded as a greyscale image XObject.
  assert.ok(buf.includes(Buffer.from('/Subtype /Image')));
  assert.ok(buf.includes(Buffer.from('/ColorSpace /DeviceGray')));
});

test('bank credentials are masked by default and only revealed on request', () => {
  const row = signedRow();
  const masked = pdfText(renderContractPdf(row));
  assert.ok(!masked.includes('000123456789'), 'account number must not appear in full');
  assert.ok(!masked.includes('123-45-6789'), 'tax id must not appear in full');
  assert.ok(masked.includes('6789'), 'the last four digits stay readable');
  assert.ok(masked.includes('partially masked'));
  // Routing numbers identify the bank branch, not the account — never masked.
  assert.ok(masked.includes('021000021'));

  const full = pdfText(renderContractPdf(row, { unmaskBankDetails: true }));
  assert.ok(full.includes('000123456789'));
  assert.ok(full.includes('123-45-6789'));
  assert.ok(!full.includes('partially masked'));
});

test('renderContractPdf still produces a document with no signature captured', () => {
  const row = signedRow();
  row.submission.fields.signatureDataUrl = null;
  const buf = renderContractPdf(row);
  const text = pdfText(buf);
  assert.ok(text.includes('no drawn signature was captured'));
  assert.ok(text.includes('Rachel Ly'));
  assert.ok(!buf.includes(Buffer.from('/Subtype /Image')));
});

test('an unsigned contract says so instead of claiming a signature', () => {
  const row = signedRow({ status: 'pending', signed_at: null, signer_name: null, submission: null });
  const text = pdfText(renderContractPdf(row));
  assert.ok(text.includes('has not been signed yet'));
  assert.ok(text.includes('$4,500'), 'the terms still render');
});

test('renderContractPdf survives a threadbare contract row', () => {
  const buf = renderContractPdf({ token: 't', status: 'pending', data: {} });
  assert.strictEqual(buf.subarray(0, 8).toString('latin1'), '%PDF-1.4');
  assert.ok(buf.length > 400);
});

// ── the terms mirror ──────────────────────────────────────────────────────

test('contractSections mirrors the signing page derivations', () => {
  const sections = contractSections(signedRow().data);
  const byTitle = Object.fromEntries(sections.map((s) => [s.title, s]));
  const valueOf = (title, label) =>
    (byTitle[title].rows.find((r) => r.label === label) || {}).value;

  // Cadence is stripped from the deliverables value — it has its own row.
  assert.strictEqual(valueOf('Campaign & Deliverables', 'Deliverables'), '3 short-form videos');
  assert.strictEqual(valueOf('Timeline', 'Cadence'), '1-2 videos per week');
  // A deliverables string that already carries a count suppresses the count row.
  assert.strictEqual(valueOf('Campaign & Deliverables', 'Number of deliverables'), undefined);
  assert.strictEqual(valueOf('Compensation & Payment', 'Total (incl. bonus)'), '$6,000');
  assert.strictEqual(
    valueOf('Compensation & Payment', 'Payment terms'),
    'Direct bank transfer, initiated within 7 working days of completing and posting all agreed deliverables',
  );
  assert.strictEqual(valueOf('Usage Rights & Exclusivity', 'Posts remain live for'), '6 months');
  // "Full creative freedom" is a standing perk pitched in every template — it
  // must never show automatically (contracts.isAutoSuppressedTerm).
  assert.deepStrictEqual(byTitle['Additional Terms'].bullets, [
    'Brand tagged in all posts',
    'One round of revisions per video',
  ]);
});

test('contractSections spells out a view-based deal the way the page does', () => {
  const sections = contractSections({
    offerType: 'view_based',
    deliverables: 'Short-form videos on Instagram',
    minTotalViews: 750000,
    viewCountingDays: 14,
    compensation: 3000,
    currency: 'USD',
  });
  const deliverables = sections.find((s) => s.title === 'Campaign & Deliverables');
  const valueOf = (label) => (deliverables.rows.find((r) => r.label === label) || {}).value;
  assert.strictEqual(
    valueOf('Guaranteed total views'),
    '750,000 — combined across all posts on Instagram',
  );
  assert.strictEqual(
    valueOf('View counting window'),
    'Views for each post are counted for 14 days from the day it is posted.',
  );
  assert.ok(valueOf('Posting commitment').includes('at least 750,000'));
});

test('a flat video-based deal never shows a guaranteed-views floor', () => {
  const sections = contractSections({
    offerType: 'video_based',
    deliverables: 'Instagram Reel',
    guaranteedViews: 200000,
    compensation: 1200,
    currency: 'USD',
  });
  const deliverables = sections.find((s) => s.title === 'Campaign & Deliverables');
  assert.ok(!deliverables.rows.some((r) => /guaranteed views/i.test(r.label)));
});
