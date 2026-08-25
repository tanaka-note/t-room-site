package jp.tanaka.tcloud.library

import jp.tanaka.tcloud.data.TCloudApiException
import jp.tanaka.tcloud.data.YouTubeVideoMetadata
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.withContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class YouTubeSearchRunnerTest {
    @Test
    fun twoCharactersDebounceThenMapsOnlineResultsWithoutAddingLibraryItems() = runTest {
        val requests = mutableListOf<String>()
        var state = MediaLibraryState()
        val runner = runner(
            search = { query, _ ->
                requests += query
                listOf(metadata("abcdefghijk", "平沢進 公式", "Official Channel", 245_000L))
            },
            update = { state = it(state) },
        )

        runner.submit("平")
        advanceUntilIdle()
        assertTrue(requests.isEmpty())

        runner.submit("平沢")
        runCurrent()
        assertTrue(state.searchingYouTube)
        advanceTimeBy(399)
        runCurrent()
        assertTrue(requests.isEmpty())
        advanceTimeBy(1)
        advanceUntilIdle()

        assertEquals(listOf("平沢"), requests)
        assertEquals("youtube:abcdefghijk", state.youtubeSearchResults.single().stableId)
        assertEquals("Official Channel", state.youtubeSearchResults.single().channel)
        assertEquals(245_000L, state.youtubeSearchResults.single().durationMs)
        assertTrue("検索だけでは保存済みライブラリへ追加しない", state.items.isEmpty())
        assertFalse(state.searchingYouTube)
    }

    @Test
    fun staleResponseCannotReplaceNewestQueryAndClearRemovesResults() = runTest {
        val firstStarted = CompletableDeferred<Unit>()
        val releaseFirst = CompletableDeferred<Unit>()
        var state = MediaLibraryState()
        val runner = runner(
            search = { query, _ ->
                if (query == "平沢") {
                    firstStarted.complete(Unit)
                    withContext(NonCancellable) { releaseFirst.await() }
                    listOf(metadata("aaaaaaaaaaa", "古い結果", "Old", 1L))
                } else {
                    listOf(metadata("bbbbbbbbbbb", "最新結果", "New", 2L))
                }
            },
            update = { state = it(state) },
        )

        runner.submit("平沢")
        advanceTimeBy(400)
        runCurrent()
        firstStarted.await()
        runner.submit("平沢進")
        advanceTimeBy(400)
        runCurrent()
        assertEquals("youtube:bbbbbbbbbbb", state.youtubeSearchResults.single().stableId)

        releaseFirst.complete(Unit)
        advanceUntilIdle()
        assertEquals("平沢進", state.youtubeSearchQuery)
        assertEquals("youtube:bbbbbbbbbbb", state.youtubeSearchResults.single().stableId)

        runner.submit("")
        assertEquals("", state.youtubeSearchQuery)
        assertTrue(state.youtubeSearchResults.isEmpty())
    }

    @Test
    fun apiAndNetworkErrorsBecomeSafeJapaneseMessages() {
        assertEquals(
            "YouTube検索のAPI設定が完了していません。",
            youtubeSearchUserMessage(TCloudApiException(503, "raw server detail")),
        )
        assertEquals(
            "YouTube側の問題で検索できませんでした。時間をおいてもう一度お試しください。",
            youtubeSearchUserMessage(TCloudApiException(502, "upstream internal detail")),
        )
        assertEquals(
            "ネットワークに接続できません。通信状態を確認して、もう一度お試しください。",
            youtubeSearchUserMessage(IOException("Connection reset")),
        )
    }

    private fun TestScope.runner(
        search: suspend (String, Int) -> List<YouTubeVideoMetadata>,
        update: ((MediaLibraryState) -> MediaLibraryState) -> Unit,
    ) = YouTubeSearchRunner(
        scope = this,
        search = search,
        onCleared = { query -> update { it.copy(youtubeSearchQuery = query, youtubeSearchResults = emptyList(), searchingYouTube = false, youtubeSearchError = null) } },
        onStarted = { query -> update { it.copy(youtubeSearchQuery = query, youtubeSearchResults = emptyList(), searchingYouTube = true, youtubeSearchError = null) } },
        onSuccess = { query, items -> update { it.copy(youtubeSearchQuery = query, youtubeSearchResults = items, searchingYouTube = false, youtubeSearchError = null) } },
        onFailure = { query, message, _ -> update { it.copy(youtubeSearchQuery = query, youtubeSearchResults = emptyList(), searchingYouTube = false, youtubeSearchError = message) } },
        debounceMs = 400L,
    )

    private fun metadata(id: String, title: String, channel: String, duration: Long) = YouTubeVideoMetadata(
        videoId = id,
        title = title,
        channel = channel,
        thumbnailUrl = "https://i.ytimg.com/vi/$id/mqdefault.jpg",
        durationMs = duration,
    )
}
