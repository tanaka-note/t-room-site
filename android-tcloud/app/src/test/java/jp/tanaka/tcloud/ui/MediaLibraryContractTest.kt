package jp.tanaka.tcloud.ui

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MediaLibraryContractTest {
    @Test
    fun playerEntryOnlyAppearsAtStorageRootOutsideSelection() {
        assertTrue(playerEntryVisible(null, false))
        assertFalse(playerEntryVisible(12L, false))
        assertFalse(playerEntryVisible(null, true))
    }

    @Test
    fun manifestRequestsAudioAndVideoMediaPermissions() {
        val manifest = File("src/main/AndroidManifest.xml").readText()
        assertTrue(manifest.contains("android.permission.READ_MEDIA_AUDIO"))
        assertTrue(manifest.contains("android.permission.READ_MEDIA_VIDEO"))
    }

    @Test
    fun youtubeUsesOfficialEmbeddedPlayerWithoutDownloadExtraction() {
        val source = File("src/main/java/jp/tanaka/tcloud/ui/MediaLibraryScreen.kt").readText()
        assertTrue(source.contains("https://www.youtube.com/iframe_api"))
        assertTrue(source.contains("loadDataWithBaseURL"))
        assertTrue(source.contains("origin:'https://tanaka-note.com'"))
        assertTrue(source.contains("settings.allowFileAccess = false"))
        assertTrue(source.contains("settings.allowContentAccess = false"))
        assertTrue(source.contains("WebSettings.MIXED_CONTENT_NEVER_ALLOW"))
        assertFalse(source.contains("yt-dlp"))
        assertFalse(source.contains("googlevideo.com"))
        assertFalse(source.contains("videoplayback"))
    }

    @Test
    fun versionIs120AndCredentialsAreNotEmbedded() {
        val gradle = File("build.gradle.kts").readText()
        assertTrue(gradle.contains("versionCode = 29"))
        assertTrue(gradle.contains("versionName = \"1.2.0\""))
        assertFalse(gradle.contains("YOUTUBE_API_KEY"))
    }

    @Test
    fun launcherUsesClassicTCloudArtworkWithoutHeadphones() {
        val foreground = File("src/main/res/drawable/tcloud_launcher_foreground.xml").readText()
        val monochrome = File("src/main/res/drawable/tcloud_launcher_monochrome.xml").readText()
        val artwork = File("src/main/res/drawable/tcloud_launcher_artwork.xml").readText()

        assertFalse(foreground.contains("M34,50 C34,32 43,22 54,22 C65,22 74,32 74,50"))
        assertFalse(monochrome.contains("M34,50 C34,32 43,22 54,22 C65,22 74,32 74,50"))
        assertTrue(artwork.contains("@drawable/tcloud_logo"))
    }

    @Test
    fun onlineSearchIsWiredThroughViewModelAndOnlyExplicitActionsPersistResults() {
        val manager = File("src/main/java/jp/tanaka/tcloud/library/MediaLibraryManager.kt").readText()
        val viewModel = File("src/main/java/jp/tanaka/tcloud/MainViewModel.kt").readText()
        val app = File("src/main/java/jp/tanaka/tcloud/ui/TCloudApp.kt").readText()
        val searchBody = manager.substringAfter("fun searchYouTube(query: String)")
            .substringBefore("fun clearYouTubeSearch")

        assertTrue(searchBody.contains("youtubeSearchRunner.submit(query)"))
        assertFalse(searchBody.contains("upsertYouTube"))
        assertTrue(manager.substringAfter("fun setFavorite").substringBefore("fun setWatchLater").contains("ensureStored(item)"))
        assertTrue(manager.substringAfter("fun setWatchLater").substringBefore("fun setTags").contains("ensureStored(item)"))
        assertTrue(manager.substringAfter("fun addToPlaylist").substringBefore("fun refreshRecommendationsAsync").contains("ensureStored(item)"))
        assertTrue(viewModel.contains("fun searchYouTube(query: String)"))
        assertTrue(app.contains("onSearchYouTube = viewModel::searchYouTube"))
    }
}
