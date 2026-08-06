'use strict';

// Run with: npm test  (node --test)
//
// splitQuotedReply separates what the sender just typed from the copy of our
// own email their mail client pasted underneath. Everything downstream that
// asks "who wrote this / what did they say" depends on the split landing in the
// right place, so the cases below cover the quote shapes the major clients
// actually emit — plus the two failure modes that matter: never swallowing the
// real message, and never leaving our own sign-off in the "new" half.
const test = require('node:test');
const assert = require('node:assert');
const { splitQuotedReply, stripQuotedReply } = require('./emailQuote');

test('splits at a Gmail "On … wrote:" attribution', () => {
  const raw = [
    'Sounds good, let us do it!',
    '',
    'Best,',
    'Kam',
    '',
    'On Thu, 06 Aug 2026 22:21:16 +0000, Jennifer Max <jennifer@frominfluence.com> wrote:',
    '',
    'Hi Kam,',
    '',
    '- Jennifer',
  ].join('\n');
  const { latest, quoted } = splitQuotedReply(raw);
  assert.strictEqual(latest, 'Sounds good, let us do it!\n\nBest,\nKam');
  assert.match(quoted, /- Jennifer/);
});

test('splits when Gmail hard-wraps the attribution across lines', () => {
  // The single-line "wrote:" regex the old stripper used missed this shape
  // entirely, leaving our whole email attached to theirs.
  const raw = [
    'Works for me.',
    '',
    '- Kam',
    '',
    'On Thu, Aug 6, 2026 at 10:21 PM Jennifer Max <jennifer@frominfluence.com>',
    'wrote:',
    '',
    '> Hi Kam,',
    '> - Jennifer',
  ].join('\n');
  assert.strictEqual(splitQuotedReply(raw).latest, 'Works for me.\n\n- Kam');
});

test('splits at Outlook / forwarded separators and header blocks', () => {
  const original = 'Happy with that.\n\nThanks,\nPriya';
  const shapes = [
    '-----Original Message-----\nFrom: Jennifer Max\nSent: Thursday\nHi Priya,',
    '________________________________\nFrom: Jennifer Max <jennifer@x.com>\nSent: Thursday\nSubject: Re: collab',
    '---------- Forwarded message ---------\nFrom: Jennifer Max <jennifer@x.com>\nDate: Thu, Aug 6\n',
    'From: Jennifer Max <jennifer@x.com>\nSent: Thursday, August 6, 2026\nTo: Priya\nSubject: Re: collab',
  ];
  for (const tail of shapes) {
    assert.strictEqual(splitQuotedReply(`${original}\n\n${tail}`).latest, original, tail.split('\n')[0]);
  }
});

test('splits at an HTML blockquote / gmail_quote container', () => {
  const raw =
    '<div dir="ltr">Sounds great!<br><br>Best,<br>Kam</div>' +
    '<div class="gmail_quote"><blockquote>Hi Kam,<br>- Jennifer</blockquote></div>';
  const { latest, quoted } = splitQuotedReply(raw);
  assert.match(latest, /Sounds great!/);
  assert.match(latest, /Kam/);
  assert.doesNotMatch(latest, /Jennifer/);
  assert.match(quoted, /Jennifer/);
});

test('drops mail-client footers so they cannot be read as the last line', () => {
  assert.strictEqual(
    splitQuotedReply('Let us go ahead.\n\n- Kam\n\nSent from my iPhone').latest,
    'Let us go ahead.\n\n- Kam',
  );
});

test('keeps the sender own signature — name detection needs it', () => {
  // The signature is the whole point of the "latest" half: it is where the
  // sender's name comes from. Only the QUOTED sign-off gets removed.
  const raw = 'All good.\n\nBest,\nTang\n\nOn Thu, Aug 6, 2026 at 1:00 PM Jennifer <j@x.com> wrote:\n> - Jennifer';
  assert.match(splitQuotedReply(raw).latest, /Tang/);
});

test('removes inline ">" quoting without cutting off the reply around it', () => {
  // Replying between the quoted lines is a real (if rarer) style — the sender's
  // own lines after a quoted chunk must survive.
  const raw = ['> Can you post on Instagram?', 'Yes, Instagram works.', '> And TikTok?', 'TikTok too.'].join('\n');
  assert.strictEqual(splitQuotedReply(raw).latest, 'Yes, Instagram works.\nTikTok too.');
});

test('leaves an ordinary message untouched', () => {
  const raw = 'Hi Jennifer,\n\nOn Monday I can shoot, and I wrote a script already:\ntwo scenes.\n\n- Kam';
  const { latest, quoted } = splitQuotedReply(raw);
  assert.strictEqual(latest, raw);
  assert.strictEqual(quoted, '');
});

test('does not treat a sentence starting with "From:" as a header block', () => {
  const raw = 'From: my end this all looks good.\n\nLet me know.\n\n- Kam';
  assert.strictEqual(splitQuotedReply(raw).latest, raw);
});

test('stripQuotedReply never returns empty for a non-empty message', () => {
  // A body that is nothing BUT quoted history would otherwise strip to '' and
  // leave callers with no text at all; the original is the safer answer.
  const onlyQuoted = 'On Thu, Aug 6, 2026 at 1:00 PM Jennifer <j@x.com> wrote:\n> Hi Kam,\n> - Jennifer';
  assert.strictEqual(stripQuotedReply(onlyQuoted), onlyQuoted);
  assert.strictEqual(stripQuotedReply('Just this.'), 'Just this.');
  assert.strictEqual(stripQuotedReply(''), '');
  assert.strictEqual(stripQuotedReply(null), '');
});

test('normalizes CRLF line endings before splitting', () => {
  const raw = 'Sounds good.\r\n\r\n- Kam\r\n\r\nOn Thu, Aug 6, 2026 at 1:00 PM Jennifer <j@x.com> wrote:\r\n> hi';
  assert.strictEqual(splitQuotedReply(raw).latest, 'Sounds good.\n\n- Kam');
});
