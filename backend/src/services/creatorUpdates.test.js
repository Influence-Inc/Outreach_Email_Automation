'use strict';

// Guards the decision logic of the campaign-update lane (services/creatorUpdates.js)
// — the pure surface, with no database and no network. What's pinned here is
// everything that decides whether a signed creator hears about their brief and
// their approval, or doesn't:
//
//   • sendability   — who may be messaged at all, and which gap is reported.
//   • windowOpen    — free-form text vs. template, the lane's central branch.
//   • channelFor    — which number carries the updates.
//   • renderUpdate  — the payload → copy mapping, including its fallbacks.
//   • UPDATE_KINDS  — that every kind is fully wired: copy, template env var,
//                     and a parameter list that matches the approved body.

const test = require('node:test');
const assert = require('node:assert');
const cu = require('./creatorUpdates');
const msg = require('./offerPortal/updateMessages');

const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000);

const SUBSCRIBED = {
  id: 1,
  first_name: 'Sam',
  whatsapp: '919876543210',
  updates_subscribed_at: hoursAgo(100),
  messaging_opted_out: false,
};

// --- sendability -----------------------------------------------------------

test('a subscribed creator with a number is sendable', () => {
  assert.deepStrictEqual(cu.sendability(SUBSCRIBED), { ok: true });
});

test('an unsigned creator is not on this lane at all', () => {
  const r = cu.sendability({ ...SUBSCRIBED, updates_subscribed_at: null });
  assert.deepStrictEqual(r, { ok: false, reason: 'not_subscribed' });
});

test('an opt-out blocks updates even for a subscribed creator', () => {
  // STOP is the only thing that ends this subscription, and it must outrank
  // every other consideration — this is compliance, not a preference.
  const r = cu.sendability({ ...SUBSCRIBED, messaging_opted_out: true });
  assert.deepStrictEqual(r, { ok: false, reason: 'opted_out' });
});

test('opt-out is reported ahead of a missing number', () => {
  // Both are true; the reason must name the one that matters, or someone
  // "fixes" it by adding a phone number to an opted-out creator.
  const r = cu.sendability({
    ...SUBSCRIBED,
    messaging_opted_out: true,
    whatsapp: null,
    imessage: null,
  });
  assert.strictEqual(r.reason, 'opted_out');
});

test('a subscribed creator with no number on file reports no_contact', () => {
  const r = cu.sendability({ ...SUBSCRIBED, whatsapp: null, imessage: null });
  assert.deepStrictEqual(r, { ok: false, reason: 'no_contact' });
});

// --- the 24h window --------------------------------------------------------

test('a recent inbound holds the free-form window open', () => {
  assert.strictEqual(cu.windowOpen({ updates_last_inbound_at: hoursAgo(1) }), true);
  assert.strictEqual(cu.windowOpen({ updates_last_inbound_at: hoursAgo(23.5) }), true);
});

test('the window shuts at 24 hours', () => {
  assert.strictEqual(cu.windowOpen({ updates_last_inbound_at: hoursAgo(24.5) }), false);
  assert.strictEqual(cu.windowOpen({ updates_last_inbound_at: hoursAgo(72) }), false);
});

test('a creator who has never written in has no window', () => {
  // The Scenario 2 case: signed, silent, reachable only by template.
  assert.strictEqual(cu.windowOpen({ updates_last_inbound_at: null }), false);
  assert.strictEqual(cu.windowOpen(null), false);
});

// --- channel choice --------------------------------------------------------

test('WhatsApp is the default carrier for updates', () => {
  assert.strictEqual(cu.channelFor({ whatsapp: '91987', imessage: '91987' }), 'whatsapp');
});

test('a creator who established the conversation on iMessage keeps it there', () => {
  assert.strictEqual(
    cu.channelFor({ whatsapp: '91987', imessage: '91987', established_channel: 'imessage' }),
    'imessage',
  );
});

test('an established iMessage channel with no iMessage number falls back rather than failing', () => {
  assert.strictEqual(
    cu.channelFor({ whatsapp: '91987', imessage: null, established_channel: 'imessage' }),
    'whatsapp',
  );
});

test('no number at all means no channel', () => {
  assert.strictEqual(cu.channelFor({ whatsapp: null, imessage: null }), null);
});

// --- rendering -------------------------------------------------------------

test('renderUpdate fills the creator name and brand from their row', () => {
  const r = cu.renderUpdate({ kind: 'review_submitted', payload: {} }, { first_name: 'Sam', brand_name: 'Reve' });
  assert.match(r.body, /Reve/);
  assert.strictEqual(r.payload.firstName, 'Sam');
});

test("a payload's brand name wins over the creator row's", () => {
  // The bot names the brand for the campaign the event actually belongs to,
  // which may not be the campaign our row is pointed at.
  const r = cu.renderUpdate(
    { kind: 'review_submitted', payload: { brandName: 'Acme' } },
    { first_name: 'Sam', brand_name: 'Reve' },
  );
  assert.match(r.body, /Acme/);
  assert.doesNotMatch(r.body, /Reve/);
});

test('an empty brand name in the payload does not blank out a known brand', () => {
  const r = cu.renderUpdate(
    { kind: 'review_submitted', payload: { brandName: '' } },
    { first_name: 'Sam', brand_name: 'Reve' },
  );
  assert.match(r.body, /Reve/);
});

test('a creator with no first name still gets a sentence that reads', () => {
  const r = cu.renderUpdate({ kind: 'deliverables_complete', payload: {} }, { full_name: null, first_name: null });
  assert.strictEqual(r.payload.firstName, 'there');
  assert.ok(r.body.length > 0);
});

test('a first name is derived from a full name when that is all we have', () => {
  const r = cu.renderUpdate({ kind: 'review_submitted', payload: {} }, { full_name: 'Sam Rivera' });
  assert.strictEqual(r.payload.firstName, 'Sam');
});

test('an unknown kind renders nothing rather than guessing', () => {
  assert.strictEqual(cu.renderUpdate({ kind: 'not_a_kind', payload: {} }, { first_name: 'Sam' }), null);
});

// --- template link suffix --------------------------------------------------

test('templateLinkSuffix strips the scheme and host Meta already has', () => {
  // A dynamic URL button's variable is the SUFFIX to the approved prefix.
  // Passing the whole URL renders a doubled link in the creator's chat.
  assert.strictEqual(cu.templateLinkSuffix('https://influence.example/brief/abc123'), 'brief/abc123');
  assert.strictEqual(cu.templateLinkSuffix('http://influence.example/o/tok?x=1'), 'o/tok?x=1');
});

test('templateLinkSuffix passes through a value that is already a suffix', () => {
  assert.strictEqual(cu.templateLinkSuffix('brief/abc123'), 'brief/abc123');
});

test('templateLinkSuffix survives a null link', () => {
  assert.strictEqual(cu.templateLinkSuffix(null), '');
});

// --- kind registry ---------------------------------------------------------

test('every update kind is fully wired', () => {
  for (const [kind, spec] of Object.entries(cu.UPDATE_KINDS)) {
    assert.strictEqual(typeof spec.render, 'function', `${kind} has no renderer`);
    assert.match(spec.templateEnv, /^WHATSAPP_TEMPLATE_/, `${kind} has no template env var`);
    assert.strictEqual(typeof spec.params, 'function', `${kind} has no template params`);
  }
});

test('every kind renders a non-empty message from an empty payload', () => {
  // Every field a bot event carries is optional — a missing submitPostsUrl or a
  // blank feedback string must still produce a message worth sending, never an
  // empty body or a thrown TypeError mid-webhook.
  for (const kind of Object.keys(cu.UPDATE_KINDS)) {
    const r = cu.renderUpdate({ kind, payload: {} }, { first_name: 'Sam' });
    assert.ok(r && r.body && r.body.trim().length > 10, `${kind} rendered nothing useful`);
  }
});

test('every template takes exactly the two positional variables the docs promise', () => {
  // .env.example tells whoever registers the copy in WhatsApp Manager that every
  // body is "{{1}} = first name, {{2}} = brand". Meta rejects the send outright
  // when the count disagrees, so this pins the contract from the code side.
  for (const [kind, spec] of Object.entries(cu.UPDATE_KINDS)) {
    const params = spec.params({ firstName: 'Sam', brandName: 'Reve' });
    assert.deepStrictEqual(params, ['Sam', 'Reve'], `${kind} does not take (firstName, brandName)`);
  }
});

test('the kinds that carry a link expose it for the template button', () => {
  const withLink = {
    brief_ready: { briefUrl: 'https://x.io/brief/1' },
    review_approved: { submitPostsUrl: 'https://x.io/submit' },
    review_feedback: { chatUrl: 'https://x.io/chat/1' },
  };
  for (const [kind, payload] of Object.entries(withLink)) {
    const spec = cu.UPDATE_KINDS[kind];
    assert.strictEqual(typeof spec.linkOf, 'function', `${kind} should expose a link`);
    assert.ok(spec.linkOf(payload), `${kind} did not resolve its link`);
  }
});

test('isKnownKind rejects anything not in the registry, including prototype keys', () => {
  assert.strictEqual(cu.isKnownKind('brief_ready'), true);
  assert.strictEqual(cu.isKnownKind('nope'), false);
  // The bot POSTs this value straight from a request body.
  assert.strictEqual(cu.isKnownKind('constructor'), false);
  assert.strictEqual(cu.isKnownKind('__proto__'), false);
});

// --- the "send us a Hi" deep link -----------------------------------------

test('hiDeepLink prefills "Hi" so the ask is one tap', () => {
  const saved = process.env.WHATSAPP_CLOUD_DISPLAY_NUMBER;
  const savedProvider = process.env.WHATSAPP_PROVIDER;
  try {
    process.env.WHATSAPP_PROVIDER = 'cloud';
    process.env.WHATSAPP_CLOUD_DISPLAY_NUMBER = '+1 (800) 555-1234';
    assert.strictEqual(cu.hiDeepLink(), 'https://wa.me/18005551234?text=Hi');
  } finally {
    if (saved === undefined) delete process.env.WHATSAPP_CLOUD_DISPLAY_NUMBER;
    else process.env.WHATSAPP_CLOUD_DISPLAY_NUMBER = saved;
    if (savedProvider === undefined) delete process.env.WHATSAPP_PROVIDER;
    else process.env.WHATSAPP_PROVIDER = savedProvider;
  }
});

test('hiDeepLink is null with no business number rather than a broken link', () => {
  const saved = { ...process.env };
  try {
    delete process.env.WHATSAPP_CLOUD_DISPLAY_NUMBER;
    delete process.env.TWILIO_WHATSAPP_FROM;
    delete process.env.WHATSAPP_PROVIDER;
    assert.strictEqual(cu.hiDeepLink(), null);
  } finally {
    Object.assign(process.env, saved);
  }
});

// --- copy ------------------------------------------------------------------

test('the intro states what the thread is for', () => {
  // This is the only message that gets to set expectations. If it doesn't say
  // updates are coming, every unprompted message after it is a surprise.
  const body = msg.introMessage({ firstName: 'Sam', brandName: 'Reve' });
  assert.match(body, /Sam/);
  assert.match(body, /Reve/);
});

test('the "send us a Hi" ask actually asks for a Hi', () => {
  const body = msg.hiRequestMessage({ firstName: 'Sam', brandName: 'Reve' });
  assert.match(body, /"Hi"/);
});

test('the hi-request email carries the tappable wa.me link when there is one', () => {
  const withLink = msg.hiRequestEmail({
    firstName: 'Sam',
    brandName: 'Reve',
    whatsappLink: 'https://wa.me/18005551234?text=Hi',
  });
  assert.match(withLink.body, /wa\.me/);
  assert.match(withLink.subject, /Reve/);

  // With no deep link, the raw number is the fallback — never a dead sentence
  // telling them to tap something that isn't there.
  const withNumber = msg.hiRequestEmail({ firstName: 'Sam', brandName: 'Reve', whatsappNumber: '+18005551234' });
  assert.match(withNumber.body, /\+18005551234/);
  assert.doesNotMatch(withNumber.body, /Tap here/);
});

test('feedback is quoted verbatim, never paraphrased', () => {
  // A summarised change request is how a re-shoot gets shot wrong.
  const feedback = 'Cut the first 3 seconds and say the product name earlier';
  const body = msg.reviewFeedback({ brandName: 'Reve', senderName: 'Ana', feedback, chatUrl: 'https://x.io/c' });
  assert.ok(body.includes(feedback));
  assert.match(body, /Ana/);
  assert.match(body, /x\.io\/c/);
});

test('feedback with no named sender still attributes it to someone', () => {
  const body = msg.reviewFeedback({ brandName: 'Reve', feedback: 'Looks good' });
  assert.match(body, /Reve team/);
});

test('the approval message names the next step whether or not it has a link', () => {
  const withUrl = msg.reviewApproved({ brandName: 'Reve', submitPostsUrl: 'https://x.io/submit' });
  assert.match(withUrl, /x\.io\/submit/);
  assert.match(withUrl, /post link/i);

  const withoutUrl = msg.reviewApproved({ brandName: 'Reve' });
  assert.match(withoutUrl, /post link/i);
  assert.doesNotMatch(withoutUrl, /https?:/);
});

test('the wrap-up says the creator stays subscribed', () => {
  // The subscription outliving the campaign is only acceptable because this
  // message tells the creator it will.
  const body = msg.deliverablesComplete({ brandName: 'Reve' });
  assert.match(body, /new campaign/i);
});

test('only the opening messages greet — later updates do not re-introduce us', () => {
  // Re-greeting on every update reads like a broken mail merge; the offer-portal
  // copy follows the same rule.
  const laterUpdates = [
    msg.briefReady({ brandName: 'Reve', briefUrl: 'https://x.io/b' }),
    msg.reviewSubmitted({ brandName: 'Reve' }),
    msg.reviewApproved({ brandName: 'Reve' }),
    msg.postSubmitted({ brandName: 'Reve' }),
    msg.deliverablesComplete({ brandName: 'Reve' }),
  ];
  for (const body of laterUpdates) {
    assert.doesNotMatch(body, /^(Hi|Hey|Hello)\b/, `"${body.slice(0, 40)}…" should not greet`);
  }
  // The two that DO open a conversation are allowed to.
  assert.match(msg.introMessage({ firstName: 'Sam', brandName: 'Reve' }), /^Hi Sam/);
  assert.match(msg.hiRequestMessage({ firstName: 'Sam', brandName: 'Reve' }), /^Hi Sam/);
});

test('every link-carrying body writes the link out in full', () => {
  // These bodies are both the stored history and the Twilio/no-template
  // fallback. A link that only lives on a button would leave both with none.
  assert.match(msg.briefReady({ brandName: 'Reve', briefUrl: 'https://x.io/b/1' }), /https:\/\/x\.io\/b\/1/);
  assert.match(msg.postSubmitted({ brandName: 'Reve', postUrl: 'https://ig.com/p/1' }), /https:\/\/ig\.com\/p\/1/);
});

test('the next-campaign pitch uses the campaign blurb when there is one', () => {
  const withBlurb = msg.nextCampaignOutreach({ firstName: 'Sam', brandName: 'Acme', blurb: 'Acme makes running shoes.' });
  assert.match(withBlurb, /Sam/);
  assert.match(withBlurb, /running shoes/);

  // And still reads as a complete message without one.
  const bare = msg.nextCampaignOutreach({ firstName: 'Sam', brandName: 'Acme' });
  assert.match(bare, /Acme/);
  assert.ok(bare.trim().length > 20);
});
