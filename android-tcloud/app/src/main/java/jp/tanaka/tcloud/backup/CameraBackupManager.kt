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

    fun update(enabled: Boolean, wifiOnly: Boolean, chargingOnly: Boolean): CameraBackupSettings {
        val previous = store.settings()
        val updated = store.update(enabled, wifiOnly, chargingOnly)
        if (previous.wifiOnly != updated.wifiOnly || previous.chargingOnly != updated.chargingOnly) {
            workManager.cancelAllWorkByTag(TCloudUploadManager.TAG_CAMERA_UPLOAD)
        }
        applySchedule(updated)
        return updated
    }

    fun restoreSchedule() = applySchedule(store.settings())

    private fun applySchedule(settings: CameraBackupSettings) {
        if (!settings.enabled || !settings.hasTarget) {
            workManager.cancelUniqueWork(PERIODIC_WORK)
            workManager.cancelUniqueWork(IMMEDIATE_WORK)
            workManager.cancelAllWorkByTag(TCloudUploadManager.TAG_CAMERA_UPLOAD)
            return
        }
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(if (settings.wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED)
            .setRequiresCharging(settings.chargingOnly)
            .build()
        val periodic = PeriodicWorkRequestBuilder<CameraBackupScanWorker>(15, TimeUnit.MINUTES)
            .setConstraints(constraints)
            .addTag(TAG_CAMERA_BACKUP)
            .build()
        workManager.enqueueUniquePeriodicWork(
            PERIODIC_WORK,
            ExistingPeriodicWorkPolicy.UPDATE,
            periodic,
        )
        val immediate = OneTimeWorkRequestBuilder<CameraBackupScanWorker>()
            .setConstraints(constraints)
            .addTag(TAG_CAMERA_BACKUP)
            .build()
        workManager.enqueueUniqueWork(IMMEDIATE_WORK, ExistingWorkPolicy.REPLACE, immediate)
    }

    companion object {
        const val TAG_CAMERA_BACKUP = "tcloud_camera_backup"
        private const val PERIODIC_WORK = "tcloud_camera_backup_periodic"
        private const val IMMEDIATE_WORK = "tcloud_camera_backup_now"
    }
}
