'use strict';

// Run with: npm test  (node --test)
//
// The rich-text composer ships twice: in the dashboard (backend/public) and in
// the Chrome extension's "Decide offer" panel (extension/). The extension can't
// load scripts from the backend, so the files are copied — this keeps the two
// copies from drifting apart. Edit backend/public/composer.*, then copy.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..', '..');
const extDir = path.join(root, 'extension');

for (const file of ['composer.js', 'composer.css']) {
  test(`extension/${file} is identical to backend/public/${file}`, { skip: !fs.existsSync(extDir) }, () => {
    const a = fs.readFileSync(path.join(root, 'backend', 'public', file), 'utf8');
    const b = fs.readFileSync(path.join(extDir, file), 'utf8');
    assert.ok(a === b, `extension/${file} is out of date — copy backend/public/${file} over it`);
  });
}

test('the extension exposes the composer to its panel iframe', { skip: !fs.existsSync(extDir) }, () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
  const resources = manifest.web_accessible_resources.flatMap((w) => w.resources);
  assert.ok(resources.includes('composer.js') && resources.includes('composer.css'));
  const html = fs.readFileSync(path.join(extDir, 'panel.html'), 'utf8');
  assert.ok(html.indexOf('composer.js') !== -1 && html.indexOf('composer.js') < html.indexOf('panel.js'));
});
