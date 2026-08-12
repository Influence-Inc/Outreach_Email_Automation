#!/usr/bin/env node
'use strict';

// Guided one-time setup for the sourcing runner.
//
//   cd runner && npm run setup
//
// Walks through: backend URL + host token, scout vs agent mode, USB vs Wi-Fi
// (running the Android-11+ `adb pair`/`adb connect` handshake for you), then
// verifies the phone + Instagram (+ scrcpy for reel audio) and writes everything
// to .runnerrc.json so future runs are just `npm start` — nothing to re-type.
//
// This file is a thin wrapper; the testable logic lives in src/setup.js.

const readline = require('readline');
const { spawnSync } = require('child_process');
const {
  parseDevices, adbPairArgs, adbConnectArgs, buildConfigFromAnswers, missingKeys,
  hostFromInput, portFromInput,
} = require('../src/setup');
const { writeConfigFile, configPath } = require('../src/fileConfig');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q, def) => new Promise((res) => {
  rl.question(def ? `${q} [${def}]: ` : `${q}: `, (a) => res((a || '').trim() || def || ''));
});
const adb = (args) => spawnSync('adb', args, { encoding: 'utf8' });
const has = (cmd) => spawnSync('which', [cmd], { encoding: 'utf8' }).status === 0;

async function main() {
  console.log('\nInfluence sourcing runner — setup\n');

  const backendUrl = await ask('Deal Studio backend URL', 'https://deals.influence.technology');
  const hostToken = await ask("Per-host token (from Scout Creators -> Paired phone-hosts, starts 'sk_')");

  const modeAns = (await ask('Mode: (a)gent = backend drives the phone, (s)cout = navigator on this host', 'a')).toLowerCase();
  const mode = modeAns.startsWith('s') ? 'scout' : 'agent';
  const hostId = mode === 'agent' ? await ask('Paired host id (integer, from the dashboard)') : '';

  const adbAns = (await ask('Connection: (u)sb or (w)ifi', 'u')).toLowerCase();
  const adbMode = adbAns.startsWith('w') ? 'wifi' : 'usb';

  let wifiHost = '';
  let wifiPort = '';
  if (adbMode === 'wifi') {
    console.log('\nOn the phone: Developer options -> Wireless debugging.');
    console.log('Keep the "Pair device with pairing code" popup OPEN while you answer — its');
    console.log('port + code change every time you open it and expire after a minute or two.');
    console.log('Tip: you can paste the whole "ip:port" into any field; only the right piece is used.\n');
    // The popup and the main screen show TWO different ports. Pull the correct
    // piece out of each answer (hostFromInput/portFromInput) so a pasted full
    // "ip:port" can't assemble into a doubled address adb rejects.
    wifiHost = hostFromInput(await ask('Phone IP (just the address, e.g. 192.168.1.5)'));
    const pairPort = portFromInput(await ask('Pairing port — the number after ":" in the PAIRING POPUP (e.g. 46451)'));
    const code = await ask('6-digit pairing code (from the same popup)');
    console.log('Pairing...');
    const pair = adb([...adbPairArgs({ host: wifiHost, pairPort }), code]);
    process.stdout.write(pair.stdout || pair.stderr || '');
    if ((pair.stderr || '').includes('protocol fault') || (pair.stdout || '').includes('protocol fault')) {
      console.log('⚠  Pairing failed — usually the popup expired or the wrong port was used.');
      console.log('   Re-open "Pair device with pairing code" for fresh numbers and re-run setup.');
    }
    wifiPort = portFromInput(
      await ask('Wireless-debugging port — the number after ":" on the MAIN screen (NOT the popup; on Android 11+ it is NOT 5555)', '5555'),
    );
    console.log('Connecting...');
    const conn = adb(adbConnectArgs({ host: wifiHost, port: wifiPort }));
    process.stdout.write(conn.stdout || conn.stderr || '');
  }

  // Verify the phone is visible + authorized.
  const devices = parseDevices(adb(['devices']).stdout);
  console.log('\nadb devices:', devices.map((d) => `${d.serial} ${d.state}`).join(', ') || '(none)');
  const online = devices.filter((d) => d.state === 'device');
  if (!online.length) console.log('⚠  No authorized device yet — plug in / tap Allow / re-pair, then re-run setup.');

  let deviceUdid = '';
  if (adbMode === 'usb' && online.length > 1) {
    deviceUdid = await ask('Multiple devices attached — which serial to use', online[0].serial);
  }

  // Best-effort capability checks.
  const serial = adbMode === 'wifi' ? `${wifiHost}:${wifiPort}` : deviceUdid || (online[0] && online[0].serial);
  if (serial) {
    const ig = adb(['-s', serial, 'shell', 'dumpsys', 'package', 'com.instagram.android']);
    console.log((ig.stdout || '').includes('versionName=') ? '✓ Instagram installed' : '⚠  Instagram not detected on the phone');
  }
  console.log(has('scrcpy') ? '✓ scrcpy found (reel audio capture ready)' : '⚠  scrcpy not found — needed for reel audio (discovery:"reels"). See docs/SOURCING_AI.md');

  const cfg = buildConfigFromAnswers({ backendUrl, hostToken, mode, hostId, adbMode, wifiHost, wifiPort, deviceUdid });
  const gaps = missingKeys(cfg);
  if (gaps.length) console.log(`\n⚠  Still missing: ${gaps.join(', ')} — you can re-run setup or set them as env vars.`);

  const p = writeConfigFile(cfg, configPath(process.env));
  console.log(`\n✓ Wrote ${p}`);
  console.log('\nStart the runner now with:  npm start');
  console.log('To auto-start on boot:      npm run install-service\n');
  rl.close();
}

main().catch((err) => { console.error('setup failed:', err.message); rl.close(); process.exit(1); });
