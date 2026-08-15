package jp.tanaka.tcloud.backup

import android.content.Context
import android.provider.MediaStore
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import jp.tanaka.tcloud.transfer.TCloudUploadManager
import jp.tanaka.tcloud.transfer.TCloudTransferStore
import jp.tanaka.tcloud.transfer.TransferDirection
import java.util.concurrent.TimeUnit

class CameraBackupManager(
    context: Context,
    private val store: CameraBackupStore,
    private val transferStore: TCloudTransferStore,
) {
    private val applicationContext = context.applicationContext
    private val workManager = WorkManager.getInstance(context)

    fun settings(): CameraBackupSettings = store.settings()

    fun setTarget(folderId: Long, folderName: String): CameraBackupSettings {
        val previous = store.settings()
        val updated = store.setTarget(folderId, folderName)
        if (previous.folderId != updated.folderId) {
            cancelActiveCameraBatches()
            workManager.cancelAllWorkByTag(TCloudUploadManager.TAG_CAMERA_UPLOAD)
        }
        applySchedule(updated)
        return updated
    }

    fun update(
        enabled: Boolean,
        wifiOnly: Boolean,
        chargingOnly: Boolean,
        includeImages: Boolean,
        includeVideos: Boolean,
        allSourceFolders: Boolean,
        sourceFolderIds: Set<String>,
    ): CameraBackupSettings {
        val previous = store.settings()
        val updated = store.update(
            enabled,
            wifiOnly,
            chargingOnly,
            includeImages,
            includeVideos,
            allSourceFolders,
            sourceFolderIds,
        )
        if (!enabled || previous.includeImages != includeImages ||
            previous.includeVideos != includeVideos ||
            previous.allSourceFolders != allSourceFolders ||
            previous.sourceFolderIds != sourceFolderIds
        ) {
            cancelActiveCameraBatches()
            workManager.cancelAllWorkByTag(TCloudUploadManager.TAG_CAMERA_UPLOAD)
        }
        applySchedule(updated)
        return updated
    }

    fun restoreSchedule() = applySchedule(store.applyCurrentScanPolicy())

    fun requestForegroundScan() {
        val settings = store.settings()
        val now = System.currentTimeMillis()
        if (!settings.enabled || !settings.hasTarget ||
            now - lastForegroundScanAtMillis < FOREGROUND_SCAN_THROTTLE_MILLIS
        ) return
        lastForegroundScanAtMillis = now
        enqueueImmediate(settings)
    }

    fun workUpdates() = workManager.getWorkInfosByTagFlow(TAG_CAMERA_BACKUP)

    fun requestRescanAfterCancellation() {
        store.requestFullRescan()
        workManager.cancelUniqueWork(IMMEDIATE_WORK)
        workManager.cancelUniqueWork(CONTINUATION_WORK)
    }

    suspend fun sourceFolders(): List<CameraBackupSourceFolder> =
        queryCameraBackupSourceFolders(applicationContext)

    fun runNow(): CameraBackupSettings {
        val settings = store.settings()
        if (settings.enabled && settings.hasTarget) enqueueImmediate(settings)
        return settings
    }

    internal fun enqueueContinuation(settings: CameraBackupSettings) {
        if (!settings.enabled || !settings.hasTarget) return
        val request = OneTimeWorkRequestBuilder<CameraBackupScanWorker>()
            .setConstraints(constraints(settings))
            .addTag(TAG_CAMERA_BACKUP)
            .build()
        workManager.enqueueUniqueWork(
            CONTINUATION_WORK,
            ExistingWorkPolicy.APPEND_OR_REPLACE,
            request,
        )
    }

    internal fun handleMediaStoreChange() {
        val settings = store.settings()
        if (!settings.enabled || !settings.hasTarget) return
        enqueueImmediate(settings)
        enqueueMediaChangeTrigger(settings, appendToCurrent = true)
    }

    private fun applySchedule(settings: CameraBackupSettings) {
        if (!settings.enabled || !settings.hasTarget) {
            cancelActiveCameraBatches()
            workManager.cancelUniqueWork(PERIODIC_WORK)
            workManager.cancelUniqueWork(IMMEDIATE_WORK)
            workManager.cancelUniqueWork(CONTINUATION_WORK)
            workManager.cancelUniqueWork(MEDIA_CHANGE_WORK)
            workManager.cancelAllWorkByTag(TCloudUploadManager.TAG_CAMERA_UPLOAD)
            return
        }
        val periodic = PeriodicWorkRequestBuilder<CameraBackupScanWorker>(15, TimeUnit.MINUTES)
            .setConstraints(constraints(settings))
            .addTag(TAG_CAMERA_BACKUP)
            .build()
        workManager.enqueueUniquePeriodicWork(
            PERIODIC_WORK,
            ExistingPeriodicWorkPolicy.UPDATE,
            periodic,
        )
        enqueueMediaChangeTrigger(settings, appendToCurrent = false)
        enqueueImmediate(settings)
    }

    private fun cancelActiveCameraBatches() {
        transferStore.batches.value
            .filter { it.active && it.direction == TransferDirection.CAMERA_BACKUP }
            .forEach { batch ->
                transferStore.requestUserCancellation(batch.id)
                transferStore.cancelBatch(batch.id)
            }
    }

    private fun enqueueImmediate(settings: CameraBackupSettings) {
        val now = System.currentTimeMillis()
        if (now - lastImmediateEnqueueAtMillis < IMMEDIATE_SCAN_DEBOUNCE_MILLIS) return
        lastImmediateEnqueueAtMillis = now
        val immediate = OneTimeWorkRequestBuilder<CameraBackupScanWorker>()
            .setConstraints(constraints(settings))
            .addTag(TAG_CAMERA_BACKUP)
            .build()
        workManager.enqueueUniqueWork(IMMEDIATE_WORK, ExistingWorkPolicy.APPEND_OR_REPLACE, immediate)
    }

    private fun enqueueMediaChangeTrigger(
        settings: CameraBackupSettings,
        appendToCurrent: Boolean,
    ) {
        if (!settings.includeImages && !settings.includeVideos) return
        val contentConstraints = Constraints.Builder().apply {
            if (settings.includeImages) addContentUriTrigger(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, true)
            if (settings.includeVideos) addContentUriTrigger(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, true)
            setTriggerContentUpdateDelay(CONTENT_TRIGGER_UPDATE_DELAY_SECONDS, TimeUnit.SECONDS)
            setTriggerContentMaxDelay(CONTENT_TRIGGER_MAX_DELAY_SECONDS, TimeUnit.SECONDS)
        }.build()
        val request = OneTimeWorkRequestBuilder<CameraBackupMediaChangeWorker>()
            .setConstraints(contentConstraints)
            .addTag(TAG_CAMERA_BACKUP)
            .build()
        workManager.enqueueUniqueWork(
            MEDIA_CHANGE_WORK,
            if (appendToCurrent) ExistingWorkPolicy.APPEND_OR_REPLACE else ExistingWorkPolicy.REPLACE,
            request,
        )
    }

    private fun constraints(settings: CameraBackupSettings) = Constraints.Builder()
        .setRequiredNetworkType(if (settings.wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED)
        .setRequiresCharging(settings.chargingOnly)
        .build()

    companion object {
        const val TAG_CAMERA_BACKUP = "tcloud_camera_backup"
        private const val PERIODIC_WORK = "tcloud_camera_backup_periodic"
        private const val IMMEDIATE_WORK = "tcloud_camera_backup_now"
        private const val CONTINUATION_WORK = "tcloud_camera_backup_continue"
        private const val MEDIA_CHANGE_WORK = "tcloud_camera_backup_media_changes"
        private const val CONTENT_TRIGGER_UPDATE_DELAY_SECONDS = 8L
        private const val CONTENT_TRIGGER_MAX_DELAY_SECONDS = 45L
        private const val FOREGROUND_SCAN_THROTTLE_MILLIS = 2 * 60 * 1_000L
        private const val IMMEDIATE_SCAN_DEBOUNCE_MILLIS = 2_000L
    }

    private var lastForegroundScanAtMillis = 0L
    private var lastImmediateEnqueueAtMillis = 0L
}
