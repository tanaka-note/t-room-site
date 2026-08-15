package jp.tanaka.tcloud.transfer

import jp.tanaka.tcloud.data.TCloudApiException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

class TransferBatchStateTest {
    @Test
    fun `batch progress counts completed and remaining without per-file notifications`() {
        val batch = fixture(total = 32, succeeded = 16, failed = 2, fileProgress = 50)

        assertEquals(18, batch.processed)
        assertEquals(14, batch.remaining)
        assertEquals(57, batch.overallProgress)
        assertEquals("32件中18件完了・残り14件", transferProgressText(batch))
    }

    @Test
    fun `final result separates success and failure counts`() {
        val batch = fixture(
            total = 32,
            succeeded = 30,
            failed = 2,
            status = TransferStatus.FAILED,
        )

        assertEquals(100, batch.overallProgress)
        assertEquals("32件中30件成功・2件失敗", transferResultText(batch))
    }

    @Test
    fun `single file success uses the same batch result format`() {
        val batch = fixture(
            total = 1,
            succeeded = 1,
            failed = 0,
            status = TransferStatus.SUCCEEDED,
        )

        assertEquals(1, batch.processed)
        assertEquals(0, batch.remaining)
        assertEquals(100, batch.overallProgress)
        assertEquals("1件中1件成功・0件失敗", transferResultText(batch))
    }

    @Test
    fun `thirty file batch reports all success only after all items finish`() {
        val running = fixture(total = 30, succeeded = 29, failed = 0, fileProgress = 99)
        val completed = fixture(
            total = 30,
            succeeded = 30,
            failed = 0,
            status = TransferStatus.SUCCEEDED,
        )

        assertEquals("30件中29件完了・残り1件", transferProgressText(running))
        assertEquals(99, running.overallProgress)
        assertEquals("30件中30件成功・0件失敗", transferResultText(completed))
        assertEquals(100, completed.overallProgress)
    }

    @Test
    fun `all failures remain distinguishable from a successful batch`() {
        val batch = fixture(
            total = 4,
            succeeded = 0,
            failed = 4,
            status = TransferStatus.FAILED,
        )

        assertEquals(4, batch.processed)
        assertEquals(0, batch.remaining)
        assertEquals("4件中0件成功・4件失敗", transferResultText(batch))
    }

    @Test
    fun `only network and retryable server errors are transient`() {
        assertTrue(isTransientTransferFailure(IOException("offline")))
        assertTrue(isTransientTransferFailure(TCloudApiException(429, "later")))
        assertTrue(isTransientTransferFailure(TCloudApiException(503, "later")))
        assertFalse(isTransientTransferFailure(TCloudApiException(401, "login")))
        assertFalse(isTransientTransferFailure(IllegalArgumentException("bad input")))
    }

    @Test
    fun `one batch keeps one stable notification id from progress through completion`() {
        val batchId = "batch-with-many-files"

        assertEquals(
            TCloudTransferNotifications.notificationId(batchId),
            TCloudTransferNotifications.notificationId(batchId),
        )
    }

    private fun fixture(
        total: Int,
        succeeded: Int,
        failed: Int,
        fileProgress: Int = 0,
        status: TransferStatus = TransferStatus.RUNNING,
    ) = TransferBatchSnapshot(
        id = "batch",
        direction = TransferDirection.UPLOAD,
        status = status,
        total = total,
        succeeded = succeeded,
        failed = failed,
        currentName = "sample.mp4",
        currentFileProgress = fileProgress,
        folderIds = setOf(10),
        failures = emptyList(),
        createdAt = 1,
        updatedAt = 2,
    )
}
