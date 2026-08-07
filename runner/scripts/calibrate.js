#!/usr/bin/env node
'use strict';

// Offline vision calibration — no backend, no DB, no deploy.
//
// Feed it a `uiautomator dump` from the phone and it shows EXACTLY what the
// server-side screen reader (backend/src/services/screenVision.js) makes of that
// screen: the classification, the tap targets it found, and the data it captured.
// If a target is missing or the screen is misclassified, tweak SIGNALS in
// screenVision.js and re-run — this is the fast loop for getting the reader right
// against the real Instagram build before the first live run.
//
// Usage (from the runner/ dir):
//   adb shell uiautomator dump /sdcard/d.xml && adb exec-out cat /sdcard/d.xml | npm run calibrate
//   # or from a saved file:
//   node scripts/calibrate.js path/to/dump.xml

const fs = require('fs');
const { parseUiXml } = require('../src/driver/android');
// Same module the deployed backend runs — so what you see here is what prod will read.
const { readScreen } = require('../../backend/src/services/screenVision');

function readInput() {
  const file = process.argv[2];
  if (file) return fs.readFileSync(file, 'utf8');
  return fs.readFileSync(0, 'utf8'); // stdin
}

function main() {
  const xml = readInput();
  if (!xml || !xml.includes('<node')) {
    console.error('No UI nodes found. Pipe in `adb exec-out cat /sdcard/d.xml` or pass a dump file.');
    process.exit(1);
  }
  const elements = parseUiXml(xml);
  const reading = readScreen({ elements });

  console.log(`\nParsed ${elements.length} UI elements.`);
  console.log(`\nSCREEN:  ${reading.screen}`);

  const targets = reading.targets || {};
  const names = Object.keys(targets);
  console.log(`\nTAP TARGETS (${names.length}):`);
  if (!names.length) console.log('  (none — the reader could not locate any tappable affordance)');
  for (const n of names) console.log(`  ${n.padEnd(22)} -> (${targets[n].x}, ${targets[n].y})`);

  const captured = { ...reading };
  delete captured.screen;
  delete captured.targets;
  if (Object.keys(captured).length) {
    console.log('\nCAPTURED DATA:');
    console.log(JSON.stringify(captured, null, 2).split('\n').map((l) => `  ${l}`).join('\n'));
  }

  if (reading.screen === 'unknown') {
    console.log('\n⚠  screen=unknown: no SIGNALS matched. Compare the resource-id / content-desc /');
    console.log('   text of the elements you expected against SIGNALS in');
    console.log('   backend/src/services/screenVision.js, and adjust the strings.');
  }
  console.log('');
}

main();
