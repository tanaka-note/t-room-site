package jp.tanaka.tcloud.ui

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VisualMotionContractTest {
    @Test
    fun storageAndPlayerShareThe140DesignSystem() {
        val design = File("src/main/java/jp/tanaka/tcloud/ui/TCloudDesignSystem.kt").readText()
        val storage = File("src/main/java/jp/tanaka/tcloud/ui/TCloudApp.kt").readText()
        val player = File("src/main/java/jp/tanaka/tcloud/ui/MediaLibraryScreen.kt").readText()

        assertTrue(design.contains("internal fun TCloudTheme"))
        assertTrue(design.contains("internal object TCloudDimens"))
        assertTrue(design.contains("internal object TCloudMotion"))
        assertTrue(design.contains("internal object TCloudSpacing"))
        assertTrue(design.contains("internal object TCloudElevation"))
        assertTrue(design.contains("dynamicLightColorScheme"))
        assertTrue(design.contains("dynamicDarkColorScheme"))
        assertTrue(design.contains("darkColorScheme"))
        assertTrue(design.contains("internal fun TCloudSearchField"))
        assertTrue(design.contains("internal fun TCloudEmptyState"))
        assertTrue(storage.contains("TCloudTheme"))
        assertTrue(storage.contains("TCloudSearchField"))
        assertTrue(player.contains("TCloudSearchField"))
        assertTrue(player.contains("SingleChoiceSegmentedButtonRow"))
        assertTrue(player.contains("MediaHeroArtwork"))
    }

    @Test
    fun hierarchySelectionAndLazyItemsUseRestrainedMotion() {
        val storage = File("src/main/java/jp/tanaka/tcloud/ui/TCloudApp.kt").readText()
        val player = File("src/main/java/jp/tanaka/tcloud/ui/MediaLibraryScreen.kt").readText()

        assertTrue(storage.contains("folderNavigationDirection"))
        assertTrue(storage.contains("TCloudMotion.Standard"))
        assertTrue(storage.contains("animateColorAsState"))
        assertTrue(storage.contains("Modifier.animateItem()"))
        assertTrue(storage.contains("PredictiveBackHandler"))
        assertTrue(storage.contains("performHapticFeedback"))
        assertTrue(storage.contains("currentWindowAdaptiveInfo"))
        assertTrue(storage.contains("NavigationRail"))
        assertTrue(player.contains("Modifier.animateItem()"))
        assertFalse(storage.contains("shadowElevation = if (selected) 0.dp else 1.dp"))
        assertFalse(player.contains("HorizontalDivider()"))
    }

    @Test
    fun motionDurationsStayFastAndNonGameLike() {
        assertTrue(TCloudMotion.Quick in 120..180)
        assertTrue(TCloudMotion.Standard in 180..240)
        assertTrue(TCloudMotion.Emphasized in 240..300)
    }
}
