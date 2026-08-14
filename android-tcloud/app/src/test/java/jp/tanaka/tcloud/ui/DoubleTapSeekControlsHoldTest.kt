package jp.tanaka.tcloud.ui

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DoubleTapSeekControlsHoldTest {
    @Test
    fun consecutiveDoubleTapsKeepOnlyTheLatestReleaseActive() {
        val hold = DoubleTapSeekControlsHold()

        val firstRelease = hold.begin()
        val secondRelease = hold.begin()

        assertTrue(hold.isHolding)
        assertFalse(hold.complete(firstRelease))
        assertTrue(hold.isHolding)
        assertTrue(hold.complete(secondRelease))
        assertFalse(hold.isHolding)
    }

    @Test
    fun controllerHoldDurationAllowsContinuousDoubleTapFeedback() {
        assertTrue(DOUBLE_TAP_SEEK_MS == 10_000L)
        assertTrue(DOUBLE_TAP_SEEK_CONTROLS_HOLD_MS >= 700L)
    }

    @Test
    fun playerViewUsesTheHoldWithoutChangingTheSeekDistance() {
        val source = File("src/main/java/jp/tanaka/tcloud/ui/TCloudApp.kt").readText()

        assertTrue(source.contains("doubleTapSeekControlsHold.begin()"))
        assertTrue(source.contains("controllerShowTimeoutMs = 0"))
        assertTrue(source.contains("doubleTapSeekControlsHold.complete(releaseToken)"))
        assertTrue(source.contains("controllerShowTimeoutMs = normalControllerShowTimeoutMs"))
        assertTrue(source.contains("DOUBLE_TAP_SEEK_CONTROLS_HOLD_MS"))
        assertTrue(source.contains("if (event.x < width / 2f) -DOUBLE_TAP_SEEK_MS else DOUBLE_TAP_SEEK_MS"))
        assertTrue(source.contains("player.seekTo((player.currentPosition + offset).coerceIn(0L, duration))"))
    }
}
