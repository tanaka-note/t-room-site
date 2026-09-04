package jp.tanaka.tcloud.ui

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RelativeSeekPlayerContractTest {
    @Test
    fun localAndCloudMedia3VideoPlayersUseTheRelativeSeekController() {
        val library = projectFile("app/src/main/java/jp/tanaka/tcloud/ui/MediaLibraryScreen.kt").readText()
        val storage = projectFile("app/src/main/java/jp/tanaka/tcloud/ui/TCloudApp.kt").readText()
        val controller = projectFile("app/src/main/res/layout/tcloud_relative_seek_player_control_view.xml").readText()
        val gradle = projectFile("app/build.gradle.kts").readText()

        assertTrue(library.contains("relativeSeekPlayerView(it, player)"))
        assertTrue(storage.contains("if (isVideo) relativeSeekPlayerView(viewContext, player) else PlayerView(viewContext)"))
        assertTrue(controller.contains("jp.tanaka.tcloud.ui.RelativeSeekTimeBar"))
        assertTrue(controller.contains("@id/exo_progress"))
        assertTrue(gradle.contains("androidx.media3:media3-ui:1.10.1"))
    }

    @Test
    fun mouseAndKeyboardRemainOnMedia3AndYouTubeRemainsOfficial() {
        val relativeSeek = projectFile("app/src/main/java/jp/tanaka/tcloud/ui/RelativeSeekTimeBar.kt").readText()
        val library = projectFile("app/src/main/java/jp/tanaka/tcloud/ui/MediaLibraryScreen.kt").readText()

        assertTrue(relativeSeek.contains("return super.onTouchEvent(event)"))
        assertTrue(relativeSeek.contains("TOOL_TYPE_FINGER"))
        assertTrue(relativeSeek.contains("TOOL_TYPE_STYLUS"))
        assertTrue(library.contains("https://www.youtube.com/iframe_api"))
        assertFalse(library.substringAfter("internal fun YouTubePlayerScreen").contains("relativeSeekPlayerView"))
    }

    private fun projectFile(relativePath: String): File {
        var current = File(checkNotNull(System.getProperty("user.dir"))).canonicalFile
        repeat(6) {
            val candidate = File(current, relativePath)
            if (candidate.isFile) return candidate
            current = current.parentFile ?: error("Project root was not found")
        }
        error("Project file was not found: $relativePath")
    }
}
