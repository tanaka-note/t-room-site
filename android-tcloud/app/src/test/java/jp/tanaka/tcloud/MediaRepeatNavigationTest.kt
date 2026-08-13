package jp.tanaka.tcloud

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MediaRepeatNavigationTest {
    @Test
    fun defaultPlaybackStopsAtTheLastItem() {
        assertNull(nextMediaIndex(2, 3, 1, automaticRepeat = false))
    }

    @Test
    fun repeatAllWrapsTheLastItemToTheBeginning() {
        assertEquals(0, nextMediaIndex(2, 3, 1, automaticRepeat = true))
    }

    @Test
    fun repeatAllWrapsTheFirstItemToTheEndWhenMovingBackward() {
        assertEquals(2, nextMediaIndex(0, 3, -1, automaticRepeat = true))
    }

    @Test
    fun nextItemAdvancesNormallyBeforeTheEnd() {
        assertEquals(1, nextMediaIndex(0, 3, 1, automaticRepeat = false))
        assertEquals(1, nextMediaIndex(0, 3, 1, automaticRepeat = true))
    }
}
