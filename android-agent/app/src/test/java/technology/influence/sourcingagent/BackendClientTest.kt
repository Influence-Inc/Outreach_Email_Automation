package technology.influence.sourcingagent

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/**
 * Pins the HTTP contract with `backend/src/routes/sourcing.js`.
 *
 * These run against MockWebServer rather than a live backend, but they lock the
 * things that are invisible until a phone is sitting in front of you: the exact
 * paths, the `x-api-token` header, 204-means-idle, and the fact that a command
 * id must go back out with the JSON type it came in with.
 *
 * MockWebServer rather than the JDK's `com.sun.net.httpserver`: the latter is
 * not part of Android's API surface, so it resolves on a plain JVM but fails to
 * compile under the Android Gradle Plugin's unit-test classpath.
 */
class BackendClientTest {

    private lateinit var server: MockWebServer
    private lateinit var client: BackendClient

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        client = BackendClient(server.url("/").toString().trimEnd('/'), "sk_test_token")
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun respond(status: Int, body: String = "{}") {
        val response = MockResponse().setResponseCode(status)
        if (status != 204) response.setBody(body)
        server.enqueue(response)
    }

    @Test
    fun `claimSession posts to the host-scoped path with the token header`() {
        respond(200, """{"active":true,"runId":10}""")

        val claim = client.claimSession(3)

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/sourcing/hosts/3/session/claim", request.path)
        assertEquals("sk_test_token", request.getHeader("x-api-token"))
        assertTrue(claim.active)
        assertEquals(10, claim.runId)
    }

    @Test
    fun `a 204 claim means idle, not failure`() {
        respond(204)

        val claim = client.claimSession(3)

        assertEquals(false, claim.active)
        assertEquals(null, claim.runId)
    }

    @Test
    fun `remote control disabled names the backend env var to set`() {
        respond(404, """{"error":"remote control disabled"}""")

        try {
            client.claimSession(3)
            fail("expected a BackendException")
        } catch (e: BackendException) {
            assertEquals(404, e.status)
            // The whole point: an operator reading this should not have to go
            // spelunking through route middleware to learn what to switch on.
            assertTrue(
                "message should name the flag, was: ${e.message}",
                e.message!!.contains("SOURCING_REMOTE_CONTROL=on"),
            )
        }
    }

    @Test
    fun `a rejected token points at re-minting rather than the raw status`() {
        respond(401, """{"error":"unauthorized"}""")

        try {
            client.pullCommands(3)
            fail("expected a BackendException")
        } catch (e: BackendException) {
            assertTrue(
                "message should mention the host token, was: ${e.message}",
                e.message!!.contains("host token"),
            )
        }
    }

    @Test
    fun `pullCommands parses the command envelope and the done flag`() {
        respond(
            200,
            """
            {"commands":[
               {"id":7,"op":"tap","args":{"x":100,"y":220}},
               {"id":8,"op":"dumpUi","args":{}}
             ],
             "done":false}
            """.trimIndent(),
        )

        val pull = client.pullCommands(3)

        val request = server.takeRequest()
        assertEquals("GET", request.method)
        assertEquals("/api/sourcing/hosts/3/commands", request.path)
        assertEquals(2, pull.commands.size)
        assertEquals("tap", pull.commands[0].op)
        assertEquals(100, pull.commands[0].args.getInt("x"))
        assertEquals("dumpUi", pull.commands[1].op)
        assertEquals(false, pull.done)
    }

    @Test
    fun `commands without an op are skipped rather than executed blindly`() {
        respond(200, """{"commands":[{"id":1,"args":{}},{"id":2,"op":"home","args":{}}],"done":false}""")

        val pull = client.pullCommands(3)

        assertEquals(1, pull.commands.size)
        assertEquals("home", pull.commands[0].op)
    }

    @Test
    fun `a numeric command id goes back as a number, not a string`() {
        respond(200, """{"commands":[{"id":7,"op":"home","args":{}}],"done":false}""")
        val cmd = client.pullCommands(3).commands.first()
        server.takeRequest()

        respond(200)
        client.postCommandResult(3, cmd.id, ok = true, result = null, error = null)

        val request = server.takeRequest()
        assertEquals("/api/sourcing/hosts/3/commands/result", request.path)
        val sent = JSONObject(request.body.readUtf8())
        // hostCommands.resolve() looks this up in a Map — a stringified id would
        // silently strand the navigator's await until it timed out.
        assertEquals(7, sent.get("id"))
        assertTrue(sent.get("id") is Int)
        assertEquals(true, sent.getBoolean("ok"))
        assertTrue(sent.isNull("result"))
        assertTrue(sent.isNull("error"))
    }

    @Test
    fun `a failed command reports ok false with the error text`() {
        respond(200)

        client.postCommandResult(3, 12, ok = false, result = null, error = "tap gesture was not completed")

        val sent = JSONObject(server.takeRequest().body.readUtf8())
        assertEquals(false, sent.getBoolean("ok"))
        assertEquals("tap gesture was not completed", sent.getString("error"))
    }

    @Test
    fun `publishFrame sends the mediaType it was given`() {
        respond(200)

        client.publishFrame(3, dataBase64 = "AAAA", mediaType = "image/jpeg", width = 1080, height = 2400)

        val request = server.takeRequest()
        assertEquals("/api/sourcing/hosts/3/frame", request.path)
        val sent = JSONObject(request.body.readUtf8())
        assertEquals("image/jpeg", sent.getString("mediaType"))
        assertEquals(1080, sent.getInt("width"))
        assertEquals(2400, sent.getInt("height"))
    }

    @Test
    fun `uploadClip posts raw bytes under the clip content type`() {
        respond(200, """{"clipId":"clip_abc"}""")

        val clipId = client.uploadClip(3, byteArrayOf(1, 2, 3, 4), "video/mp4")

        val request = server.takeRequest()
        assertEquals("/api/sourcing/hosts/3/clip", request.path)
        // Must not be application/json — the backend routes this to a raw parser
        // so the 1 MB express.json limit does not reject the upload.
        assertEquals("video/mp4", request.getHeader("Content-Type"))
        assertEquals(4L, request.bodySize)
        assertEquals("clip_abc", clipId)
    }

    @Test
    fun `a trailing slash on the backend url does not double up in paths`() {
        val padded = BackendClient("${server.url("/")}", "sk_test_token")
        respond(200, """{"active":false}""")

        padded.claimSession(3)

        assertEquals("/api/sourcing/hosts/3/session/claim", server.takeRequest().path)
    }
}
