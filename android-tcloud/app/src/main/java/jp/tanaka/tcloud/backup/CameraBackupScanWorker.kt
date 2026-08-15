package jp.tanaka.tcloud.backup

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import androidx.core.content.ContextCompat
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import jp.tanaka.tcloud.TCloudApplication
import jp.tanaka.tcloud.transfer.CameraUploadItem
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class CameraBackupScanWorker(
    appContext: Context,
    parameters: WorkerParameters,
) : CoroutineWorker(appContext, parameters) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val application = applicationContext as TCloudApplication
        val store = application.cameraBackupStore
        val settings = store.settings()
        if (!settings.enabled || !settings.hasTarget) return@withContext Result.success()

        val mediaAccess = permittedMediaAccess(settings)
        val mediaTypes = mediaAccess.mediaTypes
        if (mediaTypes.isEmpty()) {
            store.recordScan(0, "写真・動画へのアクセスが許可されていません。")
            return@withContext Result.success()
        }
        return@withContext runCatching {
            var queued = 0
            val queuedItems = mutableListOf<QueuedCameraAsset>()
            store.failedAssets(settings.folderId).forEach { failed ->
                val mediaType = failed.assetKey.split(':').getOrNull(1)?.toIntOrNull()
                val kind = mediaType?.let {
                    expectedKindForType(it, settings.includeImages, settings.includeVideos)
                }
                if (kind == null) {
                    store.discardFailed(failed.assetKey)
                    return@forEach
                }
                queuedItems += QueuedCameraAsset(failed.folderId, Uri.parse(failed.sourceUri), failed.assetKey, kind)
            }

            val collection = MediaStore.Files.getContentUri("external")
            val projection = arrayOf(
                MediaStore.Files.FileColumns._ID,
                MediaStore.Files.FileColumns.MEDIA_TYPE,
                MediaStore.Files.FileColumns.MIME_TYPE,
                MediaStore.Files.FileColumns.SIZE,
                MediaStore.Files.FileColumns.DATE_MODIFIED,
                MediaStore.Files.FileColumns.DATE_ADDED,
                MediaStore.Files.FileColumns.BUCKET_ID,
            )
            val typePlaceholders = mediaTypes.joinToString(",") { "?" }
            val selectionParts = mutableListOf(
                "${MediaStore.Files.FileColumns.MEDIA_TYPE} IN ($typePlaceholders)",
                "${MediaStore.Files.FileColumns.SIZE} > 0",
            )
            val arguments = mediaTypes.map(Int::toString).toMutableList().apply {
                if (settings.scanDateAddedSeconds > 0 || settings.scanMediaId > 0) {
                    selectionParts += "(${MediaStore.Files.FileColumns.DATE_ADDED} > ? OR " +
                        "(${MediaStore.Files.FileColumns.DATE_ADDED} = ? AND " +
                        "${MediaStore.Files.FileColumns._ID} > ?))"
                    add(settings.scanDateAddedSeconds.toString())
                    add(settings.scanDateAddedSeconds.toString())
                    add(settings.scanMediaId.toString())
                }
            }.toTypedArray()
            val mutableArguments = arguments.toMutableList()
            if (!settings.allSourceFolders) {
                if (settings.sourceFolderIds.isEmpty()) {
                    store.recordScan(0, "バックアップする端末フォルダを選択してください。")
                    return@withContext Result.success()
                }
                val sourceFilter = cameraSourceFolderFilter(false, settings.sourceFolderIds)
                sourceFilter.sql?.let(selectionParts::add)
                mutableArguments += sourceFilter.arguments
            }
            val order = "${MediaStore.Files.FileColumns.DATE_ADDED} ASC, " +
                "${MediaStore.Files.FileColumns._ID} ASC"
            val assets = mutableListOf<CameraMediaAsset>()
            applicationContext.contentResolver.query(
                collection,
                projection,
                selectionParts.joinToString(" AND "),
                mutableArguments.toTypedArray(),
                order,
            )?.use { cursor ->
                val idIndex = cursor.getColumnIndexOrThrow(MediaStore.Files.FileColumns._ID)
                val typeIndex = cursor.getColumnIndexOrThrow(MediaStore.Files.FileColumns.MEDIA_TYPE)
                val mimeIndex = cursor.getColumnIndexOrThrow(MediaStore.Files.FileColumns.MIME_TYPE)
                val sizeIndex = cursor.getColumnIndexOrThrow(MediaStore.Files.FileColumns.SIZE)
                val modifiedIndex = cursor.getColumnIndexOrThrow(MediaStore.Files.FileColumns.DATE_MODIFIED)
                val addedIndex = cursor.getColumnIndexOrThrow(MediaStore.Files.FileColumns.DATE_ADDED)
                while (cursor.moveToNext() && assets.size < MAX_SCAN_ITEMS) {
                    val id = cursor.getLong(idIndex)
                    val mediaType = cursor.getInt(typeIndex)
                    val mimeType = cursor.getString(mimeIndex).orEmpty()
                    if (cameraMediaKind(
                            mediaType,
                            mimeType,
                            settings.includeImages,
                            settings.includeVideos,
                        ) == null
                    ) continue
                    assets += CameraMediaAsset(
                        id = id,
                        mediaType = mediaType,
                        sizeBytes = cursor.getLong(sizeIndex),
                        modifiedSeconds = cursor.getLong(modifiedIndex),
                        dateAddedSeconds = cursor.getLong(addedIndex),
                        uri = ContentUris.withAppendedId(collection, id).toString(),
                    )
                }
            }
            val completed = assets.mapNotNull { asset ->
                val key = "${settings.folderId}:${asset.mediaType}:${asset.id}:" +
                    "${asset.modifiedSeconds}:${asset.sizeBytes}"
                key.takeIf(store::isCompleted)
            }.toSet()
            val plan = planCameraBackup(settings.folderId, assets, completed, MAX_SCAN_ITEMS)
            plan.pending.forEach { (assetKey, asset) ->
                val kind = expectedKindForType(asset.mediaType, settings.includeImages, settings.includeVideos)
                    ?: return@forEach
                queuedItems += QueuedCameraAsset(settings.folderId, Uri.parse(asset.uri), assetKey, kind)
            }
            store.beginBatch(queuedItems.map { it.assetKey })
            if (queuedItems.isNotEmpty()) {
                val enqueued = application.uploadManager.enqueueCameraBackupBatch(
                    items = queuedItems.map { item ->
                        CameraUploadItem(
                            folderId = item.folderId,
                            sourceUri = item.uri.toString(),
                            assetKey = item.assetKey,
                            expectedMediaKind = item.expectedMediaKind,
                        )
                    },
                    wifiOnly = settings.wifiOnly,
                    chargingOnly = settings.chargingOnly,
                )
                queued = enqueued?.itemCount ?: 0
            }
            if (plan.cursorMediaId > 0) {
                store.advanceScanCursor(plan.cursorDateAddedSeconds, plan.cursorMediaId)
            }
            store.recordScan(
                queued,
                if (mediaAccess.limited) "選択された写真・動画のみバックアップ対象です。" else "",
            )
            if (plan.reachedBatchLimit) application.cameraBackupManager.enqueueContinuation(store.settings())
            Result.success()
        }.getOrElse { error ->
            store.recordScan(0, error.message ?: "カメラロールを確認できませんでした。")
            Result.retry()
        }
    }

    private fun permittedMediaAccess(settings: CameraBackupSettings): CameraMediaAccess {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            val allowed = ContextCompat.checkSelfPermission(
                applicationContext,
                Manifest.permission.READ_EXTERNAL_STORAGE,
            ) == PackageManager.PERMISSION_GRANTED
            return CameraMediaAccess(
                mediaTypes = if (allowed) selectedMediaTypes(settings) else emptyList(),
                limited = false,
            )
        }
        val result = mutableListOf<Int>()
        if (ContextCompat.checkSelfPermission(applicationContext, Manifest.permission.READ_MEDIA_IMAGES) ==
            PackageManager.PERMISSION_GRANTED
        ) if (settings.includeImages) result += MEDIA_IMAGE
        if (ContextCompat.checkSelfPermission(applicationContext, Manifest.permission.READ_MEDIA_VIDEO) ==
            PackageManager.PERMISSION_GRANTED
        ) if (settings.includeVideos) result += MEDIA_VIDEO
        val selectedTypes = selectedMediaTypes(settings)
        val selectedAccessGranted = Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE &&
            ContextCompat.checkSelfPermission(
                applicationContext,
                Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED,
            ) == PackageManager.PERMISSION_GRANTED
        val limited = selectedTypes.any { it !in result }
        if (selectedAccessGranted) {
            selectedTypes.forEach { type ->
                if (type !in result) result += type
            }
        }
        return CameraMediaAccess(result.distinct(), limited)
    }

    private fun selectedMediaTypes(settings: CameraBackupSettings) = buildList {
        if (settings.includeImages) add(MEDIA_IMAGE)
        if (settings.includeVideos) add(MEDIA_VIDEO)
    }

    private fun expectedKindForType(mediaType: Int, includeImages: Boolean, includeVideos: Boolean): String? = when {
        includeImages && mediaType == MEDIA_IMAGE -> "image"
        includeVideos && mediaType == MEDIA_VIDEO -> "video"
        else -> null
    }

    private data class QueuedCameraAsset(
        val folderId: Long,
        val uri: Uri,
        val assetKey: String,
        val expectedMediaKind: String,
    )

    private data class CameraMediaAccess(
        val mediaTypes: List<Int>,
        val limited: Boolean,
    )

    private companion object {
        const val MEDIA_IMAGE = MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE
        const val MEDIA_VIDEO = MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO
        const val MAX_SCAN_ITEMS = 250
    }
}
