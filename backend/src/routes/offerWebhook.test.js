'use strict';

// Run with: npm test  (node --test)
//
// Guards the offer-portal inbound webhook's pure logic: parseInbound (Linq's
// nested envelope + the flat AiSensy shape, plus the events/echoes it skips) and
// verifyLinqSignature (Standard Webhooks + X-Linq-Signature HMAC schemes, and
// the sandbox-friendly "no secret → allow" convention). The DB-touching handler
// is intentionally not exercised here.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const webhook = require('./offerWebhook');

// ---------------------------------------------------------------------------
// parseInbound
// ---------------------------------------------------------------------------

test('parseInbound reads a Linq message.created reply (parts + sender_handle)', () => {
  const parsed = webhook.parseInbound({
    event_type: 'message.created',
    data: {
      direction: 'incoming',
      sender_handle: { handle: '+15556667777', service: 'imessage' },
      message: { parts: [{ type: 'text', value: 'Yes' }] },
    },
  });
  assert.deepStrictEqual(parsed, { from: '15556667777', body: 'Yes' });
});

test('parseInbound accepts sender_handle as a bare string', () => {
  const parsed = webhook.parseInbound({
    event_type: 'message.created',
    data: { sender_handle: '+15556667777', message: { parts: [{ type: 'text', value: 'no' }] } },
  });
  assert.deepStrictEqual(parsed, { from: '15556667777', body: 'no' });
});

test('parseInbound skips our own outbound echoes (direction != incoming)', () => {
  const parsed = webhook.parseInbound({
    event_type: 'message.created',
    data: {
      direction: 'outgoing',
      sender_handle: { handle: '+15556667777' },
      message: { parts: [{ type: 'text', value: 'hi from us' }] },
    },
  });
  assert.deepStrictEqual(parsed, { ignore: 'direction:outgoing' });
});

test('parseInbound skips non-message events (reactions, receipts, calls)', () => {
  assert.deepStrictEqual(webhook.parseInbound({ event_type: 'reaction.created', data: {} }), {
    ignore: 'event:reaction.created',
  });
  assert.deepStrictEqual(webhook.parseInbound({ event_type: 'call.ended', data: {} }), {
    ignore: 'event:call.ended',
  });
});

test('parseInbound renders a placeholder for a non-text part', () => {
  const parsed = webhook.parseInbound({
    event_type: 'message.created',
    data: {
      sender_handle: { handle: '+15556667777' },
      message: { parts: [{ type: 'image', url: 'https://x.test/i.jpg' }] },
    },
  });
  assert.deepStrictEqual(parsed, { from: '15556667777', body: '[non-text message: image]' });
});

test('parseInbound still handles the flat AiSensy WhatsApp shape', () => {
  assert.deepStrictEqual(webhook.parseInbound({ from: '919812345670', message: 'accept' }), {
    from: '919812345670',
    body: 'accept',
  });
  // wa_id alias + nested text.body
  assert.deepStrictEqual(webhook.parseInbound({ wa_id: '919812345670', text: { body: 'yes' } }), {
    from: '919812345670',
    body: 'yes',
  });
});

test('parseInbound does NOT treat AiSensy content type "text" as an event to skip', () => {
  // `type` here is the message CONTENT type, not an event kind — the reply must
  // still be parsed, not ignored.
  assert.deepStrictEqual(webhook.parseInbound({ from: '919812345670', type: 'text', message: 'yes' }), {
    from: '919812345670',
    body: 'yes',
  });
});

test('parseInbound skips delivery-status events (handled as status upstream)', () => {
  assert.deepStrictEqual(
    webhook.parseInbound({ event_type: 'message.delivered', data: { message: { id: 'm_1' } } }),
    { ignore: 'event:message.delivered' },
  );
});

test('parseInbound returns null when there is no sender to match on', () => {
  assert.strictEqual(
    webhook.parseInbound({ event_type: 'message.created', data: { message: { parts: [{ type: 'text', value: 'hi' }] } } }),
    null,
  );
  assert.strictEqual(webhook.parseInbound(null), null);
});

// ---------------------------------------------------------------------------
// verifyLinqSignature
// ---------------------------------------------------------------------------

function withSecret(value, fn) {
  const saved = process.env.IMESSAGE_WEBHOOK_SECRET;
  try {
    if (value === undefined) delete process.env.IMESSAGE_WEBHOOK_SECRET;
    else process.env.IMESSAGE_WEBHOOK_SECRET = value;
    return fn();
  } finally {
    if (saved === undefined) delete process.env.IMESSAGE_WEBHOOK_SECRET;
    else process.env.IMESSAGE_WEBHOOK_SECRET = saved;
  }
}

test('verifyLinqSignature allows everything when no secret is configured', () => {
  withSecret(undefined, () => {
    assert.strictEqual(webhook.verifyLinqSignature({ headers: {}, body: {} }), true);
  });
});

test('verifyLinqSignature validates a Standard Webhooks signature', () => {
  const keyBytes = crypto.randomBytes(24);
  const secret = `whsec_${keyBytes.toString('base64')}`;
  const raw = JSON.stringify({ event_type: 'message.created' });
  const id = 'msg_abc';
  const ts = '1700000000';
  const sig = crypto.createHmac('sha256', keyBytes).update(`${id}.${ts}.${raw}`).digest('base64');

  withSecret(secret, () => {
    const req = {
      rawBody: Buffer.from(raw),
      headers: { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}` },
    };
    assert.strictEqual(webhook.verifyLinqSignature(req), true);

    // Tampered body → mismatch.
    req.rawBody = Buffer.from(raw + ' ');
    assert.strictEqual(webhook.verifyLinqSignature(req), false);
  });
});

test('verifyLinqSignature validates an X-Linq-Signature (hex) signature', () => {
  const secret = 'linq_sandbox_secret';
  const raw = JSON.stringify({ event_type: 'message.created' });
  const ts = '1700000000';
  const sig = crypto.createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex');

  withSecret(secret, () => {
    const req = {
      rawBody: Buffer.from(raw),
      headers: { 'x-linq-timestamp': ts, 'x-linq-signature': sig },
    };
    assert.strictEqual(webhook.verifyLinqSignature(req), true);

    // A "sha256=" prefix is tolerated.
    req.headers['x-linq-signature'] = `sha256=${sig}`;
    assert.strictEqual(webhook.verifyLinqSignature(req), true);

    // Wrong signature → reject.
    req.headers['x-linq-signature'] = 'deadbeef';
    assert.strictEqual(webhook.verifyLinqSignature(req), false);
  });
});

test('verifyLinqSignature rejects when a secret is set but no signature header is present', () => {
  withSecret('whsec_' + Buffer.from('x').toString('base64'), () => {
    assert.strictEqual(
      webhook.verifyLinqSignature({ rawBody: Buffer.from('{}'), headers: {} }),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// pickMatch — creator phone matching (exact + last-10-digit suffix)
// ---------------------------------------------------------------------------

test('pickMatch returns the exact bare-digits match', () => {
  const rows = [
    { id: 1, contact: '+1 (555) 111-2222' },
    { id: 2, contact: '+1 (555) 666-7777' },
  ];
  assert.strictEqual(webhook.pickMatch(rows, '15556667777').id, 2);
});

test('pickMatch falls back to a last-10-digit suffix when the country code differs', () => {
  // Stored without country code; inbound has it (or vice versa).
  const rows = [{ id: 5, contact: '5556667777' }];
  assert.strictEqual(webhook.pickMatch(rows, '15556667777').id, 5);
});

test('pickMatch prefers an exact match over an earlier suffix match', () => {
  const rows = [
    { id: 1, contact: '5556667777' }, // suffix candidate (appears first)
    { id: 2, contact: '15556667777' }, // exact
  ];
  assert.strictEqual(webhook.pickMatch(rows, '15556667777').id, 2);
});

test('pickMatch skips rows with no digits and returns null on no match', () => {
  assert.strictEqual(webhook.pickMatch([{ id: 1, contact: 'n/a' }], '15556667777'), null);
  assert.strictEqual(webhook.pickMatch([], '15556667777'), null);
});

// ---------------------------------------------------------------------------
// decideInboundAction — intent → backend action (the respondToOffer convergence)
// ---------------------------------------------------------------------------

test('decideInboundAction routes accept/decline to respond (same path as web)', () => {
  assert.deepStrictEqual(webhook.decideInboundAction({ intent: 'accept', hasPendingOffer: true }), {
    action: 'respond',
    response: 'accepted',
  });
  assert.deepStrictEqual(webhook.decideInboundAction({ intent: 'decline', hasPendingOffer: true }), {
    action: 'respond',
    response: 'declined',
  });
});

test('decideInboundAction routes a rate ask with a pending offer to negotiate', () => {
  assert.deepStrictEqual(
    webhook.decideInboundAction({ intent: 'other', hasPendingOffer: true, requestedRate: 500 }),
    { action: 'negotiate', requestedRate: 500 },
  );
});

test('decideInboundAction falls back to review otherwise', () => {
  // accept but nothing pending to respond to
  assert.deepStrictEqual(webhook.decideInboundAction({ intent: 'accept', hasPendingOffer: false }), {
    action: 'review',
  });
  // other with a rate but no pending offer
  assert.deepStrictEqual(
    webhook.decideInboundAction({ intent: 'other', hasPendingOffer: false, requestedRate: 500 }),
    { action: 'review' },
  );
  // other with no parseable rate
  assert.deepStrictEqual(
    webhook.decideInboundAction({ intent: 'other', hasPendingOffer: true, requestedRate: null }),
    { action: 'review' },
  );
});
