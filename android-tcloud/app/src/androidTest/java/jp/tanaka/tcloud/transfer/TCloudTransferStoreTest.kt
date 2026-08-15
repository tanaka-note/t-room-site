package jp.tanaka.tcloud.transfer

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import jp.tanaka.tcloud.data.CloudFile
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class TCloudTransferStoreTest {
    private val context = ApplicationProvider.getApplicationContext<android.content.Context>()
    private lateinit var store: TCloudTransferStore

    @Before
    fun setUp() {
        context.deleteDatabase(TCloudTransferStore.DATABASE_NAME)
        store = TCloudTransferStore(context)
    }

    @After
    fun tearDown() {
        store.close()
        context.deleteDatabase(TCloudTransferStore.DATABASE_NAME)
    }

    @Test
    fun failedDownloadRemainsAvailableAfterBatchFinishes() {
        val batchId = store.createDownloadBatch(listOf(file(1, "ok.pdf"), file(2, "failed.pdf")))
        store.markBatchRunning(batchId)
        store.markItemRunning(batchId, 0, "ok.pdf")
        store.markItemSuccess(batchId, 0, "content://download/1")
        store.markItemRunning(batchId, 1, "failed.pdf")
        store.markItemFailure(batchId, 1, "通信が切断されました。")
        store.finishBatch(batchId)

        val batch = checkNotNull(store.batch(batchId))
        assertEquals(2, batch.total)
        assertEquals(1, batch.succeeded)
        assertEquals(1, batch.failed)
        assertEquals(TransferStatus.FAILED, batch.status)
        assertEquals("failed.pdf", batch.failures.single().name)
        assertTrue(batch.failures.single().reason.contains("通信"))
    }

    @Test
    fun activeCameraAssetCannotBeQueuedTwice() {
        val item = CameraUploadItem(
            folderId = 10,
            sourceUri = "content://media/video/1",
            assetKey = "10:3:1:100:200",
            expectedMediaKind = "video",
        )

        val first = checkNotNull(store.createCameraBatch(listOf(item, item)))
        val duplicate = store.createCameraBatch(listOf(item))

        assertEquals(1, first.itemCount)
        assertEquals(1, store.items(first.id).size)
        assertEquals(null, duplicate)
    }

    private fun file(id: Long, name: String) = CloudFile(
        id = id,
        folderId = 10,
        name = name,
        mimeType = "application/pdf",
        mediaKind = "document",
        sizeBytes = 10,
        cryptoVersion = 1,
        encryptedMetadata = "metadata",
        metadataIv = "iv",
        wrappedFileKey = "key",
        fileKeyIv = "keyIv",
        chunkSizeBytes = 8 * 1024 * 1024,
        chunkCount = 1,
        hasThumbnail = false,
        metadataDecrypted = true,
    )
}
