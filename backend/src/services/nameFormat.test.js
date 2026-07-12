'use strict';

// Run with: npm test  (node --test)
//
// formatFirstName normalizes a raw Instagram display name into the way a
// person would actually write a first name, so the "Hi {firstName}," greeting
// never reads like a bot. The cases below mirror the real creator names that
// motivated it: ALL CAPS, all-lowercase, stylized fonts, and emoji/symbol
// decoration.
const test = require('node:test');
const assert = require('node:assert');
const { formatFirstName } = require('./nameFormat');

test('title-cases ALL CAPS and all-lowercase names', () => {
  assert.strictEqual(formatFirstName('PEAR'), 'Pear');
  assert.strictEqual(formatFirstName('taoagou'), 'Taoagou');
});

test('leaves an already well-formed name unchanged', () => {
  assert.strictEqual(formatFirstName('Rabin'), 'Rabin');
  assert.strictEqual(formatFirstName('Gayatri'), 'Gayatri');
});

test('folds stylized unicode fonts back to plain letters', () => {
  assert.strictEqual(formatFirstName('ᴠᴇʀᴍᴏꜱᴀ'), 'Vermosa'); // small caps
  assert.strictEqual(formatFirstName('𝐉𝐚𝐧𝐞'), 'Jane'); // math bold
  assert.strictEqual(formatFirstName('Ｊａｎｅ'), 'Jane'); // fullwidth
});

test('strips leading/surrounding emoji and symbols', () => {
  assert.strictEqual(formatFirstName('🤍 Gayatri'), 'Gayatri');
  assert.strictEqual(formatFirstName('★ 🖇️  Najwa Q  ◟♡ ˒'), 'Najwa Q');
});

test('preserves multi-word names and trailing initials', () => {
  assert.strictEqual(formatFirstName('Anvith K'), 'Anvith K');
  assert.strictEqual(formatFirstName('anvith k'), 'Anvith K');
});

test('preserves legitimate accents', () => {
  assert.strictEqual(formatFirstName('José'), 'José');
  assert.strictEqual(formatFirstName('JOSÉ'), 'José');
});

test('returns "" when nothing name-like survives', () => {
  assert.strictEqual(formatFirstName(''), '');
  assert.strictEqual(formatFirstName('   '), '');
  assert.strictEqual(formatFirstName(null), '');
  assert.strictEqual(formatFirstName(undefined), '');
  assert.strictEqual(formatFirstName('😊'), '');
  assert.strictEqual(formatFirstName('★ ♡ ◟'), '');
});
