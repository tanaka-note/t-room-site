package jp.tanaka.tcloud.transfer

import android.Manifest
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.WorkerParameters
import jp.tanaka.tcloud.TCloudApplication
import jp.tanaka.tcloud.data.CloudFile
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStream
import kotlin.math.roundToInt

class TCloudDownloadWorker(
    appContext: Context,
    parameters: WorkerParameters,
) : CoroutineWorker(appContext, parameters) {
    override suspend fun doWork(): Result {
        val batchId = inputData.getString(KEY_BATCH_ID).orEmpty()
        if (batchId.isBlank()) return Result.failure(errorData("ダウンロード情報が不正です。"))
        val application = applicationContext as TCloudApplication
        val store = application.transferStore
        val notifications = TCloudTransferNotifications(applicationContext)
        val original = store.batch(batchId) ?: return Result.failure(errorData("転送情報が見つかりません。"))
        if (original.direction != TransferDirection.DOWNLOAD) {
            return Result.failure(errorData("転送の種類が一致しません。"))
        }

        store.recoverInterrupted(batchId, TransferDirection.DOWNLOAD).forEach(::deleteDestination)
        store.markBatchRunning(batchId)
        setForeground(notifications.foreground(checkNotNull(store.batch(batchId)), id))

        return try {
            store.items(batchId)
                .filter { it.status == TransferStatus.QUEUED }
                .forEach { item ->
                    currentCoroutineContext().ensureActive()
                    downloadOne(application, store, notifications, batchId, item)
                }
            store.finishBatch(batchId)
            Result.success()
        } catch (_: TransferRetryRequested) {
            Result.retry()
        } catch (cancelled: CancellationException) {
            store.items(batchId)
                .filter { it.status == TransferStatus.RUNNING }
                .forEach { item ->
                    if (item.resultUri.isNotBlank()) deleteDestination(item.resultUri)
                }
            store.cancelBatch(batchId)
            throw cancelled
        } catch (error: Throwable) {
            store.items(batchId)
                .filter { it.status == TransferStatus.QUEUED || it.status == TransferStatus.RUNNING }
                .forEach { item ->
                    if (item.resultUri.isNotBlank()) deleteDestination(item.resultUri)
                    store.markItemFailure(batchId, item.index, error.userMessage())
                }
            store.finishBatch(batchId)
            Result.success()
        }
    }

    private suspend fun downloadOne(
        application: TCloudApplication,
        store: TCloudTransferStore,
        notifications: TCloudTransferNotifications,
        batchId: String,
        item: TransferItem,
    ) {
        store.markItemRunning(batchId, item.index, item.name)
        updateForeground(store, notifications, batchId)
        try {
            val resultUri = retryTransientTransfer {
                val file = application.repository.loadFileForBackground(item.folderId, item.fileId)
                val destination = createDestination(file)
                store.recordDestination(batchId, item.index, destination.uri.toString())
                var lastReportedProgress = -1
                try {
                    destination.output.use { output ->
                        application.repository.downloadDecryptedFile(file, output) { downloaded, total ->
                            currentCoroutineContext().ensureActive()
                            val percent = if (total > 0) {
                                ((downloaded * 100.0) / total).roundToInt()
                            } else 0
                            if (percent != lastReportedProgress) {
                                lastReportedProgress = percent
                                store.updateProgress(batchId, file.name, percent)
                                setProgress(progressData(store, batchId))
                                updateForeground(store, notifications, batchId)
                            }
                        }
                    }
                    destination.finish()
                    destination.uri.toString()
                } catch (error: Throwable) {
                    destination.delete()
                    store.recordDestination(batchId, item.index, "")
                    throw error
                }
            }
            store.markItemSuccess(batchId, item.index, resultUri)
        } catch (cancelled: CancellationException) {
            store.items(batchId).firstOrNull { it.index == item.index }?.resultUri
                ?.takeIf(String::isNotBlank)
                ?.let(::deleteDestination)
            throw cancelled
        } catch (error: Throwable) {
            store.items(batchId).firstOrNull { it.index == item.index }?.resultUri
                ?.takeIf(String::isNotBlank)
                ?.let(::deleteDestination)
            if (isTransientTransferFailure(error) && runAttemptCount < MAX_BATCH_RETRIES) {
                store.deferItem(batchId, item.index)
                throw TransferRetryRequested(error)
            }
            store.markItemFailure(batchId, item.index, error.userMessage())
        }
        updateForeground(store, notifications, batchId)
    }

    private suspend fun createDestination(file: CloudFile): DownloadDestination {
        val safeName = safeFileName(file.name.ifBlank { "T-Cloud-${file.id}" })
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, safeName)
                put(MediaStore.Downloads.MIME_TYPE, file.mimeType)
                put(MediaStore.Downloads.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/T-Cloud")
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            val resolver = applicationContext.contentResolver
            val uri = checkNotNull(resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)) {
                "保存先を作成できませんでした。"
            }
            val output = checkNotNull(resolver.openOutputStream(uri, "w")) {
                resolver.delete(uri, null, null)
                "保存先を開けませんでした。"
            }
            return DownloadDestination(
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
        }

        check(applicationContext.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED) {
            "ファイル保存の権限を許可してください。"
        }
        @Suppress("DEPRECATION")
        val directory = File(
            Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
            "T-Cloud",
        )
        check(directory.exists() || directory.mkdirs()) { "保存フォルダを作成できませんでした。" }
        val outputFile = uniqueFile(directory, safeName)
        return DownloadDestination(
            uri = Uri.fromFile(outputFile),
            output = FileOutputStream(outputFile),
            finish = {},
            delete = { outputFile.delete() },
        )
    }

    private suspend fun updateForeground(
        store: TCloudTransferStore,
        notifications: TCloudTransferNotifications,
        batchId: String,
    ) {
        val batch = store.batch(batchId) ?: return
        setForeground(notifications.foreground(batch, id))
    }

    private fun deleteDestination(value: String) {
        runCatching {
            val uri = Uri.parse(value)
            if (uri.scheme == "file") File(checkNotNull(uri.path)).delete()
            else applicationContext.contentResolver.delete(uri, null, null)
        }
    }

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
        ?: "ダウンロードに失敗しました。"

    private fun errorData(message: String) = Data.Builder().putString(KEY_ERROR, message).build()

    private data class DownloadDestination(
        val uri: Uri,
        val output: OutputStream,
        val finish: () -> Unit,
        val delete: () -> Unit,
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
