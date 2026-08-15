package jp.tanaka.tcloud.backup

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

data class CameraBackupSettings(
    val enabled: Boolean = false,
    val folderId: Long = 0,
    val folderName: String = "未設定",
    val wifiOnly: Boolean = true,
    val chargingOnly: Boolean = true,
    val includeImages: Boolean = true,
    val includeVideos: Boolean = true,
    val allSourceFolders: Boolean = true,
    val sourceFolderIds: Set<String> = emptySet(),
    val startedAtMillis: Long = 0,
    val scanDateAddedSeconds: Long = 0,
    val scanMediaId: Long = 0,
    val lastScanAtMillis: Long = 0,
    val lastQueuedCount: Int = 0,
    val lastError: String = "",
    val scanPolicyVersion: Int = 0,
) {
    val hasTarget: Boolean get() = folderId > 0
}

data class CameraBackupBatchProgress(
    val total: Int = 0,
    val completed: Int = 0,
    val failed: Int = 0,
    val pendingAssetKeys: Set<String> = emptySet(),
) {
    val processed: Int get() = completed + failed
    val finished: Boolean get() = total > 0 && pendingAssetKeys.isEmpty()
}

data class FailedCameraAsset(
    val assetKey: String,
    val sourceUri: String,
    val folderId: Long,
)

class CameraBackupStore(context: Context) : SQLiteOpenHelper(
    context,
    DATABASE_NAME,
    null,
    DATABASE_VERSION,
) {
    private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    @Synchronized
    fun settings(): CameraBackupSettings = CameraBackupSettings(
        enabled = preferences.getBoolean(KEY_ENABLED, false),
        folderId = preferences.getLong(KEY_FOLDER_ID, 0),
        folderName = preferences.getString(KEY_FOLDER_NAME, null).orEmpty().ifBlank { "未設定" },
        wifiOnly = preferences.getBoolean(KEY_WIFI_ONLY, true),
        chargingOnly = preferences.getBoolean(KEY_CHARGING_ONLY, true),
        includeImages = preferences.getBoolean(KEY_INCLUDE_IMAGES, true),
        includeVideos = preferences.getBoolean(KEY_INCLUDE_VIDEOS, true),
        allSourceFolders = preferences.getBoolean(KEY_ALL_SOURCE_FOLDERS, true),
        sourceFolderIds = preferences.getStringSet(KEY_SOURCE_FOLDER_IDS, emptySet()).orEmpty().toSet(),
        startedAtMillis = preferences.getLong(KEY_STARTED_AT, 0),
        scanDateAddedSeconds = preferences.getLong(KEY_SCAN_DATE, 0),
        scanMediaId = preferences.getLong(KEY_SCAN_ID, 0),
        lastScanAtMillis = preferences.getLong(KEY_LAST_SCAN_AT, 0),
        lastQueuedCount = preferences.getInt(KEY_LAST_QUEUED, 0),
        lastError = preferences.getString(KEY_LAST_ERROR, "").orEmpty(),
        scanPolicyVersion = preferences.getInt(KEY_SCAN_POLICY_VERSION, 0),
    )

    /** v1.0.0 scans existing media once without discarding completed asset history. */
    @Synchronized
    fun applyCurrentScanPolicy(): CameraBackupSettings {
        val current = settings()
        if (current.scanPolicyVersion >= CURRENT_SCAN_POLICY_VERSION) return current
        preferences.edit()
            .putInt(KEY_SCAN_POLICY_VERSION, CURRENT_SCAN_POLICY_VERSION)
            .also(::resetCursor)
            .apply()
        resetBatch()
        return settings()
    }

    @Synchronized
    fun requestFullRescan() {
        preferences.edit().also(::resetCursor).apply()
        resetBatch()
    }

    @Synchronized
    fun setTarget(folderId: Long, folderName: String): CameraBackupSettings {
        require(folderId > 0 && folderName.isNotBlank())
        val current = settings()
        val targetChanged = current.folderId != folderId
        preferences.edit()
            .putLong(KEY_FOLDER_ID, folderId)
            .putString(KEY_FOLDER_NAME, folderName)
            .apply {
                if (targetChanged) {
                    putLong(KEY_STARTED_AT, if (current.enabled) System.currentTimeMillis() else 0)
                    resetCursor(this)
                }
            }
            .apply()
        if (targetChanged) {
            writableDatabase.delete(TABLE_FAILED, null, null)
            resetBatch()
        }
        return settings()
    }

    @Synchronized
    fun update(
        enabled: Boolean,
        wifiOnly: Boolean,
        chargingOnly: Boolean,
        includeImages: Boolean,
        includeVideos: Boolean,
        allSourceFolders: Boolean,
        sourceFolderIds: Set<String>,
    ): CameraBackupSettings {
        val current = settings()
        require(!enabled || current.hasTarget) { "先にバックアップ先フォルダを設定してください。" }
        require(!enabled || includeImages || includeVideos) { "写真または動画を1つ以上選択してください。" }
        require(!enabled || allSourceFolders || sourceFolderIds.isNotEmpty()) {
            "バックアップする端末フォルダを1つ以上選択してください。"
        }
        val normalizedSourceFolderIds = sourceFolderIds.filter(String::isNotBlank).toSet()
        val mediaSelectionChanged = current.includeImages != includeImages ||
            current.includeVideos != includeVideos ||
            current.allSourceFolders != allSourceFolders ||
            current.sourceFolderIds != normalizedSourceFolderIds
        preferences.edit()
            .putBoolean(KEY_ENABLED, enabled)
            .putBoolean(KEY_WIFI_ONLY, wifiOnly)
            .putBoolean(KEY_CHARGING_ONLY, chargingOnly)
            .putBoolean(KEY_INCLUDE_IMAGES, includeImages)
            .putBoolean(KEY_INCLUDE_VIDEOS, includeVideos)
            .putBoolean(KEY_ALL_SOURCE_FOLDERS, allSourceFolders)
            .putStringSet(KEY_SOURCE_FOLDER_IDS, normalizedSourceFolderIds)
            .apply {
                if (enabled && current.startedAtMillis <= 0) {
                    putLong(KEY_STARTED_AT, System.currentTimeMillis())
                    resetCursor(this)
                } else if (!enabled && current.enabled) {
                    // 中止された未完了データを、次回有効化時に完了履歴と照合し直す。
                    resetCursor(this)
                } else if (mediaSelectionChanged) {
                    resetCursor(this)
                }
            }
            .apply()
        if (!enabled || mediaSelectionChanged) {
            writableDatabase.delete(TABLE_FAILED, null, null)
            resetBatch()
        }
        return settings()
    }

    @Synchronized
    fun beginBatch(assetKeys: Collection<String>): CameraBackupBatchProgress {
        val unique = assetKeys.filter(String::isNotBlank).toSet()
        if (unique.isEmpty()) return batchProgress()
        val current = batchProgress()
        val base = if (current.pendingAssetKeys.isEmpty()) CameraBackupBatchProgress() else current
        val added = unique - base.pendingAssetKeys
        val updated = base.copy(
            total = base.total + added.size,
            pendingAssetKeys = base.pendingAssetKeys + added,
        )
        saveBatch(updated)
        return updated
    }

    @Synchronized
    fun finishBatchAsset(assetKey: String, failed: Boolean): CameraBackupBatchProgress {
        val current = batchProgress()
        if (assetKey !in current.pendingAssetKeys) return current
        val updated = current.copy(
            completed = current.completed + if (failed) 0 else 1,
            failed = current.failed + if (failed) 1 else 0,
            pendingAssetKeys = current.pendingAssetKeys - assetKey,
        )
        saveBatch(updated)
        return updated
    }

    @Synchronized
    fun batchProgress(): CameraBackupBatchProgress = CameraBackupBatchProgress(
        total = preferences.getInt(KEY_BATCH_TOTAL, 0),
        completed = preferences.getInt(KEY_BATCH_COMPLETED, 0),
        failed = preferences.getInt(KEY_BATCH_FAILED, 0),
        pendingAssetKeys = preferences.getStringSet(KEY_BATCH_PENDING, emptySet()).orEmpty().toSet(),
    )

    @Synchronized
    fun resetBatch() {
        preferences.edit()
            .remove(KEY_BATCH_TOTAL)
            .remove(KEY_BATCH_COMPLETED)
            .remove(KEY_BATCH_FAILED)
            .remove(KEY_BATCH_PENDING)
            .apply()
    }

    fun discardFailed(assetKey: String) {
        writableDatabase.delete(TABLE_FAILED, "$COLUMN_ASSET_KEY = ?", arrayOf(assetKey))
    }

    @Synchronized
    fun advanceScanCursor(dateAddedSeconds: Long, mediaId: Long) {
        preferences.edit()
            .putLong(KEY_SCAN_DATE, dateAddedSeconds)
            .putLong(KEY_SCAN_ID, mediaId)
            .apply()
    }

    @Synchronized
    fun recordScan(queuedCount: Int, error: String = "") {
        preferences.edit()
            .putLong(KEY_LAST_SCAN_AT, System.currentTimeMillis())
            .putInt(KEY_LAST_QUEUED, queuedCount.coerceAtLeast(0))
            .putString(KEY_LAST_ERROR, error)
            .apply()
    }

    fun isCompleted(assetKey: String): Boolean = readableDatabase.query(
        TABLE_COMPLETED,
        arrayOf(COLUMN_ASSET_KEY),
        "$COLUMN_ASSET_KEY = ?",
        arrayOf(assetKey),
        null,
        null,
        null,
        "1",
    ).use { it.moveToFirst() }

    fun markCompleted(assetKey: String) {
        val values = ContentValues().apply {
            put(COLUMN_ASSET_KEY, assetKey)
            put(COLUMN_COMPLETED_AT, System.currentTimeMillis())
        }
        writableDatabase.insertWithOnConflict(TABLE_COMPLETED, null, values, SQLiteDatabase.CONFLICT_REPLACE)
        writableDatabase.delete(TABLE_FAILED, "$COLUMN_ASSET_KEY = ?", arrayOf(assetKey))
    }

    fun markFailed(assetKey: String, sourceUri: String, folderId: Long, error: String) {
        val values = ContentValues().apply {
            put(COLUMN_ASSET_KEY, assetKey)
            put(COLUMN_SOURCE_URI, sourceUri)
            put(COLUMN_FOLDER_ID, folderId)
            put(COLUMN_ERROR, error.take(500))
            put(COLUMN_FAILED_AT, System.currentTimeMillis())
        }
        writableDatabase.insertWithOnConflict(TABLE_FAILED, null, values, SQLiteDatabase.CONFLICT_REPLACE)
    }

    fun failedAssets(folderId: Long, limit: Int = 25): List<FailedCameraAsset> = readableDatabase.query(
        TABLE_FAILED,
        arrayOf(COLUMN_ASSET_KEY, COLUMN_SOURCE_URI, COLUMN_FOLDER_ID),
        "$COLUMN_FOLDER_ID = ?",
        arrayOf(folderId.toString()),
        null,
        null,
        "$COLUMN_FAILED_AT ASC",
        limit.coerceIn(1, 100).toString(),
    ).use { cursor ->
        buildList {
            while (cursor.moveToNext()) {
                add(FailedCameraAsset(cursor.getString(0), cursor.getString(1), cursor.getLong(2)))
            }
        }
    }

    override fun onCreate(database: SQLiteDatabase) {
        database.execSQL(
            """CREATE TABLE $TABLE_COMPLETED (
                $COLUMN_ASSET_KEY TEXT PRIMARY KEY NOT NULL,
                $COLUMN_COMPLETED_AT INTEGER NOT NULL
            )""".trimIndent(),
        )
        createFailedTable(database)
    }

    override fun onUpgrade(database: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        if (oldVersion < 2) createFailedTable(database)
    }

    private fun createFailedTable(database: SQLiteDatabase) {
        database.execSQL(
            """CREATE TABLE IF NOT EXISTS $TABLE_FAILED (
                $COLUMN_ASSET_KEY TEXT PRIMARY KEY NOT NULL,
                $COLUMN_SOURCE_URI TEXT NOT NULL,
                $COLUMN_FOLDER_ID INTEGER NOT NULL,
                $COLUMN_ERROR TEXT NOT NULL,
                $COLUMN_FAILED_AT INTEGER NOT NULL
            )""".trimIndent(),
        )
    }

    private fun resetCursor(editor: android.content.SharedPreferences.Editor) {
        editor.putLong(KEY_SCAN_DATE, 0)
            .putLong(KEY_SCAN_ID, 0)
            .putLong(KEY_LAST_SCAN_AT, 0)
            .putInt(KEY_LAST_QUEUED, 0)
            .putString(KEY_LAST_ERROR, "")
    }

    private fun saveBatch(progress: CameraBackupBatchProgress) {
        preferences.edit()
            .putInt(KEY_BATCH_TOTAL, progress.total)
            .putInt(KEY_BATCH_COMPLETED, progress.completed)
            .putInt(KEY_BATCH_FAILED, progress.failed)
            .putStringSet(KEY_BATCH_PENDING, progress.pendingAssetKeys)
            .apply()
    }

    private companion object {
        const val DATABASE_NAME = "tcloud_camera_backup.db"
        const val DATABASE_VERSION = 2
        const val CURRENT_SCAN_POLICY_VERSION = 1
        const val TABLE_COMPLETED = "completed_assets"
        const val TABLE_FAILED = "failed_assets"
        const val COLUMN_ASSET_KEY = "asset_key"
        const val COLUMN_COMPLETED_AT = "completed_at"
        const val COLUMN_SOURCE_URI = "source_uri"
        const val COLUMN_FOLDER_ID = "folder_id"
        const val COLUMN_ERROR = "error"
        const val COLUMN_FAILED_AT = "failed_at"
        const val PREFERENCES = "tcloud_camera_backup_settings"
        const val KEY_ENABLED = "enabled"
        const val KEY_FOLDER_ID = "folder_id"
        const val KEY_FOLDER_NAME = "folder_name"
        const val KEY_WIFI_ONLY = "wifi_only"
        const val KEY_CHARGING_ONLY = "charging_only"
        const val KEY_INCLUDE_IMAGES = "include_images"
        const val KEY_INCLUDE_VIDEOS = "include_videos"
        const val KEY_ALL_SOURCE_FOLDERS = "all_source_folders"
        const val KEY_SOURCE_FOLDER_IDS = "source_folder_ids"
        const val KEY_STARTED_AT = "started_at"
        const val KEY_SCAN_DATE = "scan_date_added_seconds"
        const val KEY_SCAN_ID = "scan_media_id"
        const val KEY_LAST_SCAN_AT = "last_scan_at"
        const val KEY_LAST_QUEUED = "last_queued_count"
        const val KEY_LAST_ERROR = "last_error"
        const val KEY_BATCH_TOTAL = "batch_total"
        const val KEY_BATCH_COMPLETED = "batch_completed"
        const val KEY_BATCH_FAILED = "batch_failed"
        const val KEY_BATCH_PENDING = "batch_pending"
        const val KEY_SCAN_POLICY_VERSION = "scan_policy_version"
    }
}
