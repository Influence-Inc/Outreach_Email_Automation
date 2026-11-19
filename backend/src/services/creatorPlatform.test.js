const test = require('node:test');
const assert = require('node:assert');
const { detectPlatform, parseProfileUrl, platformOf } = require('./creatorPlatform');

test('detectPlatform recognises the three supported sites', () => {
  assert.strictEqual(detectPlatform('https://www.instagram.com/foo/'), 'instagram');
  assert.strictEqual(detectPlatform('https://www.tiktok.com/@foo'), 'tiktok');
  assert.strictEqual(detectPlatform('tiktok.com/@foo'), 'tiktok');
  assert.strictEqual(detectPlatform('https://m.youtube.com/@foo'), 'youtube');
  assert.strictEqual(detectPlatform('https://example.com/foo'), null);
  assert.strictEqual(detectPlatform(''), null);
});

test('parseProfileUrl canonicalises Instagram profiles', () => {
  assert.deepStrictEqual(parseProfileUrl('https://instagram.com/Foo.Bar/reels/?hl=en'), {
    platform: 'instagram', username: 'Foo.Bar', url: 'https://www.instagram.com/Foo.Bar/',
  });
  assert.strictEqual(parseProfileUrl('https://www.instagram.com/reel/abc/'), null);
});

test('parseProfileUrl canonicalises TikTok profiles and video links', () => {
  assert.deepStrictEqual(parseProfileUrl('https://www.tiktok.com/@some.creator?lang=en'), {
    platform: 'tiktok', username: 'some.creator', url: 'https://www.tiktok.com/@some.creator',
  });
  assert.deepStrictEqual(parseProfileUrl('https://www.tiktok.com/@x_y/video/7312345678901234567'), {
    platform: 'tiktok', username: 'x_y', url: 'https://www.tiktok.com/@x_y',
  });
  assert.strictEqual(parseProfileUrl('https://www.tiktok.com/foryou'), null);
});

test('parseProfileUrl canonicalises YouTube channel forms', () => {
  assert.deepStrictEqual(parseProfileUrl('https://www.youtube.com/@MrCreator/shorts'), {
    platform: 'youtube', username: 'MrCreator', url: 'https://www.youtube.com/@MrCreator',
  });
  assert.deepStrictEqual(parseProfileUrl('https://youtube.com/channel/UC123abc/videos'), {
    platform: 'youtube', username: 'UC123abc', url: 'https://www.youtube.com/channel/UC123abc',
  });
  assert.deepStrictEqual(parseProfileUrl('https://www.youtube.com/user/OldName'), {
    platform: 'youtube', username: 'OldName', url: 'https://www.youtube.com/user/OldName',
  });
  assert.strictEqual(parseProfileUrl('https://www.youtube.com/watch?v=abc'), null);
  assert.strictEqual(parseProfileUrl('https://www.youtube.com/shorts/abc'), null);
});

test('platformOf prefers the stored column and falls back to the URL', () => {
  assert.strictEqual(platformOf({ platform: 'tiktok' }), 'tiktok');
  assert.strictEqual(platformOf({ instagram_url: 'https://www.youtube.com/@a' }), 'youtube');
  assert.strictEqual(platformOf({}), 'instagram');
});

const { dmTargetFor } = require('./creatorPlatform');

test('dmTargetFor: Instagram / TikTok creators are DM\'d on their own profile', () => {
  assert.deepStrictEqual(
    dmTargetFor({ platform: 'tiktok', instagram_url: 'https://www.tiktok.com/@jane', instagram_username: 'jane' }),
    { platform: 'tiktok', username: 'jane', url: 'https://www.tiktok.com/@jane', via: null },
  );
  assert.strictEqual(dmTargetFor({ platform: 'instagram', instagram_url: 'https://www.instagram.com/sam/', instagram_username: 'sam' }).platform, 'instagram');
});

test('dmTargetFor: a YouTube creator goes to their linked Instagram, else linked TikTok', () => {
  assert.deepStrictEqual(
    dmTargetFor({ platform: 'youtube', bio_links: ['https://www.tiktok.com/@mk', 'http://instagram.com/MKBHD'] }),
    { platform: 'instagram', username: 'MKBHD', url: 'https://www.instagram.com/MKBHD/', via: 'youtube' },
  );
  assert.deepStrictEqual(
    dmTargetFor({ platform: 'youtube', bio_links: ['https://example.com', 'https://www.tiktok.com/@mk?lang=en'] }),
    { platform: 'tiktok', username: 'mk', url: 'https://www.tiktok.com/@mk', via: 'youtube' },
  );
});

test('dmTargetFor: no target for a channel linking no profile (posts / reels don\'t count)', () => {
  assert.strictEqual(dmTargetFor({ platform: 'youtube', bio_links: ['https://www.instagram.com/p/abc/', 'https://x.com/a'] }), null);
  assert.strictEqual(dmTargetFor({ platform: 'youtube', bio_links: null }), null);
});
