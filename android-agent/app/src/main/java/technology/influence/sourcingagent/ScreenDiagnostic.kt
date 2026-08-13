package technology.influence.sourcingagent

import org.json.JSONObject

/**
 * "What does the backend actually see?" — the calibration loop, on the phone.
 *
 * When the navigator stalls (opens a profile and goes no further, searches and
 * finds nothing), the cause is almost always that `screenVision.js` could not
 * resolve a tap target from the element tree this app sent. That failure is
 * silent by design: the reader degrades to `screen: unknown` rather than
 * throwing, so a run just quietly captures nothing.
 *
 * This runs the exact same read the navigator does and reports the answer, so
 * the question "why did it stop on the profile?" has a printable answer instead
 * of requiring a laptop, adb, and a `uiautomator dump`.
 */
object ScreenDiagnostic {

    /** Resource-ids the reader needs; reported so a missing one is obvious. */
    private val KEY_SIGNALS = listOf(
        "searchTab", "searchBox", "back", "reelsTab", "authorProfile",
    )

    data class Result(
        val elementCount: Int,
        val withResourceId: Int,
        val screen: String,
        val targets: List<String>,
        val results: List<String>,
        val followers: String?,
    ) {
        /** Rendered into the setup screen's status area. */
        fun render(): String = buildString {
            appendLine("elements      : $elementCount")
            appendLine("with view-ids : $withResourceId")
            appendLine("screen        : $screen")
            appendLine("targets       : ${if (targets.isEmpty()) "(none)" else targets.joinToString(", ")}")
            if (results.isNotEmpty()) appendLine("results       : ${results.take(5).joinToString(", ")}")
            if (followers != null) appendLine("followers     : $followers")
            appendLine()
            append(verdict())
        }

        /**
         * Turn the numbers into the one sentence that says what to do next. A
         * tree with almost no view-ids is the signature of the accessibility
         * service missing flagIncludeNotImportantViews / flagReportViewIds.
         */
        private fun verdict(): String = when {
            elementCount == 0 ->
                "✗ Nothing was read at all. The accessibility service is not attached — " +
                    "re-enable it under Settings → Accessibility."

            withResourceId == 0 ->
                "✗ No element carries a view-id. The screen reader matches on those, so " +
                    "nothing will ever resolve. Reinstall the latest APK — this is what " +
                    "flagReportViewIds / flagIncludeNotImportantViews fix."

            screen == "unknown" ->
                "✗ The backend could not classify this screen. Either it is not one of the " +
                    "scouting screens, or Instagram changed its ids — the signals in " +
                    "backend/src/services/screenVision.js need a calibration pass."

            targets.isEmpty() ->
                "△ Screen recognised as \"$screen\" but no tap targets resolved. The navigator " +
                    "would stop here. Check the SIGNALS for this screen in screenVision.js."

            else ->
                "✓ Screen recognised as \"$screen\" with ${targets.size} tap target(s). " +
                    "The navigator can act on this."
        }
    }

    /** Parse a `/vision/read` response into the reportable shape. */
    fun parse(elementCount: Int, withResourceId: Int, reading: JSONObject): Result {
        val targetsObj = reading.optJSONObject("targets")
        val targets = targetsObj?.keys()?.asSequence()?.toList().orEmpty()

        val resultsArr = reading.optJSONArray("results")
        val results = buildList {
            for (i in 0 until (resultsArr?.length() ?: 0)) {
                resultsArr?.optString(i)?.takeIf { it.isNotEmpty() }?.let(::add)
            }
        }

        return Result(
            elementCount = elementCount,
            withResourceId = withResourceId,
            screen = reading.optString("screen", "unknown").ifEmpty { "unknown" },
            targets = targets,
            results = results,
            followers = if (reading.isNull("followers")) null else reading.optString("followers"),
        )
    }

    /** Signals worth eyeballing when a screen reads as unknown. */
    fun keySignals(): List<String> = KEY_SIGNALS
}
