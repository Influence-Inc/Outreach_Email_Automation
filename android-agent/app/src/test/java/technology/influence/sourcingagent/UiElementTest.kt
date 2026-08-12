package technology.influence.sourcingagent

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Locks the wire shape against `backend/src/services/screenVision.js`.
 *
 * The backend matches on `rid` / `cls` / `text` / `desc` / `clickable` and reads
 * tap coordinates out of `bounds.{x,y,w,h}`. If any of these names drift, the
 * reader silently degrades to `screen: unknown` and the navigator starts tapping
 * nothing — a failure that is invisible until a whole run captures zero
 * candidates, so it is worth pinning here.
 */
class UiElementTest {

    private fun element() = UiElement(
        rid = "com.instagram.android:id/search_edit_text",
        cls = "android.widget.EditText",
        text = "homegym",
        desc = "Search",
        clickable = true,
        selected = false,
        x = 100,
        y = 220,
        w = 880,
        h = 140,
    )

    @Test
    fun `serializes the field names screenVision reads`() {
        val json = element().toJson()

        assertEquals("com.instagram.android:id/search_edit_text", json.getString("rid"))
        assertEquals("android.widget.EditText", json.getString("cls"))
        assertEquals("homegym", json.getString("text"))
        assertEquals("Search", json.getString("desc"))
        assertTrue(json.getBoolean("clickable"))
        assertTrue(!json.getBoolean("selected"))
    }

    @Test
    fun `bounds are x y w h in device pixels, not left top right bottom`() {
        val bounds: JSONObject = element().toJson().getJSONObject("bounds")

        assertEquals(100, bounds.getInt("x"))
        assertEquals(220, bounds.getInt("y"))
        assertEquals(880, bounds.getInt("w"))
        assertEquals(140, bounds.getInt("h"))

        // screenVision.center() computes x + w/2, so a right/bottom pair here
        // would place every tap far off-screen.
        assertEquals(540, bounds.getInt("x") + bounds.getInt("w") / 2)
        assertEquals(290, bounds.getInt("y") + bounds.getInt("h") / 2)
    }

    @Test
    fun `empty attributes serialize as empty strings rather than null`() {
        val json = UiElement(
            rid = "", cls = "android.view.View", text = "", desc = "",
            clickable = false, selected = false, x = 0, y = 0, w = 10, h = 10,
        ).toJson()

        assertEquals("", json.getString("rid"))
        assertEquals("", json.getString("text"))
        assertEquals("", json.getString("desc"))
    }

    @Test
    fun `toJsonArray preserves order`() {
        val arr = listOf(
            element().copy(text = "first"),
            element().copy(text = "second"),
        ).toJsonArray()

        assertEquals(2, arr.length())
        assertEquals("first", arr.getJSONObject(0).getString("text"))
        assertEquals("second", arr.getJSONObject(1).getString("text"))
    }
}
