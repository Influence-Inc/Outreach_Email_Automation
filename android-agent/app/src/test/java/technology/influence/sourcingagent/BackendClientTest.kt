package technology.influence.sourcingagent

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.net.InetSocketAddress

/**
 * Pins the HTTP contract with `backend/src/routes/sourcing.js`.
 *
 * These run against a stub server rather than a live backend, but they lock the
 * things that are invisible until a phone is sitting in front of you: the exact
 * paths, the `x-api-token` header, 204-means-idle, and the fact that a command
 * id must go back out with the JSON type it came in with.
 */
class BackendClientTest {

    private lateinit var server: HttpServer
    private lateinit var client: BackendClient

    private var lastMethod: String? = null
    private var lastPath: String? = null
    private var lastToken: String? = null
    private var lastBody: String? = null

    /** Set per-test: what the stub should answer with. */
    private var respondStatus = 200
    private var respondBody = "{}"

    @Before
    fun setUp() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { exchange: HttpExchange ->
            lastMethod = exchange.requestMethod
            lastPath = exchange.requestURI.path
            lastToken = exchange.requestHeaders.getFirst("x-api-token")
            lastBody = exchange.requestBody.readBytes().toString(Charsets.UTF_8)

            val bytes = respondBody.toByteArray()
            if (respondStatus == 204) {
                exchange.sendResponseHeaders(204, -1)
            } else {
                exchange.responseHeaders.add("Content-Type", "application/json")
                exchange.sendResponseHeaders(respondStatus, bytes.size.toLong())
                exchange.responseBody.use { it.write(bytes) }
            }
            exchange.close()
        }
        server.start()
        client = BackendClient("http://127.0.0.1:${server.address.port}", "sk_test_token")
    }

    @After
    fun tearDown() {
        server.stop(0)
    }

    @Test
    fun `claimSession posts to the host-scoped path with the token header`() {
        respondBody = """{"active":true,"runId":10}"""

        val claim = client.claimSession(3)

        assertEquals("POST", lastMethod)
        assertEquals("/api/sourcing/hosts/3/session/claim", lastPath)
        assertEquals("sk_test_token", lastToken)
        assertTrue(claim.active)
        assertEquals(10, claim.runId)
    }

    @Test
    fun `a 204 claim means idle, not failure`() {
        respondStatus = 204

        val claim = client.claimSession(3)

        assertEquals(false, claim.active)
        assertEquals(null, claim.runId)
    }

    @Test
    fun `remote control disabled names the backend env var to set`() {
        respondStatus = 404
        respondBody = """{"error":"remote control disabled"}"""

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
        respondStatus = 401
        respondBody = """{"error":"unauthorized"}"""

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
        respondBody = """
            {"commands":[
               {"id":7,"op":"tap","args":{"x":100,"y":220}},
               {"id":8,"op":"dumpUi","args":{}}
             ],
             "done":false}
        """.trimIndent()

        val pull = client.pullCommands(3)

        assertEquals("GET", lastMethod)
        assertEquals("/api/sourcing/hosts/3/commands", lastPath)
        assertEquals(2, pull.commands.size)
        assertEquals("tap", pull.commands[0].op)
        assertEquals(100, pull.commands[0].args.getInt("x"))
        assertEquals("dumpUi", pull.commands[1].op)
        assertEquals(false, pull.done)
    }

    @Test
    fun `commands without an op are skipped rather than executed blindly`() {
        respondBody = """{"commands":[{"id":1,"args":{}},{"id":2,"op":"home","args":{}}],"done":false}"""

        val pull = client.pullCommands(3)

        assertEquals(1, pull.commands.size)
        assertEquals("home", pull.commands[0].op)
    }

    @Test
    fun `a numeric command id goes back as a number, not a string`() {
        respondBody = """{"commands":[{"id":7,"op":"home","args":{}}],"done":false}"""
        val cmd = client.pullCommands(3).commands.first()

        respondBody = "{}"
        client.postCommandResult(3, cmd.id, ok = true, result = null, error = null)

        assertEquals("/api/sourcing/hosts/3/commands/result", lastPath)
        val sent = JSONObject(lastBody!!)
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
        client.postCommandResult(3, 12, ok = false, result = null, error = "tap gesture was not completed")

        val sent = JSONObject(lastBody!!)
        assertEquals(false, sent.getBoolean("ok"))
        assertEquals("tap gesture was not completed", sent.getString("error"))
    }

    @Test
    fun `publishFrame sends the mediaType it was given`() {
        client.publishFrame(3, dataBase64 = "AAAA", mediaType = "image/jpeg", width = 1080, height = 2400)

        assertEquals("/api/sourcing/hosts/3/frame", lastPath)
        val sent = JSONObject(lastBody!!)
        assertEquals("image/jpeg", sent.getString("mediaType"))
        assertEquals(1080, sent.getInt("width"))
        assertEquals(2400, sent.getInt("height"))
    }

    @Test
    fun `uploadClip posts raw bytes and returns the clipId`() {
        respondBody = """{"clipId":"clip_abc"}"""

        val clipId = client.uploadClip(3, byteArrayOf(1, 2, 3, 4), "video/mp4")

        assertEquals("/api/sourcing/hosts/3/clip", lastPath)
        assertEquals("clip_abc", clipId)
    }

    @Test
    fun `a trailing slash on the backend url does not double up in paths`() {
        val padded = BackendClient("http://127.0.0.1:${server.address.port}/", "sk_test_token")
        respondBody = """{"active":false}"""

        padded.claimSession(3)

        assertEquals("/api/sourcing/hosts/3/session/claim", lastPath)
    }
}
