package jp.tanaka.tcloud.ui

import jp.tanaka.tcloud.media.playbackStatusText
import org.junit.Assert.assertEquals
import org.junit.Test

class PlaybackModeTest {
    @Test
    fun audioCyclesOffRepeatAllAndOff() {
        val repeatAll = nextPlaybackMode(PlaybackMode.OFF, "audio")
        val off = nextPlaybackMode(repeatAll, "audio")

        assertEquals(PlaybackMode.REPEAT_ALL, repeatAll)
        assertEquals(PlaybackMode.OFF, off)
    }

    @Test
    fun videoCyclesOffRepeatAllAndOff() {
        val repeatAll = nextPlaybackMode(PlaybackMode.OFF, "video")
        val off = nextPlaybackMode(repeatAll, "video")

        assertEquals(PlaybackMode.REPEAT_ALL, repeatAll)
        assertEquals(PlaybackMode.OFF, off)
    }

    @Test
    fun notificationStatusIdentifiesRepeatAllPlayback() {
        assertEquals("再生中", playbackStatusText(repeatAll = false))
        assertEquals("全体リピート中", playbackStatusText(repeatAll = true))
    }
}
