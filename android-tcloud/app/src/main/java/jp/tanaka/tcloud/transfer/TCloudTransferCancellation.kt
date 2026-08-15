package jp.tanaka.tcloud.transfer

import android.content.Context
import android.net.Uri
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import jp.tanaka.tcloud.backup.CameraBackupManager
import jp.tanaka.tcloud.data.TCloudRepository
import java.io.File
import java.util.concurrent.TimeUnit

class TCloudTransferCancellation(
    context: Context,
    private val store: TCloudTransferStore,
    private val repository: TCloudRepository,
    private val cameraBackupManager: CameraBackupManager,
) {
    private val applicationContext = context.applicationContext
    private val workManager = WorkManager.getInstance(context)

    suspend fun cancel(batchId: String) {
        val batch = store.batch(batchId) ?: return
        if (!batch.active) return
        store.requestUserCancellation(batchId)
        workManager.cancelAllWorkByTag("${TCloudUploadManager.TAG_BATCH_PREFIX}$batchId")
        val items = store.items(batchId)
        items.filter { it.uploadTicketId > 0 }.forEach { item ->
            if (runCatching { repository.cancelUpload(item.uploadTicketId) }.isSuccess) {
                store.clearUploadTicket(batchId, item.index)
            }
        }
        items.map(TransferItem::resultUri)
            .filter(String::isNotBlank)
            .forEach(::deleteDestination)
        store.cancelBatch(batchId)
        if (batch.direction == TransferDirection.CAMERA_BACKUP) {
            cameraBackupManager.requestRescanAfterCancellation()
        }
        store.batch(batchId)?.let(TCloudTransferNotifications(applicationContext)::showFinal)
        store.trimFinishedHistory()
        scheduleTerminalTicketCleanup()
    }

    suspend fun cleanupOrphanedTerminalTickets(): Boolean {
        var allCleaned = true
        store.pendingTerminalUploadTickets().forEach { ticket ->
            if (runCatching { repository.cancelUpload(ticket.ticketId) }.isSuccess) {
                store.clearUploadTicket(ticket.batchId, ticket.itemIndex)
            } else {
                allCleaned = false
            }
        }
        store.trimFinishedHistory()
        return allCleaned
    }

    fun scheduleTerminalTicketCleanup() {
        val request = OneTimeWorkRequestBuilder<TCloudTransferCleanupWorker>()
            .setConstraints(
                Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build(),
            )
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        workManager.enqueueUniqueWork(CLEANUP_WORK, ExistingWorkPolicy.KEEP, request)
    }

    private fun deleteDestination(value: String) {
        runCatching {
            val uri = Uri.parse(value)
            if (uri.scheme == "file") File(checkNotNull(uri.path)).delete()
            else applicationContext.contentResolver.delete(uri, null, null)
        }
    }

    private companion object {
        const val CLEANUP_WORK = "tcloud_terminal_ticket_cleanup"
    }
}
