package jp.tanaka.tcloud.transfer

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.pm.ServiceInfo
import android.database.Cursor
import android.net.Uri
import android.os.Build
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ForegroundInfo
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import jp.tanaka.tcloud.R
import jp.tanaka.tcloud.TCloudApplication
import jp.tanaka.tcloud.data.UploadTicket
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import java.io.InputStream
import kotlin.math.absoluteValue
import kotlin.math.roundToInt

class TCloudUploadWorker(
    appContext: Context,
    parameters: WorkerParameters,
) : CoroutineWorker(appContext, parameters) {
    private val notificationManager =
        appContext.getSystemService(Service.NOTIFICATION_SERVICE) as NotificationManager

    override suspend fun doWork(): Result {
        val folderId = inputData.getLong(KEY_FOLDER_ID, 0)
        val source = inputData.getString(KEY_SOURCE_URI)?.let(Uri::parse)
        val cameraAssetKey = inputData.getString(KEY_CAMERA_ASSET_KEY)
        if (folderId <= 0 || source == null) return Result.failure(errorData("アップロード情報が不正です。"))

        createNotificationChannel()
        setForeground(notification("準備しています", 0, indeterminate = true))
        var ticket: UploadTicket? = null
        return try {
            val sourceInfo = readSourceInfo(source)
            check(sourceInfo.sizeBytes > 0) { "空ファイルのためスキップしました。" }
            val repository = (applicationContext as TCloudApplication).repository
            repository.prepareUpload(
                folderId = folderId,
                name = sourceInfo.name,
                mimeType = sourceInfo.mimeType,
                mediaKind = sourceInfo.mediaKind,
                lastModified = sourceInfo.lastModified,
                sizeBytes = sourceInfo.sizeBytes,
            ).use { prepared ->
                val activeTicket = repository.createUpload(prepared.payload)
                ticket = activeTicket
                check(activeTicket.chunkSize == prepared.payload.chunkSizeBytes) {
                    "サーバーと端末の暗号チャンク設定が一致しません。"
                }
                val parts = mutableListOf<jp.tanaka.tcloud.data.UploadedPart>()
                val input = checkNotNull(applicationContext.contentResolver.openInputStream(source)) {
                    "選択したファイルを開けませんでした。"
                }
                input.use {
                    var uploadedPlainBytes = 0L
                    for (index in 0 until prepared.payload.chunkCount) {
                        currentCoroutineContext().ensureActive()
                        val expected = minOf(
                            prepared.payload.chunkSizeBytes,
                            prepared.payload.sizeBytes - uploadedPlainBytes,
                        ).toInt()
                        val plain = input.readExactly(expected)
                        try {
                            val encrypted = prepared.encryptChunk(plain, index)
                            try {
                                parts += repository.uploadPart(activeTicket.id, index + 1, encrypted)
                            } finally {
                                encrypted.fill(0)
                            }
                        } finally {
                            plain.fill(0)
                        }
                        uploadedPlainBytes += expected
                        val percent = ((uploadedPlainBytes * 100.0) / prepared.payload.sizeBytes).roundToInt()
                        setProgress(
                            Data.Builder()
                                .putLong(KEY_UPLOADED_BYTES, uploadedPlainBytes)
                                .putLong(KEY_TOTAL_BYTES, prepared.payload.sizeBytes)
                                .putInt(KEY_PROGRESS_PERCENT, percent)
                                .build(),
                        )
                        setForeground(notification("${sourceInfo.name} を保存中", percent, indeterminate = false))
                    }
                    check(input.read() == -1) { "選択後にファイル容量が変更されました。" }
                }
                repository.completeUpload(activeTicket.id, parts)
            }
            cameraAssetKey?.let {
                (applicationContext as TCloudApplication).cameraBackupStore.markCompleted(it)
            }
            showCompletion("アップロードが完了しました")
            Result.success()
        } catch (error: Throwable) {
            withContext(NonCancellable) {
                ticket?.let { runCatching { (applicationContext as TCloudApplication).repository.cancelUpload(it.id) } }
            }
            if (isStopped) {
                showCompletion("アップロードを中止しました")
                Result.failure(errorData("中止しました。"))
            } else if (cameraAssetKey != null && runAttemptCount < MAX_CAMERA_RETRIES) {
                showCompletion("自動バックアップを再試行します")
                Result.retry()
            } else {
                if (cameraAssetKey != null) {
                    (applicationContext as TCloudApplication).cameraBackupStore.markFailed(
                        assetKey = cameraAssetKey,
                        sourceUri = source.toString(),
                        folderId = folderId,
                        error = error.message ?: "アップロードに失敗しました。",
                    )
                }
                showCompletion("アップロードに失敗しました")
                Result.failure(errorData(error.message ?: "アップロードに失敗しました。"))
            }
        }
    }

    private suspend fun readSourceInfo(uri: Uri): SourceInfo = withContext(Dispatchers.IO) {
        val extendedProjection = arrayOf(
            OpenableColumns.DISPLAY_NAME,
            OpenableColumns.SIZE,
            DocumentsContract.Document.COLUMN_LAST_MODIFIED,
        )
        val basicProjection = arrayOf(
            OpenableColumns.DISPLAY_NAME,
            OpenableColumns.SIZE,
        )
        var name = ""
        var size = -1L
        var modified = 0L

        fun readMetadata(projection: Array<String>): Boolean = runCatching {
            applicationContext.contentResolver.query(uri, projection, null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    name = cursor.stringValue(OpenableColumns.DISPLAY_NAME).orEmpty()
                    size = cursor.longValue(OpenableColumns.SIZE) ?: -1L
                    modified = cursor.longValue(DocumentsContract.Document.COLUMN_LAST_MODIFIED) ?: 0L
                    true
                } else {
                    false
                }
            } ?: false
        }.getOrDefault(false)

        if (!readMetadata(extendedProjection)) {
            modified = 0L
            check(readMetadata(basicProjection)) {
                "選択したファイルの情報を取得できませんでした。"
            }
        }
        if (size < 0) {
            size = applicationContext.contentResolver.openAssetFileDescriptor(uri, "r")?.use { it.length } ?: -1
        }
        check(size >= 0) { "ファイル容量を確認できませんでした。" }
        if (modified in 1 until 100_000_000_000L) modified *= 1_000
        val mime = applicationContext.contentResolver.getType(uri) ?: "application/octet-stream"
        SourceInfo(
            name = name.ifBlank { "T-Cloud-file" },
            sizeBytes = size,
            lastModified = modified,
            mimeType = mime,
            mediaKind = when {
                mime.startsWith("image/") -> "image"
                mime.startsWith("video/") -> "video"
                mime.startsWith("audio/") -> "audio"
                mime.startsWith("text/") || mime == "application/pdf" -> "document"
                else -> "other"
            },
        )
    }

    private fun InputStream.readExactly(size: Int): ByteArray {
        val result = ByteArray(size)
        var offset = 0
        while (offset < size) {
            val read = read(result, offset, size - offset)
            check(read > 0) { "ファイルを最後まで読み取れませんでした。" }
            offset += read
        }
        return result
    }

    private fun Cursor.stringValue(column: String): String? {
        val index = getColumnIndex(column)
        return if (index >= 0 && !isNull(index)) getString(index) else null
    }

    private fun Cursor.longValue(column: String): Long? {
        val index = getColumnIndex(column)
        return if (index >= 0 && !isNull(index)) getLong(index) else null
    }

    private fun notification(text: String, progress: Int, indeterminate: Boolean): ForegroundInfo {
        val cancelIntent = WorkManager.getInstance(applicationContext).createCancelPendingIntent(id)
        val notification = Notification.Builder(applicationContext, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_cloud_upload)
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

    private fun showCompletion(text: String) {
        notificationManager.notify(
            notificationId() + 1,
            Notification.Builder(applicationContext, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_cloud_upload)
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

    private fun notificationId(): Int = 102_000 + (id.hashCode().absoluteValue % 100_000)

    private fun errorData(message: String) = Data.Builder().putString(KEY_ERROR, message).build()

    private data class SourceInfo(
        val name: String,
        val sizeBytes: Long,
        val lastModified: Long,
        val mimeType: String,
        val mediaKind: String,
    )

    companion object {
        const val KEY_FOLDER_ID = "folder_id"
        const val KEY_SOURCE_URI = "source_uri"
        const val KEY_CAMERA_ASSET_KEY = "camera_asset_key"
        const val KEY_UPLOADED_BYTES = "uploaded_bytes"
        const val KEY_TOTAL_BYTES = "total_bytes"
        const val KEY_PROGRESS_PERCENT = "progress_percent"
        const val KEY_ERROR = "error"
        private const val CHANNEL_ID = "tcloud_transfers"
        private const val MAX_CAMERA_RETRIES = 5
    }
}
