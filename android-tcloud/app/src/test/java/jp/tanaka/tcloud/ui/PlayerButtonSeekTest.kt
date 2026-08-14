package jp.tanaka.tcloud.ui

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PlayerButtonSeekTest {
    @Test
    fun `video player buttons seek ten seconds in both directions`() {
        val source = File("src/main/java/jp/tanaka/tcloud/ui/TCloudApp.kt").readText()

        assertTrue(PLAYER_BUTTON_SEEK_MS == 10_000L)
        assertTrue(source.contains(".setSeekBackIncrementMs(PLAYER_BUTTON_SEEK_MS)"))
        assertTrue(source.contains(".setSeekForwardIncrementMs(PLAYER_BUTTON_SEEK_MS)"))
        assertFalse(source.contains(".setSeekBackIncrementMs(5_000L)"))
        assertFalse(source.contains(".setSeekForwardIncrementMs(15_000L)"))
    }

    @Test
    fun `double tap seek remains an independent ten second control`() {
        assertTrue(DOUBLE_TAP_SEEK_MS == 10_000L)
        assertTrue(PLAYER_BUTTON_SEEK_MS == 10_000L)
    }
}
