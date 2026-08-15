package jp.tanaka.tcloud.transfer

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import jp.tanaka.tcloud.TCloudApplication

class TCloudTransferCleanupWorker(
    appContext: Context,
    parameters: WorkerParameters,
) : CoroutineWorker(appContext, parameters) {
    override suspend fun doWork(): Result {
        val application = applicationContext as TCloudApplication
        return if (application.transferCancellation.cleanupOrphanedTerminalTickets()) {
            Result.success()
        } else {
            Result.retry()
        }
    }
}
