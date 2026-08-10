#!/usr/bin/env node
'use strict';

// Install the runner as a start-on-boot, restart-on-crash background service so
// setup is truly one-time. User-level (no sudo) on macOS + Linux; Windows prints
// Task Scheduler steps. Logic for the unit contents lives in src/serviceUnit.js.
//
//   cd runner && npm run install-service

const fs = require('fs');
const os = require('os');
const path = require('path');
const { launchdPlist, systemdUnit } = require('../src/serviceUnit');

const nodePath = process.execPath;
const workingDir = path.resolve(__dirname, '..');
const entry = path.join(workingDir, 'src', 'index.js');
const LABEL = 'com.influence.sourcing-runner';

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function installDarwin() {
  const dir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  ensureDir(dir);
  const file = path.join(dir, `${LABEL}.plist`);
  fs.writeFileSync(file, launchdPlist({ label: LABEL, nodePath, entry, workingDir }));
  console.log(`✓ Wrote ${file}`);
  console.log('\nLoad it now with:');
  console.log(`  launchctl unload ${file} 2>/dev/null; launchctl load ${file}`);
  console.log('It will now start on login and restart if it crashes.');
}

function installLinux() {
  const dir = path.join(os.homedir(), '.config', 'systemd', 'user');
  ensureDir(dir);
  const file = path.join(dir, 'influence-sourcing-runner.service');
  fs.writeFileSync(file, systemdUnit({ nodePath, entry, workingDir }));
  console.log(`✓ Wrote ${file}`);
  console.log('\nEnable + start it now with:');
  console.log('  systemctl --user daemon-reload');
  console.log('  systemctl --user enable --now influence-sourcing-runner');
  console.log('  loginctl enable-linger "$USER"   # keep it running after logout');
}

function installWindows() {
  console.log('Windows: register a Task Scheduler task that runs on logon:');
  console.log(`  schtasks /Create /SC ONLOGON /TN InfluenceSourcingRunner /TR "\\"${nodePath}\\" \\"${entry}\\"" /RL LIMITED /F`);
  console.log('  (set "Start in" to the runner folder, and enable "Restart if the task fails" in the task properties)');
}

function main() {
  console.log('Installing the sourcing runner as a background service...\n');
  console.log(`node:   ${nodePath}`);
  console.log(`entry:  ${entry}\n`);
  if (process.platform === 'darwin') return installDarwin();
  if (process.platform === 'linux') return installLinux();
  if (process.platform === 'win32') return installWindows();
  console.log(`Unsupported platform '${process.platform}' — run \`npm start\` under your own process manager.`);
}

main();
