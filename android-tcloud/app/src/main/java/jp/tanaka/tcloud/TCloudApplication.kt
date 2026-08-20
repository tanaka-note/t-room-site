package jp.tanaka.tcloud

import android.app.Application
import jp.tanaka.tcloud.data.SecureSessionStore
import jp.tanaka.tcloud.data.TCloudApi
import jp.tanaka.tcloud.data.TCloudRepository
import jp.tanaka.tcloud.offline.TCloudOfflineManager
import jp.tanaka.tcloud.offline.TCloudOfflineStore
import jp.tanaka.tcloud.transfer.TCloudDownloadManager
import jp.tanaka.tcloud.transfer.TCloudUploadManager
import jp.tanaka.tcloud.transfer.TCloudTransferStore
import jp.tanaka.tcloud.transfer.TCloudTransferCancellation
import jp.tanaka.tcloud.backup.CameraBackupManager
import jp.tanaka.tcloud.backup.CameraBackupStore
import jp.tanaka.tcloud.media.TCloudPlaybackManager
import jp.tanaka.tcloud.library.MediaLibraryManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

class TCloudApplication : Application() {
    private val applicationScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    val transferStore: TCloudTransferStore by lazy { TCloudTransferStore(this) }
    val downloadManager: TCloudDownloadManager by lazy { TCloudDownloadManager(this, transferStore) }
    val uploadManager: TCloudUploadManager by lazy { TCloudUploadManager(this, transferStore) }
    val offlineStore: TCloudOfflineStore by lazy { TCloudOfflineStore(this) }
    val offlineManager: TCloudOfflineManager by lazy { TCloudOfflineManager(this) }
    val cameraBackupStore: CameraBackupStore by lazy { CameraBackupStore(this) }
    val cameraBackupManager: CameraBackupManager by lazy {
        CameraBackupManager(this, cameraBackupStore, transferStore)
    }
    val repository: TCloudRepository by lazy {
        val sessionStore = SecureSessionStore(this)
        TCloudRepository(
            api = TCloudApi(sessionStore),
            sessionStore = sessionStore,
            offlineStore = offlineStore,
        )
    }
    val mediaLibraryManager: MediaLibraryManager by lazy { MediaLibraryManager(this, repository) }
    val playbackManager: TCloudPlaybackManager by lazy {
        TCloudPlaybackManager(this, repository).also { manager ->
            manager.playbackRecorded = { item, position, duration ->
                mediaLibraryManager.recordPlayback(item.stableId, position, duration)
            }
            manager.metadataResolved = { item, title, artist, album, track ->
                mediaLibraryManager.updatePlaybackMetadata(item.stableId, title, artist, album, track)
            }
        }
    }
    val transferCancellation: TCloudTransferCancellation by lazy {
        TCloudTransferCancellation(this, transferStore, repository, cameraBackupManager)
    }

    override fun onCreate() {
        super.onCreate()
        applicationScope.launch { offlineStore.cleanupExpired() }
        cameraBackupManager.restoreSchedule()
        transferCancellation.scheduleTerminalTicketCleanup()
        mediaLibraryManager.refreshLocalAsync()
    }
}
