package jp.tanaka.tcloud.offline

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import jp.tanaka.tcloud.data.CloudFile
import java.util.UUID
import java.util.concurrent.TimeUnit

class TCloudOfflineManager(context: Context) {
    private val workManager = WorkManager.getInstance(context)

    fun enqueue(file: CloudFile): UUID {
        val request = OneTimeWorkRequestBuilder<TCloudOfflineWorker>()
            .setInputData(
                Data.Builder()
                    .putLong(TCloudOfflineWorker.KEY_FOLDER_ID, file.folderId)
                    .putLong(TCloudOfflineWorker.KEY_FILE_ID, file.id)
                    .build(),
            )
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .addTag(TAG_OFFLINE)
            .build()
        workManager.enqueueUniqueWork("$UNIQUE_PREFIX${file.id}", ExistingWorkPolicy.KEEP, request)
        return request.id
    }

    companion object {
        const val TAG_OFFLINE = "tcloud_offline"
        private const val UNIQUE_PREFIX = "tcloud_offline_file_"
    }
}
