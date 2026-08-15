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

        val recovery = store.recoverInterrupted(batchId, TransferDirection.DOWNLOAD)

        assertTrue(recovery.orphanDestinations.isEmpty())
        assertEquals(listOf("interrupted.pdf"), recovery.items.map(TransferItem::name))
        val items = store.items(batchId)
        assertEquals(TransferStatus.SUCCEEDED, items[0].status)
        assertEquals("content://download/already-saved", items[0].resultUri)
        assertEquals(TransferStatus.QUEUED, items[1].status)
        assertEquals(0, items[1].progressPercent)
        assertEquals(0L, items[1].transferredBytes)
        assertEquals(1, checkNotNull(store.batch(batchId)).succeeded)
    }

    @Test
    fun networkStopWaitsWithoutFailingAndKeepsCompletedItems() {
        val batchId = store.createDownloadBatch(listOf(file(1, "done.pdf"), file(2, "pending.pdf")))
        store.markBatchRunning(batchId)
        store.markItemRunning(batchId, 0, "done.pdf")
        store.markItemSuccess(batchId, 0, "content://download/done")
        store.markItemRunning(batchId, 1, "pending.pdf")

        store.prepareForSystemStop(batchId, waitingForNetwork = true)

        val waiting = checkNotNull(store.batch(batchId))
        assertEquals(TransferStatus.WAITING_NETWORK, waiting.status)
        assertEquals(1, waiting.succeeded)
        assertEquals(0, waiting.failed)
        assertEquals(false, waiting.userCancelRequested)
        assertEquals(TransferStatus.SUCCEEDED, store.items(batchId)[0].status)
        assertEquals(TransferStatus.QUEUED, store.items(batchId)[1].status)

        store.markBatchRunning(batchId)
        store.markItemRunning(batchId, 1, "pending.pdf")
        store.markItemSuccess(batchId, 1, "content://download/pending")
        store.finishBatch(batchId)

        val completed = checkNotNull(store.batch(batchId))
        assertEquals(TransferStatus.SUCCEEDED, completed.status)
        assertEquals(2, completed.succeeded)
        assertEquals(0, completed.failed)
    }

    @Test
    fun userCancellationIsPersistedAndDoesNotResume() {
        val batchId = store.createDownloadBatch(listOf(file(1, "pending.pdf")))
        store.markBatchRunning(batchId)
        store.markItemRunning(batchId, 0, "pending.pdf")

        store.requestUserCancellation(batchId)
        store.cancelBatch(batchId)

        val batch = checkNotNull(store.batch(batchId))
        assertEquals(TransferStatus.CANCELLED, batch.status)
        assertTrue(batch.userCancelRequested)
        assertEquals(TransferStatus.CANCELLED, store.items(batchId).single().status)
    }

    @Test
    fun finishedHistoryIsPrunedToThreeWithoutDeletingActiveOrWaitingBatches() {
        val terminalIds = (1L..5L).map { id ->
            store.createDownloadBatch(listOf(file(id, "finished-$id.pdf"))).also { batchId ->
                store.markItemRunning(batchId, 0, "finished-$id.pdf")
                store.markItemSuccess(batchId, 0)
                store.finishBatch(batchId)
                Thread.sleep(2)
            }
        }
        val activeId = store.createDownloadBatch(listOf(file(10, "active.pdf")))
        store.markBatchRunning(activeId)
        val waitingId = store.createDownloadBatch(listOf(file(11, "waiting.pdf")))
        store.markBatchRetryPending(waitingId, waitingForNetwork = true)

        store.trimFinishedHistory()

        assertEquals(null, store.batch(terminalIds[0]))
        assertEquals(null, store.batch(terminalIds[1]))
        terminalIds.takeLast(3).forEach { assertTrue(store.batch(it) != null) }
        assertEquals(TransferStatus.RUNNING, checkNotNull(store.batch(activeId)).status)
        assertEquals(TransferStatus.WAITING_NETWORK, checkNotNull(store.batch(waitingId)).status)
        assertEquals(3, store.batches.value.take(3).size)
        assertEquals(
            listOf(TransferStatus.RUNNING, TransferStatus.WAITING_NETWORK),
            store.batches.value.take(2).map(TransferBatchSnapshot::status),
        )
    }

    @Test
    fun uploadFailureNoticePersistsUntilDismissedAndNewFailureCanAppear() {
        val batchId = failedUploadBatch("content://source/problem", "problem.mp4")
        val notice = store.failureNotices.value.single()
        assertEquals(batchId, notice.batchId)
        assertEquals(10L, notice.folderId)
        assertEquals("problem.mp4", notice.failures.single().name)

        store.close()
        store = TCloudTransferStore(context)
        assertEquals(notice.id, store.failureNotices.value.single().id)

        store.dismissFailureNotice(notice.id)
        store.close()
        store = TCloudTransferStore(context)
        assertTrue(store.failureNotices.value.isEmpty())

        val newBatchId = failedUploadBatch("content://source/problem", "problem.mp4")
        assertEquals(newBatchId, store.failureNotices.value.single().batchId)
    }

    @Test
    fun recoveredUploadTicketIsKeptUntilResolvedAndClearedOnSuccess() {
        val batchId = store.createUploadBatch(10, listOf("content://source/video" to "video.mp4"))
        store.markBatchRunning(batchId)
        store.markItemRunning(batchId, 0, "video.mp4")
        store.recordUploadTicket(batchId, 0, 1234)

        val recovery = store.recoverInterrupted(batchId, TransferDirection.UPLOAD)
        assertEquals(1234L, recovery.items.single().uploadTicketId)
        assertEquals(1234L, store.items(batchId).single().uploadTicketId)

        store.markItemSuccess(batchId, 0)
        assertEquals(0L, store.items(batchId).single().uploadTicketId)
    }

    @Test
    fun unresolvedTicketSurvivesTerminalStateForStartupCleanup() {
        val batchId = store.createUploadBatch(10, listOf("content://source/video" to "video.mp4"))
        store.markItemRunning(batchId, 0, "video.mp4")
        store.recordUploadTicket(batchId, 0, 5678)
        store.markItemFailure(batchId, 0, "保存できませんでした。")
        store.finishBatch(batchId)

        val pending = store.pendingTerminalUploadTickets().single()
        assertEquals(batchId, pending.batchId)
        assertEquals(0, pending.itemIndex)
        assertEquals(5678L, pending.ticketId)
    }

    private fun failedUploadBatch(sourceUri: String, name: String): String {
        val batchId = store.createUploadBatch(10, listOf(sourceUri to name))
        store.markBatchRunning(batchId)
        store.markItemRunning(batchId, 0, name)
        store.markItemFailure(batchId, 0, "通信を再試行しても保存できませんでした。")
        store.finishBatch(batchId)
        return batchId
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
