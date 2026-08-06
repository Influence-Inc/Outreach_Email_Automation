# Sourcing Runner (paired-host)

A small Node process that sits on a computer next to a personal phone, drives the
Instagram app on that phone (screenshot + tap + swipe — no Instagram API), and
posts captured candidates back to Deal Studio. The backend applies the scouting
rules (`backend/src/services/sourcingFilters.js`) and adds passing creators to the
target campaign.

The `{screenshot, tap, swipe, typeText, openApp, home}` contract in
`src/driver/base.js` is the same on Android and iOS, so the navigator + main loop
are OS-agnostic. Only the driver implementation changes per phone.

## Configure

Set these environment variables on the host:

| Env | Description |
| --- | --- |
| `RUNNER_BACKEND_URL`   | Deal Studio backend origin (no trailing slash). |
| `RUNNER_HOST_TOKEN`    | Machine token the backend accepts as `x-api-token`. In Phase 2 this is the existing `DASHBOARD_API_TOKEN` env value on the backend — reuse it. Phase 3 will replace it with per-host tokens minted by a dashboard *Pair a host* flow (stored as SHA-256 in `sourcing_hosts`). |
| `RUNNER_RUN_ID`        | The `sourcing_runs.id` this process will drive. |
| `RUNNER_DRIVER`        | `mock` (default), `android`, or `ios` (Phase 3). |
| `RUNNER_APPIUM_URL`    | Appium server URL for `android`/`ios` (default `http://127.0.0.1:4723`). |
| `RUNNER_DEVICE_UDID`   | iOS only. |
| `RUNNER_BATCH_SIZE`    | Candidates per POST (default 5). |
| `RUNNER_PACING_MS`     | Min ms between IG actions (default 1800 — human-like pacing). |
| `RUNNER_DAILY_CAP`     | Hard stop after N captures/day (default 200). |

## Run

```bash
cd runner
npm install           # only 'webdriverio' is optional; skips fine
npm run start:mock    # exercises the whole pipeline with no phone
# ... or, with a paired Android phone + Appium up on 4723:
RUNNER_DRIVER=android RUNNER_BACKEND_URL=... RUNNER_HOST_TOKEN=... RUNNER_RUN_ID=42 npm start
```

## Android setup (Phase 2)

1. **Dedicated IG account** on the phone — never your team member's personal one.
2. Enable **Developer options** + **USB debugging** on the phone; connect it to the
   host and confirm with `adb devices`.
3. Install Appium 2 on the host and the UiAutomator2 driver:
   ```bash
   npm install -g appium
   appium driver install uiautomator2
   appium --base-path /wd/hub          # start the server
   ```
4. `cd runner && npm install webdriverio` (Appium client used by `driver/android.js`).
5. Pair the host in Deal Studio (**Scout creators → Pair a host**) and copy the
   token into `RUNNER_HOST_TOKEN`. Start a run from the dashboard, grab its
   `runId` from the URL, and start the runner as above.

## iOS setup (Phase 3)

Same runner, different driver: `RUNNER_DRIVER=ios` on a Mac host running Appium +
XCUITest driver + WebDriverAgent (requires an Apple developer account to sign the
WDA app; the signature must be refreshed periodically). Full instructions land
with the Phase 3 commit.

## Files

- `src/driver/base.js` — the DeviceDriver contract.
- `src/driver/mock.js` — fixture-replay driver used by tests.
- `src/driver/android.js` — Appium UiAutomator2 driver (skeleton).
- `src/navigator/instagram.js` — the vision-driven scout flow.
- `src/navigator/screenReader.js` — screenshot → structured data (mock in tests).
- `src/backend.js` — thin Deal Studio HTTP client.
- `src/main.js` — the runner loop (capture → batch → POST → stop).
- `src/index.js` — entry point that wires config + driver + backend.

## Tests

```bash
cd runner && npm test
```

Runs everything with the mock driver + mock reader + a stub backend — no phone,
no Appium, no network calls.
