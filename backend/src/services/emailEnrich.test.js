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
    source: 'web:birdsofparadyes.com',
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
  assert.deepStrictEqual(res, { email: 'hello@mybrand.com', source: 'web:mybrand.com' });
});

test('enrichEmail reads an email pasted on the hub page itself', async () => {
  const fetchHtml = fakeFetcher({
    'https://linktr.ee/u': '<p>bookings: bookme@studio.co</p>',
  });
  const res = await enrichEmail({ bioLinks: ['https://linktr.ee/u'] }, { fetchHtml, verify: false });
  assert.deepStrictEqual(res, { email: 'bookme@studio.co', source: 'web:linktr.ee' });
});

test('enrichEmail falls to a /contact page when the home page has none', async () => {
  const fetchHtml = fakeFetcher({
    'https://brand.com/': '<p>welcome</p>',
    'https://brand.com/contact': '<a href="mailto:hi@brand.com">reach us</a>',
  });
  const res = await enrichEmail({ externalUrl: 'https://brand.com/' }, { fetchHtml, verify: false });
  assert.deepStrictEqual(res, { email: 'hi@brand.com', source: 'web:brand.com' });
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
  assert.deepStrictEqual(res, { email: 'me@portfolio.me', source: 'web:portfolio.me' });
});
