package technology.influence.sourcingagent

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The diagnostic exists to answer "why did the run stop?" without a laptop, so
 * its verdicts are the actual deliverable — these pin them.
 */
class ScreenDiagnosticTest {

    private fun reading(json: String) = JSONObject(json)

    @Test
    fun `a healthy profile read reports the screen and its targets`() {
        val result = ScreenDiagnostic.parse(
            elementCount = 812,
            withResourceId = 240,
            reading = reading("""{"screen":"profile","targets":{"reelsTab":{"x":540,"y":900},"back":{"x":40,"y":100}}}"""),
        )

        assertEquals("profile", result.screen)
        assertEquals(2, result.targets.size)
        assertTrue(result.render().contains("✓"))
    }

    @Test
    fun `an empty tree points at the accessibility service, not Instagram`() {
        val result = ScreenDiagnostic.parse(0, 0, reading("""{"screen":"unknown"}"""))

        val text = result.render()
        assertTrue(text.contains("✗"))
        assertTrue("should blame the a11y service, was: $text", text.contains("accessibility service"))
    }

    /**
     * The exact failure that made the first on-device run stall on a profile:
     * elements came back, but with no view-ids for the reader to match on.
     */
    @Test
    fun `a tree with no view-ids points at reinstalling the APK`() {
        val result = ScreenDiagnostic.parse(
            elementCount = 143,
            withResourceId = 0,
            reading = reading("""{"screen":"unknown"}"""),
        )

        val text = result.render()
        assertTrue(text.contains("✗"))
        assertTrue("should name the flags, was: $text", text.contains("flagReportViewIds"))
    }

    @Test
    fun `a recognised screen with no targets warns the navigator would stop`() {
        val result = ScreenDiagnostic.parse(
            elementCount = 500,
            withResourceId = 120,
            reading = reading("""{"screen":"profile","targets":{}}"""),
        )

        val text = result.render()
        assertTrue(text.contains("△"))
        assertTrue("should name the screen, was: $text", text.contains("profile"))
        assertTrue(text.contains("screenVision.js"))
    }

    @Test
    fun `an unclassified screen points at calibration`() {
        val result = ScreenDiagnostic.parse(
            elementCount = 500,
            withResourceId = 200,
            reading = reading("""{"screen":"unknown","targets":{}}"""),
        )

        assertTrue(result.render().contains("screenVision.js"))
    }

    @Test
    fun `search results are surfaced so a bad keyword query is visible`() {
        val result = ScreenDiagnostic.parse(
            elementCount = 600,
            withResourceId = 180,
            reading = reading(
                """{"screen":"search_results","targets":{"back":{"x":1,"y":2}},
                    "results":["homegym.co","fitfam","liftheavy"]}"""
            ),
        )

        assertEquals(listOf("homegym.co", "fitfam", "liftheavy"), result.results)
        assertTrue(result.render().contains("homegym.co"))
    }

    @Test
    fun `a missing screen field degrades to unknown rather than throwing`() {
        val result = ScreenDiagnostic.parse(10, 5, reading("{}"))

        assertEquals("unknown", result.screen)
        assertTrue(result.targets.isEmpty())
    }
}
