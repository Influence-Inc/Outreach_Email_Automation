# Phase D — Android live E2E checklist

The runner package already ships the Android driver (`src/driver/android.js`)
and the vision-driven Instagram Navigator. Android needs **no Appium and no
extra software** — the driver talks to the phone directly through `adb`
(Google's own Android SDK tool, the same one you use for `adb devices`). What's
left is one-time host setup: install `adb`, connect the phone, and pair a Deal
Studio host token. This checklist is a linear script — do each step, verify the
"expected output" matches, then move on.

The tests from Phase 2 already prove the runner talks to the backend correctly
(commit `db3dbfa` on PR #305 verified this against a real Postgres). Anything
that goes wrong from here on is a **phone/adb-side setup issue**, not the
runner code — the `preflight.js` script in step 2 pinpoints where in the stack
the failure actually is.

---

## Prerequisites

- [ ] Android phone (any model on Android 8+; a spare / non-personal phone is
      strongly preferred so an IG account lock doesn't hit a team member)
- [ ] USB cable (or a Wi-Fi ADB pairing, but USB is more reliable for the first run)
- [ ] Host computer with Node 20+ and `npm` (already required for the runner)
- [ ] `adb` installed on the host — macOS: `brew install android-platform-tools`;
      Ubuntu: `sudo apt install android-tools-adb`; Windows: install the
      Android SDK Platform Tools. **That's the only extra software needed —
      no Appium, no separate server to run.**
- [ ] A **dedicated Instagram account** signed into the IG app on the phone
      — never the team's real one; IG will action it if it gets flagged
- [ ] Backend URL you can reach (production Railway, staging, or local)

## Step 1 — enable developer mode + connect the phone

1. Settings → About phone → tap "Build number" 7 times until it says
   "You are now a developer"

Then connect **one of two ways**:

**USB (simplest for the first run)**

2. Settings → System → Developer options → enable **USB debugging**
3. Plug the phone in via USB
4. On the phone, tap **Allow** on the "Allow USB debugging?" prompt

**Wi-Fi (Android 11+, no cable — the phone can sit on a shelf charging)**

2. Developer options → enable **Wireless debugging** → "Pair device with pairing code"
3. On the host: `adb pair <ip:pairingPort>` and enter the 6-digit code
4. Then `adb connect <ip:port>` (the main Wireless-debugging ip:port)
5. Set `RUNNER_ADB_MODE=wifi` and `RUNNER_DEVICE_UDID=<ip:port>` for the run. The
   runner auto-reconnects (`adb connect`) if the Wi-Fi link drops mid-run.

**Expected:** `adb devices` on the host lists your phone as `<serial> device`
(not `unauthorized` or `offline`). For Wi-Fi the serial is the `ip:port`.

```bash
adb devices
# List of devices attached
# 12345ABCDE     device          # USB
# 192.168.1.9:5555   device      # Wi-Fi
```

## Step 2 — install runner deps + run preflight

```bash
cd runner
npm install                 # installs the base runner package (no Appium needed for Android)
node scripts/preflight.js
```

**Expected — every check green:**

```
Runner preflight (Android via adb — no Appium)
[preflight] ADB found: /usr/bin/adb
[preflight] ADB devices:
             12345ABCDE   device
[preflight] Instagram installed on device: yes (versionName=326.0.0.42.108)
[preflight] Opening the phone with AndroidDriver (adb only, no Appium)…
[preflight] Screen size reported: 1080 x 2400
[preflight] Screenshot bytes: 348271
[preflight] ✅ all checks passed — the runner is ready to scout
```

If **any** check fails, `preflight.js` prints an actionable next-step. Fix and
re-run; do not proceed past this step with a red preflight — you'll just burn
IG rate limit against a broken setup.

## Step 3 — mint a per-host token

Two ways, pick either:

**A) From the Scout Creators dashboard (recommended)**

- Open `<backend-url>/sourcing.html` in a browser signed in as an admin.
- Under **Paired phone-hosts**: label `"Android — <phone model>"`, tick
  `Android`, click **Mint token**.
- Copy the plaintext token shown once — it starts with `sk_`.

**B) HTTP direct (for scripting)**

```bash
curl -X POST <backend-url>/api/sourcing/hosts \
  -H "x-api-token: <DASHBOARD_API_TOKEN>" \
  -H 'content-type: application/json' \
  -d '{"label":"Android — <phone model>","platforms":["android"]}'
# → returns { id, label, platforms, status, token: "sk_..." }
```

## Step 4 — start a small scouting run

From the Scout Creators page (or via curl), start a run on a real campaign with:

- niche: something narrow (e.g. `home fitness`)
- keywords: one word (e.g. `homegym`)
- floor: generous (e.g. `10000`) so we don't reject early
- risk: `high` (accepts everything the other rules pass)
- targetCount: `1` (we want one clean end-to-end capture first)

Note the returned `run.id`.

## Step 5 — run the runner

For this first controlled test, drive the specific run from step 4 by its id
(instead of `auto`) so the loop stops after exactly one run — keeps the first
diagnostic pass tight:

```bash
cd runner
RUNNER_DRIVER=android \
RUNNER_BACKEND_URL=<backend-url> \
RUNNER_HOST_TOKEN=sk_...            # from step 3
RUNNER_RUN_ID=<from step 4> \
RUNNER_PACING_MS=2500 \
npm start
```

No `RUNNER_APPIUM_URL` needed — the Android driver talks to the phone directly.
If you have more than one phone attached, add `RUNNER_DEVICE_UDID=<serial>`
(from `adb devices`).

**Expected — on the phone:**

1. IG opens.
2. Search tab tapped, keyword typed.
3. First result profile opened, Reels tab tapped, page scrolls.
4. Back to search, next result, repeat.

**Expected — in the terminal:**

```
[runner] finished run #<id> status=done captured=1
```

**Expected — in the dashboard:** the Scout Creators page shows the candidate in
the pass/reject log, and the campaign's creators table has a new row with
`status=pending_extraction`.

## Common failures + fixes

| Symptom | Meaning | Fix |
|---|---|---|
| `adb devices` shows `unauthorized` | You haven't tapped Allow on the phone | Unplug, replug, tap Allow |
| `spawn adb ENOENT` | `adb` isn't installed / not on PATH | Install Android platform-tools (see Prerequisites) |
| `adb: more than one device/emulator` | Two+ phones attached | Set `RUNNER_DEVICE_UDID=<serial>` |
| `openApp` runs but IG never opens | IG not installed on the phone | Install IG from Play Store; sign in; retry |
| Screenshot comes back empty | Screen is locked | Handled automatically now — the driver wakes + retries, and `RUNNER_KEEP_AWAKE=on` (default) holds the screen on. Only fails if the lock is secured (PIN) — remove the lock on the dedicated phone. |
| `adb` link keeps dropping | Flaky cable / Wi-Fi | Handled automatically — every adb call reconnects + retries (`RUNNER_ADB_RECONNECT_RETRIES`). For Wi-Fi, keep the phone on the same network; re-`adb pair` if the port rotated. |
| Candidates come back empty / wrong targets | Screen-reader signals need calibration to this IG build | The reader runs and degrades to `screen: unknown` (never crashes). Dump a screen and adjust `SIGNALS`/extractors in `backend/src/services/screenVision.js` — see step 6. |

Every failure above also gets an actionable "cause + fix" line automatically —
the runner's `src/diagnose.js` recognizes these patterns and prints the fix,
not just a raw stack trace.

## Step 6 — calibrate the screen reader to this IG build

The vision reader is implemented and runs: on a real run the runner captures the
phone's UI tree (`adb shell uiautomator dump`) and the backend
(`backend/src/services/screenVision.js`) interprets it into `{screen, targets,
results, profile, reels}`. It **degrades to `screen: unknown`** when it can't
classify — it never throws — so a mis-calibrated signal makes the navigator fall
back to a hardware Back or a human take-over via the live mirror, not crash the run.

If candidates come back empty or a tap lands on the wrong thing, confirm the
reader's signals against the actual app:

```bash
# on a typed search-results screen, then a profile, then the reels tab:
adb shell uiautomator dump /sdcard/window_dump.xml && adb exec-out cat /sdcard/window_dump.xml
```

Eyeball the `resource-id` / `content-desc` / `text` / `bounds` for the elements
you expect (search box, result rows, Reels tab, followers count, reel view
overlays). If a signal in `SIGNALS` or an extractor doesn't match, adjust the
string(s) in `backend/src/services/screenVision.js` — no navigator or driver
change needed — and add the real values as a fixture case in
`backend/src/services/screenVision.test.js` to lock it against future IG drift.
See `src/vision/PLACEHOLDERS.md` for the full contract + calibration notes.

## Step 7 — switch to persistent mode (one-time setup)

Once step 5's single controlled run works end-to-end, stop driving runs one at a
time by id. Switch `RUNNER_RUN_ID` to `auto` and leave the runner running — it
polls the backend forever, drives whatever run an admin queues from the Scout
Creators page next, and immediately checks for another when that one finishes:

```bash
cd runner
RUNNER_DRIVER=android \
RUNNER_BACKEND_URL=<backend-url> \
RUNNER_HOST_TOKEN=sk_...            # from step 3
RUNNER_RUN_ID=auto \
RUNNER_PACING_MS=2500 \
npm start
```

This is the one-time setup: start it once, leave the terminal/host running, and
every future run just needs someone to click "Start scouting run" on the
dashboard — nothing to re-type here. Press `Ctrl+C` to stop it (it finishes the
step it's on first). If nothing is queued it logs nothing and quietly polls
again every `RUNNER_IDLE_POLL_MS` (default 15s); once a run lands you'll see the
same phone activity and `[runner] finished run #<id> ...` line as step 5, then
the terminal goes back to polling instead of exiting.

---

## Reference

- Runner main entry: `src/index.js`
- Android driver: `src/driver/android.js`
- Navigator: `src/navigator/instagram.js`
- Vision shape the reader must return: `src/vision/PLACEHOLDERS.md`
- Preflight source: `scripts/preflight.js`
