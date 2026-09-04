package jp.tanaka.tcloud.ui

import androidx.media3.common.C
import org.junit.Assert.assertEquals
import org.junit.Test

class RelativeSeekPositionTest {
    @Test
    fun touchingWithoutDraggingKeepsThePlaybackStartPosition() {
        assertEquals(42_000L, relativeSeekPositionMs(42_000L, 900f, 900f, 1_000, 120_000L))
    }

    @Test
    fun draggingRightAndLeftUsesTheFullDurationAsOneTrackWidth() {
        assertEquals(72_000L, relativeSeekPositionMs(42_000L, 400f, 650f, 1_000, 120_000L))
        assertEquals(12_000L, relativeSeekPositionMs(42_000L, 650f, 400f, 1_000, 120_000L))
    }

    @Test
    fun draggingPastTheBeginningAndEndIsClamped() {
        assertEquals(0L, relativeSeekPositionMs(1_000L, 500f, -500f, 1_000, 120_000L))
        assertEquals(120_000L, relativeSeekPositionMs(119_000L, 500f, 1_500f, 1_000, 120_000L))
    }

    @Test
    fun shortAndLongVideosKeepProportionalPrecision() {
        assertEquals(450L, relativeSeekPositionMs(300L, 20f, 45f, 100, 600L))
        assertEquals(32_400_000L, relativeSeekPositionMs(21_600_000L, 100f, 350f, 1_000, 43_200_000L))
    }

    @Test
    fun unknownOrInvalidDurationDoesNotSeek() {
        assertEquals(0L, relativeSeekPositionMs(10_000L, 0f, 50f, 100, C.TIME_UNSET))
        assertEquals(0L, relativeSeekPositionMs(10_000L, 0f, 50f, 100, 0L))
    }

    @Test
    fun invalidPointerCoordinatesKeepTheCurrentPosition() {
        assertEquals(10_000L, relativeSeekPositionMs(10_000L, Float.NaN, 50f, 100, 60_000L))
        assertEquals(10_000L, relativeSeekPositionMs(10_000L, 0f, Float.POSITIVE_INFINITY, 100, 60_000L))
    }

    @Test
    fun zeroWidthFallsBackSafelyAndStillClamps() {
        assertEquals(60_000L, relativeSeekPositionMs(10_000L, 0f, 1f, 0, 60_000L))
    }
}
