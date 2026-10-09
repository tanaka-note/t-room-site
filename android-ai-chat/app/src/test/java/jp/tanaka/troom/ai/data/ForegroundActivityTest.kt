package jp.tanaka.troom.ai.data

import org.junit.Assert.*
import org.junit.Test

class ForegroundActivityTest {
    @Test fun onlyRecentForegroundInteractionCounts() {
        var now = 0L
        val activity = ForegroundActivity { now }
        assertFalse(activity.isActive())
        activity.resume()
        assertTrue(activity.isActive())
        now = 60_001
        assertFalse(activity.isActive())
        activity.interact()
        assertTrue(activity.isActive())
        activity.pause()
        activity.interact()
        assertFalse(activity.isActive())
        now += 43_200_001
        activity.resume()
        assertTrue(activity.isActive())
    }
}
