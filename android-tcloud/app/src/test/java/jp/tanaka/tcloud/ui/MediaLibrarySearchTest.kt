package jp.tanaka.tcloud.ui

import jp.tanaka.tcloud.library.LibraryMediaType
import jp.tanaka.tcloud.library.MediaLibraryState
import jp.tanaka.tcloud.library.MediaSourceType
import jp.tanaka.tcloud.library.PlayableMediaItem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MediaLibrarySearchTest {
    @Test
    fun allSourcesSeparatesIndexedMediaFromOnlineYouTubeResults() {
        val state = stateFor("平沢進")
        val groups = videoSearchGroups(state, null, "平沢進")

        assertEquals(listOf("端末・T-Cloud", "YouTube"), groups.map { it.label })
        assertEquals(listOf("local:1", "cloud:2"), groups[0].items.map { it.stableId })
        assertEquals(listOf("youtube:saved000001", "youtube:online00001"), groups[1].items.map { it.stableId })
    }

    @Test
    fun youtubeFilterIncludesOnlineResultsAndIgnoresStaleQuery() {
        val state = stateFor("平沢進")
        val youtube = videoSearchGroups(state, MediaSourceType.YOUTUBE, "平沢進")
        assertEquals(listOf("youtube:saved000001", "youtube:online00001"), youtube.single().items.map { it.stableId })

        val stale = videoSearchGroups(state, MediaSourceType.YOUTUBE, "別の検索")
        assertTrue(stale.single().items.isEmpty())
    }

    @Test
    fun youtubeDurationIsFormattedForSearchRows() {
        assertEquals("4:05", formatMediaDuration(245_000L))
        assertEquals("1:02:03", formatMediaDuration(3_723_000L))
    }

    private fun stateFor(query: String) = MediaLibraryState(
        items = listOf(
            item("local:1", MediaSourceType.LOCAL, "平沢進 端末動画"),
            item("cloud:2", MediaSourceType.CLOUD, "平沢進 T-Cloud動画"),
            item("youtube:saved000001", MediaSourceType.YOUTUBE, "平沢進 保存済み"),
        ),
        youtubeSearchQuery = query,
        youtubeSearchResults = listOf(item("youtube:online00001", MediaSourceType.YOUTUBE, "オンライン検索結果")),
    )

    private fun item(id: String, source: MediaSourceType, title: String) = PlayableMediaItem(
        stableId = id,
        source = source,
        mediaType = LibraryMediaType.VIDEO,
        title = title,
        youtubeVideoId = if (source == MediaSourceType.YOUTUBE) id.removePrefix("youtube:") else "",
    )
}
