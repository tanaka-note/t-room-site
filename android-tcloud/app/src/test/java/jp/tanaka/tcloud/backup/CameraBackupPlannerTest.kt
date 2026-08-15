package jp.tanaka.tcloud.backup

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CameraBackupPlannerTest {
    @Test
    fun `dummy camera data continues past completed first batch`() {
        val assets = (1L..6L).map { id ->
            CameraMediaAsset(id, 1, 1_000 + id, id, 100 + id, "content://media/$id")
        }
        val firstKeys = assets.take(3).map { "99:1:${it.id}:${it.modifiedSeconds}:${it.sizeBytes}" }.toSet()
        val first = planCameraBackup(99, assets, firstKeys, 3)
        assertTrue(first.pending.isEmpty())
        assertEquals(3L, first.cursorMediaId)
        assertTrue(first.reachedBatchLimit)

        val second = planCameraBackup(99, assets.drop(3), firstKeys, 3)
        assertEquals(listOf(4L, 5L, 6L), second.pending.map { it.second.id })
    }

    @Test
    fun `zero byte assets are ignored without blocking later data`() {
        val assets = listOf(
            CameraMediaAsset(1, 1, 0, 1, 1, "content://media/1"),
            CameraMediaAsset(2, 1, 500, 2, 2, "content://media/2"),
        )
        val plan = planCameraBackup(10, assets, emptySet(), 10)
        assertEquals(listOf(2L), plan.pending.map { it.second.id })
    }

    @Test
    fun `camera roll accepts only selected image and video MIME types`() {
        assertEquals("image", cameraMediaKind(1, "image/jpeg", includeImages = true, includeVideos = false))
        assertEquals(null, cameraMediaKind(1, "application/pdf", includeImages = true, includeVideos = true))
        assertEquals(null, cameraMediaKind(2, "audio/mpeg", includeImages = true, includeVideos = true))
        assertEquals(null, cameraMediaKind(3, "video/mp4", includeImages = true, includeVideos = false))
        assertEquals("video", cameraMediaKind(3, "video/mp4", includeImages = false, includeVideos = true))
    }

    @Test
    fun `existing assets are planned regardless of when backup was enabled`() {
        val oldAsset = CameraMediaAsset(1, 1, 500, 1, 1, "content://media/old")

        val plan = planCameraBackup(10, listOf(oldAsset), emptySet(), 250)

        assertEquals(listOf(1L), plan.pending.map { it.second.id })
    }

    @Test
    fun `one thousand assets are processed in four bounded pages`() {
        val assets = (1L..1_000L).map { id ->
            CameraMediaAsset(id, 1, 1_000, id, id, "content://media/$id")
        }
        val pendingIds = mutableListOf<Long>()

        assets.chunked(250).forEach { page ->
            val plan = planCameraBackup(10, page, emptySet(), 250)
            assertTrue(plan.reachedBatchLimit)
            assertTrue(plan.pending.size <= 250)
            pendingIds += plan.pending.map { it.second.id }
        }

        assertEquals(1_000, pendingIds.size)
        assertEquals((1L..1_000L).toList(), pendingIds)
    }
}
