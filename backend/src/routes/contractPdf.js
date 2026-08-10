'use strict';

// Executed-contract PDF download, for sending a creator the copy of what they
// signed when they ask for one.
//
// Deliberately mounted OUTSIDE the public /api/contracts prefix: that router is
// on the siteAuth allowlist because the creator-facing signing page has to
// reach it unauthenticated. This endpoint returns the submitted identity and
// (masked) payment details, so it must sit behind the Slack sign-in gate — the
// team downloads the PDF and sends it on, rather than the document hanging off
// a public URL.

const express = require('express');
const contracts = require('../services/contracts');
const { renderContractPdf, contractFilename } = require('../services/contractPdf');

const router = express.Router();

function isTruthyFlag(value) {
  return value === '1' || value === 'true' || value === 'yes';
}

// GET /api/contract-pdf/:token[?full=1][&inline=1]
//   full=1   — include unmasked account / tax identifiers (internal copies only)
//   inline=1 — render in the browser instead of downloading, for a quick check
//              before the PDF is attached to an email
router.get('/:token', async (req, res, next) => {
  try {
    const row = await contracts.getByToken(req.params.token);
    if (!row) return res.status(404).json({ error: 'Contract not found' });

    const pdf = renderContractPdf(row, { unmaskBankDetails: isTruthyFlag(req.query.full) });
    const disposition = isTruthyFlag(req.query.inline) ? 'inline' : 'attachment';

    res
      .status(200)
      .set('Content-Type', 'application/pdf')
      .set('Content-Length', String(pdf.length))
      .set('Content-Disposition', `${disposition}; filename="${contractFilename(row)}"`)
      // The contract can change (terms edited, then re-signed), and it carries
      // personal details — never let a proxy hold on to a copy.
      .set('Cache-Control', 'no-store')
      .send(pdf);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
