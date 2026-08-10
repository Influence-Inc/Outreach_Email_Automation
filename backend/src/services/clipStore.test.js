'use strict';

const test = require('node:test');
const assert = require('node:assert');
const cs = require('./clipStore');

test.afterEach(() => cs._reset());

test('put returns an id; get reads and take consumes the bytes', () => {
  const id = cs.put(1, Buffer.from('MP4'), 'video/mp4');
  assert.match(id, /^clip_/);
  assert.strictEqual(cs.get(id).buf.toString(), 'MP4');
  assert.strictEqual(cs.get(id).mediaType, 'video/mp4');
  const taken = cs.take(id);
  assert.strictEqual(taken.buf.toString(), 'MP4');
  assert.strictEqual(cs.get(id), null, 'consumed after take');
});

test('rejects empty and oversized clips', () => {
  assert.throws(() => cs.put(1, Buffer.alloc(0)), /empty/);
  assert.throws(() => cs.put(1, Buffer.alloc(cs.MAX_BYTES + 1)), /too large/);
});

test('evicts the oldest clip beyond the count cap', () => {
  const ids = [];
  for (let i = 0; i < cs.MAX_CLIPS + 2; i += 1) ids.push(cs.put(1, Buffer.from(`x${i}`)));
  assert.strictEqual(cs.get(ids[0]), null, 'oldest evicted');
  assert.ok(cs.get(ids[ids.length - 1]), 'newest still present');
});
