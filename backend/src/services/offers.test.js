'use strict';

// Run with: npm test  (node --test)
//
// Guards inviteNumbersFor — decides which of our own business messaging numbers
// to show a creator in the invite email. A channel is included only when the
// creator has a number on file for it, isn't opted out, AND our business number
// for that channel is configured. Env-stubbed; no DB.
const test = require('node:test');
const assert = require('node:assert');
const offers = require('./offers');

// Run `fn` with the two business-number env vars set to the given values.
function withBusinessNumbers({ wa, im }, fn) {
  const saved = { wa: process.env.AISENSY_WHATSAPP_NUMBER, im: process.env.IMESSAGE_FROM_NUMBER };
  try {
    if (wa === undefined) delete process.env.AISENSY_WHATSAPP_NUMBER;
    else process.env.AISENSY_WHATSAPP_NUMBER = wa;
    if (im === undefined) delete process.env.IMESSAGE_FROM_NUMBER;
    else process.env.IMESSAGE_FROM_NUMBER = im;
    return fn();
  } finally {
    if (saved.wa === undefined) delete process.env.AISENSY_WHATSAPP_NUMBER;
    else process.env.AISENSY_WHATSAPP_NUMBER = saved.wa;
    if (saved.im === undefined) delete process.env.IMESSAGE_FROM_NUMBER;
    else process.env.IMESSAGE_FROM_NUMBER = saved.im;
  }
}

test('inviteNumbersFor returns both business numbers when both channels are usable', () => {
  withBusinessNumbers({ wa: '+18005551234', im: '+18005555678' }, () => {
    assert.deepStrictEqual(
      offers.inviteNumbersFor({ whatsapp: '+1999', imessage: '+1999', messaging_opted_out: false }),
      { whatsappNumber: '+18005551234', imessageNumber: '+18005555678' },
    );
  });
});

test('inviteNumbersFor omits a channel the creator has no number on file for', () => {
  withBusinessNumbers({ wa: '+18005551234', im: '+18005555678' }, () => {
    assert.deepStrictEqual(
      offers.inviteNumbersFor({ whatsapp: '+1999', imessage: null, messaging_opted_out: false }),
      { whatsappNumber: '+18005551234', imessageNumber: null },
    );
  });
});

test('inviteNumbersFor omits a channel whose business number is not configured', () => {
  withBusinessNumbers({ wa: undefined, im: '+18005555678' }, () => {
    // Creator has a WhatsApp number, but we have no WhatsApp business number set.
    assert.deepStrictEqual(
      offers.inviteNumbersFor({ whatsapp: '+1999', imessage: '+1999', messaging_opted_out: false }),
      { whatsappNumber: null, imessageNumber: '+18005555678' },
    );
  });
});

test('inviteNumbersFor returns nulls for an opted-out creator', () => {
  withBusinessNumbers({ wa: '+18005551234', im: '+18005555678' }, () => {
    assert.deepStrictEqual(
      offers.inviteNumbersFor({ whatsapp: '+1999', imessage: '+1999', messaging_opted_out: true }),
      { whatsappNumber: null, imessageNumber: null },
    );
  });
});

test('inviteNumbersFor returns nulls when the creator has no numbers on file', () => {
  withBusinessNumbers({ wa: '+18005551234', im: '+18005555678' }, () => {
    assert.deepStrictEqual(offers.inviteNumbersFor({ whatsapp: null, imessage: null }), {
      whatsappNumber: null,
      imessageNumber: null,
    });
  });
});
