package jp.tanaka.tcloud.backup

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import jp.tanaka.tcloud.transfer.TCloudUploadManager
import java.util.concurrent.TimeUnit

class CameraBackupManager(
    context: Context,
    private val store: CameraBackupStore,
) {
    private val workManager = WorkManager.getInstance(context)

    fun settings(): CameraBackupSettings = store.settings()

    fun setTarget(folderId: Long, folderName: String): CameraBackupSettings {
        val previous = store.settings()
        val updated = store.setTarget(folderId, folderName)
        if (previous.folderId != updated.folderId) {
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
    ): CameraBackupSettings {
        val previous = store.settings()
        val updated = store.update(enabled, wifiOnly, chargingOnly, includeImages, includeVideos)
        if (!enabled || previous.includeImages != includeImages || previous.includeVideos != includeVideos) {
            workManager.cancelAllWorkByTag(TCloudUploadManager.TAG_CAMERA_UPLOAD)
        }
        applySchedule(updated)
        return updated
    }

    fun restoreSchedule() = applySchedule(store.settings())

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

    private fun applySchedule(settings: CameraBackupSettings) {
        if (!settings.enabled || !settings.hasTarget) {
            workManager.cancelUniqueWork(PERIODIC_WORK)
            workManager.cancelUniqueWork(IMMEDIATE_WORK)
            workManager.cancelUniqueWork(CONTINUATION_WORK)
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
        enqueueImmediate(settings)
    }

    private fun enqueueImmediate(settings: CameraBackupSettings) {
        val immediate = OneTimeWorkRequestBuilder<CameraBackupScanWorker>()
            .setConstraints(constraints(settings))
            .addTag(TAG_CAMERA_BACKUP)
            .build()
        workManager.enqueueUniqueWork(IMMEDIATE_WORK, ExistingWorkPolicy.REPLACE, immediate)
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
    }
}
