package technology.influence.sourcingagent

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import technology.influence.sourcingagent.databinding.ActivityMainBinding

/**
 * The entire setup surface: three fields, three buttons.
 *
 * This replaces `adb pair` / `adb connect` / `.runnerrc.json` / a laptop running
 * Node. The phone reaches out to the backend, so there is no pairing handshake,
 * no ip:port that rotates, and no requirement that a computer be on the same
 * network — or on at all.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var prefs: Prefs

    private var projectionResultCode: Int = 0
    private var projectionData: Intent? = null

    /** Last "Test screen read" verdict, shown under the status block. */
    private var diagnostic: String? = null

    private val ui = Handler(Looper.getMainLooper())

    private val requestProjection = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode != RESULT_OK || result.data == null) {
            toast("Screen capture not granted — reel recording will stay off")
            return@registerForActivityResult
        }
        projectionResultCode = result.resultCode
        projectionData = result.data
        toast("Screen capture granted")
        render()
    }

    private val requestPermissions = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { /* best effort — the agent still runs without notifications or audio */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        prefs = Prefs(this)

        binding.backendUrl.setText(prefs.backendUrl)
        binding.hostToken.setText(prefs.hostToken)
        binding.hostId.setText(if (prefs.hostId > 0) prefs.hostId.toString() else "")
        binding.liveMirror.isChecked = prefs.liveMirror

        binding.enableAccessibility.setOnClickListener {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            toast("Find \"Sourcing Agent\" under Installed apps and switch it on")
        }

        binding.grantCapture.setOnClickListener {
            val manager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            requestProjection.launch(manager.createScreenCaptureIntent())
        }

        binding.toggleAgent.setOnClickListener { if (AgentService.isRunning) stopAgent() else startAgent() }
        binding.testRead.setOnClickListener { startDiagnostic() }

        askForOptionalPermissions()
    }

    // ── screen-read diagnostic ──────────────────────────────────────────────

    /**
     * Read the current screen through the backend and report the verdict.
     *
     * Delayed rather than immediate: the interesting screen is whatever
     * Instagram is showing, and tapping a button in this app necessarily puts
     * this app in the foreground. Six seconds is enough to switch across.
     */
    private fun startDiagnostic() {
        save()
        if (!SourcingAccessibilityService.isRunning()) {
            toast("Enable the accessibility service first (step 1)")
            return
        }
        val gaps = prefs.missing()
        if (gaps.isNotEmpty()) {
            toast("Still needed: ${gaps.joinToString(", ")}")
            return
        }
        diagnostic = "reading in 6s — switch to Instagram now"
        render()
        toast("Switch to Instagram now — reading the screen in 6 seconds")
        ui.postDelayed(::runDiagnostic, 6_000L)
    }

    private fun runDiagnostic() {
        Thread {
            val text = runCatching { readCurrentScreen() }
                .getOrElse { "diagnostic failed: ${it.message}" }
            ui.post {
                diagnostic = text
                render()
            }
        }.start()
    }

    private fun readCurrentScreen(): String {
        val service = SourcingAccessibilityService.instance
            ?: return "accessibility service is not attached"

        val elements = service.dumpElements()
        val (width, height) = service.windowSize()
        val reading = BackendClient(prefs.backendUrl, prefs.hostToken)
            .readScreen(elements.toJsonArray(), width, height)

        return ScreenDiagnostic.parse(
            elementCount = elements.size,
            withResourceId = elements.count { it.rid.isNotEmpty() },
            reading = reading,
        ).render()
    }

    override fun onResume() {
        super.onResume()
        ui.post(pollRunnable)
    }

    override fun onPause() {
        super.onPause()
        // Only stop the status refresh. Cancelling everything here would also
        // kill the pending "Test screen read", whose whole point is to fire
        // after the operator has switched away to Instagram.
        ui.removeCallbacks(pollRunnable)
        save()
    }

    // ── actions ─────────────────────────────────────────────────────────────

    private fun startAgent() {
        save()
        val gaps = prefs.missing()
        if (gaps.isNotEmpty()) {
            toast("Still needed: ${gaps.joinToString(", ")}")
            return
        }
        if (!SourcingAccessibilityService.isRunning()) {
            toast("Enable the accessibility service first (step 1)")
            return
        }

        val intent = Intent(this, AgentService::class.java)
        projectionData?.let {
            intent.putExtra(AgentService.EXTRA_PROJECTION_RESULT_CODE, projectionResultCode)
            intent.putExtra(AgentService.EXTRA_PROJECTION_DATA, it)
        }
        ContextCompat.startForegroundService(this, intent)
        render()
    }

    private fun stopAgent() {
        startService(Intent(this, AgentService::class.java).setAction(AgentService.ACTION_STOP))
        render()
    }

    private fun save() {
        prefs.backendUrl = binding.backendUrl.text.toString()
        prefs.hostToken = binding.hostToken.text.toString()
        prefs.hostId = binding.hostId.text.toString().trim().toIntOrNull() ?: 0
        prefs.liveMirror = binding.liveMirror.isChecked
    }

    private fun askForOptionalPermissions() {
        val wanted = mutableListOf<String>()
        // POST_NOTIFICATIONS only exists from API 33; on 30-32 the foreground
        // notification shows without asking.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            wanted += Manifest.permission.POST_NOTIFICATIONS
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED
        ) {
            wanted += Manifest.permission.RECORD_AUDIO
        }
        if (wanted.isNotEmpty()) requestPermissions.launch(wanted.toTypedArray())
    }

    // ── status ──────────────────────────────────────────────────────────────

    /** One-second refresh instead of a bound service — it is a single string. */
    private val pollRunnable = object : Runnable {
        override fun run() {
            render()
            ui.postDelayed(this, 1_000L)
        }
    }

    private fun render() {
        val a11y = if (SourcingAccessibilityService.isRunning()) "on" else "OFF — tap step 1"
        val capture = if (projectionData != null) "granted" else "not granted (reels only)"
        binding.toggleAgent.text = if (AgentService.isRunning) "3. Stop agent" else "3. Start agent"
        binding.status.text = buildString {
            appendLine("accessibility : $a11y")
            appendLine("screen capture: $capture")
            appendLine("agent         : ${if (AgentService.isRunning) "running" else "stopped"}")
            appendLine("status        : ${AgentService.status}")
            append("phone view    : ${AgentService.mirrorStatus}")
            diagnostic?.let {
                appendLine()
                appendLine()
                appendLine("── screen read ──")
                append(it)
            }
        }
    }

    private fun toast(message: String) =
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()
}
