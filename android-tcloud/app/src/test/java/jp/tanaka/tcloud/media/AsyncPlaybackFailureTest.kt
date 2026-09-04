package jp.tanaka.tcloud.media

import jp.tanaka.tcloud.library.LibraryMediaType
import jp.tanaka.tcloud.library.MediaSourceType
import jp.tanaka.tcloud.library.PlayableMediaItem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class AsyncPlaybackFailureTest {
    @Test
    fun localFailureExplainsFileAccessRecovery() {
        val failure = audioPlaybackFailure(
            item = audioItem(MediaSourceType.LOCAL),
            stableId = "local:7",
            fileId = null,
            title = "",
            errorCodeName = "ERROR_CODE_IO_FILE_NOT_FOUND",
        )

        assertEquals("local:7", failure.stableId)
        assertNull(failure.fileId)
        assertEquals("「Song」を再生できませんでした。端末のファイルアクセスを確認してください。", failure.userMessage)
        assertEquals("ERROR_CODE_IO_FILE_NOT_FOUND", failure.errorCodeName)
    }

    @Test
    fun cloudFailureExplainsRetryableNetworkRecovery() {
        val failure = audioPlaybackFailure(
            item = audioItem(MediaSourceType.CLOUD),
            stableId = "cloud:31",
            fileId = 31L,
            title = "",
            errorCodeName = "ERROR_CODE_IO_NETWORK_CONNECTION_FAILED",
        )

        assertEquals(31L, failure.fileId)
        assertEquals("「Song」を再生できませんでした。通信状態を確認して、もう一度お試しください。", failure.userMessage)
    }

    @Test
    fun cleanupCompletesBeforeFailureIsReported() {
        var stableId: String? = "cloud:31"
        var fileId: Long? = 31L
        var queueSize = 2
        var factoryOpen = true
        var serviceRunning = true
        val events = mutableListOf<String>()
        val failure = audioPlaybackFailure(
            item = audioItem(MediaSourceType.CLOUD),
            stableId = stableId,
            fileId = fileId,
            title = "",
            errorCodeName = "ERROR_CODE_IO_UNSPECIFIED",
        )

        completeAsyncPlaybackFailure(
            failure = failure,
            stopPlayback = {
                stableId = null
                fileId = null
                queueSize = 0
                factoryOpen = false
                serviceRunning = false
                events += "cleanup"
            },
            reportFailure = {
                assertNull(stableId)
                assertNull(fileId)
                assertEquals(0, queueSize)
                assertFalse(factoryOpen)
                assertFalse(serviceRunning)
                events += "report"
            },
        )

        assertEquals(listOf("cleanup", "report"), events)
    }

    private fun audioItem(source: MediaSourceType) = PlayableMediaItem(
        stableId = "${source.name.lowercase()}:7",
        source = source,
        mediaType = LibraryMediaType.AUDIO,
        title = "Song",
    )
}
