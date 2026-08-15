package jp.tanaka.tcloud.backup

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import jp.tanaka.tcloud.TCloudApplication

/**
 * A durable MediaStore change monitor. Content URI trigger work is one-shot, so each successful
 * delivery appends the next monitor before this worker completes.
 */
class CameraBackupMediaChangeWorker(
    appContext: Context,
    parameters: WorkerParameters,
) : CoroutineWorker(appContext, parameters) {
    override suspend fun doWork(): Result {
        val application = applicationContext as TCloudApplication
        application.cameraBackupManager.handleMediaStoreChange()
        return Result.success()
    }
}
