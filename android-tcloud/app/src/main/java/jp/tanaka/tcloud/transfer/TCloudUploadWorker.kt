package jp.tanaka.tcloud.transfer

import android.content.Context
import android.database.Cursor
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.WorkerParameters
import jp.tanaka.tcloud.TCloudApplication
import jp.tanaka.tcloud.data.UploadTicket
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import java.io.InputStream
import kotlin.math.roundToInt

class TCloudUploadWorker(
    appContext: Context,
    parameters: WorkerParameters,
) : CoroutineWorker(appContext, parameters) {
    override suspend fun doWork(): Result {
        val batchId = inputData.getString(KEY_BATCH_ID).orEmpty()
        if (batchId.isBlank()) return Result.failure(errorData("アップロード情報が不正です。"))
        val application = applicationContext as TCloudApplication
        val store = application.transferStore
        val notifications = TCloudTransferNotifications(applicationContext)
        val original = store.batch(batchId) ?: return Result.failure(errorData("転送情報が見つかりません。"))
        if (original.direction !in setOf(TransferDirection.UPLOAD, TransferDirection.CAMERA_BACKUP)) {
            return Result.failure(errorData("転送の種類が一致しません。"))
        }

        store.recoverInterrupted(batchId, original.direction)
        store.markBatchRunning(batchId)
        setForeground(notifications.foreground(checkNotNull(store.batch(batchId)), id))

        return try {
            store.items(batchId)
                .filter { it.status == TransferStatus.QUEUED }
                .forEach { item ->
                    currentCoroutineContext().ensureActive()
                    uploadOne(application, store, notifications, batchId, item)
                }
            store.finishBatch(batchId)
            Result.success()
        } catch (_: TransferRetryRequested) {
            Result.retry()
        } catch (cancelled: CancellationException) {
            store.cancelBatch(batchId)
            throw cancelled
        } catch (error: Throwable) {
            store.items(batchId)
                .filter { it.status == TransferStatus.QUEUED || it.status == TransferStatus.RUNNING }
                .forEach { store.markItemFailure(batchId, it.index, error.userMessage()) }
            store.finishBatch(batchId)
            Result.success()
        }
    }

    private suspend fun uploadOne(
        application: TCloudApplication,
        store: TCloudTransferStore,
        notifications: TCloudTransferNotifications,
        batchId: String,
        item: TransferItem,
    ) {
        val source = Uri.parse(item.sourceUri)
        var ticket: UploadTicket? = null
        var completionStarted = false
        try {
            val sourceInfo = readSourceInfo(source)
            store.markItemRunning(batchId, item.index, sourceInfo.name)
            updateForeground(store, notifications, batchId)
            if (item.cameraAssetKey.isNotBlank() && sourceInfo.mediaKind != item.expectedMediaKind) {
                application.cameraBackupStore.markCompleted(item.cameraAssetKey)
                application.cameraBackupStore.finishBatchAsset(item.cameraAssetKey, failed = false)
                store.markItemSuccess(batchId, item.index)
                updateForeground(store, notifications, batchId)
                return
            }
            check(sourceInfo.sizeBytes > 0) { "空ファイルのためスキップしました。" }

            val thumbnail = runCatching {
                TCloudThumbnailFactory.create(applicationContext, source, sourceInfo.mediaKind)
            }.getOrNull()
            try {
                application.repository.prepareUpload(
                    folderId = item.folderId,
                    name = sourceInfo.name,
                    mimeType = sourceInfo.mimeType,
                    mediaKind = sourceInfo.mediaKind,
                    lastModified = sourceInfo.lastModified,
                    sizeBytes = sourceInfo.sizeBytes,
                ).use { prepared ->
                    val encryptedThumbnail = thumbnail?.let(prepared::encryptThumbnail)
                    try {
                        val activeTicket = retryTransientTransfer {
                            application.repository.createUpload(prepared.payload)
                        }
                        ticket = activeTicket
                        check(activeTicket.chunkSize == prepared.payload.chunkSizeBytes) {
                            "サーバーと端末の暗号チャンク設定が一致しません。"
                        }
                        val parts = mutableListOf<jp.tanaka.tcloud.data.UploadedPart>()
                        val input = checkNotNull(applicationContext.contentResolver.openInputStream(source)) {
                            "選択したファイルを開けませんでした。"
                        }
                        store.markItemStage(batchId, item.index, TCloudTransferStore.STAGE_UPLOADING)
                        input.use {
                            var uploadedPlainBytes = 0L
                            var lastReportedProgress = -1
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
                                        parts += retryTransientTransfer {
                                            application.repository.uploadPart(activeTicket.id, index + 1, encrypted)
                                        }
                                    } finally {
                                        encrypted.fill(0)
                                    }
                                } finally {
                                    plain.fill(0)
                                }
                                uploadedPlainBytes += expected
                                val percent = ((uploadedPlainBytes * 100.0) / prepared.payload.sizeBytes).roundToInt()
                                if (percent != lastReportedProgress) {
                                    lastReportedProgress = percent
                                    store.updateProgress(batchId, sourceInfo.name, percent)
                                    setProgress(progressData(store, batchId))
                                    updateForeground(store, notifications, batchId)
                                }
                            }
                            check(input.read() == -1) { "選択後にファイル容量が変更されました。" }
                        }
                        store.markItemStage(batchId, item.index, TCloudTransferStore.STAGE_COMPLETING)
                        completionStarted = true
                        application.repository.completeUpload(activeTicket.id, parts)

                        if (encryptedThumbnail != null) {
                            runCatching {
                                retryTransientTransfer {
                                    application.repository.putThumbnail(activeTicket.id, encryptedThumbnail)
                                }
                            }
                        }
                        store.markItemSuccess(batchId, item.index)
                        ticket = null
                    } finally {
                        encryptedThumbnail?.fill(0)
                    }
                }
            } finally {
                thumbnail?.fill(0)
            }
            if (item.cameraAssetKey.isNotBlank()) {
                application.cameraBackupStore.markCompleted(item.cameraAssetKey)
                application.cameraBackupStore.finishBatchAsset(item.cameraAssetKey, failed = false)
            }
        } catch (cancelled: CancellationException) {
            withContext(NonCancellable) {
                ticket?.let { runCatching { application.repository.cancelUpload(it.id) } }
            }
            throw cancelled
        } catch (error: Throwable) {
            withContext(NonCancellable) {
                ticket?.let { runCatching { application.repository.cancelUpload(it.id) } }
            }
            if (!completionStarted && isTransientTransferFailure(error) && runAttemptCount < MAX_BATCH_RETRIES) {
                store.deferItem(batchId, item.index)
                throw TransferRetryRequested(error)
            }
            if (item.cameraAssetKey.isNotBlank()) {
                application.cameraBackupStore.markFailed(
                    assetKey = item.cameraAssetKey,
                    sourceUri = item.sourceUri,
                    folderId = item.folderId,
                    error = error.userMessage(),
                )
                application.cameraBackupStore.finishBatchAsset(item.cameraAssetKey, failed = true)
            }
            store.markItemFailure(batchId, item.index, error.userMessage())
        }
        updateForeground(store, notifications, batchId)
    }

    private suspend fun updateForeground(
        store: TCloudTransferStore,
        notifications: TCloudTransferNotifications,
        batchId: String,
    ) {
        val batch = store.batch(batchId) ?: return
        setForeground(notifications.foreground(batch, id))
    }

    private suspend fun readSourceInfo(uri: Uri): SourceInfo = withContext(Dispatchers.IO) {
        val extendedProjection = arrayOf(
            OpenableColumns.DISPLAY_NAME,
            OpenableColumns.SIZE,
            DocumentsContract.Document.COLUMN_LAST_MODIFIED,
        )
        val basicProjection = arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
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
                } else false
            } ?: false
        }.getOrDefault(false)

        if (!readMetadata(extendedProjection)) {
            modified = 0L
            check(readMetadata(basicProjection)) { "選択したファイルの情報を取得できませんでした。" }
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

    private fun progressData(store: TCloudTransferStore, batchId: String): Data {
        val batch = store.batch(batchId) ?: return Data.EMPTY
        return Data.Builder()
            .putInt(KEY_TOTAL_COUNT, batch.total)
            .putInt(KEY_COMPLETED_COUNT, batch.processed)
            .putInt(KEY_REMAINING_COUNT, batch.remaining)
            .putInt(KEY_PROGRESS_PERCENT, batch.overallProgress)
            .build()
    }

    private fun Throwable.userMessage(): String = message?.takeIf(String::isNotBlank)
        ?: "アップロードに失敗しました。"

    private fun errorData(message: String) = Data.Builder().putString(KEY_ERROR, message).build()

    private data class SourceInfo(
        val name: String,
        val sizeBytes: Long,
        val lastModified: Long,
        val mimeType: String,
        val mediaKind: String,
    )

    companion object {
        const val KEY_BATCH_ID = "batch_id"
        const val KEY_TOTAL_COUNT = "total_count"
        const val KEY_COMPLETED_COUNT = "completed_count"
        const val KEY_REMAINING_COUNT = "remaining_count"
        const val KEY_PROGRESS_PERCENT = "progress_percent"
        const val KEY_ERROR = "error"
        private const val MAX_BATCH_RETRIES = 5
    }
}
