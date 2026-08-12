package technology.influence.sourcingagent

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.IBinder
import android.util.Base64
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The agent loop, as a foreground service — the Kotlin twin of `runAgent()` in
 * `runner/src/agent.js`.
 *
 *   claim a run -> pull the backend's device commands -> execute each on this
 *   phone -> post the result -> repeat until the backend says the run is done.
 *
 * Foreground because this is a standing worker: the operator starts it once and
 * leaves the phone on a shelf, so it has to survive the launcher going away and
 * Doze kicking in.
 */
class AgentService : Service() {

    companion object {
        private const val TAG = "AgentService"
        private const val CHANNEL_ID = "sourcing-agent"
        private const val NOTIFICATION_ID = 1001

        const val EXTRA_PROJECTION_RESULT_CODE = "projection_result_code"
        const val EXTRA_PROJECTION_DATA = "projection_data"
        const val ACTION_STOP = "technology.influence.sourcingagent.STOP"

        /** Polled by the setup screen — simpler than a bound service for one string. */
        @Volatile
        var status: String = "idle"
            private set

        @Volatile
        var isRunning: Boolean = false
            private set
    }

    private val running = AtomicBoolean(false)
    private var worker: Thread? = null
    private var mirror: Thread? = null

    private lateinit var prefs: Prefs
    private lateinit var power: PowerController

    private var projection: MediaProjection? = null
    private var clipRecorder: ClipRecorder? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        prefs = Prefs(this)
        power = PowerController(this)
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopEverything()
            return START_NOT_STICKY
        }
        if (running.get()) return START_STICKY

        val hasProjection = intent != null &&
            intent.hasExtra(EXTRA_PROJECTION_RESULT_CODE) &&
            intent.getIntExtra(EXTRA_PROJECTION_RESULT_CODE, 0) != 0

        startForegroundCompat(hasProjection)
        if (hasProjection) setUpProjection(intent!!)

        running.set(true)
        isRunning = true
        worker = Thread(::loop, "sourcing-agent").apply { start() }
        if (prefs.liveMirror) {
            mirror = Thread(::mirrorLoop, "sourcing-mirror").apply { start() }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        stopEverything()
        super.onDestroy()
    }

    // ── the loop ────────────────────────────────────────────────────────────

    private fun loop() {
        val backend = BackendClient(prefs.backendUrl, prefs.hostToken)
        val hostId = prefs.hostId
        val executor = CommandExecutor(
            context = this,
            backend = backend,
            hostId = hostId,
            power = power,
            clipProvider = { clipRecorder },
        )

        // The phone must stay awake for the whole session or the first screen
        // lock ends the run — same reason the Node runner shells out to
        // `svc power stayon true` before it starts scouting.
        runCatching { power.keepAwake() }

        while (running.get()) {
            val claim = try {
                backend.claimSession(hostId)
            } catch (e: Exception) {
                setStatus("claim failed: ${e.message}")
                sleep(prefs.idlePollMs)
                continue
            }

            if (!claim.active) {
                setStatus("idle — waiting for a queued run")
                sleep(prefs.idlePollMs)
                continue
            }

            setStatus("running — session started (run #${claim.runId ?: "?"})")
            serveSession(backend, executor, hostId)
            setStatus("session ended")
        }
        setStatus("stopped")
    }

    /** Serve one backend-owned session until it reports done. */
    private fun serveSession(backend: BackendClient, executor: CommandExecutor, hostId: Int) {
        var executed = 0
        while (running.get()) {
            val pulled = try {
                backend.pullCommands(hostId)
            } catch (e: Exception) {
                setStatus("pull failed: ${e.message}")
                sleep(prefs.agentPollMs)
                continue
            }

            for (cmd in pulled.commands) {
                if (!running.get()) return
                var ok = true
                var result: Any? = null
                var error: String? = null
                try {
                    result = executor.execute(cmd)
                } catch (e: Exception) {
                    ok = false
                    error = e.message ?: e.toString()
                    Log.w(TAG, "command ${cmd.op} failed: $error")
                }
                executed++
                setStatus("running — ${cmd.op} (${executed} commands)")
                try {
                    backend.postCommandResult(hostId, cmd.id, ok, result, error)
                } catch (e: Exception) {
                    Log.w(TAG, "result post failed: ${e.message}")
                }
            }

            if (pulled.done && pulled.commands.isEmpty()) return
            if (pulled.commands.isEmpty()) sleep(prefs.agentPollMs)
        }
    }

    /**
     * Feed the dashboard's "Watch phone" panel and execute admin take-over taps.
     *
     * Runs alongside the command loop rather than inside it, so a mirror hiccup
     * can never stall scouting. The whole loop switches itself off on a 404,
     * which is the backend saying SOURCING_LIVE_MIRROR is not enabled.
     */
    private fun mirrorLoop() {
        val backend = BackendClient(prefs.backendUrl, prefs.hostToken)
        val hostId = prefs.hostId

        while (running.get()) {
            val service = SourcingAccessibilityService.instance
            if (service == null) {
                sleep(prefs.frameMs)
                continue
            }

            try {
                val jpeg = service.screenshotJpeg()
                val (w, h) = service.windowSize()
                backend.publishFrame(
                    hostId = hostId,
                    dataBase64 = Base64.encodeToString(jpeg, Base64.NO_WRAP),
                    mediaType = "image/jpeg",
                    width = w,
                    height = h,
                )
            } catch (e: BackendException) {
                if (e.status == 404) {
                    Log.i(TAG, "live mirror disabled on the backend — stopping frame loop")
                    return
                }
                Log.w(TAG, "publishFrame failed: ${e.message}")
            } catch (e: Exception) {
                Log.w(TAG, "frame capture failed: ${e.message}")
            }

            runCatching { drainControls(backend, hostId) }
            sleep(prefs.frameMs)
        }
    }

    /** Apply admin taps/swipes/typing pushed from the dashboard. */
    private fun drainControls(backend: BackendClient, hostId: Int) {
        val service = SourcingAccessibilityService.instance ?: return
        for (op in backend.pullControls(hostId)) {
            when (op.optString("op")) {
                "tap" -> service.tap(op.optInt("x"), op.optInt("y"))
                "swipe" -> service.swipe(
                    op.optInt("x1"), op.optInt("y1"),
                    op.optInt("x2"), op.optInt("y2"),
                    op.optLong("durationMs", 200L),
                )
                "type" -> service.typeText(op.optString("text"))
                "home" -> service.goHome()
                // pause/resume are handled by the backend run state, not here.
                else -> Unit
            }
        }
    }

    // ── projection ──────────────────────────────────────────────────────────

    private fun setUpProjection(intent: Intent) {
        val code = intent.getIntExtra(EXTRA_PROJECTION_RESULT_CODE, 0)
        @Suppress("DEPRECATION")
        val data = intent.getParcelableExtra<Intent>(EXTRA_PROJECTION_DATA) ?: return
        val manager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager

        projection = manager.getMediaProjection(code, data)?.also { mp ->
            // Android 14+ requires a registered callback before a virtual display.
            mp.registerCallback(object : MediaProjection.Callback() {
                override fun onStop() {
                    clipRecorder = null
                    projection = null
                }
            }, null)

            val metrics = resources.displayMetrics
            clipRecorder = ClipRecorder(
                projection = mp,
                screenWidth = metrics.widthPixels,
                screenHeight = metrics.heightPixels,
                dpi = metrics.densityDpi,
            )
        }
    }

    // ── lifecycle plumbing ──────────────────────────────────────────────────

    private fun stopEverything() {
        running.set(false)
        isRunning = false
        worker?.interrupt()
        mirror?.interrupt()
        worker = null
        mirror = null
        runCatching { power.release() }
        runCatching { projection?.stop() }
        projection = null
        clipRecorder = null
        setStatus("stopped")
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun startForegroundCompat(withProjection: Boolean) {
        val type = if (withProjection) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC or
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
        } else {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
        }
        ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(status), type)
    }

    private fun createChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Sourcing agent",
            NotificationManager.IMPORTANCE_LOW,
        ).apply { description = "Shows whether the phone is connected to Deal Studio." }
        (getSystemService(NotificationManager::class.java)).createNotificationChannel(channel)
    }

    private fun buildNotification(text: String): Notification {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val stop = PendingIntent.getService(
            this,
            1,
            Intent(this, AgentService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Sourcing agent")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop", stop)
            .build()
    }

    private fun setStatus(text: String) {
        status = text
        runCatching {
            getSystemService(NotificationManager::class.java)
                .notify(NOTIFICATION_ID, buildNotification(text))
        }
    }

    private fun sleep(ms: Long) {
        try {
            Thread.sleep(ms)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }
    }
}
