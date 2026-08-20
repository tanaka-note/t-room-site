package jp.tanaka.tcloud.library

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MediaLibraryModelsTest {
    @Test
    fun parsesSupportedYouTubeUrlsAndIds() {
        val id = "dQw4w9WgXcQ"
        assertEquals(id, parseYouTubeVideoId(id))
        assertEquals(id, parseYouTubeVideoId("https://www.youtube.com/watch?v=$id&t=1"))
        assertEquals(id, parseYouTubeVideoId("https://youtu.be/$id"))
        assertEquals(id, parseYouTubeVideoId("https://youtube.com/shorts/$id"))
        assertEquals(id, parseYouTubeVideoId("https://youtube.com/embed/$id"))
        assertNull(parseYouTubeVideoId("https://example.com/$id"))
        assertNull(parseYouTubeVideoId("invalid"))
    }

    @Test
    fun crossSourceSearchUsesAllRequiredMetadata() {
        val item = PlayableMediaItem(
            stableId = "cloud:1",
            source = MediaSourceType.CLOUD,
            mediaType = LibraryMediaType.AUDIO,
            title = "夜の曲",
            fileName = "track01.flac",
            artist = "Tanaka Band",
            album = "Blue",
            channel = "Official",
            location = "音楽 / 旅行",
            tags = setOf("お気に入りタグ"),
        )
        listOf("夜", "track01", "tanaka", "blue", "official", "旅行", "お気に入りタグ")
            .forEach { assertTrue("$it should match", mediaMatchesQuery(item, it)) }
        assertFalse(mediaMatchesQuery(item, "存在しない"))
    }

    @Test
    fun recommendationTermsPreferFavoritesWithoutUsingFilePath() {
        val items = listOf(
            PlayableMediaItem("local:1", MediaSourceType.LOCAL, LibraryMediaType.AUDIO, "A", artist = "Artist A", favorite = true, location = "秘密/個人"),
            PlayableMediaItem("youtube:1", MediaSourceType.YOUTUBE, LibraryMediaType.VIDEO, "B", channel = "Channel B", watchLater = true),
        )
        val terms = recommendationTerms(items)
        assertTrue("Artist A" in terms)
        assertTrue("Channel B" in terms)
        assertFalse(terms.any { it.contains("秘密") })
    }

    @Test
    fun localAndCloudAudioShareOneQueueAndNavigateTogether() {
        val items = listOf(
            PlayableMediaItem("local:1", MediaSourceType.LOCAL, LibraryMediaType.AUDIO, "Local 1"),
            PlayableMediaItem("cloud:2", MediaSourceType.CLOUD, LibraryMediaType.AUDIO, "Cloud 2"),
            PlayableMediaItem("local:3", MediaSourceType.LOCAL, LibraryMediaType.AUDIO, "Local 3"),
            PlayableMediaItem("youtube:4", MediaSourceType.YOUTUBE, LibraryMediaType.VIDEO, "Video"),
        )
        val queue = audioQueue(items)
        assertEquals(listOf("local:1", "cloud:2", "local:3"), queue.map { it.stableId })
        assertEquals(1, nextLibraryQueueIndex(0, queue.size, 1, false))
        assertEquals(2, nextLibraryQueueIndex(1, queue.size, 1, false))
        assertNull(nextLibraryQueueIndex(2, queue.size, 1, false))
        assertEquals(0, nextLibraryQueueIndex(2, queue.size, 1, true))
    }
}
