'use strict';

// Run with: npm test  (node --test)
const test = require('node:test');
const assert = require('node:assert');
const {
  enrichEmail,
  normalizeUrl,
  hostOf,
  isLinkHub,
  isUsableEmail,
  extractEmailsFromHtml,
  extractLinksFromHtml,
  pickBestEmail,
  contactPagesFor,
  creatorTokens,
  relatesToCreator,
  isCreatorContactEmail,
  isSponsoredLink,
} = require('./emailEnrich');

test('normalizeUrl adds https, rejects non-URLs', () => {
  assert.strictEqual(normalizeUrl('birdsofparadyes.com'), 'https://birdsofparadyes.com/');
  assert.strictEqual(normalizeUrl('https://x.com/path'), 'https://x.com/path');
  assert.strictEqual(normalizeUrl('  http://y.io '), 'http://y.io/');
  assert.strictEqual(normalizeUrl('just some text'), null);
  assert.strictEqual(normalizeUrl(''), null);
  assert.strictEqual(normalizeUrl(null), null);
  assert.strictEqual(normalizeUrl('ftp://nope.com'), null);
});

test('hostOf strips www and lowercases', () => {
  assert.strictEqual(hostOf('https://www.Brand.com/x'), 'brand.com');
  assert.strictEqual(hostOf('https://linktr.ee/abc'), 'linktr.ee');
  assert.strictEqual(hostOf('nonsense'), null);
});

test('isLinkHub recognises bio-hub hosts', () => {
  assert.strictEqual(isLinkHub('https://linktr.ee/someone'), true);
  assert.strictEqual(isLinkHub('https://www.beacons.ai/x'), true);
  assert.strictEqual(isLinkHub('https://mybrand.com'), false);
});

test('isUsableEmail filters assets, placeholders, and non-inbox domains', () => {
  assert.strictEqual(isUsableEmail('hi@brand.com'), true);
  assert.strictEqual(isUsableEmail('yushika@birdsofparadyes.com'), true);
  assert.strictEqual(isUsableEmail('logo@2x.png'), false); // asset
  assert.strictEqual(isUsableEmail('you@example.com'), false); // placeholder + junk domain
  assert.strictEqual(isUsableEmail('name@yourdomain.com'), false);
  assert.strictEqual(isUsableEmail('team@sentry.io'), false); // analytics
  assert.strictEqual(isUsableEmail('hello@instagram.com'), false);
});

test('extractEmailsFromHtml pulls mailto + text, drops junk, dedupes', () => {
  const html = `
    <a href="mailto:hi@brand.com">email</a>
    <p>reach me at hi@brand.com or team@brand.com</p>
    <img src="logo@2x.png">
    <span>placeholder you@example.com</span>
  `;
  assert.deepStrictEqual(extractEmailsFromHtml(html), ['hi@brand.com', 'team@brand.com']);
  assert.deepStrictEqual(extractEmailsFromHtml(''), []);
});

test('extractEmailsFromHtml decodes percent-encoded mailto', () => {
  const html = '<a href="mailto:jj%40brand.com">x</a>';
  assert.deepStrictEqual(extractEmailsFromHtml(html), ['jj@brand.com']);
});

test('extractLinksFromHtml resolves relative, drops mailto/assets', () => {
  const html = `
    <a href="/about">About</a>
    <a href="https://mybrand.com/shop">Shop</a>
    <a href="mailto:x@y.com">Mail</a>
    <a href="/logo.png">img</a>
  `;
  const links = extractLinksFromHtml(html, 'https://hub.example/u');
  assert.ok(links.includes('https://hub.example/about'));
  assert.ok(links.includes('https://mybrand.com/shop'));
  assert.ok(!links.some((l) => l.includes('mailto')));
  assert.ok(!links.some((l) => l.endsWith('.png')));
});

test('pickBestEmail prefers the on-domain address', () => {
  assert.strictEqual(
    pickBestEmail(['random@gmail.com', 'hi@brand.com'], 'brand.com'),
    'hi@brand.com',
  );
  // No on-domain match -> first usable.
  assert.strictEqual(pickBestEmail(['random@gmail.com'], 'brand.com'), 'random@gmail.com');
  assert.strictEqual(pickBestEmail([], 'brand.com'), null);
});

test('contactPagesFor builds sibling contact/about URLs', () => {
  const pages = contactPagesFor('https://brand.com/home');
  assert.ok(pages.includes('https://brand.com/contact'));
  assert.ok(pages.includes('https://brand.com/about'));
});

// ---- Orchestrator (fake fetcher, verify disabled) -------------------------

function fakeFetcher(map) {
  return async (url) => (Object.prototype.hasOwnProperty.call(map, url) ? map[url] : null);
}

test('enrichEmail finds an on-domain email on the creator site', async () => {
  const fetchHtml = fakeFetcher({
    'https://birdsofparadyes.com/':
      '<a href="mailto:yushika@birdsofparadyes.com">Email us</a>',
  });
  const res = await enrichEmail(
    { externalUrl: 'birdsofparadyes.com', fullName: 'Yushika Jolly' },
    { fetchHtml, verify: false },
  );
  assert.deepStrictEqual(res, {
    email: 'yushika@birdsofparadyes.com',
    source: 'https://birdsofparadyes.com/',
  });
});

test('enrichEmail expands a Linktree hub to the real site', async () => {
  const fetchHtml = fakeFetcher({
    'https://linktr.ee/yushika':
      '<a href="https://mybrand.com">My site</a><a href="https://instagram.com/x">IG</a>',
    'https://mybrand.com/': '<p>contact hello@mybrand.com</p>',
  });
  const res = await enrichEmail(
    { bioLinks: ['https://linktr.ee/yushika'] },
    { fetchHtml, verify: false },
  );
  assert.deepStrictEqual(res, { email: 'hello@mybrand.com', source: 'https://mybrand.com/' });
});

test('enrichEmail reads an email pasted on the hub page itself', async () => {
  const fetchHtml = fakeFetcher({
    'https://linktr.ee/u': '<p>bookings: bookme@studio.co</p>',
  });
  const res = await enrichEmail({ bioLinks: ['https://linktr.ee/u'] }, { fetchHtml, verify: false });
  assert.deepStrictEqual(res, { email: 'bookme@studio.co', source: 'https://linktr.ee/u' });
});

test('enrichEmail falls to a /contact page when the home page has none', async () => {
  const fetchHtml = fakeFetcher({
    'https://brand.com/': '<p>welcome</p>',
    'https://brand.com/contact': '<a href="mailto:hi@brand.com">reach us</a>',
  });
  const res = await enrichEmail({ externalUrl: 'https://brand.com/' }, { fetchHtml, verify: false });
  assert.deepStrictEqual(res, { email: 'hi@brand.com', source: 'https://brand.com/contact' });
});

test('enrichEmail returns null when there are no links or no email', async () => {
  const noLinks = await enrichEmail({ fullName: 'No Links' }, { fetchHtml: fakeFetcher({}), verify: false });
  assert.strictEqual(noLinks, null);

  const noEmail = await enrichEmail(
    { externalUrl: 'https://empty.com/' },
    { fetchHtml: fakeFetcher({ 'https://empty.com/': '<p>nothing here</p>' }), verify: false },
  );
  assert.strictEqual(noEmail, null);
});

test('enrichEmail picks a URL out of the biography text', async () => {
  const fetchHtml = fakeFetcher({
    'https://portfolio.me/': '<a href="mailto:me@portfolio.me">hire me</a>',
  });
  const res = await enrichEmail(
    { biography: 'photographer · portfolio: https://portfolio.me/ · dm for rates' },
    { fetchHtml, verify: false },
  );
  assert.deepStrictEqual(res, { email: 'me@portfolio.me', source: 'https://portfolio.me/' });
});

// ---- Third-party brand / sponsored-link filtering -------------------------

test('creatorTokens splits name + handle into matchable tokens', () => {
  const t = creatorTokens({ fullName: 'Yushika Jolly', instagramUsername: 'yushikajolly' });
  assert.ok(t.words.includes('yushika'));
  assert.ok(t.words.includes('jolly'));
  assert.strictEqual(t.handle, 'yushikajolly');
});

test('relatesToCreator matches a name in the local part but not a coincidental substring', () => {
  const t = creatorTokens({ fullName: 'Yushika Jolly', instagramUsername: 'yushikajolly' });
  assert.strictEqual(relatesToCreator('yushika', 'birdsofparadyes.com', t), true);
  const arch = creatorTokens({ fullName: 'Arch Apollo', instagramUsername: 'architect.apollo' });
  // "research@..." must not be treated as related to the token "arch".
  assert.strictEqual(relatesToCreator('research', 'somesite.com', arch), false);
  assert.strictEqual(relatesToCreator('pxvbusiness', 'gmail.com', arch), false);
});

test('isCreatorContactEmail drops support/role mailboxes', () => {
  assert.strictEqual(isCreatorContactEmail('support@higgsfield.ai'), false);
  assert.strictEqual(isCreatorContactEmail('support@mail.pippit.ai'), false);
  assert.strictEqual(isCreatorContactEmail('no-reply@brand.com'), false);
  assert.strictEqual(isCreatorContactEmail('support+creator@brand.com'), false);
  // …but keeps legitimate creator / manager inboxes.
  assert.strictEqual(isCreatorContactEmail('hello@brand.com'), true);
  assert.strictEqual(isCreatorContactEmail('bookings@studio.co'), true);
  assert.strictEqual(isCreatorContactEmail('management@agency.com'), true);
});

test('isCreatorContactEmail drops unrelated free-mail but keeps creator-named free-mail', () => {
  const arch = creatorTokens({ fullName: 'Arch Apollo', instagramUsername: 'architect.apollo' });
  assert.strictEqual(isCreatorContactEmail('pxvbusiness@gmail.com', { tokens: arch }), false);
  const yush = creatorTokens({ fullName: 'Yushika Jolly', instagramUsername: 'yushikajolly' });
  // A creator's own name on a free-mail address is still theirs.
  assert.strictEqual(isCreatorContactEmail('yushikajolly@gmail.com', { tokens: yush }), true);
  // On-domain address on the creator's own brand site (different name) is kept.
  assert.strictEqual(isCreatorContactEmail('yushika@birdsofparadyes.com', { tokens: yush }), true);
});

test('isSponsoredLink flags any query string + affiliate paths, keeps clean links', () => {
  // Any "?…" tail is treated as tracking/referral/promo → sponsored.
  assert.strictEqual(isSponsoredLink('https://brand.com/product?aff=123'), true);
  assert.strictEqual(isSponsoredLink('https://brand.com/?coupon=SAVE20'), true);
  assert.strictEqual(isSponsoredLink('https://brand.com/?ref=instagram'), true);
  assert.strictEqual(isSponsoredLink('https://brand.com/?utm_source=ig&utm_medium=bio'), true);
  assert.strictEqual(isSponsoredLink('https://brand.com/?via=creator'), true);
  // Affiliate/referral path segment, no query string.
  assert.strictEqual(isSponsoredLink('https://brand.com/affiliate/xyz'), true);
  // A creator's own clean link (bare domain / plain path / fragment) is kept.
  assert.strictEqual(isSponsoredLink('https://mysite.com/'), false);
  assert.strictEqual(isSponsoredLink('https://mysite.com'), false);
  assert.strictEqual(isSponsoredLink('https://mysite.com/about'), false);
  assert.strictEqual(isSponsoredLink('https://mysite.com/#contact'), false);
});

test('isSponsoredLink carves out a tracked link on the creator own-name domain', () => {
  const yush = creatorTokens({ fullName: 'Yushika Jolly', instagramUsername: 'yushikajolly' });
  // Query tail on the creator's own-name domain -> still followed.
  assert.strictEqual(isSponsoredLink('https://yushika-studio.com/?utm_source=ig', yush), false);
  assert.strictEqual(isSponsoredLink('https://www.yushikajolly.com/?ref=x', yush), false);
  // Same tail on an unrelated brand domain -> still sponsored.
  assert.strictEqual(isSponsoredLink('https://higgsfield.ai/?ref=creator', yush), true);
  // Without tokens, any query tail is sponsored (unchanged behaviour).
  assert.strictEqual(isSponsoredLink('https://yushika-studio.com/?utm_source=ig'), true);
});

test('enrichEmail ignores a third-party brand support address (higgsfield case)', async () => {
  const fetchHtml = fakeFetcher({
    'https://higgsfield.ai/': '<a href="mailto:support@higgsfield.ai">support</a>',
  });
  const res = await enrichEmail(
    { fullName: 'Akshay Bhatti', instagramUsername: 'ai.akshu', bioLinks: ['https://higgsfield.ai'] },
    { fetchHtml, verify: false },
  );
  assert.strictEqual(res, null);
});

test('enrichEmail ignores an unrelated free-mail on a promoted brand site (morphix case)', async () => {
  const fetchHtml = fakeFetcher({
    'https://morphix.pro/': '<p>business enquiries pxvbusiness@gmail.com</p>',
  });
  const res = await enrichEmail(
    { fullName: 'Arch Apollo', instagramUsername: 'architect.apollo', bioLinks: ['https://morphix.pro'] },
    { fetchHtml, verify: false },
  );
  assert.strictEqual(res, null);
});

test('enrichEmail keeps a creator-named email on their own differently-named brand site', async () => {
  const fetchHtml = fakeFetcher({
    'https://birdsofparadyes.com/': '<a href="mailto:yushika@birdsofparadyes.com">email us</a>',
  });
  const res = await enrichEmail(
    { fullName: 'Yushika Jolly', instagramUsername: 'yushikajolly', externalUrl: 'birdsofparadyes.com' },
    { fetchHtml, verify: false },
  );
  assert.deepStrictEqual(res, {
    email: 'yushika@birdsofparadyes.com',
    source: 'https://birdsofparadyes.com/',
  });
});

test('enrichEmail skips a sponsored bio link and enriches from the creator own site', async () => {
  const fetchHtml = fakeFetcher({
    // Sponsored link — must never be fetched/scraped.
    'https://brand.com/?aff=abc': '<a href="mailto:support@brand.com">support</a>',
    'https://mysite.com/': '<a href="mailto:hello@mysite.com">say hi</a>',
  });
  const res = await enrichEmail(
    { instagramUsername: 'creator', bioLinks: ['https://brand.com/?aff=abc', 'https://mysite.com'] },
    { fetchHtml, verify: false },
  );
  assert.deepStrictEqual(res, { email: 'hello@mysite.com', source: 'https://mysite.com/' });
});

test('enrichEmail skips a tracked brand link even when its email is a non-role on-domain address', async () => {
  // The residual case: a promoted brand whose site lists hello@brand.ai (shape-
  // identical to a creator's own hello@theirbrand.com). The tracking tail on the
  // link is what marks it sponsored, so we never fetch it — and fall through to
  // the creator's own clean link instead.
  const fetchHtml = fakeFetcher({
    'https://brand.ai/?utm_source=ig': '<a href="mailto:hello@brand.ai">contact</a>',
    'https://myportfolio.com/': '<a href="mailto:hi@myportfolio.com">reach me</a>',
  });
  const res = await enrichEmail(
    {
      instagramUsername: 'creator',
      bioLinks: ['https://brand.ai/?utm_source=ig', 'https://myportfolio.com'],
    },
    { fetchHtml, verify: false },
  );
  assert.deepStrictEqual(res, { email: 'hi@myportfolio.com', source: 'https://myportfolio.com/' });
});

test('enrichEmail returns null when the only bio link is a tracked brand link', async () => {
  const fetchHtml = fakeFetcher({
    'https://brand.ai/?via=creator': '<a href="mailto:hello@brand.ai">contact</a>',
  });
  const res = await enrichEmail(
    { instagramUsername: 'creator', bioLinks: ['https://brand.ai/?via=creator'] },
    { fetchHtml, verify: false },
  );
  assert.strictEqual(res, null);
});

test('enrichEmail still follows a tracked link when its domain carries the creator name', async () => {
  const fetchHtml = fakeFetcher({
    'https://yushika-studio.com/?utm_source=instagram':
      '<a href="mailto:hi@yushika-studio.com">email</a>',
  });
  const res = await enrichEmail(
    {
      fullName: 'Yushika Jolly',
      instagramUsername: 'yushikajolly',
      externalUrl: 'https://yushika-studio.com/?utm_source=instagram',
    },
    { fetchHtml, verify: false },
  );
  assert.deepStrictEqual(res, {
    email: 'hi@yushika-studio.com',
    source: 'https://yushika-studio.com/?utm_source=instagram',
  });
});
