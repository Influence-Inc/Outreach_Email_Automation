'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { launchdPlist, systemdUnit } = require('./serviceUnit');

const opts = { nodePath: '/usr/bin/node', entry: '/opt/runner/src/index.js', workingDir: '/opt/runner' };

test('launchdPlist embeds node + entry and starts at load, restarting on crash', () => {
  const p = launchdPlist({ ...opts, label: 'com.test.runner' });
  assert.match(p, /<string>com\.test\.runner<\/string>/);
  assert.match(p, /<string>\/usr\/bin\/node<\/string>/);
  assert.match(p, /<string>\/opt\/runner\/src\/index\.js<\/string>/);
  assert.match(p, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(p, /<key>KeepAlive<\/key><true\/>/);
  assert.match(p, /StandardOutPath.*runner\.log/s);
});

test('systemdUnit runs the entry with always-restart', () => {
  const u = systemdUnit({ ...opts, restartSec: 15 });
  assert.match(u, /ExecStart=\/usr\/bin\/node \/opt\/runner\/src\/index\.js/);
  assert.match(u, /WorkingDirectory=\/opt\/runner/);
  assert.match(u, /Restart=always/);
  assert.match(u, /RestartSec=15/);
  assert.match(u, /WantedBy=default\.target/);
});
