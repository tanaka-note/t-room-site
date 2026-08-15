package jp.tanaka.tcloud.ui

import java.io.File
import jp.tanaka.tcloud.media.PlaybackMode
import jp.tanaka.tcloud.media.playbackStatusText
import jp.tanaka.tcloud.media.playerRepeatMode
import androidx.media3.common.Player
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PlaybackModeTest {
    @Test
    fun audioCyclesOffRepeatAllRepeatOneAndOff() {
        val repeatAll = nextPlaybackMode(PlaybackMode.OFF, "audio")
        val repeatOne = nextPlaybackMode(repeatAll, "audio")
        val off = nextPlaybackMode(repeatOne, "audio")

        assertEquals(PlaybackMode.REPEAT_ALL, repeatAll)
        assertEquals(PlaybackMode.REPEAT_ONE, repeatOne)
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
    fun repeatButtonUsesRepeatOneIconOnlyForSingleTrackMode() {
        val source = File("src/main/java/jp/tanaka/tcloud/ui/TCloudApp.kt").readText()

        assertTrue(source.contains("Icons.Default.RepeatOne else Icons.Default.Repeat"))
        assertTrue(source.contains("tint = if (playbackMode == PlaybackMode.OFF) TCloudMuted else TCloudBlue"))
        assertFalse(source.contains("PlaybackMode.REPEAT_ALL -> Icons.AutoMirrored.Filled.PlaylistPlay"))
    }

    @Test
    fun notificationStatusIdentifiesRepeatAllPlayback() {
        assertEquals("再生中", playbackStatusText(PlaybackMode.OFF))
        assertEquals("全体リピート中", playbackStatusText(PlaybackMode.REPEAT_ALL))
        assertEquals("1曲リピート中", playbackStatusText(PlaybackMode.REPEAT_ONE))
    }

    @Test
    fun onlySingleTrackRepeatUsesExoPlayerRepeatOne() {
        assertEquals(Player.REPEAT_MODE_OFF, playerRepeatMode(PlaybackMode.OFF))
        assertEquals(Player.REPEAT_MODE_OFF, playerRepeatMode(PlaybackMode.REPEAT_ALL))
        assertEquals(Player.REPEAT_MODE_ONE, playerRepeatMode(PlaybackMode.REPEAT_ONE))
    }
}
