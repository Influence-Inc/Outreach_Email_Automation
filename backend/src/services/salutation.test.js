'use strict';

// Run with: npm test  (node --test)
//
// Greeting resolution. negotiationReply.test.js already covers the original
// sender-detection behaviour through negotiation.salutationFor; these tests
// cover the guarantees added after replies started going out addressed to our
// own manager, and addressed about their reader in the third person:
//
//   • the name comes from the NEW message, never from the quoted thread below it
//   • we never greet anyone with one of our own names
//   • third person about the creator needs evidence, not just a different name
//   • a poisoned creators.reply_salutation heals instead of repeating forever
const test = require('node:test');
const assert = require('node:assert');
const { resolveSalutation, salutationFor, sanitizeStored, isSamePerson } = require('./salutation');

// The real reply that produced "Hi Jennifer," on an email to the creator Kam:
// Kam signs off, then his client quotes our whole previous email, which ends
// "- Jennifer". A tail scan over the raw body reads OUR sign-off as his.
const KAM_REPLY = [
  'Hi Jennifer,',
  '',
  "Thanks for the detailed response! I really like the structure overall, and I'm happy with the $5,000 figure.",
  '',
  'The one adjustment I would like to make is to the payment structure — 50% upfront works better for me.',
  '',
  'Everything else sounds great, and I am excited about the possibility of working together.',
  '',
  'Best,',
  '',
  'Kam',
  '',
  'On Thu, 06 Aug 2026 22:21:16 +0000, Jennifer Max <jennifer@frominfluence.com> wrote:',
  '',
  'Hi Kam,',
  '',
  'Thank you for sharing your platform preferences — that makes total sense.',
  '',
  'We do direct bank transfers. Payment will be initiated within 7 working days.',
  '',
  'Would love to make this happen, Kam — let me know your thoughts! :)',
  '',
  '- Jennifer',
].join('\n');

test('greets the creator, not our own manager, on a reply that quotes our email', () => {
  const r = resolveSalutation('Kam', KAM_REPLY, {
    senderEmail: 'kam@gmail.com',
    creatorEmail: 'kam@gmail.com',
  });
  assert.strictEqual(r.name, 'Kam');
  assert.strictEqual(r.isDelegate, false);
});

test('never greets by our own manager name even if it is the only name found', () => {
  // Belt and braces: if quote-stripping ever misses a shape, the name still has
  // to survive the "that is us" check before it can reach a greeting.
  const r = resolveSalutation('Kam', 'Sounds good.\n\n- Jennifer', {
    senderEmail: 'kam@gmail.com',
    creatorEmail: 'kam@gmail.com',
  });
  assert.strictEqual(r.name, 'Kam');
  assert.strictEqual(r.isDelegate, false);
});

test('never derives a greeting from one of our own sending addresses', () => {
  const r = resolveSalutation('Kam', 'Forwarding this along.', {
    senderEmail: 'jennifer@frominfluence.com',
    creatorEmail: 'kam@gmail.com',
    ourEmails: ['jennifer@frominfluence.com'],
  });
  assert.strictEqual(r.name, 'Kam');
});

test('a creator who really is named Jennifer is still greeted by her name', () => {
  const r = resolveSalutation('Jennifer', 'Sounds great!\n\nBest,\nJennifer', {
    senderEmail: 'jen@gmail.com',
    creatorEmail: 'jen@gmail.com',
  });
  assert.strictEqual(r.name, 'Jennifer');
  assert.strictEqual(r.isDelegate, false);
});

// ── Short forms are the same person, not a third party ─────────────────────

test('a short form of the creator name is the creator, not someone writing for them', () => {
  const r = resolveSalutation('Kamran', 'Sounds great!\n\nBest,\nKam', {
    senderEmail: 'kam@gmail.com',
    creatorEmail: 'kam@gmail.com',
  });
  // Greeted the way they signed…
  assert.strictEqual(r.name, 'Kam');
  // …and NOT flagged as a delegate, which is what turns the email third-person.
  assert.strictEqual(r.isDelegate, false);
});

test('a multi-word first_name still wins over the single token they signed', () => {
  const r = resolveSalutation('Anvith K', "Sounds great, let's do it!\n- Anvith");
  assert.strictEqual(r.name, 'Anvith K');
  assert.strictEqual(r.isDelegate, false);
});

test('isSamePerson matches tokens and short forms, not unrelated names', () => {
  assert.ok(isSamePerson('Kam', 'Kamran'));
  assert.ok(isSamePerson('Anvith', 'Anvith K'));
  assert.ok(isSamePerson('jennifer', 'Jennifer'));
  assert.ok(!isSamePerson('Priya', 'Anvith'));
  assert.ok(!isSamePerson('Al', 'Alex')); // too short to be a confident stem
  assert.ok(!isSamePerson('Kam', null));
});

// ── Third person needs evidence ────────────────────────────────────────────

test('a different name with no evidence greets that name but stays second person', () => {
  // We honour the signature — but with nothing saying this is a third party, an
  // email that discusses its own reader in the third person is the worse bet.
  const r = resolveSalutation('Dua', 'Yes, interested!\n\nBest, Sarah');
  assert.strictEqual(r.name, 'Sarah');
  assert.strictEqual(r.isDelegate, false);
});

test('an explicit "X\'s manager" is evidence of a delegate', () => {
  const r = resolveSalutation('Dua', "Hi, this is Alex, Dua's manager. She's keen!");
  assert.strictEqual(r.name, 'Alex');
  assert.strictEqual(r.isDelegate, true);
});

test('a different sending address is evidence of a delegate', () => {
  const r = resolveSalutation('Rachel', 'Thanks for the updated offer.\n\nBest,\nClaudia', {
    senderEmail: 'claudia@talentco.com',
    creatorEmail: 'rachel@gmail.com',
  });
  assert.strictEqual(r.name, 'Claudia');
  assert.strictEqual(r.isDelegate, true);
});

test('the sender-email fallback still names a signature-less third party', () => {
  const r = resolveSalutation('Rachel', 'Thanks for the updated offer.\n\nWould $6,000 work?\n\nBest,', {
    senderEmail: 'claudia@example.com',
    creatorEmail: 'idkrachex@gmail.com',
  });
  assert.strictEqual(r.name, 'Claudia');
  assert.strictEqual(r.isDelegate, true);
  assert.strictEqual(r.source, 'sender_email');
});

test('a From header in "Name <addr>" form resolves to the address local part', () => {
  const r = resolveSalutation('Rachel', 'Thanks!\n\nBest,', {
    senderEmail: 'Claudia Villondo <claudia.villondo@example.com>',
    creatorEmail: 'rachel@gmail.com',
  });
  assert.strictEqual(r.name, 'Claudia');
});

test('the same address written with different casing is not a third party', () => {
  const r = resolveSalutation('Rachel', 'Sounds great, tell me more!', {
    senderEmail: 'Rachel@Gmail.com',
    creatorEmail: 'rachel@gmail.com',
  });
  assert.strictEqual(r.name, 'Rachel');
  assert.strictEqual(r.isDelegate, false);
});

test('falls back to the creator, then to "there"', () => {
  assert.strictEqual(salutationFor('Dua', 'sounds great, tell me more'), 'Dua');
  assert.strictEqual(salutationFor(null, 'sounds great'), 'there');
});

// ── The cached greeting heals itself ───────────────────────────────────────

test('sanitizeStored drops a cached greeting that is one of our own names', () => {
  // This is what made the bug recur: once "Jennifer" was written to
  // creators.reply_salutation, every later send preferred it over re-detection.
  assert.strictEqual(sanitizeStored('Jennifer', 'Kam'), null);
  assert.strictEqual(sanitizeStored('Influence', 'Kam'), null);
  assert.strictEqual(sanitizeStored('there', 'Kam'), null);
  assert.strictEqual(sanitizeStored('', 'Kam'), null);
  assert.strictEqual(sanitizeStored(null, 'Kam'), null);
});

test('sanitizeStored keeps a real greeting, including an admin-typed one', () => {
  assert.strictEqual(sanitizeStored('Kam', 'Kam'), 'Kam');
  assert.strictEqual(sanitizeStored('Alex', 'Kam'), 'Alex');
  assert.strictEqual(sanitizeStored('Anvith K', 'Anvith K'), 'Anvith K');
  // A creator named like us keeps their own name.
  assert.strictEqual(sanitizeStored('Jennifer', 'Jennifer'), 'Jennifer');
});
