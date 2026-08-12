package technology.influence.sourcingagent

import org.json.JSONArray
import org.json.JSONObject

/**
 * One screen element, in exactly the shape the backend screen reader consumes.
 *
 * This is the compatibility contract with the laptop runner: `parseUiXml()` in
 * `runner/src/driver/android.js` turns a `uiautomator dump` into
 * `{ rid, cls, text, desc, clickable, selected, bounds:{x,y,w,h} }`, and
 * `backend/src/services/screenVision.js` matches on those field names. Producing
 * the same objects from the accessibility tree is what lets this app drop in
 * without touching a line of backend code.
 *
 * Deliberately kept free of Android imports so the wire shape can be compiled
 * and tested on a plain JVM — see `UiElementTest`.
 */
data class UiElement(
    val rid: String,
    val cls: String,
    val text: String,
    val desc: String,
    val clickable: Boolean,
    val selected: Boolean,
    val x: Int,
    val y: Int,
    val w: Int,
    val h: Int,
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("rid", rid)
        put("cls", cls)
        put("text", text)
        put("desc", desc)
        put("clickable", clickable)
        put("selected", selected)
        put("bounds", JSONObject().apply {
            put("x", x)
            put("y", y)
            put("w", w)
            put("h", h)
        })
    }
}

fun List<UiElement>.toJsonArray(): JSONArray =
    JSONArray().also { arr -> forEach { arr.put(it.toJson()) } }
