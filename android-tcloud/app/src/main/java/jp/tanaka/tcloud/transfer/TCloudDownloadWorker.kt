package jp.tanaka.tcloud.transfer

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ForegroundInfo
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import jp.tanaka.tcloud.R
import jp.tanaka.tcloud.TCloudApplication
import jp.tanaka.tcloud.data.CloudFile
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStream
import kotlin.math.absoluteValue
import kotlin.math.roundToInt

class TCloudDownloadWorker(
    appContext: Context,
    parameters: WorkerParameters,
) : CoroutineWorker(appContext, parameters) {
    private val notificationManager =
        appContext.getSystemService(Service.NOTIFICATION_SERVICE) as NotificationManager

    override suspend fun doWork(): Result {
        val folderId = inputData.getLong(KEY_FOLDER_ID, 0)
        val fileId = inputData.getLong(KEY_FILE_ID, 0)
        if (folderId <= 0 || fileId <= 0) return Result.failure(errorData("ファイル情報が不正です。"))

        createNotificationChannel()
        setForeground(notification("準備しています", 0, indeterminate = true))

        var destination: DownloadDestination? = null
        return try {
            val repository = (applicationContext as TCloudApplication).repository
            val file = repository.loadFileForBackground(folderId, fileId)
            destination = createDestination(file)
            destination.output.use { output ->
                repository.downloadDecryptedFile(file, output) { downloaded, total ->
                    val percent = if (total > 0) ((downloaded * 100.0) / total).roundToInt() else 0
                    setProgress(
                        Data.Builder()
                            .putLong(KEY_DOWNLOADED_BYTES, downloaded)
                            .putLong(KEY_TOTAL_BYTES, total)
                            .putInt(KEY_PROGRESS_PERCENT, percent)
                            .build(),
                    )
                    setForeground(notification("${file.name} を保存中", percent, indeterminate = false))
                }
            }
            destination.finish()
            showCompletion("${file.name} を保存しました")
            val completed = checkNotNull(destination)
            Result.success(Data.Builder().putString(KEY_RESULT_URI, completed.uri.toString()).build())
        } catch (error: Throwable) {
            destination?.delete()
            if (isStopped) {
                showCompletion("ダウンロードを中止しました")
                Result.failure(errorData("中止しました。"))
            } else {
                showCompletion("ダウンロードに失敗しました")
                Result.failure(errorData(error.message ?: "ダウンロードに失敗しました。"))
            }
        }
    }

    private suspend fun createDestination(file: CloudFile): DownloadDestination = withContext(Dispatchers.IO) {
        val safeName = safeFileName(file.name.ifBlank { "T-Cloud-${file.id}" })
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, safeName)
                put(MediaStore.Downloads.MIME_TYPE, file.mimeType)
                put(MediaStore.Downloads.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/T-Cloud")
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            val resolver = applicationContext.contentResolver
            val uri = checkNotNull(
                resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values),
            ) { "保存先を作成できませんでした。" }
            val output = checkNotNull(resolver.openOutputStream(uri, "w")) {
                resolver.delete(uri, null, null)
                "保存先を開けませんでした。"
            }
            DownloadDestination(
                uri = uri,
                output = output,
                finish = {
                    resolver.update(
                        uri,
                        ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) },
                        null,
                        null,
                    )
                },
                delete = { resolver.delete(uri, null, null) },
            )
        } else {
            check(applicationContext.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED) {
                "ファイル保存の権限を許可してください。"
            }
            @Suppress("DEPRECATION")
            val directory = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "T-Cloud")
            check(directory.exists() || directory.mkdirs()) { "保存フォルダを作成できませんでした。" }
            val outputFile = uniqueFile(directory, safeName)
            DownloadDestination(
                uri = Uri.fromFile(outputFile),
                output = FileOutputStream(outputFile),
                finish = {},
                delete = { outputFile.delete() },
            )
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
            .addAction(
                Notification.Action.Builder(
                    null,
                    "中止",
                    cancelIntent,
                ).build(),
            )
            .build()
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ForegroundInfo(notificationId(), notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            ForegroundInfo(notificationId(), notification)
        }
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

    private fun createNotificationChannel() {
        notificationManager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                "T-Cloud 転送",
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply {
                description = "アップロードとダウンロードの進行状況"
                setShowBadge(false)
            },
        )
    }

    private fun errorData(message: String) = Data.Builder().putString(KEY_ERROR, message).build()

    private fun notificationId(): Int = 2_000 + (id.hashCode().absoluteValue % 100_000)

    private fun safeFileName(value: String): String = value
        .replace(Regex("[\\\\/:*?\"<>|\\u0000-\\u001f]"), "_")
        .trim()
        .take(240)
        .ifBlank { "T-Cloud-file" }

    private fun uniqueFile(directory: File, name: String): File {
        val first = File(directory, name)
        if (!first.exists()) return first
        val dot = name.lastIndexOf('.')
        val stem = if (dot > 0) name.substring(0, dot) else name
        val extension = if (dot > 0) name.substring(dot) else ""
        var counter = 1
        while (true) {
            val candidate = File(directory, "$stem ($counter)$extension")
            if (!candidate.exists()) return candidate
            counter += 1
        }
    }

    private data class DownloadDestination(
        val uri: Uri,
        val output: OutputStream,
        val finish: () -> Unit,
        val delete: () -> Unit,
    )

    companion object {
        const val KEY_FOLDER_ID = "folder_id"
        const val KEY_FILE_ID = "file_id"
        const val KEY_FILE_NAME = "file_name"
        const val KEY_DOWNLOADED_BYTES = "downloaded_bytes"
        const val KEY_TOTAL_BYTES = "total_bytes"
        const val KEY_PROGRESS_PERCENT = "progress_percent"
        const val KEY_RESULT_URI = "result_uri"
        const val KEY_ERROR = "error"
        private const val CHANNEL_ID = "tcloud_transfers"
    }
}
