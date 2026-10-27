'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fv = require('./feedVirality');

test('views are estimated from likes and comments with creator-list\'s engagement rates', () => {
  // 3,200 reactions: 100K at the 3.2% median, 57K at 5.6%, 137K at 2.34%.
  assert.deepStrictEqual(fv.estimate({ likes: 3000, comments: 200 }), {
    views: 100000, low: 57143, high: 136752, from: 'likes',
  });
});

test('a view count on screen is used as it is', () => {
  assert.deepStrictEqual(fv.estimate({ likes: 10, views: 250000 }), { views: 250000, low: 250000, high: 250000, from: 'views' });
});

test('hidden likes and comments cannot be estimated, and are let through', () => {
  assert.strictEqual(fv.estimate({}), null);
  const c = fv.check({ likes: null, comments: null }, { viralViews: 100000 });
  assert.strictEqual(c.pass, true);
  assert.match(c.reason, /hidden/);
});

test('the reel passes when even its generous estimate reaches the viral bar', () => {
  // 2,400 reactions: high estimate 102.6K, median 75K.
  assert.strictEqual(fv.check({ likes: 2300, comments: 100 }, { viralViews: 100000 }).pass, true);
  const low = fv.check({ likes: 1500, comments: 50 }, { viralViews: 100000 });
  assert.strictEqual(low.pass, false);
  assert.strictEqual(low.reason, 'about 48K views (28K–66K) from 2K likes and 50 comments — below the 100K viral bar');
});

test('the median rate can be overridden, keeping the spread', () => {
  const e = fv.estimate({ likes: 4000 }, { env: { SOURCING_FEED_ENGAGEMENT_RATE: '0.04' } });
  assert.strictEqual(e.views, 100000);
  assert.ok(e.low < e.views && e.views < e.high);
});
