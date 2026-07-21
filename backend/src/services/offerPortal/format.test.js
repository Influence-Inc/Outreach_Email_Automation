'use strict';

// Run with: npm test  (node --test)
//
// Guards fillTemplate — the placeholder substitution used by the WhatsApp/
// iMessage brief (campaigns.messaging_brief) and shared with the same
// {firstName}/{brandName}/{campaignName} convention as the email templates.
const test = require('node:test');
const assert = require('node:assert');
const { fillTemplate } = require('./format');

test('fillTemplate substitutes known placeholders', () => {
  assert.strictEqual(
    fillTemplate('Hi {firstName}, {brandName} loved your last reel!', {
      firstName: 'Sam',
      brandName: 'Acme',
    }),
    'Hi Sam, Acme loved your last reel!',
  );
});

test('fillTemplate leaves unknown placeholders intact', () => {
  assert.strictEqual(fillTemplate('{firstName} + {unknown}', { firstName: 'Sam' }), 'Sam + {unknown}');
});

test('fillTemplate renders a null/undefined var as empty string', () => {
  assert.strictEqual(fillTemplate('Hi {firstName}.', { firstName: null }), 'Hi .');
  assert.strictEqual(fillTemplate('Hi {firstName}.', { firstName: undefined }), 'Hi .');
});

test('fillTemplate tolerates a null/empty template', () => {
  assert.strictEqual(fillTemplate(null, {}), '');
  assert.strictEqual(fillTemplate('', {}), '');
});
