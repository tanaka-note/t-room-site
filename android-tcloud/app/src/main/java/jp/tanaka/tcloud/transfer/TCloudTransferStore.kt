package jp.tanaka.tcloud.transfer

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import jp.tanaka.tcloud.data.CloudFile
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
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
) {
    val processed: Int get() = (succeeded + failed).coerceAtMost(total)
    val remaining: Int get() = (total - processed).coerceAtLeast(0)
    val active: Boolean get() = status == TransferStatus.QUEUED || status == TransferStatus.RUNNING
    val overallProgress: Int get() = when {
        total <= 0 -> 0
        !active -> 100
        else -> ((processed * 100 + currentFileProgress.coerceIn(0, 100)) / total).coerceIn(0, 99)
    }
}

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
    "${batch.total}件中${batch.processed}件完了・残り${batch.remaining}件"

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

    init {
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
                    ),
                )
            }
        }
    }

    @Synchronized
    fun recoverInterrupted(batchId: String, direction: TransferDirection): List<String> {
        val interrupted = items(batchId).filter { it.status == TransferStatus.RUNNING }
        val orphanDestinations = interrupted.mapNotNull { it.resultUri.takeIf(String::isNotBlank) }
        interrupted.forEach { item ->
            if (direction != TransferDirection.DOWNLOAD && item.stage == STAGE_COMPLETING) {
                markItemFailure(
                    batchId,
                    item.index,
                    "通信中断後に保存完了状態を安全に確認できないため、再操作してください。",
                    publishNow = false,
                )
            } else {
                writableDatabase.update(
                    TABLE_ITEMS,
                    ContentValues().apply {
                        put(COLUMN_STATUS, TransferStatus.QUEUED.value)
                        put(COLUMN_STAGE, STAGE_QUEUED)
                        put(COLUMN_RESULT_URI, "")
                    },
                    "$COLUMN_BATCH_ID = ? AND $COLUMN_ITEM_INDEX = ?",
                    arrayOf(batchId, item.index.toString()),
                )
            }
        }
        if (interrupted.isNotEmpty()) updateBatch(batchId, TransferStatus.QUEUED, "", 0)
        publish()
        return orphanDestinations
    }

    @Synchronized
    fun markBatchRunning(batchId: String) = updateBatch(batchId, TransferStatus.RUNNING, "", 0)

    @Synchronized
    fun markItemRunning(batchId: String, index: Int, name: String) {
        updateItem(batchId, index) {
            put(COLUMN_STATUS, TransferStatus.RUNNING.value)
            put(COLUMN_STAGE, STAGE_PREPARING)
            put(COLUMN_ERROR, "")
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
    fun updateProgress(batchId: String, name: String, progress: Int) =
        updateBatch(batchId, TransferStatus.RUNNING, name, progress.coerceIn(0, 100))

    @Synchronized
    fun markItemSuccess(batchId: String, index: Int, resultUri: String = "") {
        updateItem(batchId, index) {
            put(COLUMN_STATUS, TransferStatus.SUCCEEDED.value)
            put(COLUMN_STAGE, STAGE_DONE)
            put(COLUMN_ERROR, "")
            put(COLUMN_RESULT_URI, resultUri)
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
    }

    @Synchronized
    fun cancelBatch(batchId: String) {
        writableDatabase.update(
            TABLE_ITEMS,
            ContentValues().apply {
                put(COLUMN_STATUS, TransferStatus.CANCELLED.value)
                put(COLUMN_STAGE, STAGE_DONE)
                put(COLUMN_ERROR, "中止しました。")
            },
            "$COLUMN_BATCH_ID = ? AND $COLUMN_STATUS IN (?, ?)",
            arrayOf(batchId, TransferStatus.QUEUED.value, TransferStatus.RUNNING.value),
        )
        updateBatch(batchId, TransferStatus.CANCELLED, "", 0)
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
                $COLUMN_UPDATED_AT INTEGER NOT NULL
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
                PRIMARY KEY ($COLUMN_BATCH_ID, $COLUMN_ITEM_INDEX)
            )""".trimIndent(),
        )
        database.execSQL("CREATE INDEX transfer_items_batch_status ON $TABLE_ITEMS ($COLUMN_BATCH_ID, $COLUMN_STATUS)")
    }

    override fun onUpgrade(database: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit

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
                    ),
                )
            }
        }
    }

    private fun publish() {
        mutableBatches.value = readBatches()
    }

    companion object {
        internal const val STAGE_UPLOADING = "uploading"
        internal const val STAGE_COMPLETING = "completing"
        const val DATABASE_NAME = "tcloud_transfers.db"
        const val DATABASE_VERSION = 1
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
        )
    }
}
