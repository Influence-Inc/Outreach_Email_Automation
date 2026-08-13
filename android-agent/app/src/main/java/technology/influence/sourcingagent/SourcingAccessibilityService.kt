package technology.influence.sourcingagent

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Path
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.view.Display
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * The device primitives, implemented natively — this is what replaces `adb`.
 *
 * Every op the backend navigator can send maps to a platform API here:
 *
 *   tap / swipe   -> dispatchGesture()                (adb shell input tap/swipe)
 *   type          -> ACTION_SET_TEXT on the focused node (adb shell input text)
 *   home          -> performGlobalAction(GLOBAL_ACTION_HOME)
 *   dumpUi        -> the accessibility node tree      (adb shell uiautomator dump)
 *   screenshot    -> takeScreenshot()                 (adb exec-out screencap)
 *   getWindowSize -> WindowMetrics                    (adb shell wm size)
 *
 * All of these are safe to call from a background thread: the async platform
 * calls are bridged back with a latch, and [AgentService] never runs the loop on
 * the main thread.
 */
class SourcingAccessibilityService : AccessibilityService() {

    companion object {
        private const val TAG = "SourcingA11y"

        /** Platform floor between screenshots; going faster returns an error. */
        private const val SCREENSHOT_INTERVAL_MS = 1_000L
        private const val GESTURE_TIMEOUT_MS = 15_000L
        private const val SCREENSHOT_TIMEOUT_MS = 10_000L

        /**
         * Set while the service is bound so [AgentService] can reach it. The
         * service is started by the system, not by us, which is why this is the
         * handoff rather than a binder.
         */
        @Volatile
        var instance: SourcingAccessibilityService? = null
            private set

        fun isRunning(): Boolean = instance != null
    }

    private val screenshotExecutor = Executors.newSingleThreadExecutor()

    @Volatile
    private var lastScreenshotAt = 0L

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        Log.i(TAG, "accessibility service connected — device control ready")
    }

    override fun onUnbind(intent: android.content.Intent?): Boolean {
        instance = null
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        instance = null
        screenshotExecutor.shutdownNow()
        super.onDestroy()
    }

    // The agent polls; it never reacts to events. Nothing to do here.
    override fun onAccessibilityEvent(event: AccessibilityEvent?) = Unit

    override fun onInterrupt() = Unit

    // ── gestures ────────────────────────────────────────────────────────────

    /** Single tap at device pixel coordinates. */
    fun tap(x: Int, y: Int): Boolean {
        val path = Path().apply { moveTo(x.toFloat(), y.toFloat()) }
        return dispatchBlocking(
            GestureDescription.Builder()
                .addStroke(GestureDescription.StrokeDescription(path, 0L, 60L))
                .build()
        )
    }

    /** Straight-line drag, matching `adb shell input swipe x1 y1 x2 y2 duration`. */
    fun swipe(x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Long): Boolean {
        val path = Path().apply {
            moveTo(x1.toFloat(), y1.toFloat())
            lineTo(x2.toFloat(), y2.toFloat())
        }
        val duration = durationMs.coerceIn(1L, 30_000L)
        return dispatchBlocking(
            GestureDescription.Builder()
                .addStroke(GestureDescription.StrokeDescription(path, 0L, duration))
                .build()
        )
    }

    fun goHome(): Boolean = performGlobalAction(GLOBAL_ACTION_HOME)

    /**
     * Dispatch a gesture and wait for the system to finish playing it back.
     *
     * Blocking matters: the backend navigator issues a tap and immediately dumps
     * the UI to read the result, so returning before the gesture completes would
     * race the screen it is about to read.
     */
    private fun dispatchBlocking(gesture: GestureDescription): Boolean {
        val latch = CountDownLatch(1)
        val completed = AtomicReference(false)

        val started = dispatchGesture(
            gesture,
            object : GestureResultCallback() {
                override fun onCompleted(description: GestureDescription?) {
                    completed.set(true)
                    latch.countDown()
                }

                override fun onCancelled(description: GestureDescription?) {
                    completed.set(false)
                    latch.countDown()
                }
            },
            null,
        )
        if (!started) {
            Log.w(TAG, "dispatchGesture refused the gesture")
            return false
        }
        if (!latch.await(GESTURE_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
            Log.w(TAG, "gesture timed out")
            return false
        }
        return completed.get()
    }

    // ── text ────────────────────────────────────────────────────────────────

    /**
     * Put `text` into the focused input, replacing whatever is there.
     *
     * This deliberately does NOT mimic `adb shell input text`, which appends at
     * the caret. adb synthesises real key events into a field the navigator had
     * usually just opened empty; here a stale query routinely survives on the
     * search box between keywords, and appending turned "fitness" followed by
     * "homegym" into a search for "fitnesshomegym". Replacing is both the
     * predictable behaviour and the one the navigator actually wants.
     *
     * Three things beyond the obvious, all needed for Instagram's search box:
     *  - the field must be focused, or the text is set on a view that ignores it;
     *  - the caret is moved to the end so IG's TextWatcher sees a normal edit;
     *  - if ACTION_SET_TEXT is refused (some IG builds reject it on the SERP
     *    header) fall back to a clipboard paste, which goes through the ordinary
     *    input path.
     */
    fun typeText(text: String): Boolean {
        val root = rootInActiveWindow ?: return false
        val target = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
            ?: firstEditable(root)
            ?: return false

        if (!target.isFocused) target.performAction(AccessibilityNodeInfo.ACTION_FOCUS)

        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        }
        if (target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) {
            moveCaretToEnd(target, text.length)
            return true
        }
        return pasteOver(target, text)
    }

    /**
     * Press the keyboard's Search key on the focused input.
     *
     * Typing alone only ever gets Instagram's as-you-type ACCOUNT suggestions,
     * which match handles against the raw string — that is why keyword scouting
     * kept surfacing profiles whose *name* contained the keyword rather than
     * creators posting about it. Committing the query is what loads the real
     * results page with its Reels tab.
     */
    fun submitSearch(): Boolean {
        val root = rootInActiveWindow ?: return false
        val target = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
            ?: firstEditable(root)
            ?: return false
        return target.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id)
    }

    private fun moveCaretToEnd(target: AccessibilityNodeInfo, length: Int) {
        val selection = Bundle().apply {
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, length)
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, length)
        }
        target.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, selection)
    }

    /** Select everything already in the field, then paste over it. */
    private fun pasteOver(target: AccessibilityNodeInfo, text: String): Boolean {
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("sourcing-agent", text))

        val existing = target.text?.toString().orEmpty()
        if (existing.isNotEmpty()) {
            val selectAll = Bundle().apply {
                putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, 0)
                putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, existing.length)
            }
            target.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, selectAll)
        }
        return target.performAction(AccessibilityNodeInfo.ACTION_PASTE)
    }

    private fun firstEditable(node: AccessibilityNodeInfo, depth: Int = 0): AccessibilityNodeInfo? {
        if (depth > 48) return null
        if (node.isEditable) return node
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            firstEditable(child, depth + 1)?.let { return it }
        }
        return null
    }

    // ── reading the screen ──────────────────────────────────────────────────

    /**
     * The flattened node tree the backend screen reader consumes — every
     * window, not just the active one, so dialogs and bottom sheets are visible
     * the way they were in a `uiautomator dump`.
     */
    fun dumpElements(): List<UiElement> = UiTree.collect(this)

    /** Real display size in pixels, matching `adb shell wm size`. */
    fun windowSize(): Pair<Int, Int> {
        val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val bounds = wm.currentWindowMetrics.bounds
        return bounds.width() to bounds.height()
    }

    /** Full-resolution PNG, matching `adb exec-out screencap -p`. */
    fun screenshotPng(): ByteArray = compress(captureBitmap(), Bitmap.CompressFormat.PNG, 100)

    /**
     * Downscaled JPEG for the dashboard's live mirror.
     *
     * The backend rejects frames over [BackendClient.MAX_FRAME_BYTES], so this
     * scales down and steps the quality until the payload fits rather than
     * firing off a frame that is certain to be refused.
     */
    fun screenshotJpeg(maxWidth: Int = 720, startQuality: Int = 70): ByteArray {
        val full = captureBitmap()
        val scaled = if (full.width > maxWidth) {
            val ratio = maxWidth.toFloat() / full.width
            Bitmap.createScaledBitmap(full, maxWidth, (full.height * ratio).toInt(), true)
        } else {
            full
        }

        var quality = startQuality
        var bytes = compress(scaled, Bitmap.CompressFormat.JPEG, quality)
        while (bytes.size > BackendClient.MAX_FRAME_BYTES && quality > 25) {
            quality -= 15
            bytes = compress(scaled, Bitmap.CompressFormat.JPEG, quality)
        }
        return bytes
    }

    private fun compress(bitmap: Bitmap, format: Bitmap.CompressFormat, quality: Int): ByteArray {
        val out = ByteArrayOutputStream()
        if (!bitmap.compress(format, quality, out)) {
            throw IllegalStateException("failed to encode screenshot as $format")
        }
        return out.toByteArray()
    }

    /**
     * Capture the screen through the accessibility API.
     *
     * This is the reason the app needs only one permission toggle: unlike
     * MediaProjection there is no per-session consent dialog. The platform rate
     * limits it to roughly one per second, so a too-soon call is waited out and
     * retried instead of surfacing as a failed command.
     */
    private fun captureBitmap(): Bitmap {
        val sinceLast = SystemClock.elapsedRealtime() - lastScreenshotAt
        if (sinceLast in 0 until SCREENSHOT_INTERVAL_MS) {
            Thread.sleep(SCREENSHOT_INTERVAL_MS - sinceLast)
        }

        val latch = CountDownLatch(1)
        val bitmapRef = AtomicReference<Bitmap?>(null)
        val errorRef = AtomicReference<String?>(null)

        takeScreenshot(
            Display.DEFAULT_DISPLAY,
            screenshotExecutor,
            object : TakeScreenshotCallback {
                override fun onSuccess(screenshot: ScreenshotResult) {
                    try {
                        val buffer = screenshot.hardwareBuffer
                        val bitmap = Bitmap.wrapHardwareBuffer(buffer, screenshot.colorSpace)
                        buffer.close()
                        if (bitmap == null) {
                            errorRef.set("screenshot buffer could not be decoded")
                        } else {
                            // Copy off the hardware buffer so the bitmap stays
                            // valid (and mutable enough to scale) after close().
                            bitmapRef.set(bitmap.copy(Bitmap.Config.ARGB_8888, false) ?: bitmap)
                        }
                    } catch (t: Throwable) {
                        errorRef.set(t.message ?: t.toString())
                    } finally {
                        latch.countDown()
                    }
                }

                override fun onFailure(errorCode: Int) {
                    errorRef.set(describeScreenshotError(errorCode))
                    latch.countDown()
                }
            },
        )

        if (!latch.await(SCREENSHOT_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
            throw IllegalStateException("screenshot timed out after ${SCREENSHOT_TIMEOUT_MS}ms")
        }
        lastScreenshotAt = SystemClock.elapsedRealtime()

        errorRef.get()?.let { throw IllegalStateException("screenshot failed: $it") }
        return bitmapRef.get() ?: throw IllegalStateException("screenshot returned no bitmap")
    }

    private fun describeScreenshotError(code: Int): String = when (code) {
        ERROR_TAKE_SCREENSHOT_INTERNAL_ERROR -> "internal error"
        ERROR_TAKE_SCREENSHOT_NO_ACCESSIBILITY_ACCESS -> "no accessibility access"
        ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT -> "rate limited (too soon after the last capture)"
        ERROR_TAKE_SCREENSHOT_INVALID_DISPLAY -> "invalid display"
        else -> "error code $code"
    }
}
