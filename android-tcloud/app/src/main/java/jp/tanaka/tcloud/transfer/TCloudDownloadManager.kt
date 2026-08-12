package jp.tanaka.tcloud.transfer

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import jp.tanaka.tcloud.data.CloudFile
import java.util.UUID
import java.util.concurrent.TimeUnit

class TCloudDownloadManager(context: Context) {
    private val workManager = WorkManager.getInstance(context)

    fun enqueue(file: CloudFile): UUID {
        val request = OneTimeWorkRequestBuilder<TCloudDownloadWorker>()
            .setInputData(
                Data.Builder()
                    .putLong(TCloudDownloadWorker.KEY_FOLDER_ID, file.folderId)
                    .putLong(TCloudDownloadWorker.KEY_FILE_ID, file.id)
                    .putString(TCloudDownloadWorker.KEY_FILE_NAME, file.name)
                    .build(),
            )
            .setConstraints(
                Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build(),
            )
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .addTag(TAG_DOWNLOAD)
            .build()
        workManager.enqueue(request)
        return request.id
    }

    companion object {
        const val TAG_DOWNLOAD = "tcloud_download"
    }
}
