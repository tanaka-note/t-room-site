package jp.tanaka.tcloud.transfer

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import java.util.UUID
import java.util.concurrent.TimeUnit

class TCloudUploadManager(
    context: Context,
    private val transferStore: TCloudTransferStore,
) {
    private val applicationContext = context.applicationContext
    private val workManager = WorkManager.getInstance(context)

    data class EnqueuedCameraBackup(
        val workId: UUID,
        val itemCount: Int,
    )

    fun enqueue(folderId: Long, uris: List<Uri>): UUID {
        val sources = uris.map { uri -> uri.toString() to displayName(uri) }
        val batchId = transferStore.createUploadBatch(folderId, sources)
        return enqueueBatch(batchId, TAG_UPLOAD, connectedConstraints())
    }

    fun enqueueCameraBackup(
        folderId: Long,
        uri: Uri,
        assetKey: String,
        expectedMediaKind: String,
        wifiOnly: Boolean,
        chargingOnly: Boolean,
    ): UUID? = enqueueCameraBackupBatch(
        items = listOf(
            CameraUploadItem(folderId, uri.toString(), assetKey, expectedMediaKind),
        ),
        wifiOnly = wifiOnly,
        chargingOnly = chargingOnly,
    )?.workId

    fun enqueueCameraBackupBatch(
        items: List<CameraUploadItem>,
        wifiOnly: Boolean,
        chargingOnly: Boolean,
    ): EnqueuedCameraBackup? {
        val batch = transferStore.createCameraBatch(items) ?: return null
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(if (wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED)
            .setRequiresCharging(chargingOnly)
            .build()
        return EnqueuedCameraBackup(
            workId = enqueueBatch(batch.id, TAG_CAMERA_UPLOAD, constraints),
            itemCount = batch.itemCount,
        )
    }

    private fun enqueueBatch(batchId: String, tag: String, constraints: Constraints): UUID {
        val request = OneTimeWorkRequestBuilder<TCloudUploadWorker>()
            .setInputData(Data.Builder().putString(TCloudUploadWorker.KEY_BATCH_ID, batchId).build())
            .setConstraints(constraints)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .addTag(TAG_UPLOAD)
            .addTag(tag)
            .addTag("$TAG_BATCH_PREFIX$batchId")
            .build()
        val completion = OneTimeWorkRequestBuilder<TCloudTransferCompletionWorker>()
            .setInputData(Data.Builder().putString(TCloudTransferCompletionWorker.KEY_BATCH_ID, batchId).build())
            .addTag(tag)
            .addTag("$TAG_BATCH_PREFIX$batchId")
            .build()
        workManager.beginUniqueWork(
            "$UNIQUE_PREFIX$batchId",
            ExistingWorkPolicy.KEEP,
            request,
        )
            .then(completion)
            .enqueue()
        return request.id
    }

    private fun connectedConstraints(): Constraints = Constraints.Builder()
        .setRequiredNetworkType(NetworkType.CONNECTED)
        .build()

    private fun displayName(uri: Uri): String = runCatching {
        applicationContext.contentResolver.query(
            uri,
            arrayOf(OpenableColumns.DISPLAY_NAME),
            null,
            null,
            null,
        )?.use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(0) else null
        }
    }.getOrNull().orEmpty().ifBlank { "T-Cloud-file" }

    companion object {
        const val TAG_UPLOAD = "tcloud_upload"
        const val TAG_CAMERA_UPLOAD = "tcloud_camera_upload"
        const val TAG_BATCH_PREFIX = "tcloud_transfer_batch_"
        private const val UNIQUE_PREFIX = "tcloud_upload_batch_"
    }
}
