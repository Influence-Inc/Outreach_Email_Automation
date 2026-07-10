'use strict';

// Run with: npm test  (node --test)
//
// Guards the outreach {{firstName}} merge-tag fallback: when the scraper
// couldn't find a name for a creator's Instagram profile, the outreach
// email must greet them by @handle instead of an empty string. Fixes the
// jarring "Hi ," greeting.
const test = require('node:test');
const assert = require('node:assert');
const { outreachFirstName } = require('./outreach');

test('outreachFirstName uses first_name verbatim when present', () => {
  assert.strictEqual(
    outreachFirstName({ first_name: 'Rabin', instagram_username: 'rabin' }),
    'Rabin',
  );
});

test('outreachFirstName preserves multi-word first_name (e.g. "Anvith K")', () => {
  assert.strictEqual(
    outreachFirstName({ first_name: 'Anvith K', instagram_username: 'anvith' }),
    'Anvith K',
  );
});

test('outreachFirstName falls back to @<handle> when first_name is empty', () => {
  assert.strictEqual(
    outreachFirstName({ first_name: null, instagram_username: 'rabin' }),
    '@rabin',
  );
  assert.strictEqual(
    outreachFirstName({ first_name: '', instagram_username: 'kota.does.things' }),
    '@kota.does.things',
  );
});

test('outreachFirstName strips any existing @ so we never end up with double @@', () => {
  assert.strictEqual(
    outreachFirstName({ first_name: null, instagram_username: '@rabin' }),
    '@rabin',
  );
  assert.strictEqual(
    outreachFirstName({ first_name: null, instagram_username: '@@rabin' }),
    '@rabin',
  );
});

test('outreachFirstName trims whitespace on first_name before falling back', () => {
  // A whitespace-only first_name is effectively empty — fall back to @handle.
  assert.strictEqual(
    outreachFirstName({ first_name: '   ', instagram_username: 'rabin' }),
    '@rabin',
  );
});

test('outreachFirstName returns "" when neither first_name nor handle exist', () => {
  // Instantly's merge tag will render as empty — better than throwing at
  // send time. This case should be vanishingly rare (a creator row with no
  // Instagram context has no way to reach outreach anyway).
  assert.strictEqual(outreachFirstName({}), '');
  assert.strictEqual(outreachFirstName({ first_name: null, instagram_username: null }), '');
});
