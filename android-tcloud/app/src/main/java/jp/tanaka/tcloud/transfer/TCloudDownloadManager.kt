package jp.tanaka.tcloud.transfer

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.ExistingWorkPolicy
import androidx.work.WorkManager
import jp.tanaka.tcloud.data.CloudFile
import java.util.UUID
import java.util.concurrent.TimeUnit

class TCloudDownloadManager(
    context: Context,
    private val transferStore: TCloudTransferStore,
) {
    private val workManager = WorkManager.getInstance(context)

    fun enqueue(file: CloudFile): UUID = enqueue(listOf(file))

    fun enqueue(files: List<CloudFile>): UUID {
        val batchId = transferStore.createDownloadBatch(files)
        val request = OneTimeWorkRequestBuilder<TCloudDownloadWorker>()
            .setInputData(
                Data.Builder()
                    .putString(TCloudDownloadWorker.KEY_BATCH_ID, batchId)
                    .build(),
            )
            .setConstraints(
                Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build(),
            )
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .addTag(TAG_DOWNLOAD)
            .addTag("${TCloudUploadManager.TAG_BATCH_PREFIX}$batchId")
            .build()
        val completion = OneTimeWorkRequestBuilder<TCloudTransferCompletionWorker>()
            .setInputData(Data.Builder().putString(TCloudTransferCompletionWorker.KEY_BATCH_ID, batchId).build())
            .addTag(TAG_DOWNLOAD)
            .addTag("${TCloudUploadManager.TAG_BATCH_PREFIX}$batchId")
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

    companion object {
        const val TAG_DOWNLOAD = "tcloud_download"
        private const val UNIQUE_PREFIX = "tcloud_download_batch_"
    }
}
