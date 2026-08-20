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
        assertFalse(source.contains("yt-dlp"))
        assertFalse(source.contains("googlevideo.com"))
        assertFalse(source.contains("videoplayback"))
    }

    @Test
    fun versionIs110AndCredentialsAreNotEmbedded() {
        val gradle = File("build.gradle.kts").readText()
        assertTrue(gradle.contains("versionCode = 28"))
        assertTrue(gradle.contains("versionName = \"1.1.0\""))
        assertFalse(gradle.contains("YOUTUBE_API_KEY"))
    }
}
