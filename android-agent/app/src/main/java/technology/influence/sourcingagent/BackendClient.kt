package technology.influence.sourcingagent

import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * Thin Deal Studio HTTP client — the Kotlin twin of `runner/src/backend.js`.
 *
 * Every request carries the paired host's machine token as `x-api-token`, which
 * is what `siteAuth.js` accepts. Deliberately tiny: no retries, no polling. The
 * caller ([AgentService]) owns pacing and error handling, exactly as the Node
 * runner's loop does.
 */
class BackendClient(baseUrl: String, private val token: String) {

    private val base: String = baseUrl.trim().trimEnd('/')

    companion object {
        /** Mirrors MAX_FRAME_BYTES in `backend/src/services/hostChannel.js`. */
        const val MAX_FRAME_BYTES = 400 * 1024
    }

    data class Claim(val active: Boolean, val runId: Int?)

    data class Command(val id: Any, val op: String, val args: JSONObject)

    data class Pull(val commands: List<Command>, val done: Boolean)

    /**
     * Claim the newest queued run for this host.
     *
     * A 204 means "nothing queued right now" (or we are outside the backend's
     * configured active hours) — not an error, just idle.
     */
    fun claimSession(hostId: Int): Claim {
        val (status, body) = request("POST", "/api/sourcing/hosts/$hostId/session/claim")
        if (status == 204) return Claim(active = false, runId = null)
        val json = expectJson("POST", "/session/claim", status, body)
        return Claim(
            active = json.optBoolean("active", false),
            runId = if (json.isNull("runId")) null else json.optInt("runId"),
        )
    }

    /** Drain the queued device commands. `done` means the backend finished the run. */
    fun pullCommands(hostId: Int): Pull {
        val (status, body) = request("GET", "/api/sourcing/hosts/$hostId/commands")
        val json = expectJson("GET", "/commands", status, body)
        val arr: JSONArray = json.optJSONArray("commands") ?: JSONArray()
        val cmds = ArrayList<Command>(arr.length())
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val op = o.optString("op", "")
            if (op.isEmpty()) continue
            // Preserve the id's JSON type verbatim — the backend settles the
            // navigator's await by looking this value up in a Map, so coercing a
            // number to a string here would silently strand the promise.
            cmds.add(Command(id = o.get("id"), op = op, args = o.optJSONObject("args") ?: JSONObject()))
        }
        return Pull(commands = cmds, done = json.optBoolean("done", false))
    }

    /** Post a command's result, settling the backend navigator's await. */
    fun postCommandResult(hostId: Int, id: Any, ok: Boolean, result: Any?, error: String?) {
        val payload = JSONObject().apply {
            put("id", id)
            put("ok", ok)
            put("result", result ?: JSONObject.NULL)
            put("error", error ?: JSONObject.NULL)
        }
        val (status, body) = request("POST", "/api/sourcing/hosts/$hostId/commands/result", payload.toString())
        expectJson("POST", "/commands/result", status, body)
    }

    /** Upload a recorded reel clip as raw bytes; returns the backend's clipId. */
    fun uploadClip(hostId: Int, bytes: ByteArray, mediaType: String = "video/mp4"): String {
        val (status, body) = requestRaw(
            method = "POST",
            path = "/api/sourcing/hosts/$hostId/clip",
            contentType = mediaType,
            body = bytes,
        )
        val json = expectJson("POST", "/clip", status, body)
        return json.optString("clipId", "")
    }

    /**
     * Publish the latest screen frame for the dashboard's "Watch phone" panel.
     * 404s when `SOURCING_LIVE_MIRROR` is off on the backend, which the caller
     * treats as "the mirror is disabled" rather than a failure.
     *
     * The backend caps a frame at [MAX_FRAME_BYTES] (`hostChannel.js`), so the
     * caller must send a downscaled JPEG — a full-resolution PNG screencap
     * routinely blows past the cap and comes back as "frame too large".
     */
    fun publishFrame(
        hostId: Int,
        dataBase64: String,
        mediaType: String,
        width: Int?,
        height: Int?,
    ) {
        val payload = JSONObject().apply {
            put("dataBase64", dataBase64)
            put("mediaType", mediaType)
            put("width", width ?: JSONObject.NULL)
            put("height", height ?: JSONObject.NULL)
        }
        val (status, body) = request("POST", "/api/sourcing/hosts/$hostId/frame", payload.toString())
        expectJson("POST", "/frame", status, body)
    }

    /**
     * Drain admin take-over ops queued from the dashboard's phone view.
     *
     * Note the op fields are flat (`{op:"tap", x, y}`), not nested under `args`
     * the way device commands are — this is a different channel from the
     * navigator's, and `liveMirror.js` defines the shape.
     */
    fun pullControls(hostId: Int): List<JSONObject> {
        val (status, body) = request("GET", "/api/sourcing/hosts/$hostId/control")
        val json = expectJson("GET", "/control", status, body)
        val arr = json.optJSONArray("ops") ?: JSONArray()
        return (0 until arr.length()).mapNotNull { arr.optJSONObject(it) }
    }

    // ── plumbing ────────────────────────────────────────────────────────────

    private fun request(method: String, path: String, body: String? = null): Pair<Int, String> =
        requestRaw(method, path, "application/json", body?.toByteArray(Charsets.UTF_8))

    private fun requestRaw(
        method: String,
        path: String,
        contentType: String,
        body: ByteArray?,
    ): Pair<Int, String> {
        val conn = (URL(base + path).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            setRequestProperty("Content-Type", contentType)
            setRequestProperty("x-api-token", token)
            setRequestProperty("Accept", "application/json")
            connectTimeout = 15_000
            readTimeout = 60_000
            doInput = true
        }
        try {
            if (body != null) {
                conn.doOutput = true
                conn.setFixedLengthStreamingMode(body.size)
                conn.outputStream.use { it.write(body) }
            } else if (method == "POST") {
                // A POST with no body still needs a content length or some
                // servers hang waiting for one.
                conn.doOutput = true
                conn.setFixedLengthStreamingMode(0)
                conn.outputStream.use { }
            }
            val status = conn.responseCode
            val stream: InputStream? = if (status in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.use { readAll(it) }.orEmpty()
            return status to text
        } finally {
            conn.disconnect()
        }
    }

    private fun readAll(stream: InputStream): String {
        val out = ByteArrayOutputStream()
        val buf = ByteArray(16 * 1024)
        while (true) {
            val n = stream.read(buf)
            if (n < 0) break
            out.write(buf, 0, n)
        }
        return out.toString("UTF-8")
    }

    private fun expectJson(method: String, label: String, status: Int, body: String): JSONObject {
        val json = runCatching { if (body.isBlank()) null else JSONObject(body) }.getOrNull()
        if (status !in 200..299) {
            val serverError = json?.optString("error").orEmpty()
            throw BackendException(status, friendly(status, serverError, method, label, body))
        }
        return json ?: JSONObject()
    }

    /**
     * Turn the two failures that actually strand an operator into instructions
     * instead of status codes. `remote control disabled` in particular is a
     * backend feature flag, not a client bug — surfacing it as a bare 404 is
     * what makes an agent look like it is silently retrying nothing.
     */
    private fun friendly(
        status: Int,
        serverError: String,
        method: String,
        label: String,
        rawBody: String,
    ): String = when {
        status == 404 && serverError.contains("remote control disabled", ignoreCase = true) ->
            "Backend has agent mode switched off. Set SOURCING_REMOTE_CONTROL=on in the " +
                "backend's environment (Railway → Variables) and redeploy."

        status == 401 || status == 403 ->
            "Backend rejected the host token (HTTP $status). Re-mint it in Deal Studio under " +
                "Scout creators → Paired phone-hosts and paste the full sk_… value."

        else -> "$method $label -> $status ${serverError.ifEmpty { rawBody.take(200) }}"
    }
}

class BackendException(val status: Int, message: String) : Exception(message)
