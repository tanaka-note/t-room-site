package jp.tanaka.tcloud.offline

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ForegroundInfo
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import jp.tanaka.tcloud.R
import jp.tanaka.tcloud.TCloudApplication
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlin.math.absoluteValue
import kotlin.math.roundToInt

class TCloudOfflineWorker(
    appContext: Context,
    parameters: WorkerParameters,
) : CoroutineWorker(appContext, parameters) {
    private val application = appContext as TCloudApplication
    private val notificationManager =
        appContext.getSystemService(Service.NOTIFICATION_SERVICE) as NotificationManager

    override suspend fun doWork(): Result {
        val folderId = inputData.getLong(KEY_FOLDER_ID, 0)
        val fileId = inputData.getLong(KEY_FILE_ID, 0)
        if (folderId <= 0 || fileId <= 0) return Result.failure(errorData("ファイル情報が不正です。"))

        createNotificationChannel()
        setForeground(notification("端末保存を準備しています", 0, indeterminate = true))
        return try {
            val file = application.repository.loadFileForBackground(folderId, fileId)
            application.offlineStore.prepare(file)
            if (application.offlineStore.isComplete(file)) {
                showCompletion("${file.name} は端末に保存済みです")
                return Result.success()
            }
            var completedPlainBytes = 0L
            for (index in 0 until file.chunkCount) {
                currentCoroutineContext().ensureActive()
                val plainSize = minOf(
                    file.chunkSizeBytes,
                    file.sizeBytes - index * file.chunkSizeBytes,
                )
                if (!application.offlineStore.hasEncryptedChunk(file, index)) {
                    val envelope = application.repository.downloadEncryptedChunk(file, index)
                    try {
                        application.offlineStore.writeEncryptedChunk(file, index, envelope)
                    } finally {
                        envelope.fill(0)
                    }
                }
                completedPlainBytes += plainSize
                val percent = ((completedPlainBytes * 100.0) / file.sizeBytes).roundToInt()
                setProgress(
                    Data.Builder()
                        .putLong(KEY_SAVED_BYTES, completedPlainBytes)
                        .putLong(KEY_TOTAL_BYTES, file.sizeBytes)
                        .putInt(KEY_PROGRESS_PERCENT, percent)
                        .build(),
                )
                setForeground(notification("${file.name} を暗号化保存中", percent, indeterminate = false))
            }
            application.offlineStore.finish(file)
            showCompletion("${file.name} を端末へ暗号化保存しました")
            Result.success()
        } catch (error: Throwable) {
            if (isStopped) {
                showCompletion("端末保存を中止しました")
                Result.failure(errorData("中止しました。"))
            } else {
                showCompletion("端末保存に失敗しました")
                Result.failure(errorData(error.message ?: "端末保存に失敗しました。"))
            }
        }
    }

    private fun notification(text: String, progress: Int, indeterminate: Boolean): ForegroundInfo {
        val cancelIntent = WorkManager.getInstance(applicationContext).createCancelPendingIntent(id)
        val notification = Notification.Builder(applicationContext, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_cloud_download)
            .setContentTitle("T-Cloud")
            .setContentText(text)
            .setOnlyAlertOnce(true)
            .setOngoing(true)
            .setProgress(100, progress.coerceIn(0, 100), indeterminate)
            .addAction(Notification.Action.Builder(null, "中止", cancelIntent).build())
            .build()
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ForegroundInfo(notificationId(), notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            ForegroundInfo(notificationId(), notification)
        }
    }

    private fun createNotificationChannel() {
        notificationManager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "T-Cloud 転送", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "アップロード、ダウンロード、端末保存の進行状況"
                setShowBadge(false)
            },
        )
    }

    private fun showCompletion(text: String) {
        notificationManager.notify(
            notificationId() + 1,
            Notification.Builder(applicationContext, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_cloud_download)
                .setContentTitle("T-Cloud")
                .setContentText(text)
                .setAutoCancel(true)
                .build(),
        )
    }

    private fun notificationId(): Int = 202_000 + (id.hashCode().absoluteValue % 100_000)

    private fun errorData(message: String) = Data.Builder().putString(KEY_ERROR, message).build()

    companion object {
        const val KEY_FOLDER_ID = "folder_id"
        const val KEY_FILE_ID = "file_id"
        const val KEY_SAVED_BYTES = "saved_bytes"
        const val KEY_TOTAL_BYTES = "total_bytes"
        const val KEY_PROGRESS_PERCENT = "progress_percent"
        const val KEY_ERROR = "error"
        private const val CHANNEL_ID = "tcloud_transfers"
    }
}
