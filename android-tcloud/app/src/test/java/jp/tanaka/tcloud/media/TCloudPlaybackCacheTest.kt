package jp.tanaka.tcloud.media

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

class TCloudPlaybackCacheTest {
    @Test
    fun repeatedReadUsesCachedPlainChunk() {
        val loads = AtomicInteger()
        TCloudPlaybackCache(chunkCount = 2, maximumBytes = 16) { index ->
            loads.incrementAndGet()
            byteArrayOf(index.toByte(), 2, 3, 4)
        }.use { cache ->
            assertArrayEquals(byteArrayOf(0, 2, 3, 4), cache.load(0))
            assertArrayEquals(byteArrayOf(0, 2, 3, 4), cache.load(0))
            assertEquals(1, loads.get())
        }
    }

    @Test
    fun evictionAndCloseErasePlainBytes() {
        val first = byteArrayOf(1, 2, 3, 4)
        val second = byteArrayOf(5, 6, 7, 8)
        val cache = TCloudPlaybackCache(chunkCount = 2, maximumBytes = 4) { index ->
            if (index == 0) first else second
        }

        cache.load(0)
        cache.load(1)
        assertFalse(0 in cache.cachedIndexes())
        assertTrue(first.all { it == 0.toByte() })

        cache.close()
        assertTrue(second.all { it == 0.toByte() })
    }
}
