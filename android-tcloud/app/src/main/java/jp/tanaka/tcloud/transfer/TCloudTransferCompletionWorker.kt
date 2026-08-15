package jp.tanaka.tcloud.transfer

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import jp.tanaka.tcloud.TCloudApplication

class TCloudTransferCompletionWorker(
    appContext: Context,
    parameters: WorkerParameters,
) : CoroutineWorker(appContext, parameters) {
    override suspend fun doWork(): Result {
        val batchId = inputData.getString(KEY_BATCH_ID).orEmpty()
        if (batchId.isBlank()) return Result.failure()
        val application = applicationContext as TCloudApplication
        val batch = application.transferStore.batch(batchId) ?: return Result.failure()
        TCloudTransferNotifications(applicationContext).showFinal(batch)
        return Result.success()
    }

    companion object {
        const val KEY_BATCH_ID = "batch_id"
    }
}
