package jp.tanaka.tcloud.transfer

import android.content.Context
import android.net.Uri
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import java.util.UUID
import java.util.concurrent.TimeUnit

class TCloudUploadManager(context: Context) {
    private val workManager = WorkManager.getInstance(context)

    fun enqueue(folderId: Long, uris: List<Uri>): List<UUID> = uris.map { uri ->
        val request = OneTimeWorkRequestBuilder<TCloudUploadWorker>()
            .setInputData(
                Data.Builder()
                    .putLong(TCloudUploadWorker.KEY_FOLDER_ID, folderId)
                    .putString(TCloudUploadWorker.KEY_SOURCE_URI, uri.toString())
                    .build(),
            )
            .setConstraints(
                Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build(),
            )
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .addTag(TAG_UPLOAD)
            .build()
            .also(workManager::enqueue)
        request.id
    }

    fun enqueueCameraBackup(
        folderId: Long,
        uri: Uri,
        assetKey: String,
        wifiOnly: Boolean,
        chargingOnly: Boolean,
    ): UUID {
        val request = OneTimeWorkRequestBuilder<TCloudUploadWorker>()
            .setInputData(
                Data.Builder()
                    .putLong(TCloudUploadWorker.KEY_FOLDER_ID, folderId)
                    .putString(TCloudUploadWorker.KEY_SOURCE_URI, uri.toString())
                    .putString(TCloudUploadWorker.KEY_CAMERA_ASSET_KEY, assetKey)
                    .build(),
            )
            .setConstraints(
                Constraints.Builder()
                    .setRequiredNetworkType(if (wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED)
                    .setRequiresCharging(chargingOnly)
                    .build(),
            )
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .addTag(TAG_UPLOAD)
            .addTag(TAG_CAMERA_UPLOAD)
            .build()
        workManager.enqueueUniqueWork(
            "$CAMERA_UNIQUE_PREFIX$assetKey",
            ExistingWorkPolicy.KEEP,
            request,
        )
        return request.id
    }

    companion object {
        const val TAG_UPLOAD = "tcloud_upload"
        const val TAG_CAMERA_UPLOAD = "tcloud_camera_upload"
        private const val CAMERA_UNIQUE_PREFIX = "tcloud_camera_asset_"
    }
}
