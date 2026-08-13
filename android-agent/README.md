# Sourcing Agent (on-device Android app)

The phone-side replacement for the laptop runner in `RUNNER_MODE=agent`.

Instead of a Mac running Node and reaching *into* the phone over `adb`, the
phone runs this app and reaches *out* to Deal Studio. Same backend, same
endpoints, same host token — **zero backend changes**.

```
before:  Deal Studio  <--HTTP--  Mac (Node runner)  --adb over Wi-Fi-->  phone
after:   Deal Studio  <--HTTP--  phone (this app)
```

## Why

`adb` wireless debugging has to be re-established constantly and its pairing
handshake is unreliable on macOS (`protocol fault (couldn't read status
message)`). Even when it works it requires: developer options, a pairing code
that expires in two minutes, a connect port that rotates on every toggle, the
laptop and phone on the same LAN, and a laptop that stays awake.

This app needs none of that. Setup is: install, paste three values, flip one
toggle. It works over cellular, from anywhere, with no computer involved.

## What it replaces

Every device primitive the backend navigator sends is implemented natively:

| Backend op | Node runner (adb) | This app |
| --- | --- | --- |
| `tap` / `swipe` | `adb shell input tap/swipe` | `dispatchGesture()` |
| `type` | `adb shell input text` | `ACTION_SET_TEXT` on the focused node |
| `home` | `adb shell input keyevent HOME` | `performGlobalAction()` |
| `openApp` | `adb shell monkey -p …` | `getLaunchIntentForPackage()` |
| `dumpUi` | `adb shell uiautomator dump` | accessibility node tree |
| `screenshot` | `adb exec-out screencap` | `takeScreenshot()` |
| `getWindowSize` | `adb shell wm size` | `WindowMetrics` |
| `keepAwake` / `wake` | `adb shell svc power stayon` | `WakeLock` |
| `recordClip` | **scrcpy** (separate install) | `MediaProjection` + `AudioPlaybackCapture` |

`dumpUi` emits the exact object shape `parseUiXml()` produces in
`runner/src/driver/android.js` — `{rid, cls, text, desc, clickable, selected,
bounds:{x,y,w,h}}` — because `backend/src/services/screenVision.js` matches on
those names. `app/src/test/…/UiElementTest.kt` pins that contract.

## Build

### No local toolchain: download the APK from CI

`.github/workflows/android-agent.yml` builds the APK and runs the unit tests on
every push that touches this folder. To get an installable build without
installing anything on your machine:

1. Open the repo's **Actions** tab → the latest **Android agent** run.
2. Download the **`sourcing-agent-debug-apk`** artifact (a zip).
3. Unzip, transfer `app-debug.apk` to the phone (AirDrop, Drive, email, USB).
4. Tap it on the phone. Android will ask permission to install from that source
   the first time — allow it, then install.

That is the whole build step. Skip the rest of this section unless you want to
develop the app.

### Locally, with Android Studio

Needs Android Studio (Koala or newer) or a local Android SDK. **Open the
`android-agent/` folder itself** — it is the Gradle root. Opening the repo root
will not import the project.

```bash
# Android Studio: File → Open → select the android-agent/ folder, then Run.

# or from the command line, with ANDROID_HOME set:
cd android-agent
gradle wrapper          # first time only, generates ./gradlew
./gradlew :app:assembleDebug
./gradlew :app:testDebugUnitTest      # the wire-shape tests

# install onto the phone (USB once, or any file transfer — this is the only
# time a cable is even optional)
./gradlew :app:installDebug
```

The APK lands at `app/build/outputs/apk/debug/app-debug.apk`. It is not
distributable through the Play Store — an accessibility app that automates
another app will not pass review — so sideload it.

## Set up on the phone

1. **Install the APK** and open **Sourcing Agent**.
2. **Paste three values:**
   - *Backend URL* — e.g. `https://deals.influence.technology`
   - *Host token* — the full `sk_…` from Deal Studio → **Scout creators →
     Paired phone-hosts**
   - *Host ID* — the integer next to that host (e.g. `3`)
3. **Tap "1. Enable accessibility service"** → find **Sourcing Agent** under
   *Installed apps* and switch it on. This is the one permission that matters.
4. **Tap "3. Start agent".** The status panel should read
   `idle — waiting for a queued run`, then `running — session started (run #N)`
   once someone queues a run from the dashboard.

Step 2 (screen capture) is **only** needed for `discovery: "reels"` mode, which
records video with audio for the AI judge. Skip it otherwise.

### Backend prerequisite

Agent mode is opt-in server-side. Without this the app gets a 404 on every
claim (it will tell you so in the status line):

```
SOURCING_REMOTE_CONTROL=on
```

Set it in the backend's environment (Railway → Variables) and redeploy. For the
dashboard's live phone view, also set `SOURCING_LIVE_MIRROR=on` and tick
*"Stream the screen to the dashboard"* in the app.

## Phone hygiene

Same rules as the laptop setup, and for the same reasons:

- **A dedicated Instagram account.** Never a team member's personal one.
- **No secure lock screen** (PIN/pattern/biometric) — a locked phone can't be
  driven. The app holds a wake lock, but it cannot dismiss a secure keyguard.
- **Keep it charging.** The screen stays on for the whole session.
- Leave *Battery optimisation* **off** for this app (Settings → Apps → Sourcing
  Agent → Battery → Unrestricted), or Android will eventually freeze the loop.

## Status / caveats

**Covered by unit tests** (`./gradlew :app:testDebugUnitTest`, 15 tests):

- the `dumpUi` element shape `screenVision.js` matches on, including that
  `bounds` is `{x,y,w,h}` and not left/top/right/bottom;
- the HTTP contract — endpoint paths, the `x-api-token` header, `204` meaning
  idle rather than failure, the `{id, ok, result, error}` result envelope, and
  that a numeric command id goes back as a **number** (stringifying it would
  strand the backend navigator's await until it timed out);
- the two errors that otherwise strand an operator — `remote control disabled`
  and a rejected token — surface as instructions, not bare status codes.

`BackendClient.kt` and `UiElement.kt` are deliberately free of Android imports
so those tests run on a plain JVM.

**Not yet exercised on a physical device.** The accessibility, screenshot and
media paths are written against the platform APIs but have not been run on real
hardware, so expect the first live run to need small calibration:

- **`recordClip`** is the least-exercised path. An app can opt out of audio
  capture (`allowAudioPlaybackCapture="false"`), in which case the clip records
  with silent audio; video always works. If reels mode misbehaves, keep using
  the Node runner for that mode — both can point at the same backend.
- **Screenshots are rate limited** by the platform to roughly one per second.
  The capture path waits that interval out rather than failing, so a fast
  navigator loop will pace itself rather than error.
- **`type` targets the focused field.** If IG changes its search box so it is
  not focused when text arrives, the op fails loudly rather than typing into
  nothing — the error names the problem in the run log.

## Files

- `MainActivity.kt` — the three-field setup screen.
- `AgentService.kt` — foreground service: claim → pull → execute → post, plus
  the live-mirror frame/control loops.
- `SourcingAccessibilityService.kt` — the device primitives (gestures, node
  tree, screenshots). This is the adb replacement.
- `CommandExecutor.kt` — op name → device action, mirroring
  `runner/src/agent.js`.
- `BackendClient.kt` — Deal Studio HTTP client, mirroring
  `runner/src/backend.js`.
- `UiTree.kt` — accessibility tree → the backend's element array.
- `ClipRecorder.kt` — screen + internal audio → mp4, replacing scrcpy.
- `Prefs.kt` — replaces `.runnerrc.json`; validated, with nothing to hand-edit.
