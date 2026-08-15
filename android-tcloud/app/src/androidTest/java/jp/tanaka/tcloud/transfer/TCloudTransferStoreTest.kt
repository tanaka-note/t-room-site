package jp.tanaka.tcloud.transfer

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import android.database.sqlite.SQLiteDatabase
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

    @Test
    fun parallelByteProgressIsAggregatedAcrossRunningItems() {
        val batchId = store.createDownloadBatch(listOf(file(1, "one.mp4", 100), file(2, "two.mp4", 100)))
        store.markBatchRunning(batchId)
        store.markItemRunning(batchId, 0, "one.mp4")
        store.markItemRunning(batchId, 1, "two.mp4")
        store.updateProgress(batchId, 0, "one.mp4", 25, 25, 100)
        store.updateProgress(batchId, 1, "two.mp4", 50, 50, 100)

        val batch = checkNotNull(store.batch(batchId))
        assertEquals(2, batch.activeCount)
        assertEquals(37, batch.overallProgress)
        assertTrue(transferProgressText(batch).contains("2件を処理中"))
    }

    @Test
    fun versionOneDatabaseMigratesWithoutDeletingTransferHistory() {
        store.close()
        context.deleteDatabase(TCloudTransferStore.DATABASE_NAME)
        val database = SQLiteDatabase.openOrCreateDatabase(
            context.getDatabasePath(TCloudTransferStore.DATABASE_NAME),
            null,
        )
        database.execSQL(
            """CREATE TABLE transfer_batches (
                batch_id TEXT PRIMARY KEY NOT NULL, direction TEXT NOT NULL, status TEXT NOT NULL,
                total INTEGER NOT NULL, succeeded INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
                current_name TEXT NOT NULL DEFAULT '', current_progress INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
            )""".trimIndent(),
        )
        database.execSQL(
            """CREATE TABLE transfer_items (
                batch_id TEXT NOT NULL, item_index INTEGER NOT NULL, folder_id INTEGER NOT NULL,
                file_id INTEGER NOT NULL DEFAULT 0, source_uri TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '',
                camera_asset_key TEXT NOT NULL DEFAULT '', expected_media_kind TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL, stage TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', result_uri TEXT NOT NULL DEFAULT '',
                PRIMARY KEY (batch_id, item_index)
            )""".trimIndent(),
        )
        database.execSQL(
            "INSERT INTO transfer_batches VALUES ('legacy', 'download', 'failed', 1, 0, 1, '', 0, 1, 2)",
        )
        database.execSQL(
            "INSERT INTO transfer_items VALUES ('legacy', 0, 10, 20, '', 'legacy.pdf', '', '', 'failed', 'done', 'network', '')",
        )
        database.version = 1
        database.close()

        store = TCloudTransferStore(context)

        val item = store.items("legacy").single()
        assertEquals("legacy.pdf", item.name)
        assertEquals(TransferStatus.FAILED, item.status)
        assertEquals(0L, item.totalBytes)
        assertEquals(1, checkNotNull(store.batch("legacy")).failed)
    }

    @Test
    fun interruptedBatchRecoveryKeepsSuccessAndRequeuesOnlySafeIncompleteItems() {
        val batchId = store.createDownloadBatch(
            listOf(
                file(1, "already-saved.pdf"),
                file(2, "interrupted.pdf"),
            ),
        )
        store.markBatchRunning(batchId)
        store.markItemRunning(batchId, 0, "already-saved.pdf", 10)
        store.markItemSuccess(batchId, 0, "content://download/already-saved")
        store.markItemRunning(batchId, 1, "interrupted.pdf", 10)
        store.updateProgress(batchId, 1, "interrupted.pdf", 60, 6, 10)

        val abandonedDestinations = store.recoverInterrupted(batchId, TransferDirection.DOWNLOAD)

        assertTrue(abandonedDestinations.isEmpty())
        val items = store.items(batchId)
        assertEquals(TransferStatus.SUCCEEDED, items[0].status)
        assertEquals("content://download/already-saved", items[0].resultUri)
        assertEquals(TransferStatus.QUEUED, items[1].status)
        assertEquals(0, items[1].progressPercent)
        assertEquals(0L, items[1].transferredBytes)
        assertEquals(1, checkNotNull(store.batch(batchId)).succeeded)
    }

    private fun file(id: Long, name: String, sizeBytes: Long = 10) = CloudFile(
        id = id,
        folderId = 10,
        name = name,
        mimeType = "application/pdf",
        mediaKind = "document",
        sizeBytes = sizeBytes,
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
