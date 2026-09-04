package jp.tanaka.tcloud.ui

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AdaptiveUiContractTest {
    @Test
    fun activityUsesEdgeToEdgeAndManifestAllowsAdaptiveWindowing() {
        val activity = File("src/main/java/jp/tanaka/tcloud/MainActivity.kt").readText()
        val manifest = File("src/main/AndroidManifest.xml").readText()
        val theme = File("src/main/res/values/themes.xml").readText()

        assertTrue(activity.contains("enableEdgeToEdge()"))
        assertFalse(manifest.contains("android:screenOrientation"))
        assertTrue(manifest.contains("android:configChanges=\"screenSize|smallestScreenSize|screenLayout|orientation\""))
        assertTrue(manifest.contains("android:windowSoftInputMode=\"adjustResize\""))
        assertTrue(theme.contains("@android:color/transparent"))
    }

    @Test
    fun androidViewsRemainOutsideSharedElementAnimation() {
        val storage = File("src/main/java/jp/tanaka/tcloud/ui/TCloudApp.kt").readText()
        val player = File("src/main/java/jp/tanaka/tcloud/ui/MediaLibraryScreen.kt").readText()
        val mediaPlayer = storage.substringAfter("private fun MediaPlayerScreen")
            .substringBefore("internal fun nextPlaybackMode")

        assertTrue(storage.contains("AndroidView("))
        assertTrue(player.contains("AndroidView("))
        assertTrue(storage.contains("tCloudSharedImageBounds(file.id"))
        assertFalse(mediaPlayer.contains("sharedElement"))
        assertFalse(player.contains("sharedElement"))
    }
}
