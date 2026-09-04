package jp.tanaka.tcloud

import jp.tanaka.tcloud.library.LibraryMediaType
import jp.tanaka.tcloud.library.MediaSourceType
import jp.tanaka.tcloud.library.PlayableMediaItem
import jp.tanaka.tcloud.media.AudioPlaybackFailure
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class AudioPlaybackFailureStateTest {
    @Test
    fun libraryAudioFailureClosesNowPlayingAndKeepsLibraryOpen() {
        val audio = PlayableMediaItem(
            stableId = "local:7",
            source = MediaSourceType.LOCAL,
            mediaType = LibraryMediaType.AUDIO,
            title = "Song",
        )

        val state = MainUiState(
            showingPlayerLibrary = true,
            selectedLibraryMedia = audio,
        ).afterAudioPlaybackFailure(failure("local:7", null))

        assertTrue(state.showingPlayerLibrary)
        assertNull(state.selectedLibraryMedia)
        assertEquals("再生エラー", state.error)
    }

    @Test
    fun playbackFailureDoesNotCloseAnUnrelatedVideoPlayer() {
        val video = PlayableMediaItem(
            stableId = "local:video",
            source = MediaSourceType.LOCAL,
            mediaType = LibraryMediaType.VIDEO,
            title = "Video",
        )

        val state = MainUiState(
            showingPlayerLibrary = true,
            selectedLibraryMedia = video,
        ).afterAudioPlaybackFailure(failure("local:7", null))

        assertSame(video, state.selectedLibraryMedia)
        assertEquals("再生エラー", state.error)
    }

    @Test
    fun matchingStorageAudioFailureClosesItsPlayerState() {
        val file = jp.tanaka.tcloud.data.CloudFile(
            id = 31L,
            folderId = 1L,
            name = "Cloud song",
            mimeType = "audio/mpeg",
            mediaKind = "audio",
            sizeBytes = 128L,
            cryptoVersion = 2,
            encryptedMetadata = "",
            metadataIv = "",
            wrappedFileKey = "",
            fileKeyIv = "",
            chunkSizeBytes = 64L,
            chunkCount = 2,
            hasThumbnail = false,
            metadataDecrypted = true,
        )

        val state = MainUiState(
            selectedFile = file,
            selectedFileStartsAtBeginning = true,
            imageLoading = true,
        ).afterAudioPlaybackFailure(failure("cloud:31", 31L))

        assertNull(state.selectedFile)
        assertFalse(state.selectedFileStartsAtBeginning)
        assertFalse(state.imageLoading)
        assertEquals("再生エラー", state.error)
    }

    private fun failure(stableId: String, fileId: Long?) = AudioPlaybackFailure(
        stableId = stableId,
        fileId = fileId,
        userMessage = "再生エラー",
        errorCodeName = "ERROR_CODE_IO_UNSPECIFIED",
    )
}
