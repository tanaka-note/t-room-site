package jp.tanaka.tcloud.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class PlaybackModeTest {
    @Test
    fun audioCyclesOffRepeatContinuousAndOff() {
        val repeat = nextPlaybackMode(PlaybackMode.OFF, "audio")
        val continuous = nextPlaybackMode(repeat, "audio")
        val off = nextPlaybackMode(continuous, "audio")

        assertEquals(PlaybackMode.REPEAT_ONE, repeat)
        assertEquals(PlaybackMode.CONTINUOUS_AUDIO, continuous)
        assertEquals(PlaybackMode.OFF, off)
    }

    @Test
    fun videoOnlyCyclesOffAndRepeat() {
        val repeat = nextPlaybackMode(PlaybackMode.OFF, "video")
        val off = nextPlaybackMode(repeat, "video")

        assertEquals(PlaybackMode.REPEAT_ONE, repeat)
        assertEquals(PlaybackMode.OFF, off)
    }
}
