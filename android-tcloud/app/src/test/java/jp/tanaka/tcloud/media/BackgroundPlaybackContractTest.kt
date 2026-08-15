package jp.tanaka.tcloud.media

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

class BackgroundPlaybackContractTest {
    @Test
    fun manifestKeepsPlaybackInDedicatedForegroundService() {
        val manifest = projectFile("app/src/main/AndroidManifest.xml").readText()

        assertTrue(manifest.contains("android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK"))
        assertTrue(manifest.contains(".media.TCloudPlaybackService"))
        assertTrue(manifest.contains("android:foregroundServiceType=\"mediaPlayback\""))
        assertTrue(manifest.contains("android:stopWithTask=\"false\""))
    }

    @Test
    fun playbackServiceExposesAppleMusicStyleTransportActions() {
        val service = projectFile(
            "app/src/main/java/jp/tanaka/tcloud/media/TCloudPlaybackService.kt",
        ).readText()

        assertTrue(service.contains("ACTION_PREVIOUS -> manager.skipPrevious()"))
        assertTrue(service.contains("ACTION_NEXT -> manager.skipNext()"))
        assertTrue(service.contains("setShowActionsInCompactView(0, 1, 2)"))
        assertTrue(service.contains("MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE"))
        assertTrue(service.contains("ACTION_SKIP_TO_PREVIOUS"))
        assertTrue(service.contains("ACTION_SKIP_TO_NEXT"))
    }

    @Test
    fun closingPlayerOnlyReleasesVideoAndPreservesAudio() {
        val ui = projectFile(
            "app/src/main/java/jp/tanaka/tcloud/ui/TCloudApp.kt",
        ).readText()
        val playerCleanup = ui.substringAfter("DisposableEffect(player, context, file.id)")
            .substringBefore("DisposableEffect(activity, file.id, isVideo)")

        assertTrue(playerCleanup.contains("if (!isAudio)"))
        assertTrue(playerCleanup.contains("player.release()"))
        assertTrue(ui.contains("tcloud_folder_scroll"))
        assertTrue(ui.contains("state = listState"))
    }

    @Test
    fun activityVisibilityPausesOnlyNormalVideoAndKeepsPipExclusion() {
        val activity = projectFile(
            "app/src/main/java/jp/tanaka/tcloud/MainActivity.kt",
        ).readText()
        val ui = projectFile(
            "app/src/main/java/jp/tanaka/tcloud/ui/TCloudApp.kt",
        ).readText()

        assertTrue(activity.contains("override fun onStop()"))
        assertTrue(activity.contains("applicationVisible = false"))
        assertTrue(ui.contains("pictureInPicture || activity?.isInPictureInPictureMode == true"))
        assertTrue(ui.contains("player.pause()"))
        assertTrue(ui.contains("if (!isAudio)"))
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
