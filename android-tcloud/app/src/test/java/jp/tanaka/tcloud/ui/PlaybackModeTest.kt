package jp.tanaka.tcloud.ui

import java.io.File
import jp.tanaka.tcloud.media.playbackStatusText
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
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
    fun repeatButtonKeepsTheSameIconAndUsesTintForState() {
        val source = File("src/main/java/jp/tanaka/tcloud/ui/TCloudApp.kt").readText()

        assertTrue(source.contains("Icons.Default.Repeat,"))
        assertTrue(source.contains("tint = if (playbackMode == PlaybackMode.OFF) TCloudMuted else TCloudBlue"))
        assertFalse(source.contains("PlaybackMode.REPEAT_ALL -> Icons.AutoMirrored.Filled.PlaylistPlay"))
        assertFalse(source.contains("Icons.Default.RepeatOne"))
    }

    @Test
    fun notificationStatusIdentifiesRepeatAllPlayback() {
        assertEquals("再生中", playbackStatusText(repeatAll = false))
        assertEquals("全体リピート中", playbackStatusText(repeatAll = true))
    }
}
