'use strict';

// Pure generators for a "start on boot, restart on crash" background service, so
// the paired host is genuinely one-time-setup. Both are USER-level units (no sudo):
// macOS LaunchAgent and Linux systemd --user. Windows gets printed Task Scheduler
// steps from the installer. Kept pure + exported so the exact unit is testable.

function launchdPlist({
  label = 'com.influence.sourcing-runner',
  nodePath,
  entry,
  workingDir,
  logPath,
} = {}) {
  const log = logPath || `${workingDir}/runner.log`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${entry}</string>
  </array>
  <key>WorkingDirectory</key><string>${workingDir}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`;
}

function systemdUnit({
  description = 'Influence sourcing runner',
  nodePath,
  entry,
  workingDir,
  restartSec = 10,
} = {}) {
  return `[Unit]
Description=${description}
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${workingDir}
ExecStart=${nodePath} ${entry}
Restart=always
RestartSec=${restartSec}

[Install]
WantedBy=default.target
`;
}

module.exports = { launchdPlist, systemdUnit };
