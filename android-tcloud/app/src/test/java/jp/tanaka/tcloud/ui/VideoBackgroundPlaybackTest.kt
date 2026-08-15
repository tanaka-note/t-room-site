package jp.tanaka.tcloud.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VideoBackgroundPlaybackTest {
    @Test
    fun `normal hidden video pauses but visible and pip video keep their current state`() {
        assertTrue(shouldPauseVideoForBackground(isVideo = true, applicationVisible = false, pictureInPicture = false))
        assertFalse(shouldPauseVideoForBackground(isVideo = true, applicationVisible = true, pictureInPicture = false))
        assertFalse(shouldPauseVideoForBackground(isVideo = true, applicationVisible = false, pictureInPicture = true))
    }

    @Test
    fun `audio is never paused by the video background rule`() {
        assertFalse(shouldPauseVideoForBackground(isVideo = false, applicationVisible = false, pictureInPicture = false))
    }
}
