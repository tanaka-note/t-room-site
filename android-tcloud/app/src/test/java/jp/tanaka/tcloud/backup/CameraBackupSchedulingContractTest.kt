package jp.tanaka.tcloud.backup

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CameraBackupSchedulingContractTest {
    @Test
    fun scheduleCombinesPeriodicImmediateAndDurableMediaStoreTrigger() {
        val manager = projectFile(
            "app/src/main/java/jp/tanaka/tcloud/backup/CameraBackupManager.kt",
        ).readText()

        assertTrue(manager.contains("PeriodicWorkRequestBuilder<CameraBackupScanWorker>(15, TimeUnit.MINUTES)"))
        assertTrue(manager.contains("ExistingPeriodicWorkPolicy.UPDATE"))
        assertTrue(manager.contains("OneTimeWorkRequestBuilder<CameraBackupMediaChangeWorker>()"))
        assertTrue(manager.contains("MediaStore.Images.Media.EXTERNAL_CONTENT_URI"))
        assertTrue(manager.contains("MediaStore.Video.Media.EXTERNAL_CONTENT_URI"))
        assertTrue(manager.contains("setTriggerContentUpdateDelay"))
        assertTrue(manager.contains("setTriggerContentMaxDelay"))
    }

    @Test
    fun scansAreCoalescedWithoutReplacingAnActiveScanAndTriggerRearms() {
        val manager = projectFile(
            "app/src/main/java/jp/tanaka/tcloud/backup/CameraBackupManager.kt",
        ).readText()
        val trigger = projectFile(
            "app/src/main/java/jp/tanaka/tcloud/backup/CameraBackupMediaChangeWorker.kt",
        ).readText()

        assertTrue(manager.contains("ExistingWorkPolicy.APPEND_OR_REPLACE, immediate"))
        assertFalse(manager.contains("ExistingWorkPolicy.REPLACE, immediate"))
        assertTrue(manager.contains("ExistingWorkPolicy.APPEND_OR_REPLACE"))
        assertTrue(manager.contains("IMMEDIATE_SCAN_DEBOUNCE_MILLIS"))
        assertTrue(trigger.contains("cameraBackupManager.handleMediaStoreChange()"))
    }

    @Test
    fun disabledScheduleCancelsTheTriggerAndForegroundResumeIsThrottled() {
        val manager = projectFile(
            "app/src/main/java/jp/tanaka/tcloud/backup/CameraBackupManager.kt",
        ).readText()
        val activity = projectFile(
            "app/src/main/java/jp/tanaka/tcloud/MainActivity.kt",
        ).readText()

        assertTrue(manager.contains("cancelUniqueWork(MEDIA_CHANGE_WORK)"))
        assertTrue(manager.contains("FOREGROUND_SCAN_THROTTLE_MILLIS"))
        assertTrue(activity.contains("cameraBackupManager.requestForegroundScan()"))
    }

    @Test
    fun automaticWorkCompletionRefreshesTheVisibleSettingsState() {
        val viewModel = projectFile(
            "app/src/main/java/jp/tanaka/tcloud/MainViewModel.kt",
        ).readText()

        assertTrue(viewModel.contains("cameraBackupManager.workUpdates().collectLatest"))
        assertTrue(viewModel.contains("cameraBackupSettings = cameraBackupManager.settings()"))
    }

    private fun projectFile(relativePath: String): File {
        var current = File(checkNotNull(System.getProperty("user.dir"))).canonicalFile
        repeat(6) {
            val candidate = File(current, relativePath)
            if (candidate.isFile) return candidate
            current = current.parentFile ?: error("Project root was not found")
        }
        error("Project file was not found: $relativePath")
    }
}
