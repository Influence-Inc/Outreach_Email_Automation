# Phase D — Android live E2E checklist

The runner package already ships the Android driver (`src/driver/android.js`)
and the vision-driven Instagram Navigator. What's left is one-time host setup:
Appium 2 + UiAutomator2, ADB against the phone, and a paired Deal Studio host
token. This checklist is a linear script — do each step, verify the "expected
output" matches, then move on.

The tests from Phase 2 already prove the runner talks to the backend correctly
(commit `db3dbfa` on PR #305 verified this against a real Postgres). Anything
that goes wrong from here on is an **Appium/phone-side setup issue**, not the
runner code — the `preflight.js` script in step 4 pinpoints where in the stack
the failure actually is.

---

## Prerequisites

- [ ] Android phone (any model on Android 8+; a spare / non-personal phone is
      strongly preferred so an IG account lock doesn't hit a team member)
- [ ] USB cable (or a Wi-Fi ADB pairing, but USB is more reliable for the first run)
- [ ] Host computer with Node 20+ and `npm` (already required for the runner)
- [ ] A **dedicated Instagram account** signed into the IG app on the phone
      — never the team's real one; IG will action it if it gets flagged
- [ ] Backend URL you can reach (production Railway, staging, or local)

## Step 1 — enable developer mode on the phone

1. Settings → About phone → tap "Build number" 7 times until it says
   "You are now a developer"
2. Settings → System → Developer options → enable **USB debugging**
3. Plug the phone in via USB
4. On the phone, tap **Allow** on the "Allow USB debugging?" prompt

**Expected:** `adb devices` on the host lists your phone as `<serial> device`
(not `unauthorized` or `offline`).

```bash
adb devices
# List of devices attached
# 12345ABCDE     device
```

## Step 2 — install Appium 2 + the UiAutomator2 driver

```bash
npm install -g appium
appium driver install uiautomator2
appium driver list --installed
```

**Expected:** `uiautomator2@x.y.z (installed)` in the output.

## Step 3 — start Appium

In a spare terminal (keep it running for the whole session):

```bash
appium --base-path /wd/hub
```

**Expected:** logs `[Appium] Welcome to Appium vX.Y.Z` and
`[Appium] You can provide the following URLS in your client code to connect to
this server: http://127.0.0.1:4723/wd/hub`

## Step 4 — install runner deps + run preflight

```bash
cd runner
npm install                 # installs the base runner package
npm install webdriverio     # optional dep needed only for real drivers
node scripts/preflight.js
```

**Expected — every check green:**

```
[preflight] Appium /status: 200 OK — v2.x.y
[preflight] ADB found: /usr/bin/adb
[preflight] ADB devices:
             12345ABCDE   device
[preflight] Instagram installed on device: yes (versionName=326.0.0.42.108)
[preflight] Attempting Appium UiAutomator2 session against Instagram… OK
[preflight] Screen size reported: 1080 x 2400
[preflight] Screenshot bytes: 348271
[preflight] ✅ all checks passed — the runner is ready to scout
```

If **any** check fails, `preflight.js` prints an actionable next-step. Fix and
re-run; do not proceed past this step with a red preflight — you'll just burn
IG rate limit against a broken setup.

## Step 5 — mint a per-host token

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

## Step 6 — start a small scouting run

From the Scout Creators page (or via curl), start a run on a real campaign with:

- niche: something narrow (e.g. `home fitness`)
- keywords: one word (e.g. `homegym`)
- floor: generous (e.g. `10000`) so we don't reject early
- risk: `high` (accepts everything the other rules pass)
- targetCount: `1` (we want one clean end-to-end capture first)

Note the returned `run.id`.

## Step 7 — run the runner

```bash
cd runner
RUNNER_DRIVER=android \
RUNNER_APPIUM_URL=http://127.0.0.1:4723 \
RUNNER_BACKEND_URL=<backend-url> \
RUNNER_HOST_TOKEN=sk_...            # from step 5
RUNNER_RUN_ID=<from step 6> \
RUNNER_PACING_MS=2500 \
npm start
```

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
| Appium session error `Original error: Could not find a driver for automationName 'UiAutomator2'` | Driver not installed | `appium driver install uiautomator2` |
| `Cannot find module 'webdriverio'` from the runner | Optional dep not installed | `cd runner && npm install webdriverio` |
| Session opens but IG never opens | IG not installed on the phone | Install IG from Play Store; sign in; retry |
| `takeScreenshot` returns empty / black | Screen is locked | Wake the phone; disable auto-lock during the run |
| Runner exits with `not implemented` from `ScreenReader.read` | Expected on the first live run | Send screenshots per step 8 below |

## Step 8 — first-live-run iteration loop

On the very first Track D run, the vision reader (`src/navigator/screenReader.js`)
is intentionally the `not implemented` stub for real drivers — we build it
against your actual IG screenshots rather than guessing what IG's Android UI
looks like today. When you hit the `not implemented` error, capture the current
screen and share:

```bash
adb exec-out screencap -p > screen-1-search-results.png
adb exec-out screencap -p > screen-2-profile.png
adb exec-out screencap -p > screen-3-reels-tab.png
```

Ship these three PNGs back — with those in hand I'll ship the first real
`ScreenReader` implementation as a follow-up commit on PR #305 and you re-run
step 7 with the vision layer live.

---

## Reference

- Runner main entry: `src/index.js`
- Android driver: `src/driver/android.js`
- Navigator: `src/navigator/instagram.js`
- Vision shape the reader must return: `src/vision/PLACEHOLDERS.md`
- Preflight source: `scripts/preflight.js`
