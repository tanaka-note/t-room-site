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
    val startedAtMillis: Long = 0,
) {
    val hasTarget: Boolean get() = folderId > 0
}

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
        startedAtMillis = preferences.getLong(KEY_STARTED_AT, 0),
    )

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
                }
            }
            .apply()
        return settings()
    }

    @Synchronized
    fun update(enabled: Boolean, wifiOnly: Boolean, chargingOnly: Boolean): CameraBackupSettings {
        val current = settings()
        require(!enabled || current.hasTarget) { "先にバックアップ先フォルダを設定してください。" }
        preferences.edit()
            .putBoolean(KEY_ENABLED, enabled)
            .putBoolean(KEY_WIFI_ONLY, wifiOnly)
            .putBoolean(KEY_CHARGING_ONLY, chargingOnly)
            .apply {
                if (enabled && current.startedAtMillis <= 0) putLong(KEY_STARTED_AT, System.currentTimeMillis())
            }
            .apply()
        return settings()
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
        writableDatabase.insertWithOnConflict(
            TABLE_COMPLETED,
            null,
            values,
            SQLiteDatabase.CONFLICT_REPLACE,
        )
    }

    override fun onCreate(database: SQLiteDatabase) {
        database.execSQL(
            """CREATE TABLE $TABLE_COMPLETED (
                $COLUMN_ASSET_KEY TEXT PRIMARY KEY NOT NULL,
                $COLUMN_COMPLETED_AT INTEGER NOT NULL
            )""".trimIndent(),
        )
    }

    override fun onUpgrade(database: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit

    private companion object {
        const val DATABASE_NAME = "tcloud_camera_backup.db"
        const val DATABASE_VERSION = 1
        const val TABLE_COMPLETED = "completed_assets"
        const val COLUMN_ASSET_KEY = "asset_key"
        const val COLUMN_COMPLETED_AT = "completed_at"
        const val PREFERENCES = "tcloud_camera_backup_settings"
        const val KEY_ENABLED = "enabled"
        const val KEY_FOLDER_ID = "folder_id"
        const val KEY_FOLDER_NAME = "folder_name"
        const val KEY_WIFI_ONLY = "wifi_only"
        const val KEY_CHARGING_ONLY = "charging_only"
        const val KEY_STARTED_AT = "started_at"
    }
}
