package technology.influence.sourcingagent

import android.content.Context

/**
 * The on-device equivalent of the runner's `.runnerrc.json`.
 *
 * Deliberately typed and validated rather than free-form: the whole reason the
 * laptop setup kept failing was a config file that could be half-written or
 * syntactically broken and still load as "empty" with no complaint. Here there
 * is no file to hand-edit — [isComplete] is the single gate the UI enforces
 * before the agent can start.
 */
class Prefs(context: Context) {

    private val sp = context.getSharedPreferences("sourcing-agent", Context.MODE_PRIVATE)

    var backendUrl: String
        get() = sp.getString(KEY_URL, "")!!.trim().trimEnd('/')
        set(v) = sp.edit().putString(KEY_URL, v.trim().trimEnd('/')).apply()

    var hostToken: String
        get() = sp.getString(KEY_TOKEN, "")!!.trim()
        set(v) = sp.edit().putString(KEY_TOKEN, v.trim()).apply()

    var hostId: Int
        get() = sp.getInt(KEY_HOST_ID, 0)
        set(v) = sp.edit().putInt(KEY_HOST_ID, v).apply()

    var liveMirror: Boolean
        get() = sp.getBoolean(KEY_MIRROR, false)
        set(v) = sp.edit().putBoolean(KEY_MIRROR, v).apply()

    /** Poll interval for pending backend commands (mirrors RUNNER_AGENT_POLL_MS). */
    val agentPollMs: Long get() = 400L

    /** Wait between claim attempts when nothing is queued (RUNNER_IDLE_POLL_MS). */
    val idlePollMs: Long get() = 15_000L

    /** Live-mirror frame cadence (RUNNER_FRAME_MS). */
    val frameMs: Long get() = 3_000L

    fun isComplete(): Boolean =
        backendUrl.isNotEmpty() && hostToken.isNotEmpty() && hostId > 0

    /** Human-readable list of what is still missing, for the setup screen. */
    fun missing(): List<String> = buildList {
        if (backendUrl.isEmpty()) add("Backend URL")
        if (hostToken.isEmpty()) add("Host token")
        if (hostId <= 0) add("Host ID")
    }

    private companion object {
        const val KEY_URL = "backend_url"
        const val KEY_TOKEN = "host_token"
        const val KEY_HOST_ID = "host_id"
        const val KEY_MIRROR = "live_mirror"
    }
}
