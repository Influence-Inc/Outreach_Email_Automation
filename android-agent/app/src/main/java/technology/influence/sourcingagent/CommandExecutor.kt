package technology.influence.sourcingagent

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.os.PowerManager
import android.util.Base64
import org.json.JSONObject

/** Supplies reel clips; absent until the operator grants screen capture. */
interface ClipProvider {
    /** Record `seconds` of screen + internal audio, returning mp4 bytes. */
    fun record(seconds: Int): ByteArray
}

/**
 * Maps one backend command to a device action — the Kotlin twin of
 * `executeCommand()` in `runner/src/agent.js`.
 *
 * The op names and result shapes here are a hard contract with
 * `backend/src/services/remoteDriver.js`: ops that only mutate the phone resolve
 * null, while `dumpUi` / `getWindowSize` / `screenshot` / `recordClip` carry data
 * back for the backend navigator to read.
 */
class CommandExecutor(
    private val context: Context,
    private val backend: BackendClient,
    private val hostId: Int,
    private val power: PowerController,
    private val clipProvider: () -> ClipProvider?,
) {

    companion object {
        const val IG_PACKAGE = "com.instagram.android"
    }

    /** @return the JSON-encodable result for this op, or null for mutating ops. */
    fun execute(cmd: BackendClient.Command): Any? {
        val a = cmd.args
        return when (cmd.op) {
            "openApp" -> {
                openApp(a.optString("pkg", IG_PACKAGE).ifEmpty { IG_PACKAGE })
                null
            }

            "tap" -> {
                require(service().tap(a.optInt("x"), a.optInt("y"))) { "tap gesture was not completed" }
                null
            }

            "swipe" -> {
                val ok = service().swipe(
                    x1 = a.optInt("x1"),
                    y1 = a.optInt("y1"),
                    x2 = a.optInt("x2"),
                    y2 = a.optInt("y2"),
                    durationMs = a.optLong("durationMs", 200L),
                )
                require(ok) { "swipe gesture was not completed" }
                null
            }

            "type" -> {
                val text = a.optString("text", "")
                require(service().typeText(text)) {
                    "no focused text field to type into — the keyboard target was not found"
                }
                null
            }

            "submitSearch" -> {
                require(service().submitSearch()) {
                    "could not press Search — no focused text field to submit"
                }
                null
            }

            "back" -> {
                require(service().goBackGlobal()) { "BACK action was refused" }
                null
            }

            "home" -> {
                require(service().goHome()) { "HOME action was refused" }
                null
            }

            "keepAwake" -> {
                power.keepAwake()
                null
            }

            "wake" -> {
                power.wake()
                null
            }

            "dumpUi" -> service().dumpElements().toJsonArray()

            "getWindowSize" -> {
                val (w, h) = service().windowSize()
                JSONObject().apply {
                    put("width", w)
                    put("height", h)
                }
            }

            "screenshot" -> {
                val png = service().screenshotPng()
                JSONObject().apply {
                    put("mediaType", "image/png")
                    put("dataBase64", Base64.encodeToString(png, Base64.NO_WRAP))
                }
            }

            "recordClip" -> {
                val provider = clipProvider()
                    ?: throw IllegalStateException(
                        "screen capture is not granted on this phone — open the Sourcing Agent " +
                            "app and tap \"Grant screen capture\" to enable reel recording"
                    )
                val bytes = provider.record(a.optInt("seconds", 12))
                val clipId = backend.uploadClip(hostId, bytes, "video/mp4")
                JSONObject().apply { put("clipId", clipId) }
            }

            else -> throw IllegalArgumentException("unknown command op: ${cmd.op}")
        }
    }

    private fun service(): SourcingAccessibilityService =
        SourcingAccessibilityService.instance
            ?: throw IllegalStateException(
                "accessibility service is not enabled — turn on \"Sourcing Agent\" under " +
                    "Settings → Accessibility → Installed apps"
            )

    /**
     * Launch by package without knowing the activity class, the equivalent of
     * `adb shell monkey -p <pkg> -c LAUNCHER 1` — robust across IG releases that
     * rename their entry activity.
     */
    private fun openApp(pkg: String) {
        val intent = context.packageManager.getLaunchIntentForPackage(pkg)
            ?: throw IllegalStateException("$pkg is not installed on this phone")
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
        context.startActivity(intent)
    }
}

/**
 * Screen-state control, replacing `adb shell svc power stayon true` and
 * `input keyevent KEYCODE_WAKEUP`.
 *
 * A long standing session dies the moment the screen locks, so [keepAwake] holds
 * a wake lock for the whole session and [wake] pulses one to bring the display
 * back if something else put it to sleep.
 */
class PowerController(context: Context) {

    private val powerManager = context.getSystemService(Context.POWER_SERVICE) as PowerManager

    @SuppressLint("WakelockTimeout")
    private val sessionLock: PowerManager.WakeLock =
        @Suppress("DEPRECATION")
        powerManager.newWakeLock(
            PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP,
            "sourcing-agent:session",
        )

    @SuppressLint("WakelockTimeout")
    fun keepAwake() {
        if (!sessionLock.isHeld) sessionLock.acquire()
    }

    /** Pulse the display on without changing the session-long lock's state. */
    @Suppress("DEPRECATION")
    fun wake() {
        if (sessionLock.isHeld) return
        val pulse = powerManager.newWakeLock(
            PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP,
            "sourcing-agent:wake",
        )
        pulse.acquire(3_000L)
        pulse.release()
    }

    fun release() {
        if (sessionLock.isHeld) sessionLock.release()
    }
}
