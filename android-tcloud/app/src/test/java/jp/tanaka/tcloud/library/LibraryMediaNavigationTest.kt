package jp.tanaka.tcloud.library

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Test

class LibraryMediaNavigationTest {
    @Test
    fun localAudioStartsQueueBeforeOpeningNowPlaying() {
        assertAudioTransition(MediaSourceType.LOCAL)
    }

    @Test
    fun cloudAudioStartsQueueBeforeOpeningNowPlaying() {
        assertAudioTransition(MediaSourceType.CLOUD)
    }

    @Test
    fun failedQueueStartupDoesNotOpenNowPlaying() {
        val item = audioItem(MediaSourceType.CLOUD)
        var selected = false

        assertThrows(IllegalStateException::class.java) {
            coordinateLibraryMediaOpen(
                item = item,
                startAudioQueue = { error("queue failed") },
                selectMedia = { selected = true },
                recordStandalonePlayback = {},
            )
        }

        assertFalse(selected)
    }

    @Test
    fun videoAndYouTubeRemainStandaloneDestinations() {
        listOf(
            PlayableMediaItem("local-video", MediaSourceType.LOCAL, LibraryMediaType.VIDEO, "Local video") to LibraryMediaDestination.VIDEO_PLAYER,
            PlayableMediaItem("youtube-video", MediaSourceType.YOUTUBE, LibraryMediaType.VIDEO, "YouTube video") to LibraryMediaDestination.YOUTUBE_PLAYER,
        ).forEach { (item, expected) ->
            var queueStarts = 0
            var records = 0
            val destination = coordinateLibraryMediaOpen(
                item = item,
                startAudioQueue = { queueStarts += 1 },
                selectMedia = {},
                recordStandalonePlayback = { records += 1 },
            )

            assertEquals(expected, destination)
            assertEquals(0, queueStarts)
            assertEquals(1, records)
        }
    }

    private fun assertAudioTransition(source: MediaSourceType) {
        val item = audioItem(source)
        val events = mutableListOf<String>()
        var queuedItem: PlayableMediaItem? = null
        var selectedItem: PlayableMediaItem? = null
        var records = 0

        val destination = coordinateLibraryMediaOpen(
            item = item,
            startAudioQueue = { queued ->
                events += "queue"
                queuedItem = queued
            },
            selectMedia = { selected ->
                events += "select"
                selectedItem = selected
            },
            recordStandalonePlayback = { records += 1 },
        )

        assertEquals(LibraryMediaDestination.AUDIO_NOW_PLAYING, destination)
        assertEquals(listOf("queue", "select"), events)
        assertSame(item, queuedItem)
        assertSame(item, selectedItem)
        assertEquals(0, records)
    }

    private fun audioItem(source: MediaSourceType) = PlayableMediaItem(
        stableId = "${source.name.lowercase()}-audio",
        source = source,
        mediaType = LibraryMediaType.AUDIO,
        title = "Song",
    )
}
