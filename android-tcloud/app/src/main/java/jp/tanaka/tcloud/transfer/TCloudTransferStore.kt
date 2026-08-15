package jp.tanaka.tcloud.transfer

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import jp.tanaka.tcloud.data.CloudFile
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.security.MessageDigest
import java.util.UUID

enum class TransferDirection(val value: String) {
    UPLOAD("upload"),
    DOWNLOAD("download"),
    CAMERA_BACKUP("camera_backup"),
    ;

    companion object {
        fun from(value: String): TransferDirection = entries.firstOrNull { it.value == value } ?: UPLOAD
    }
}

enum class TransferStatus(val value: String) {
    QUEUED("queued"),
    RUNNING("running"),
    WAITING_NETWORK("waiting_network"),
    SUCCEEDED("succeeded"),
    FAILED("failed"),
    CANCELLED("cancelled"),
    ;

    companion object {
        fun from(value: String): TransferStatus = entries.firstOrNull { it.value == value } ?: QUEUED
    }
}

data class TransferItem(
    val batchId: String,
    val index: Int,
    val folderId: Long,
    val fileId: Long,
    val sourceUri: String,
    val name: String,
    val cameraAssetKey: String,
    val expectedMediaKind: String,
    val status: TransferStatus,
    val stage: String,
    val error: String,
    val resultUri: String,
    val progressPercent: Int,
    val transferredBytes: Long,
    val totalBytes: Long,
    val uploadTicketId: Long,
)

data class TransferFailure(
    val name: String,
    val direction: TransferDirection,
    val reason: String,
)

data class TransferBatchSnapshot(
    val id: String,
    val direction: TransferDirection,
    val status: TransferStatus,
    val total: Int,
    val succeeded: Int,
    val failed: Int,
    val currentName: String,
    val currentFileProgress: Int,
    val folderIds: Set<Long>,
    val failures: List<TransferFailure>,
    val createdAt: Long,
    val updatedAt: Long,
    val activeCount: Int = 0,
    val transferredBytes: Long = 0,
    val totalBytes: Long = 0,
    private val aggregateProgress: Int? = null,
    val userCancelRequested: Boolean = false,
) {
    val processed: Int get() = (succeeded + failed).coerceAtMost(total)
    val remaining: Int get() = (total - processed).coerceAtLeast(0)
    val active: Boolean get() = status in setOf(
        TransferStatus.QUEUED,
        TransferStatus.RUNNING,
        TransferStatus.WAITING_NETWORK,
    )
    val waitingForNetwork: Boolean get() = status == TransferStatus.WAITING_NETWORK
    val overallProgress: Int get() = when {
        total <= 0 -> 0
        !active -> 100
        aggregateProgress != null -> aggregateProgress.coerceIn(0, 99)
        else -> ((processed * 100 + currentFileProgress.coerceIn(0, 100)) / total).coerceIn(0, 99)
    }
}

data class FolderTransferFailureNotice(
    val id: String,
    val batchId: String,
    val folderId: Long,
    val direction: TransferDirection,
    val failures: List<TransferFailure>,
    val createdAt: Long,
) {
    val failedCount: Int get() = failures.size
}

data class InterruptedTransferRecovery(
    val items: List<TransferItem>,
    val orphanDestinations: List<String>,
)

data class PersistedUploadTicket(
    val batchId: String,
    val itemIndex: Int,
    val ticketId: Long,
)

data class CameraUploadItem(
    val folderId: Long,
    val sourceUri: String,
    val assetKey: String,
    val expectedMediaKind: String,
)

data class CreatedCameraBatch(
    val id: String,
    val itemCount: Int,
)

internal fun transferProgressText(batch: TransferBatchSnapshot): String =
    "${batch.total}件中${batch.processed}件完了・残り${batch.remaining}件" +
        when {
            batch.waitingForNetwork -> "\nネットワークエラー・再接続待ち"
            batch.activeCount > 0 -> "\n${batch.activeCount}件を処理中"
            else -> ""
        }

internal fun transferResultText(batch: TransferBatchSnapshot): String =
    "${batch.total}件中${batch.succeeded}件成功・${batch.failed}件失敗"

class TCloudTransferStore(context: Context) : SQLiteOpenHelper(
    context,
    DATABASE_NAME,
    null,
    DATABASE_VERSION,
) {
    private val mutableBatches = MutableStateFlow<List<TransferBatchSnapshot>>(emptyList())
    val batches: StateFlow<List<TransferBatchSnapshot>> = mutableBatches.asStateFlow()
    private val mutableFailureNotices = MutableStateFlow<List<FolderTransferFailureNotice>>(emptyList())
    val failureNotices: StateFlow<List<FolderTransferFailureNotice>> = mutableFailureNotices.asStateFlow()

    init {
        pruneFinishedHistory()
        publish()
    }

    @Synchronized
    fun createUploadBatch(folderId: Long, sources: List<Pair<String, String>>): String {
        require(folderId > 0 && sources.isNotEmpty())
        return createBatch(
            direction = TransferDirection.UPLOAD,
            items = sources.mapIndexed { index, (uri, name) ->
                TransferItem(
                    batchId = "",
                    index = index,
                    folderId = folderId,
                    fileId = 0,
                    sourceUri = uri,
                    name = name,
                    cameraAssetKey = "",
                    expectedMediaKind = "",
                    status = TransferStatus.QUEUED,
                    stage = STAGE_QUEUED,
                    error = "",
                    resultUri = "",
                    progressPercent = 0,
                    transferredBytes = 0,
                    totalBytes = 0,
                    uploadTicketId = 0,
                )
            },
        )
    }

    @Synchronized
    fun createCameraBatch(items: List<CameraUploadItem>): CreatedCameraBatch? {
        require(items.isNotEmpty())
        val activeAssetKeys = readableDatabase.query(
            TABLE_ITEMS,
            arrayOf(COLUMN_CAMERA_ASSET_KEY),
            "$COLUMN_CAMERA_ASSET_KEY != '' AND $COLUMN_STATUS IN (?, ?)",
            arrayOf(TransferStatus.QUEUED.value, TransferStatus.RUNNING.value),
            null,
            null,
            null,
        ).use { cursor ->
            buildSet {
                while (cursor.moveToNext()) add(cursor.getString(0))
            }
        }
        val pendingItems = items
            .distinctBy(CameraUploadItem::assetKey)
            .filterNot { it.assetKey in activeAssetKeys }
        if (pendingItems.isEmpty()) return null
        val batchId = createBatch(
            direction = TransferDirection.CAMERA_BACKUP,
            items = pendingItems.mapIndexed { index, item ->
                TransferItem(
                    batchId = "",
                    index = index,
                    folderId = item.folderId,
                    fileId = 0,
                    sourceUri = item.sourceUri,
                    name = "カメラロール ${index + 1}",
                    cameraAssetKey = item.assetKey,
                    expectedMediaKind = item.expectedMediaKind,
                    status = TransferStatus.QUEUED,
                    stage = STAGE_QUEUED,
                    error = "",
                    resultUri = "",
                    progressPercent = 0,
                    transferredBytes = 0,
                    totalBytes = 0,
                    uploadTicketId = 0,
                )
            },
        )
        return CreatedCameraBatch(batchId, pendingItems.size)
    }

    @Synchronized
    fun createDownloadBatch(files: List<CloudFile>): String {
        require(files.isNotEmpty())
        return createBatch(
            direction = TransferDirection.DOWNLOAD,
            items = files.mapIndexed { index, file ->
                TransferItem(
                    batchId = "",
                    index = index,
                    folderId = file.folderId,
                    fileId = file.id,
                    sourceUri = "",
                    name = file.name,
                    cameraAssetKey = "",
                    expectedMediaKind = "",
                    status = TransferStatus.QUEUED,
                    stage = STAGE_QUEUED,
                    error = "",
                    resultUri = "",
                    progressPercent = 0,
                    transferredBytes = 0,
                    totalBytes = file.sizeBytes.coerceAtLeast(0),
                    uploadTicketId = 0,
                )
            },
        )
    }

    @Synchronized
    fun batch(batchId: String): TransferBatchSnapshot? = readBatch(batchId)

    @Synchronized
    fun items(batchId: String): List<TransferItem> = readableDatabase.query(
        TABLE_ITEMS,
        ITEM_COLUMNS,
        "$COLUMN_BATCH_ID = ?",
        arrayOf(batchId),
        null,
        null,
        "$COLUMN_ITEM_INDEX ASC",
    ).use { cursor ->
        buildList {
            while (cursor.moveToNext()) {
                add(
                    TransferItem(
                        batchId = cursor.getString(0),
                        index = cursor.getInt(1),
                        folderId = cursor.getLong(2),
                        fileId = cursor.getLong(3),
                        sourceUri = cursor.getString(4),
                        name = cursor.getString(5),
                        cameraAssetKey = cursor.getString(6),
                        expectedMediaKind = cursor.getString(7),
                        status = TransferStatus.from(cursor.getString(8)),
                        stage = cursor.getString(9),
                        error = cursor.getString(10),
                        resultUri = cursor.getString(11),
                        progressPercent = cursor.getInt(12),
                        transferredBytes = cursor.getLong(13),
                        totalBytes = cursor.getLong(14),
                        uploadTicketId = cursor.getLong(15),
                    ),
                )
            }
        }
    }

    @Synchronized
    fun recoverInterrupted(batchId: String, direction: TransferDirection): InterruptedTransferRecovery {
        val interrupted = items(batchId).filter { it.status == TransferStatus.RUNNING }
        val orphanDestinations = interrupted.mapNotNull { it.resultUri.takeIf(String::isNotBlank) }
        interrupted.forEach { item ->
            writableDatabase.update(
                TABLE_ITEMS,
                ContentValues().apply {
                    put(COLUMN_STATUS, TransferStatus.QUEUED.value)
                    put(COLUMN_STAGE, STAGE_QUEUED)
                    put(COLUMN_RESULT_URI, "")
                    put(COLUMN_PROGRESS_PERCENT, 0)
                    put(COLUMN_TRANSFERRED_BYTES, 0)
                },
                "$COLUMN_BATCH_ID = ? AND $COLUMN_ITEM_INDEX = ?",
                arrayOf(batchId, item.index.toString()),
            )
        }
        if (interrupted.isNotEmpty()) updateBatch(batchId, TransferStatus.QUEUED, "", 0)
        publish()
        return InterruptedTransferRecovery(interrupted, orphanDestinations)
    }

    @Synchronized
    fun markBatchRunning(batchId: String) = updateBatch(batchId, TransferStatus.RUNNING, "", 0)

    @Synchronized
    fun markBatchRetryPending(batchId: String, waitingForNetwork: Boolean = false) =
        updateBatch(
            batchId,
            if (waitingForNetwork) TransferStatus.WAITING_NETWORK else TransferStatus.QUEUED,
            if (waitingForNetwork) "ネットワークエラー・再接続待ち" else "一時エラーのため再試行します",
            0,
        )

    @Synchronized
    fun prepareForSystemStop(batchId: String, waitingForNetwork: Boolean) {
        writableDatabase.update(
            TABLE_ITEMS,
            ContentValues().apply {
                put(COLUMN_STATUS, TransferStatus.QUEUED.value)
                put(COLUMN_STAGE, STAGE_QUEUED)
                put(COLUMN_RESULT_URI, "")
                put(COLUMN_PROGRESS_PERCENT, 0)
                put(COLUMN_TRANSFERRED_BYTES, 0)
            },
            "$COLUMN_BATCH_ID = ? AND $COLUMN_STATUS = ?",
            arrayOf(batchId, TransferStatus.RUNNING.value),
        )
        markBatchRetryPending(batchId, waitingForNetwork)
    }

    @Synchronized
    fun markItemRunning(batchId: String, index: Int, name: String, totalBytes: Long? = null) {
        updateItem(batchId, index) {
            put(COLUMN_STATUS, TransferStatus.RUNNING.value)
            put(COLUMN_STAGE, STAGE_PREPARING)
            put(COLUMN_ERROR, "")
            put(COLUMN_PROGRESS_PERCENT, 0)
            put(COLUMN_TRANSFERRED_BYTES, 0)
            totalBytes?.let { put(COLUMN_TOTAL_BYTES, it.coerceAtLeast(0)) }
            if (name.isNotBlank()) put(COLUMN_NAME, name)
        }
        updateBatch(batchId, TransferStatus.RUNNING, name, 0)
    }

    @Synchronized
    fun markItemStage(batchId: String, index: Int, stage: String) {
        updateItem(batchId, index) { put(COLUMN_STAGE, stage) }
    }

    @Synchronized
    fun recordDestination(batchId: String, index: Int, uri: String) {
        updateItem(batchId, index) { put(COLUMN_RESULT_URI, uri) }
    }

    @Synchronized
    fun recordUploadTicket(batchId: String, index: Int, ticketId: Long) {
        updateItem(batchId, index) { put(COLUMN_UPLOAD_TICKET_ID, ticketId.coerceAtLeast(0)) }
    }

    @Synchronized
    fun clearUploadTicket(batchId: String, index: Int) {
        updateItem(batchId, index) { put(COLUMN_UPLOAD_TICKET_ID, 0) }
    }

    @Synchronized
    fun updateProgress(
        batchId: String,
        index: Int,
        name: String,
        progress: Int,
        transferredBytes: Long,
        totalBytes: Long,
    ) {
        updateItem(batchId, index, publishNow = false) {
            put(COLUMN_PROGRESS_PERCENT, progress.coerceIn(0, 100))
            put(COLUMN_TRANSFERRED_BYTES, transferredBytes.coerceAtLeast(0))
            put(COLUMN_TOTAL_BYTES, totalBytes.coerceAtLeast(0))
        }
        updateBatch(batchId, TransferStatus.RUNNING, name, progress.coerceIn(0, 100))
    }

    @Synchronized
    fun markItemSuccess(batchId: String, index: Int, resultUri: String = "") {
        updateItem(batchId, index) {
            put(COLUMN_STATUS, TransferStatus.SUCCEEDED.value)
            put(COLUMN_STAGE, STAGE_DONE)
            put(COLUMN_ERROR, "")
            put(COLUMN_RESULT_URI, resultUri)
            put(COLUMN_PROGRESS_PERCENT, 100)
            put(COLUMN_UPLOAD_TICKET_ID, 0)
        }
        refreshBatchCounts(batchId)
    }

    @Synchronized
    fun markItemFailure(
        batchId: String,
        index: Int,
        error: String,
        publishNow: Boolean = true,
    ) {
        updateItem(batchId, index, publishNow = false) {
            put(COLUMN_STATUS, TransferStatus.FAILED.value)
            put(COLUMN_STAGE, STAGE_DONE)
            put(COLUMN_ERROR, error.take(500))
            put(COLUMN_RESULT_URI, "")
            put(COLUMN_PROGRESS_PERCENT, 0)
            put(COLUMN_TRANSFERRED_BYTES, 0)
        }
        refreshBatchCounts(batchId, publishNow)
    }

    @Synchronized
    fun deferItem(batchId: String, index: Int) {
        updateItem(batchId, index, publishNow = false) {
            put(COLUMN_STATUS, TransferStatus.QUEUED.value)
            put(COLUMN_STAGE, STAGE_QUEUED)
            put(COLUMN_ERROR, "")
            put(COLUMN_RESULT_URI, "")
        }
        updateBatch(batchId, TransferStatus.QUEUED, "通信回復後に再試行します", 0)
    }

    @Synchronized
    fun finishBatch(batchId: String) {
        val current = readBatch(batchId) ?: return
        val finalStatus = when {
            current.status == TransferStatus.CANCELLED -> TransferStatus.CANCELLED
            current.failed > 0 -> TransferStatus.FAILED
            else -> TransferStatus.SUCCEEDED
        }
        updateBatch(batchId, finalStatus, "", 100)
        if (finalStatus == TransferStatus.FAILED) recordFailureNotices(batchId)
        publish()
    }

    @Synchronized
    fun requestUserCancellation(batchId: String) {
        writableDatabase.update(
            TABLE_BATCHES,
            ContentValues().apply { put(COLUMN_USER_CANCEL_REQUESTED, 1) },
            "$COLUMN_BATCH_ID = ?",
            arrayOf(batchId),
        )
        publish()
    }

    @Synchronized
    fun isUserCancellationRequested(batchId: String): Boolean = readableDatabase.query(
        TABLE_BATCHES,
        arrayOf(COLUMN_USER_CANCEL_REQUESTED),
        "$COLUMN_BATCH_ID = ?",
        arrayOf(batchId),
        null,
        null,
        null,
        "1",
    ).use { cursor -> cursor.moveToFirst() && cursor.getInt(0) != 0 }

    @Synchronized
    fun cancelBatch(batchId: String) {
        writableDatabase.update(
            TABLE_ITEMS,
            ContentValues().apply {
                put(COLUMN_STATUS, TransferStatus.CANCELLED.value)
                put(COLUMN_STAGE, STAGE_DONE)
                put(COLUMN_ERROR, "中止しました。")
                put(COLUMN_RESULT_URI, "")
            },
            "$COLUMN_BATCH_ID = ? AND $COLUMN_STATUS IN (?, ?)",
            arrayOf(batchId, TransferStatus.QUEUED.value, TransferStatus.RUNNING.value),
        )
        updateBatch(batchId, TransferStatus.CANCELLED, "", 0)
        publish()
    }

    @Synchronized
    fun trimFinishedHistory() {
        pruneFinishedHistory()
        publish()
    }

    @Synchronized
    fun pendingTerminalUploadTickets(): List<PersistedUploadTicket> = readableDatabase.rawQuery(
        """SELECT i.$COLUMN_BATCH_ID, i.$COLUMN_ITEM_INDEX, i.$COLUMN_UPLOAD_TICKET_ID
            FROM $TABLE_ITEMS i
            JOIN $TABLE_BATCHES b ON b.$COLUMN_BATCH_ID = i.$COLUMN_BATCH_ID
            WHERE i.$COLUMN_UPLOAD_TICKET_ID > 0
              AND b.$COLUMN_STATUS IN (?, ?, ?)""".trimIndent(),
        arrayOf(
            TransferStatus.CANCELLED.value,
            TransferStatus.FAILED.value,
            TransferStatus.SUCCEEDED.value,
        ),
    ).use { cursor ->
        buildList {
            while (cursor.moveToNext()) {
                add(PersistedUploadTicket(cursor.getString(0), cursor.getInt(1), cursor.getLong(2)))
            }
        }
    }

    @Synchronized
    fun dismissFailureNotice(noticeId: String) {
        writableDatabase.beginTransaction()
        try {
            writableDatabase.update(
                TABLE_FAILURE_NOTICES,
                ContentValues().apply { put(COLUMN_DISMISSED, 1) },
                "$COLUMN_NOTICE_ID = ?",
                arrayOf(noticeId),
            )
            writableDatabase.delete(
                TABLE_FAILURE_NOTICE_ITEMS,
                "$COLUMN_NOTICE_ID = ?",
                arrayOf(noticeId),
            )
            writableDatabase.setTransactionSuccessful()
        } finally {
            writableDatabase.endTransaction()
        }
        publish()
    }

    override fun onCreate(database: SQLiteDatabase) {
        database.execSQL(
            """CREATE TABLE $TABLE_BATCHES (
                $COLUMN_BATCH_ID TEXT PRIMARY KEY NOT NULL,
                $COLUMN_DIRECTION TEXT NOT NULL,
                $COLUMN_STATUS TEXT NOT NULL,
                $COLUMN_TOTAL INTEGER NOT NULL,
                $COLUMN_SUCCEEDED INTEGER NOT NULL DEFAULT 0,
                $COLUMN_FAILED INTEGER NOT NULL DEFAULT 0,
                $COLUMN_CURRENT_NAME TEXT NOT NULL DEFAULT '',
                $COLUMN_CURRENT_PROGRESS INTEGER NOT NULL DEFAULT 0,
                $COLUMN_CREATED_AT INTEGER NOT NULL,
                $COLUMN_UPDATED_AT INTEGER NOT NULL,
                $COLUMN_USER_CANCEL_REQUESTED INTEGER NOT NULL DEFAULT 0
            )""".trimIndent(),
        )
        database.execSQL(
            """CREATE TABLE $TABLE_ITEMS (
                $COLUMN_BATCH_ID TEXT NOT NULL,
                $COLUMN_ITEM_INDEX INTEGER NOT NULL,
                $COLUMN_FOLDER_ID INTEGER NOT NULL,
                $COLUMN_FILE_ID INTEGER NOT NULL DEFAULT 0,
                $COLUMN_SOURCE_URI TEXT NOT NULL DEFAULT '',
                $COLUMN_NAME TEXT NOT NULL DEFAULT '',
                $COLUMN_CAMERA_ASSET_KEY TEXT NOT NULL DEFAULT '',
                $COLUMN_EXPECTED_MEDIA_KIND TEXT NOT NULL DEFAULT '',
                $COLUMN_STATUS TEXT NOT NULL,
                $COLUMN_STAGE TEXT NOT NULL,
                $COLUMN_ERROR TEXT NOT NULL DEFAULT '',
                $COLUMN_RESULT_URI TEXT NOT NULL DEFAULT '',
                $COLUMN_PROGRESS_PERCENT INTEGER NOT NULL DEFAULT 0,
                $COLUMN_TRANSFERRED_BYTES INTEGER NOT NULL DEFAULT 0,
                $COLUMN_TOTAL_BYTES INTEGER NOT NULL DEFAULT 0,
                $COLUMN_UPLOAD_TICKET_ID INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY ($COLUMN_BATCH_ID, $COLUMN_ITEM_INDEX)
            )""".trimIndent(),
        )
        database.execSQL("CREATE INDEX transfer_items_batch_status ON $TABLE_ITEMS ($COLUMN_BATCH_ID, $COLUMN_STATUS)")
        createFailureNoticeTables(database)
    }

    override fun onUpgrade(database: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        if (oldVersion < 2) {
            database.execSQL("ALTER TABLE $TABLE_ITEMS ADD COLUMN $COLUMN_PROGRESS_PERCENT INTEGER NOT NULL DEFAULT 0")
            database.execSQL("ALTER TABLE $TABLE_ITEMS ADD COLUMN $COLUMN_TRANSFERRED_BYTES INTEGER NOT NULL DEFAULT 0")
            database.execSQL("ALTER TABLE $TABLE_ITEMS ADD COLUMN $COLUMN_TOTAL_BYTES INTEGER NOT NULL DEFAULT 0")
        }
        if (oldVersion < 3) {
            database.execSQL(
                "ALTER TABLE $TABLE_BATCHES ADD COLUMN $COLUMN_USER_CANCEL_REQUESTED INTEGER NOT NULL DEFAULT 0",
            )
            database.execSQL(
                "ALTER TABLE $TABLE_ITEMS ADD COLUMN $COLUMN_UPLOAD_TICKET_ID INTEGER NOT NULL DEFAULT 0",
            )
            createFailureNoticeTables(database)
        }
    }

    private fun createFailureNoticeTables(database: SQLiteDatabase) {
        database.execSQL(
            """CREATE TABLE IF NOT EXISTS $TABLE_FAILURE_NOTICES (
                $COLUMN_NOTICE_ID TEXT PRIMARY KEY NOT NULL,
                $COLUMN_BATCH_ID TEXT NOT NULL,
                $COLUMN_FOLDER_ID INTEGER NOT NULL,
                $COLUMN_DIRECTION TEXT NOT NULL,
                $COLUMN_FINGERPRINT TEXT NOT NULL,
                $COLUMN_CREATED_AT INTEGER NOT NULL,
                $COLUMN_UPDATED_AT INTEGER NOT NULL,
                $COLUMN_DISMISSED INTEGER NOT NULL DEFAULT 0
            )""".trimIndent(),
        )
        database.execSQL(
            """CREATE TABLE IF NOT EXISTS $TABLE_FAILURE_NOTICE_ITEMS (
                $COLUMN_NOTICE_ID TEXT NOT NULL,
                $COLUMN_ITEM_INDEX INTEGER NOT NULL,
                $COLUMN_NAME TEXT NOT NULL,
                $COLUMN_ERROR TEXT NOT NULL,
                PRIMARY KEY ($COLUMN_NOTICE_ID, $COLUMN_ITEM_INDEX)
            )""".trimIndent(),
        )
        database.execSQL(
            "CREATE INDEX IF NOT EXISTS transfer_failure_notices_folder ON " +
                "$TABLE_FAILURE_NOTICES ($COLUMN_FOLDER_ID, $COLUMN_DISMISSED, $COLUMN_UPDATED_AT DESC)",
        )
    }

    private fun createBatch(direction: TransferDirection, items: List<TransferItem>): String {
        val batchId = UUID.randomUUID().toString()
        val now = System.currentTimeMillis()
        writableDatabase.beginTransaction()
        try {
            writableDatabase.insertOrThrow(
                TABLE_BATCHES,
                null,
                ContentValues().apply {
                    put(COLUMN_BATCH_ID, batchId)
                    put(COLUMN_DIRECTION, direction.value)
                    put(COLUMN_STATUS, TransferStatus.QUEUED.value)
                    put(COLUMN_TOTAL, items.size)
                    put(COLUMN_SUCCEEDED, 0)
                    put(COLUMN_FAILED, 0)
                    put(COLUMN_CURRENT_NAME, "")
                    put(COLUMN_CURRENT_PROGRESS, 0)
                    put(COLUMN_CREATED_AT, now)
                    put(COLUMN_UPDATED_AT, now)
                    put(COLUMN_USER_CANCEL_REQUESTED, 0)
                },
            )
            items.forEach { item ->
                writableDatabase.insertOrThrow(
                    TABLE_ITEMS,
                    null,
                    ContentValues().apply {
                        put(COLUMN_BATCH_ID, batchId)
                        put(COLUMN_ITEM_INDEX, item.index)
                        put(COLUMN_FOLDER_ID, item.folderId)
                        put(COLUMN_FILE_ID, item.fileId)
                        put(COLUMN_SOURCE_URI, item.sourceUri)
                        put(COLUMN_NAME, item.name)
                        put(COLUMN_CAMERA_ASSET_KEY, item.cameraAssetKey)
                        put(COLUMN_EXPECTED_MEDIA_KIND, item.expectedMediaKind)
                        put(COLUMN_STATUS, TransferStatus.QUEUED.value)
                        put(COLUMN_STAGE, STAGE_QUEUED)
                        put(COLUMN_ERROR, "")
                        put(COLUMN_RESULT_URI, "")
                        put(COLUMN_PROGRESS_PERCENT, item.progressPercent)
                        put(COLUMN_TRANSFERRED_BYTES, item.transferredBytes)
                        put(COLUMN_TOTAL_BYTES, item.totalBytes)
                        put(COLUMN_UPLOAD_TICKET_ID, 0)
                    },
                )
            }
            writableDatabase.setTransactionSuccessful()
        } finally {
            writableDatabase.endTransaction()
        }
        publish()
        return batchId
    }

    private fun updateItem(
        batchId: String,
        index: Int,
        publishNow: Boolean = true,
        values: ContentValues.() -> Unit,
    ) {
        writableDatabase.update(
            TABLE_ITEMS,
            ContentValues().apply(values),
            "$COLUMN_BATCH_ID = ? AND $COLUMN_ITEM_INDEX = ?",
            arrayOf(batchId, index.toString()),
        )
        if (publishNow) publish()
    }

    private fun refreshBatchCounts(batchId: String, publishNow: Boolean = true) {
        val counts = readableDatabase.rawQuery(
            """SELECT
                SUM(CASE WHEN $COLUMN_STATUS = ? THEN 1 ELSE 0 END),
                SUM(CASE WHEN $COLUMN_STATUS = ? THEN 1 ELSE 0 END)
                FROM $TABLE_ITEMS WHERE $COLUMN_BATCH_ID = ?""".trimIndent(),
            arrayOf(TransferStatus.SUCCEEDED.value, TransferStatus.FAILED.value, batchId),
        ).use { cursor ->
            if (cursor.moveToFirst()) cursor.getInt(0) to cursor.getInt(1) else 0 to 0
        }
        writableDatabase.update(
            TABLE_BATCHES,
            ContentValues().apply {
                put(COLUMN_SUCCEEDED, counts.first)
                put(COLUMN_FAILED, counts.second)
                put(COLUMN_CURRENT_PROGRESS, 0)
                put(COLUMN_UPDATED_AT, System.currentTimeMillis())
            },
            "$COLUMN_BATCH_ID = ?",
            arrayOf(batchId),
        )
        if (publishNow) publish()
    }

    private fun updateBatch(
        batchId: String,
        status: TransferStatus,
        currentName: String,
        currentProgress: Int,
    ) {
        writableDatabase.update(
            TABLE_BATCHES,
            ContentValues().apply {
                put(COLUMN_STATUS, status.value)
                put(COLUMN_CURRENT_NAME, currentName)
                put(COLUMN_CURRENT_PROGRESS, currentProgress)
                put(COLUMN_UPDATED_AT, System.currentTimeMillis())
            },
            "$COLUMN_BATCH_ID = ?",
            arrayOf(batchId),
        )
        publish()
    }

    private fun readBatch(batchId: String): TransferBatchSnapshot? = readBatches(
        "$COLUMN_BATCH_ID = ?",
        arrayOf(batchId),
        "1",
    ).firstOrNull()

    private fun readBatches(
        selection: String? = null,
        selectionArgs: Array<String>? = null,
        limit: String = "12",
    ): List<TransferBatchSnapshot> = readableDatabase.query(
        TABLE_BATCHES,
        BATCH_COLUMNS,
        selection,
        selectionArgs,
        null,
        null,
        "$COLUMN_UPDATED_AT DESC",
        limit,
    ).use { cursor ->
        buildList {
            while (cursor.moveToNext()) {
                val batchId = cursor.getString(0)
                val direction = TransferDirection.from(cursor.getString(1))
                val itemRows = items(batchId)
                val running = itemRows.filter { it.status == TransferStatus.RUNNING }
                val allSizesKnown = itemRows.isNotEmpty() && itemRows.all { it.totalBytes > 0 }
                val knownTotalBytes = itemRows.sumOf { it.totalBytes.coerceAtLeast(0) }
                val effectiveTransferredBytes = itemRows.sumOf { item ->
                    if (item.status in setOf(TransferStatus.SUCCEEDED, TransferStatus.FAILED, TransferStatus.CANCELLED)) {
                        item.totalBytes.coerceAtLeast(item.transferredBytes)
                    } else item.transferredBytes.coerceAtMost(item.totalBytes.coerceAtLeast(item.transferredBytes))
                }
                val aggregateProgress = if (allSizesKnown && knownTotalBytes > 0) {
                    ((effectiveTransferredBytes * 100.0) / knownTotalBytes).toInt()
                } else {
                    itemRows.sumOf { item ->
                        if (item.status in setOf(TransferStatus.SUCCEEDED, TransferStatus.FAILED, TransferStatus.CANCELLED)) 100
                        else item.progressPercent.coerceIn(0, 100)
                    } / itemRows.size.coerceAtLeast(1)
                }
                add(
                    TransferBatchSnapshot(
                        id = batchId,
                        direction = direction,
                        status = TransferStatus.from(cursor.getString(2)),
                        total = cursor.getInt(3),
                        succeeded = cursor.getInt(4),
                        failed = cursor.getInt(5),
                        currentName = cursor.getString(6),
                        currentFileProgress = cursor.getInt(7),
                        folderIds = itemRows.mapTo(linkedSetOf()) { it.folderId },
                        failures = itemRows.filter { it.status == TransferStatus.FAILED }.map {
                            TransferFailure(it.name, direction, it.error.ifBlank { "理由を確認できませんでした。" })
                        },
                        createdAt = cursor.getLong(8),
                        updatedAt = cursor.getLong(9),
                        activeCount = running.size,
                        transferredBytes = effectiveTransferredBytes,
                        totalBytes = knownTotalBytes,
                        aggregateProgress = aggregateProgress,
                        userCancelRequested = cursor.getInt(10) != 0,
                    ),
                )
            }
        }
    }

    private fun publish() {
        val active = readBatches(
            "$COLUMN_STATUS IN (?, ?, ?)",
            arrayOf(
                TransferStatus.RUNNING.value,
                TransferStatus.WAITING_NETWORK.value,
                TransferStatus.QUEUED.value,
            ),
            "100",
        ).sortedWith(
            compareBy<TransferBatchSnapshot> {
                when (it.status) {
                    TransferStatus.RUNNING -> 0
                    TransferStatus.WAITING_NETWORK -> 1
                    else -> 2
                }
            }.thenByDescending { it.updatedAt },
        )
        val finished = readBatches(
            "$COLUMN_STATUS NOT IN (?, ?, ?)",
            arrayOf(
                TransferStatus.RUNNING.value,
                TransferStatus.WAITING_NETWORK.value,
                TransferStatus.QUEUED.value,
            ),
            FINISHED_HISTORY_LIMIT.toString(),
        )
        mutableBatches.value = active + finished
        mutableFailureNotices.value = readFailureNotices()
    }

    private fun recordFailureNotices(batchId: String) {
        val batch = readBatch(batchId) ?: return
        if (batch.direction == TransferDirection.DOWNLOAD) return
        val failures = items(batchId).filter { it.status == TransferStatus.FAILED }.groupBy { it.folderId }
        val now = System.currentTimeMillis()
        failures.forEach { (folderId, failedItems) ->
            if (folderId <= 0 || failedItems.isEmpty()) return@forEach
            val fingerprint = failureFingerprint(batch.direction, folderId, failedItems)
            val existingId = readableDatabase.query(
                TABLE_FAILURE_NOTICES,
                arrayOf(COLUMN_NOTICE_ID),
                "$COLUMN_FOLDER_ID = ? AND $COLUMN_FINGERPRINT = ? AND $COLUMN_DISMISSED = 0",
                arrayOf(folderId.toString(), fingerprint),
                null,
                null,
                "$COLUMN_UPDATED_AT DESC",
                "1",
            ).use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null }
            val noticeId = existingId ?: UUID.randomUUID().toString()
            writableDatabase.beginTransaction()
            try {
                writableDatabase.insertWithOnConflict(
                    TABLE_FAILURE_NOTICES,
                    null,
                    ContentValues().apply {
                        put(COLUMN_NOTICE_ID, noticeId)
                        put(COLUMN_BATCH_ID, batchId)
                        put(COLUMN_FOLDER_ID, folderId)
                        put(COLUMN_DIRECTION, batch.direction.value)
                        put(COLUMN_FINGERPRINT, fingerprint)
                        put(COLUMN_CREATED_AT, if (existingId == null) now else batch.createdAt)
                        put(COLUMN_UPDATED_AT, now)
                        put(COLUMN_DISMISSED, 0)
                    },
                    SQLiteDatabase.CONFLICT_REPLACE,
                )
                writableDatabase.delete(
                    TABLE_FAILURE_NOTICE_ITEMS,
                    "$COLUMN_NOTICE_ID = ?",
                    arrayOf(noticeId),
                )
                failedItems.forEachIndexed { index, item ->
                    writableDatabase.insertOrThrow(
                        TABLE_FAILURE_NOTICE_ITEMS,
                        null,
                        ContentValues().apply {
                            put(COLUMN_NOTICE_ID, noticeId)
                            put(COLUMN_ITEM_INDEX, index)
                            put(COLUMN_NAME, item.name)
                            put(COLUMN_ERROR, item.error.ifBlank { "理由を確認できませんでした。" })
                        },
                    )
                }
                writableDatabase.setTransactionSuccessful()
            } finally {
                writableDatabase.endTransaction()
            }
        }
    }

    private fun failureFingerprint(
        direction: TransferDirection,
        folderId: Long,
        failedItems: List<TransferItem>,
    ): String {
        val raw = buildString {
            append(direction.value).append(':').append(folderId)
            failedItems.map { item ->
                item.cameraAssetKey.ifBlank { item.sourceUri.ifBlank { item.name } }
            }.sorted().forEach { append('|').append(it) }
        }
        return MessageDigest.getInstance("SHA-256")
            .digest(raw.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
    }

    private fun readFailureNotices(): List<FolderTransferFailureNotice> = readableDatabase.query(
        TABLE_FAILURE_NOTICES,
        arrayOf(COLUMN_NOTICE_ID, COLUMN_BATCH_ID, COLUMN_FOLDER_ID, COLUMN_DIRECTION, COLUMN_CREATED_AT),
        "$COLUMN_DISMISSED = 0",
        null,
        null,
        null,
        "$COLUMN_UPDATED_AT DESC",
        "100",
    ).use { cursor ->
        buildList {
            while (cursor.moveToNext()) {
                val noticeId = cursor.getString(0)
                val direction = TransferDirection.from(cursor.getString(3))
                val failures = readableDatabase.query(
                    TABLE_FAILURE_NOTICE_ITEMS,
                    arrayOf(COLUMN_NAME, COLUMN_ERROR),
                    "$COLUMN_NOTICE_ID = ?",
                    arrayOf(noticeId),
                    null,
                    null,
                    "$COLUMN_ITEM_INDEX ASC",
                ).use { itemsCursor ->
                    buildList {
                        while (itemsCursor.moveToNext()) {
                            add(TransferFailure(itemsCursor.getString(0), direction, itemsCursor.getString(1)))
                        }
                    }
                }
                add(
                    FolderTransferFailureNotice(
                        id = noticeId,
                        batchId = cursor.getString(1),
                        folderId = cursor.getLong(2),
                        direction = direction,
                        failures = failures,
                        createdAt = cursor.getLong(4),
                    ),
                )
            }
        }
    }

    private fun pruneFinishedHistory() {
        val terminalStatuses = arrayOf(
            TransferStatus.SUCCEEDED.value,
            TransferStatus.FAILED.value,
            TransferStatus.CANCELLED.value,
        )
        val placeholders = terminalStatuses.joinToString(",") { "?" }
        val staleIds = readableDatabase.rawQuery(
            """SELECT b.$COLUMN_BATCH_ID FROM $TABLE_BATCHES b
                WHERE b.$COLUMN_STATUS IN ($placeholders)
                  AND NOT EXISTS (
                    SELECT 1 FROM $TABLE_ITEMS i
                    WHERE i.$COLUMN_BATCH_ID = b.$COLUMN_BATCH_ID
                      AND i.$COLUMN_UPLOAD_TICKET_ID > 0
                  )
                ORDER BY b.$COLUMN_UPDATED_AT DESC
                LIMIT -1 OFFSET $FINISHED_HISTORY_LIMIT""".trimIndent(),
            terminalStatuses,
        ).use { cursor -> buildList { while (cursor.moveToNext()) add(cursor.getString(0)) } }
        if (staleIds.isEmpty()) return
        writableDatabase.beginTransaction()
        try {
            staleIds.forEach { batchId ->
                writableDatabase.delete(TABLE_ITEMS, "$COLUMN_BATCH_ID = ?", arrayOf(batchId))
                writableDatabase.delete(TABLE_BATCHES, "$COLUMN_BATCH_ID = ?", arrayOf(batchId))
            }
            writableDatabase.setTransactionSuccessful()
        } finally {
            writableDatabase.endTransaction()
        }
    }

    companion object {
        internal const val STAGE_UPLOADING = "uploading"
        internal const val STAGE_COMPLETING = "completing"
        const val DATABASE_NAME = "tcloud_transfers.db"
        const val DATABASE_VERSION = 3
        private const val FINISHED_HISTORY_LIMIT = 3
        const val TABLE_BATCHES = "transfer_batches"
        const val TABLE_ITEMS = "transfer_items"
        const val COLUMN_BATCH_ID = "batch_id"
        const val COLUMN_DIRECTION = "direction"
        const val COLUMN_STATUS = "status"
        const val COLUMN_TOTAL = "total"
        const val COLUMN_SUCCEEDED = "succeeded"
        const val COLUMN_FAILED = "failed"
        const val COLUMN_CURRENT_NAME = "current_name"
        const val COLUMN_CURRENT_PROGRESS = "current_progress"
        const val COLUMN_CREATED_AT = "created_at"
        const val COLUMN_UPDATED_AT = "updated_at"
        const val COLUMN_ITEM_INDEX = "item_index"
        const val COLUMN_FOLDER_ID = "folder_id"
        const val COLUMN_FILE_ID = "file_id"
        const val COLUMN_SOURCE_URI = "source_uri"
        const val COLUMN_NAME = "name"
        const val COLUMN_CAMERA_ASSET_KEY = "camera_asset_key"
        const val COLUMN_EXPECTED_MEDIA_KIND = "expected_media_kind"
        const val COLUMN_STAGE = "stage"
        const val COLUMN_ERROR = "error"
        const val COLUMN_RESULT_URI = "result_uri"
        const val COLUMN_PROGRESS_PERCENT = "progress_percent"
        const val COLUMN_TRANSFERRED_BYTES = "transferred_bytes"
        const val COLUMN_TOTAL_BYTES = "total_bytes"
        const val COLUMN_UPLOAD_TICKET_ID = "upload_ticket_id"
        const val COLUMN_USER_CANCEL_REQUESTED = "user_cancel_requested"
        const val TABLE_FAILURE_NOTICES = "transfer_failure_notices"
        const val TABLE_FAILURE_NOTICE_ITEMS = "transfer_failure_notice_items"
        const val COLUMN_NOTICE_ID = "notice_id"
        const val COLUMN_FINGERPRINT = "fingerprint"
        const val COLUMN_DISMISSED = "dismissed"
        const val STAGE_QUEUED = "queued"
        const val STAGE_PREPARING = "preparing"
        const val STAGE_DONE = "done"

        val BATCH_COLUMNS = arrayOf(
            COLUMN_BATCH_ID,
            COLUMN_DIRECTION,
            COLUMN_STATUS,
            COLUMN_TOTAL,
            COLUMN_SUCCEEDED,
            COLUMN_FAILED,
            COLUMN_CURRENT_NAME,
            COLUMN_CURRENT_PROGRESS,
            COLUMN_CREATED_AT,
            COLUMN_UPDATED_AT,
            COLUMN_USER_CANCEL_REQUESTED,
        )
        val ITEM_COLUMNS = arrayOf(
            COLUMN_BATCH_ID,
            COLUMN_ITEM_INDEX,
            COLUMN_FOLDER_ID,
            COLUMN_FILE_ID,
            COLUMN_SOURCE_URI,
            COLUMN_NAME,
            COLUMN_CAMERA_ASSET_KEY,
            COLUMN_EXPECTED_MEDIA_KIND,
            COLUMN_STATUS,
            COLUMN_STAGE,
            COLUMN_ERROR,
            COLUMN_RESULT_URI,
            COLUMN_PROGRESS_PERCENT,
            COLUMN_TRANSFERRED_BYTES,
            COLUMN_TOTAL_BYTES,
            COLUMN_UPLOAD_TICKET_ID,
        )
    }
}
