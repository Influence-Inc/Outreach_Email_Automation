package technology.influence.sourcingagent

import android.graphics.Rect
import android.view.accessibility.AccessibilityNodeInfo

/**
 * Flattens the accessibility node tree into [UiElement]s — the on-device
 * replacement for `adb shell uiautomator dump`.
 *
 * The element shape itself lives in `UiElement.kt`, free of Android imports, so
 * the backend wire contract stays testable on a plain JVM.
 */
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
