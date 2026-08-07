# Sourcing Runner (paired-host)

A small Node process that sits on a computer next to a personal phone, drives the
Instagram app on that phone (screenshot + tap + swipe — no Instagram API), and
posts captured candidates back to Deal Studio. The backend applies the scouting
rules (`backend/src/services/sourcingFilters.js`) and adds passing creators to the
target campaign.

**Android only.** The `{screenshot, tap, swipe, typeText, openApp, home}` contract
in `src/driver/base.js` keeps the navigator + main loop decoupled from the driver
implementation, but the one driver shipped here targets Android.

**No extra software beyond `adb`** (Google's own Android SDK tool — you already
need it just to plug the phone in). The driver shells out to `adb` directly
(`screencap`, `input tap/swipe/text`, `monkey` to launch the app) — there is no
Appium server, no extra npm dependency, nothing else to install or run.

## Configure

Set these environment variables on the host:

| Env | Description |
| --- | --- |
| `RUNNER_BACKEND_URL`   | Deal Studio backend origin (no trailing slash). |
| `RUNNER_HOST_TOKEN`    | Token the backend accepts as `x-api-token` on `/api/sourcing/*`. Preferred: a **per-host token** minted from the dashboard's "Paired phone-hosts" panel — stored as SHA-256 in `sourcing_hosts`, revocable individually, shown only once at mint time. The legacy global `DASHBOARD_API_TOKEN` still works (siteAuth continues to accept it), but per-host tokens are auditable per phone and can be revoked without rotating the shared credential. |
| `RUNNER_RUN_ID`        | `auto` (recommended) to poll forever for the newest queued run, or a specific `sourcing_runs.id` to drive once and exit. |
| `RUNNER_DRIVER`        | `mock` (default) or `android`. |
| `RUNNER_DEVICE_UDID`   | The `adb` serial to target. Only needed when more than one phone is attached to the host. |
| `RUNNER_BATCH_SIZE`    | Candidates per POST (default 5). |
| `RUNNER_PACING_MS`     | Min ms between IG actions (default 1800 — human-like pacing). |
| `RUNNER_DAILY_CAP`     | Hard stop after N captures/day (default 200). |
| `RUNNER_IDLE_POLL_MS`  | `RUNNER_RUN_ID=auto` only: wait this long between polls when nothing is queued (default 15000). |

## Run

**One-time setup (recommended):** `RUNNER_RUN_ID=auto` starts a standing worker —
it polls the backend for the newest queued run, drives it to completion, then
immediately checks for the next one, forever. Start it once and it keeps working
for every run an admin queues from the dashboard afterwards, with nothing to
re-type. Press `Ctrl+C` to stop it.

```bash
cd runner
npm install           # no extra packages needed
npm run start:mock    # exercises the whole pipeline with no phone

# ... or, with a paired Android phone connected over USB:
RUNNER_DRIVER=android RUNNER_BACKEND_URL=... RUNNER_HOST_TOKEN=... RUNNER_RUN_ID=auto npm start
```

Tip: export the env vars once in your shell profile (`~/.zshrc` / `~/.bashrc`) so
future sessions only need `cd runner && npm start`:

```bash
export RUNNER_DRIVER=android
export RUNNER_BACKEND_URL=https://deals.influence.technology
export RUNNER_HOST_TOKEN=<paste your per-host token>
export RUNNER_RUN_ID=auto
```

To drive one specific run and exit (e.g. for a controlled test), set
`RUNNER_RUN_ID` to a number instead of `auto`:

```bash
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
   the token into `RUNNER_HOST_TOKEN`. Start the runner with `RUNNER_RUN_ID=auto`
   (see above) — it's now a standing worker, so start a run from the dashboard any
   time and it picks it up on its next poll.

See `PHASE_D_CHECKLIST.md` for the full step-by-step with expected output at
each step.

**Note on iOS:** this runner is Android-only by design. Apple sandboxes iOS
hard enough that the only sanctioned way to tap/type/screenshot an iPhone from
outside is through Apple's own testing framework (what Appium + WebDriverAgent
wrap) — a materially heavier setup (a Mac, Xcode, a paid or frequently
re-signed developer certificate) than adb needs. If iOS support is ever
revisited, add a new driver implementing the same `DeviceDriver` contract in
`src/driver/base.js` — the navigator and main loop wouldn't need to change.

## Files

- `src/driver/base.js` — the DeviceDriver contract.
- `src/driver/mock.js` — fixture-replay driver used by tests.
- `src/driver/android.js` — direct-`adb` driver (no Appium, no extra deps).
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
