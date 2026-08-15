package jp.tanaka.tcloud.backup

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class CameraBackupStoreTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private lateinit var store: CameraBackupStore

    @Before
    fun setUp() {
        context.deleteDatabase("tcloud_camera_backup.db")
        context.getSharedPreferences("tcloud_camera_backup_settings", Context.MODE_PRIVATE)
            .edit()
            .clear()
            .commit()
        store = CameraBackupStore(context)
    }

    @After
    fun tearDown() {
        store.close()
        context.deleteDatabase("tcloud_camera_backup.db")
        context.getSharedPreferences("tcloud_camera_backup_settings", Context.MODE_PRIVATE)
            .edit()
            .clear()
            .commit()
    }

    @Test
    fun versionOnePolicyResetsCursorExactlyOnceAndPreservesCompletedAssets() {
        val completedKey = "10:1:5:100:200"
        store.markCompleted(completedKey)
        store.advanceScanCursor(500, 900)
        store.beginBatch(listOf("pending"))

        val migrated = store.applyCurrentScanPolicy()

        assertEquals(1, migrated.scanPolicyVersion)
        assertEquals(0L, migrated.scanDateAddedSeconds)
        assertEquals(0L, migrated.scanMediaId)
        assertTrue(store.isCompleted(completedKey))
        assertEquals(0, store.batchProgress().total)

        store.advanceScanCursor(700, 901)
        val secondStart = store.applyCurrentScanPolicy()
        assertEquals(700L, secondStart.scanDateAddedSeconds)
        assertEquals(901L, secondStart.scanMediaId)
        assertTrue(store.isCompleted(completedKey))
    }
}
