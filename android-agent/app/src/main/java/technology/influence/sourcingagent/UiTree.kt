package technology.influence.sourcingagent

import android.graphics.Rect
import android.view.accessibility.AccessibilityNodeInfo
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

object UiTree {

    /**
     * The backend rejects trees larger than this, so stop walking rather than
     * build a payload that is guaranteed to be refused.
     */
    const val MAX_ELEMENTS = 4000

    private const val MAX_DEPTH = 64

    /** Flatten an accessibility node tree, depth-first, in screen order. */
    fun collect(root: AccessibilityNodeInfo?): List<UiElement> {
        val out = ArrayList<UiElement>(256)
        if (root != null) walk(root, out, 0)
        return out
    }

    private fun walk(node: AccessibilityNodeInfo, out: MutableList<UiElement>, depth: Int) {
        if (depth > MAX_DEPTH || out.size >= MAX_ELEMENTS) return

        toElement(node)?.let(out::add)

        for (i in 0 until node.childCount) {
            if (out.size >= MAX_ELEMENTS) return
            val child = node.getChild(i) ?: continue
            walk(child, out, depth + 1)
        }
    }

    /**
     * Degenerate nodes (zero width or height) are dropped: `uiautomator` skips
     * anything without a bounds box for the same reason — there is nothing to
     * tap and nothing to read, and they only inflate the payload toward the
     * backend's element cap.
     */
    private fun toElement(node: AccessibilityNodeInfo): UiElement? {
        val r = Rect()
        node.getBoundsInScreen(r)
        val w = r.width()
        val h = r.height()
        if (w <= 0 || h <= 0) return null

        return UiElement(
            rid = node.viewIdResourceName.orEmpty(),
            cls = node.className?.toString().orEmpty(),
            text = node.text?.toString().orEmpty(),
            desc = node.contentDescription?.toString().orEmpty(),
            clickable = node.isClickable,
            selected = node.isSelected,
            x = r.left,
            y = r.top,
            w = w,
            h = h,
        )
    }
}
