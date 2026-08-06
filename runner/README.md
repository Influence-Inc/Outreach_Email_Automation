# Sourcing Runner (paired-host)

A small Node process that sits on a computer next to a personal phone, drives the
Instagram app on that phone (screenshot + tap + swipe — no Instagram API), and
posts captured candidates back to Deal Studio. The backend applies the scouting
rules (`backend/src/services/sourcingFilters.js`) and adds passing creators to the
target campaign.

The `{screenshot, tap, swipe, typeText, openApp, home}` contract in
`src/driver/base.js` is the same on Android and iOS, so the navigator + main loop
are OS-agnostic. Only the driver implementation changes per phone.

**Android needs no extra software beyond `adb`** (Google's own Android SDK tool —
you already need it just to plug the phone in). The driver shells out to `adb`
directly (`screencap`, `input tap/swipe/text`, `monkey` to launch the app) — there
is no Appium server, no extra npm dependency, nothing else to install or run.
**iOS is different**: Apple sandboxes the OS so hard that the only sanctioned way
to tap/type/screenshot an iPhone from outside is through Apple's own testing
framework, which is what Appium + WebDriverAgent wrap. That part isn't optional on
iOS — see the iOS section below.

## Configure

Set these environment variables on the host:

| Env | Description |
| --- | --- |
| `RUNNER_BACKEND_URL`   | Deal Studio backend origin (no trailing slash). |
| `RUNNER_HOST_TOKEN`    | Token the backend accepts as `x-api-token` on `/api/sourcing/*`. Preferred: a **per-host token** minted from the dashboard's "Paired phone-hosts" panel — stored as SHA-256 in `sourcing_hosts`, revocable individually, shown only once at mint time. The legacy global `DASHBOARD_API_TOKEN` still works (siteAuth continues to accept it), but per-host tokens are auditable per phone and can be revoked without rotating the shared credential. |
| `RUNNER_RUN_ID`        | The `sourcing_runs.id` this process will drive. |
| `RUNNER_DRIVER`        | `mock` (default), `android`, or `ios`. |
| `RUNNER_APPIUM_URL`    | Appium server URL — **iOS only** (default `http://127.0.0.1:4723`). Android doesn't use Appium. |
| `RUNNER_DEVICE_UDID`   | The `adb` serial (Android) or device UDID (iOS). Only needed when more than one phone is attached to the host. |
| `RUNNER_BATCH_SIZE`    | Candidates per POST (default 5). |
| `RUNNER_PACING_MS`     | Min ms between IG actions (default 1800 — human-like pacing). |
| `RUNNER_DAILY_CAP`     | Hard stop after N captures/day (default 200). |

## Run

```bash
cd runner
npm install           # only 'webdriverio' is optional (iOS only); skips fine
npm run start:mock    # exercises the whole pipeline with no phone
# ... or, with a paired Android phone connected over USB (no Appium needed):
RUNNER_DRIVER=android RUNNER_BACKEND_URL=... RUNNER_HOST_TOKEN=... RUNNER_RUN_ID=42 npm start
```

## Android setup

No Appium, no extra npm packages — just `adb` (Google's own Android SDK tool).

1. **Dedicated IG account** on the phone — never your team member's personal one.
2. Enable **Developer options** + **USB debugging** on the phone; connect it to the
   host and confirm with `adb devices` (install platform-tools first if `adb` isn't
   found: macOS `brew install android-platform-tools`, Ubuntu
   `sudo apt install android-tools-adb`, Windows: Android SDK Platform Tools).
3. Run `node scripts/preflight.js` — it checks `adb`, the phone, Instagram being
   installed, and takes a real screenshot through the driver. Fix anything it flags
   before continuing.
4. Pair the host in Deal Studio (**Scout creators → Paired phone-hosts**) and copy
   the token into `RUNNER_HOST_TOKEN`. Start a run from the dashboard, grab its
   `runId`, and start the runner as above.

See `PHASE_D_CHECKLIST.md` for the full step-by-step with expected output at
each step.

## iOS setup

Same runner, different driver — and unlike Android, this one genuinely needs
Appium, because Apple gives no adb-equivalent shortcut past its sandbox. The
host **must be a Mac** (Xcode is required to build and sign WebDriverAgent —
Apple's own sanctioned test agent), and the WDA signature must be refreshed
periodically:

- **≈7 days** on a free personal Apple ID.
- **1 year** on a paid Apple Developer Program account (`$99/yr`, strongly
  preferred for anything long-running).

One-time setup on the Mac:

1. Install **Xcode** + Xcode command-line tools.
2. Pair the iPhone to the Mac (Finder → device → "Trust this computer").
3. Install Appium 2 + the XCUITest driver:
   ```bash
   npm install -g appium
   appium driver install xcuitest
   appium --base-path /wd/hub
   ```
4. Build/sign WebDriverAgent against the phone (Xcode Signing tab → pick your
   Team, then):
   ```bash
   xcodebuild \
     -project /path/to/appium-webdriveragent/WebDriverAgent.xcodeproj \
     -scheme WebDriverAgentRunner \
     -destination 'id=<IPHONE_UDID>' \
     test
   ```
   On the phone: **Settings → General → VPN & Device Management → trust the
   developer certificate.**
5. `cd runner && npm install webdriverio` (the Appium client — iOS only; Android
   doesn't need it).
6. Set env and run:
   ```bash
   RUNNER_DRIVER=ios \
   RUNNER_APPIUM_URL=http://127.0.0.1:4723 \
   RUNNER_DEVICE_UDID=00008101-000A1B2C3D4E5F6 \
   RUNNER_DEVICE_NAME='Scouting iPhone' \
   RUNNER_XCODE_ORG_ID=ABCDE12345 \
   RUNNER_BACKEND_URL=https://... RUNNER_HOST_TOKEN=... RUNNER_RUN_ID=42 \
   npm start
   ```

When the WDA signature expires you'll see Appium fail to start a session — rerun
step 4 to re-sign.

## Files

- `src/driver/base.js` — the DeviceDriver contract.
- `src/driver/mock.js` — fixture-replay driver used by tests.
- `src/driver/android.js` — direct-`adb` driver (no Appium, no extra deps).
- `src/driver/ios.js` — Appium XCUITest / WebDriverAgent driver.
- `src/navigator/instagram.js` — the vision-driven scout flow.
- `src/navigator/screenReader.js` — screenshot → structured data (mock in tests).
- `src/backend.js` — thin Deal Studio HTTP client.
- `src/main.js` — the runner loop (capture → batch → POST → stop).
- `src/index.js` — entry point that wires config + driver + backend.
- `src/diagnose.js` — turns a raw error into a compact "cause + fix" line.
- `scripts/preflight.js` — verifies adb + phone + Instagram + a live screenshot
  before a real run.

## Tests

```bash
cd runner && npm test
```

Runs everything with the mock driver + mock reader + a stub backend — no phone,
no Appium, no network calls.
