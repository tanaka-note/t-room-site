package jp.tanaka.tcloud.backup

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.provider.MediaStore
import androidx.core.content.ContextCompat
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import jp.tanaka.tcloud.TCloudApplication
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class CameraBackupScanWorker(
    appContext: Context,
    parameters: WorkerParameters,
) : CoroutineWorker(appContext, parameters) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val application = applicationContext as TCloudApplication
        val settings = application.cameraBackupStore.settings()
        if (!settings.enabled || !settings.hasTarget) return@withContext Result.success()

        val mediaTypes = permittedMediaTypes()
        if (mediaTypes.isEmpty()) return@withContext Result.success()
        return@withContext runCatching {
            val collection = MediaStore.Files.getContentUri("external")
            val projection = arrayOf(
                MediaStore.Files.FileColumns._ID,
                MediaStore.Files.FileColumns.MEDIA_TYPE,
                MediaStore.Files.FileColumns.SIZE,
                MediaStore.Files.FileColumns.DATE_MODIFIED,
            )
            val typePlaceholders = mediaTypes.joinToString(",") { "?" }
            val selection = "${MediaStore.Files.FileColumns.MEDIA_TYPE} IN ($typePlaceholders) AND " +
                "${MediaStore.Files.FileColumns.DATE_ADDED} >= ? AND " +
                "${MediaStore.Files.FileColumns.SIZE} > 0"
            val arguments = (mediaTypes.map(Int::toString) +
                (settings.startedAtMillis / 1000).toString()).toTypedArray()
            val order = "${MediaStore.Files.FileColumns.DATE_ADDED} ASC"
            applicationContext.contentResolver.query(
                collection,
                projection,
                selection,
                arguments,
                order,
            )?.use { cursor ->
                val idIndex = cursor.getColumnIndexOrThrow(MediaStore.Files.FileColumns._ID)
                val typeIndex = cursor.getColumnIndexOrThrow(MediaStore.Files.FileColumns.MEDIA_TYPE)
                val sizeIndex = cursor.getColumnIndexOrThrow(MediaStore.Files.FileColumns.SIZE)
                val modifiedIndex = cursor.getColumnIndexOrThrow(MediaStore.Files.FileColumns.DATE_MODIFIED)
                var scanned = 0
                while (cursor.moveToNext() && scanned < MAX_SCAN_ITEMS) {
                    scanned += 1
                    val id = cursor.getLong(idIndex)
                    val type = cursor.getInt(typeIndex)
                    val size = cursor.getLong(sizeIndex)
                    val modified = cursor.getLong(modifiedIndex)
                    // 同じ端末データでも保存先が変われば、新しいフォルダへ改めて保存する。
                    val assetKey = "${settings.folderId}:$type:$id:$modified:$size"
                    if (!application.cameraBackupStore.isCompleted(assetKey)) {
                        val uri = ContentUris.withAppendedId(collection, id)
                        application.uploadManager.enqueueCameraBackup(
                            folderId = settings.folderId,
                            uri = uri,
                            assetKey = assetKey,
                            wifiOnly = settings.wifiOnly,
                            chargingOnly = settings.chargingOnly,
                        )
                    }
                }
            }
            Result.success()
        }.getOrElse { Result.retry() }
    }

    private fun permittedMediaTypes(): List<Int> {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            val allowed = ContextCompat.checkSelfPermission(
                applicationContext,
                Manifest.permission.READ_EXTERNAL_STORAGE,
            ) == PackageManager.PERMISSION_GRANTED
            return if (allowed) listOf(MEDIA_IMAGE, MEDIA_VIDEO) else emptyList()
        }
        val result = mutableListOf<Int>()
        if (ContextCompat.checkSelfPermission(applicationContext, Manifest.permission.READ_MEDIA_IMAGES) ==
            PackageManager.PERMISSION_GRANTED
        ) result += MEDIA_IMAGE
        if (ContextCompat.checkSelfPermission(applicationContext, Manifest.permission.READ_MEDIA_VIDEO) ==
            PackageManager.PERMISSION_GRANTED
        ) result += MEDIA_VIDEO
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE && result.isEmpty() &&
            ContextCompat.checkSelfPermission(
                applicationContext,
                Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED,
            ) == PackageManager.PERMISSION_GRANTED
        ) {
            result += listOf(MEDIA_IMAGE, MEDIA_VIDEO)
        }
        return result.distinct()
    }

    private companion object {
        const val MEDIA_IMAGE = MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE
        const val MEDIA_VIDEO = MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO
        const val MAX_SCAN_ITEMS = 250
    }
}
