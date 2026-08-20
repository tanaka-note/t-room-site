package jp.tanaka.tcloud

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import jp.tanaka.tcloud.data.CloudFolder
import jp.tanaka.tcloud.data.CloudFile
import jp.tanaka.tcloud.data.FolderPage
import jp.tanaka.tcloud.data.FolderPasswordRequiredException
import jp.tanaka.tcloud.data.CloudUsage
import jp.tanaka.tcloud.data.CloudUsageFolder
import jp.tanaka.tcloud.data.CloudSearchResults
import jp.tanaka.tcloud.data.TrashPage
import jp.tanaka.tcloud.data.MoveDestination
import jp.tanaka.tcloud.data.Session
import jp.tanaka.tcloud.data.ShareResult
import jp.tanaka.tcloud.data.TCloudRepository
import jp.tanaka.tcloud.transfer.TCloudDownloadManager
import jp.tanaka.tcloud.transfer.TCloudUploadManager
import jp.tanaka.tcloud.transfer.TCloudTransferStore
import jp.tanaka.tcloud.transfer.TCloudTransferCancellation
import jp.tanaka.tcloud.transfer.FolderTransferFailureNotice
import jp.tanaka.tcloud.transfer.TransferBatchSnapshot
import jp.tanaka.tcloud.transfer.TransferDirection
import jp.tanaka.tcloud.media.TCloudDataSource
import jp.tanaka.tcloud.media.TCloudPlaybackManager
import jp.tanaka.tcloud.library.MediaLibraryManager
import jp.tanaka.tcloud.library.MediaLibraryState
import jp.tanaka.tcloud.library.PlayableMediaItem
import jp.tanaka.tcloud.library.LibraryMediaType
import jp.tanaka.tcloud.library.MediaSourceType
import jp.tanaka.tcloud.offline.TCloudOfflineManager
import jp.tanaka.tcloud.offline.TCloudOfflineStore
import jp.tanaka.tcloud.backup.CameraBackupManager
import jp.tanaka.tcloud.backup.CameraBackupSettings
import jp.tanaka.tcloud.backup.CameraBackupSourceFolder
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.withContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest

data class MainUiState(
    val restoring: Boolean = true,
    val busy: Boolean = false,
    val session: Session? = null,
    val page: FolderPage? = null,
    val folderStack: List<CloudFolder> = emptyList(),
    val pendingUnlock: CloudFolder? = null,
    val selectedFile: CloudFile? = null,
    val selectedFileStartsAtBeginning: Boolean = false,
    val imageBitmap: Bitmap? = null,
    val imageLoading: Boolean = false,
    val imageError: String? = null,
    val thumbnailBitmaps: Map<Long, Bitmap> = emptyMap(),
    val pendingMoveFile: CloudFile? = null,
    val pendingMoveFolder: CloudFolder? = null,
    val pendingMoveFiles: List<CloudFile> = emptyList(),
    val pendingMoveFolders: List<CloudFolder> = emptyList(),
    val moveDestinations: List<MoveDestination> = emptyList(),
    val pendingRenameFile: CloudFile? = null,
    val pendingRenameFolder: CloudFolder? = null,
    val pendingShareFile: CloudFile? = null,
    val pendingShareFolder: CloudFolder? = null,
    val pendingShareFiles: List<CloudFile> = emptyList(),
    val shareResult: ShareResult? = null,
    val selectedFileIds: Set<Long> = emptySet(),
    val selectedFolderIds: Set<Long> = emptySet(),
    val confirmingSelectionDelete: Boolean = false,
    val creatingFolder: Boolean = false,
    val pendingFolderSecurity: CloudFolder? = null,
    val cameraBackupSettings: CameraBackupSettings = CameraBackupSettings(),
    val cameraBackupSourceFolders: List<CameraBackupSourceFolder> = emptyList(),
    val loadingCameraBackupSourceFolders: Boolean = false,
    val showingOffline: Boolean = false,
    val offlineEntries: List<TCloudOfflineStore.OfflineEntry> = emptyList(),
    val showingTrash: Boolean = false,
    val showingPlayerLibrary: Boolean = false,
    val selectedLibraryMedia: PlayableMediaItem? = null,
    val trashPage: TrashPage = TrashPage(emptyList(), emptyList()),
    val cloudUsage: CloudUsage = CloudUsage(),
    val usageDetails: List<CloudUsageFolder> = emptyList(),
    val searchResults: CloudSearchResults = CloudSearchResults(),
    val searchQuery: String = "",
    val searching: Boolean = false,
    val searchScannedCount: Int = 0,
    val transferBatches: List<TransferBatchSnapshot> = emptyList(),
    val transferFailureNotices: List<FolderTransferFailureNotice> = emptyList(),
    val message: String? = null,
    val error: String? = null,
)

internal fun canDeleteSelection(session: Session?, page: FolderPage?): Boolean =
    session?.isAdmin == true || page?.canTrashContents == true

private fun MainUiState.activeFiles(): List<CloudFile> =
    if (searchQuery.isNotBlank()) searchResults.files else page?.files.orEmpty()

private fun MainUiState.activeFolders(): List<CloudFolder> =
    if (searchQuery.isNotBlank()) searchResults.folders else page?.folders.orEmpty()

class MainViewModel(
    private val repository: TCloudRepository,
    private val downloadManager: TCloudDownloadManager,
    private val uploadManager: TCloudUploadManager,
    private val offlineManager: TCloudOfflineManager,
    private val cameraBackupManager: CameraBackupManager,
    private val playbackManager: TCloudPlaybackManager,
    private val mediaLibraryManager: MediaLibraryManager,
    private val transferStore: TCloudTransferStore,
    private val transferCancellation: TCloudTransferCancellation,
) : ViewModel() {
    private val mutableState = MutableStateFlow(MainUiState())
    val state: StateFlow<MainUiState> = mutableState.asStateFlow()
    val mediaLibraryState: StateFlow<MediaLibraryState> = mediaLibraryManager.state
    private var imageLoadJob: Job? = null
    private var searchJob: Job? = null
    private val thumbnailJobs = mutableMapOf<Long, Job>()
    private val refreshedUploadBatches = mutableSetOf<String>()

    init {
        viewModelScope.launch {
            runCatching { repository.restore() }
                .onSuccess { (session, page) ->
                    if (!session.authenticated) mediaLibraryManager.clearCloud()
                    mutableState.value = MainUiState(
                        restoring = false,
                        session = session.takeIf { it.authenticated },
                        page = page,
                        cameraBackupSettings = cameraBackupManager.settings(),
                        transferBatches = transferStore.batches.value,
                        transferFailureNotices = transferStore.failureNotices.value,
                    )
                }
                .onFailure { error ->
                    mediaLibraryManager.clearCloud()
                    mutableState.value = MainUiState(
                        restoring = false,
                        transferBatches = transferStore.batches.value,
                        transferFailureNotices = transferStore.failureNotices.value,
                        error = error.userMessage(),
                    )
                }
        }
        viewModelScope.launch {
            transferStore.batches.collectLatest { batches ->
                mutableState.update { it.copy(transferBatches = batches) }
                val completedUploads = batches.filter { batch ->
                    !batch.active && batch.succeeded > 0 &&
                        batch.direction in setOf(TransferDirection.UPLOAD, TransferDirection.CAMERA_BACKUP) &&
                        refreshedUploadBatches.add(batch.id)
                }
                if (completedUploads.isNotEmpty()) refreshVisibleFolderAfterUpload(completedUploads)
            }
        }
        viewModelScope.launch {
            transferStore.failureNotices.collectLatest { notices ->
                mutableState.update { it.copy(transferFailureNotices = notices) }
            }
        }
        viewModelScope.launch {
            cameraBackupManager.workUpdates().collectLatest {
                mutableState.update { state ->
                    state.copy(cameraBackupSettings = cameraBackupManager.settings())
                }
            }
        }
    }

    fun login(loginId: String, password: String) {
        if (mutableState.value.busy) return
        mutableState.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            runCatching { repository.login(loginId, password) }
                .onSuccess { (session, page) ->
                    mutableState.value = MainUiState(
                        restoring = false,
                        session = session,
                        page = page,
                        cameraBackupSettings = cameraBackupManager.settings(),
                        transferBatches = transferStore.batches.value,
                        transferFailureNotices = transferStore.failureNotices.value,
                    )
                }
                .onFailure { error ->
                    mutableState.update { it.copy(busy = false, error = error.userMessage()) }
                }
        }
    }

    fun openFolder(folder: CloudFolder) {
        if (mutableState.value.busy) return
        mutableState.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            runCatching { repository.openFolder(folder) }
                .onSuccess { page -> showOpenedFolder(folder, page) }
                .onFailure { error ->
                    if (error is FolderPasswordRequiredException) {
                        mutableState.update {
                            it.copy(busy = false, pendingUnlock = error.folder, error = null)
                        }
                    } else {
                        mutableState.update { it.copy(busy = false, error = error.userMessage()) }
                    }
                }
        }
    }

    fun unlockFolder(password: String) {
        val folder = mutableState.value.pendingUnlock ?: return
        if (mutableState.value.busy) return
        mutableState.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            runCatching { repository.unlockAndOpenFolder(folder, password) }
                .onSuccess { page -> showOpenedFolder(folder, page) }
                .onFailure { error ->
                    mutableState.update {
                        it.copy(busy = false, pendingUnlock = folder, error = error.userMessage())
                    }
                }
        }
    }

    fun cancelUnlock() = mutableState.update { it.copy(pendingUnlock = null) }

    fun openCreateFolder() {
        val current = mutableState.value
        if (current.busy || current.session?.canUpload != true) return
        mutableState.update { it.copy(creatingFolder = true, error = null) }
    }

    fun cancelCreateFolder() = mutableState.update { it.copy(creatingFolder = false) }

    fun createFolder(name: String, password: String) {
        val current = mutableState.value
        if (current.busy || current.session?.canUpload != true) return
        val parentId = current.page?.currentFolderId
        if (parentId == null && password.length < 4) {
            mutableState.update { it.copy(error = "最上位フォルダには4文字以上のパスワードが必要です。") }
            return
        }
        mutableState.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            runCatching { repository.createFolder(parentId, name, password) }
                .onSuccess { page ->
                    mutableState.update {
                        it.copy(busy = false, page = page, creatingFolder = false, message = "フォルダを作成しました。")
                    }
                }
                .onFailure { error -> mutableState.update { it.copy(busy = false, error = error.userMessage()) } }
        }
    }

    private fun showOpenedFolder(folder: CloudFolder, page: FolderPage) {
        searchJob?.cancel()
        mutableState.update {
            it.copy(
                busy = false,
                page = page,
                folderStack = it.folderStack + folder,
                pendingUnlock = null,
                searchResults = CloudSearchResults(),
                searchQuery = "",
                searching = false,
                searchScannedCount = 0,
                error = null,
            )
        }
        if (folder.isProtected) mediaLibraryManager.registerCloudRoot(folder.id)
    }

    fun openPlayerLibrary() {
        mutableState.update { it.copy(showingPlayerLibrary = true, error = null) }
        mediaLibraryManager.refreshLocalAsync()
        mediaLibraryManager.refreshCloudAsync()
        mediaLibraryManager.refreshRecommendationsAsync()
    }

    fun closePlayerLibrary() {
        mutableState.update { it.copy(showingPlayerLibrary = false, selectedLibraryMedia = null) }
    }

    fun openLibraryMedia(item: PlayableMediaItem) {
        mediaLibraryManager.ensureStored(item)
        if (item.mediaType == LibraryMediaType.AUDIO && item.source != MediaSourceType.YOUTUBE) {
            runCatching {
                playbackManager.playQueue(
                    mediaLibraryManager.state.value.items,
                    item.stableId,
                    startAtBeginning = false,
                )
            }.onFailure { error -> mutableState.update { it.copy(error = error.userMessage()) } }
        } else {
            mutableState.update { it.copy(selectedLibraryMedia = item) }
            mediaLibraryManager.recordPlayback(item.stableId, item.playbackPositionMs, item.durationMs)
        }
    }

    fun closeLibraryMedia(positionMs: Long = 0L, durationMs: Long = 0L) {
        mutableState.value.selectedLibraryMedia?.let { mediaLibraryManager.recordPlayback(it.stableId, positionMs, durationMs) }
        mutableState.update { it.copy(selectedLibraryMedia = null) }
    }

    suspend fun saveYouTube(input: String): PlayableMediaItem = mediaLibraryManager.saveYouTube(input)

    suspend fun loadMediaArtwork(item: PlayableMediaItem): Bitmap? = mediaLibraryManager.loadArtwork(item)

    fun setMediaFavorite(item: PlayableMediaItem, enabled: Boolean) =
        mediaLibraryManager.setFavorite(item, enabled)

    fun setMediaWatchLater(item: PlayableMediaItem, enabled: Boolean) =
        mediaLibraryManager.setWatchLater(item, enabled)

    fun createMediaPlaylist(name: String): Long = mediaLibraryManager.createPlaylist(name)

    fun addMediaToPlaylist(playlistId: Long, item: PlayableMediaItem) =
        mediaLibraryManager.addToPlaylist(playlistId, item)

    fun setMediaTags(item: PlayableMediaItem, tags: Set<String>) = mediaLibraryManager.setTags(item, tags)

    fun refreshMediaLibrary() {
        mediaLibraryManager.refreshLocalAsync()
        mediaLibraryManager.refreshCloudAsync()
        mediaLibraryManager.refreshRecommendationsAsync(force = true)
    }

    fun goBack(): Boolean {
        val current = mutableState.value
        if (current.selectedLibraryMedia != null) {
            closeLibraryMedia()
            return true
        }
        if (current.showingPlayerLibrary) {
            closePlayerLibrary()
            return true
        }
        if (current.selectedFile != null) {
            closeFile()
            return true
        }
        if (current.pendingUnlock != null) {
            cancelUnlock()
            return true
        }
        if (current.pendingMoveFile != null || current.pendingMoveFolder != null ||
            current.pendingMoveFiles.isNotEmpty() || current.pendingMoveFolders.isNotEmpty()
        ) {
            cancelMove()
            return true
        }
        if (current.pendingRenameFile != null || current.pendingRenameFolder != null) {
            cancelRename()
            return true
        }
        if (current.pendingShareFile != null || current.pendingShareFolder != null ||
            current.pendingShareFiles.isNotEmpty() || current.shareResult != null
        ) {
            cancelShare()
            return true
        }
        if (current.confirmingSelectionDelete) {
            cancelDeleteSelection()
            return true
        }
        if (current.pendingFolderSecurity != null) {
            cancelFolderSecurity()
            return true
        }
        if (current.selectedFileIds.isNotEmpty() || current.selectedFolderIds.isNotEmpty()) {
            clearSelection()
            return true
        }
        if (current.showingOffline) {
            mutableState.update { it.copy(showingOffline = false, offlineEntries = emptyList()) }
            return true
        }
        if (current.showingTrash) {
            mutableState.update { it.copy(showingTrash = false, trashPage = TrashPage(emptyList(), emptyList())) }
            return true
        }
        if (current.folderStack.isEmpty() || current.busy) return false
        val nextStack = current.folderStack.dropLast(1)
        val parentId = nextStack.lastOrNull()?.id
        mutableState.update { it.copy(busy = true, error = null) }
        searchJob?.cancel()
        viewModelScope.launch {
            runCatching { repository.listItems(parentId) }
                .onSuccess { page ->
                    mutableState.update {
                        it.copy(
                            busy = false,
                            page = page,
                            folderStack = nextStack,
                            searchResults = CloudSearchResults(),
                            searchQuery = "",
                            searching = false,
                            searchScannedCount = 0,
                        )
                    }
                }
                .onFailure { error ->
                    mutableState.update { it.copy(busy = false, error = error.userMessage()) }
                }
        }
        return true
    }

    fun search(query: String, kind: String) {
        val normalized = query.trim()
        searchJob?.cancel()
        if (normalized.isBlank()) {
            mutableState.update {
                it.copy(
                    searchResults = CloudSearchResults(),
                    searchQuery = "",
                    searching = false,
                    searchScannedCount = 0,
                )
            }
            return
        }
        val folderId = mutableState.value.page?.currentFolderId
        mutableState.update {
            it.copy(searchQuery = normalized, searching = true, searchScannedCount = 0, error = null)
        }
        searchJob = viewModelScope.launch {
            delay(300)
            runCatching {
                repository.searchItems(folderId, normalized, kind) { scanned ->
                    mutableState.update { current ->
                        if (current.searchQuery == normalized) current.copy(searchScannedCount = scanned)
                        else current
                    }
                }
            }.onSuccess { results ->
                mutableState.update { current ->
                    if (current.searchQuery == normalized) {
                        current.copy(searchResults = results, searching = false)
                    } else current
                }
            }.onFailure { error ->
                if (error is kotlinx.coroutines.CancellationException) return@onFailure
                mutableState.update { current ->
                    if (current.searchQuery == normalized) {
                        current.copy(searching = false, error = error.userMessage())
                    } else current
                }
            }
        }
    }

    fun logout() {
        viewModelScope.launch {
            playbackManager.stop()
            mediaLibraryManager.clearCloud()
            val backup = cameraBackupManager.settings()
            if (backup.enabled) cameraBackupManager.update(
                false,
                backup.wifiOnly,
                backup.chargingOnly,
                backup.includeImages,
                backup.includeVideos,
                backup.allSourceFolders,
                backup.sourceFolderIds,
            )
            repository.logout()
            mutableState.value = MainUiState(
                restoring = false,
                cameraBackupSettings = cameraBackupManager.settings(),
                transferBatches = transferStore.batches.value,
                transferFailureNotices = transferStore.failureNotices.value,
            )
        }
    }

    fun setCurrentFolderAsCameraBackupTarget() {
        val current = mutableState.value
        val folder = current.page?.currentFolder ?: run {
            mutableState.update { it.copy(error = "バックアップ先にするフォルダを開いてください。") }
            return
        }
        if (current.session?.canUpload != true) return
        runCatching { cameraBackupManager.setTarget(folder.id, folder.name) }
            .onSuccess { settings ->
                mutableState.update {
                    it.copy(
                        cameraBackupSettings = settings,
                        message = "${folder.name} をカメラロールの保存先に設定しました。",
                    )
                }
            }
            .onFailure { error -> mutableState.update { it.copy(error = error.userMessage()) } }
    }

    fun updateCameraBackup(
        enabled: Boolean,
        wifiOnly: Boolean,
        chargingOnly: Boolean,
        includeImages: Boolean,
        includeVideos: Boolean,
        allSourceFolders: Boolean,
        sourceFolderIds: Set<String>,
    ) {
        runCatching {
            cameraBackupManager.update(
                enabled,
                wifiOnly,
                chargingOnly,
                includeImages,
                includeVideos,
                allSourceFolders,
                sourceFolderIds,
            )
        }
            .onSuccess { settings ->
                mutableState.update {
                    it.copy(
                        cameraBackupSettings = settings,
                        message = if (enabled) {
                            val targets = buildList {
                                if (includeImages) add("写真")
                                if (includeVideos) add("動画")
                            }.joinToString("・")
                            "カメラロール自動バックアップを有効にしました。既存および今後追加される${targets}が対象です。"
                        } else {
                            "カメラロール自動バックアップを停止しました。"
                        },
                    )
                }
            }
            .onFailure { error -> mutableState.update { it.copy(error = error.userMessage()) } }
    }

    fun refreshCameraBackupSettings() = mutableState.update {
        it.copy(cameraBackupSettings = cameraBackupManager.settings())
    }

    fun refreshCameraBackupSourceFolders() {
        if (mutableState.value.loadingCameraBackupSourceFolders) return
        mutableState.update { it.copy(loadingCameraBackupSourceFolders = true) }
        viewModelScope.launch {
            runCatching { cameraBackupManager.sourceFolders() }
                .onSuccess { folders ->
                    mutableState.update {
                        it.copy(
                            cameraBackupSourceFolders = folders,
                            loadingCameraBackupSourceFolders = false,
                        )
                    }
                }
                .onFailure { error ->
                    mutableState.update {
                        it.copy(
                            loadingCameraBackupSourceFolders = false,
                            error = error.userMessage(),
                        )
                    }
                }
        }
    }

    fun runCameraBackupNow() {
        val settings = cameraBackupManager.runNow()
        mutableState.update {
            it.copy(
                cameraBackupSettings = settings,
                message = if (settings.enabled && settings.hasTarget) {
                    "カメラロールの確認を開始しました。結果は設定画面で確認できます。"
                } else {
                    null
                },
                error = if (!settings.enabled || !settings.hasTarget) {
                    "先に保存先を設定し、自動バックアップを有効にしてください。"
                } else {
                    null
                },
            )
        }
    }

    fun cameraBackupPermissionDenied() = mutableState.update {
        it.copy(error = "写真・動画へのアクセスが許可されなかったため、自動バックアップを開始していません。")
    }

    fun download(file: CloudFile) {
        downloadManager.enqueue(file)
        mutableState.update {
            it.copy(message = "${file.name} のダウンロードを開始しました。通知欄で進行状況を確認できます。")
        }
    }

    fun saveOffline(file: CloudFile) {
        offlineManager.enqueue(file)
        mutableState.update {
            it.copy(message = "${file.name} の暗号化オフライン保存を開始しました。通知欄で進行状況を確認できます。")
        }
    }

    fun downloadSelection() {
        val current = mutableState.value
        val files = current.activeFiles().filter { it.id in current.selectedFileIds }
        if (current.selectedFolderIds.isNotEmpty()) {
            mutableState.update { it.copy(error = "フォルダはダウンロード対象外です。ファイルだけを選択してください。") }
            return
        }
        if (files.isEmpty()) return
        downloadManager.enqueue(files)
        mutableState.update {
            it.copy(
                selectedFileIds = emptySet(),
                selectedFolderIds = emptySet(),
                message = "${files.size}件のダウンロードを開始しました。通知欄で進行状況を確認できます。",
            )
        }
    }

    fun saveSelectionOffline() {
        val current = mutableState.value
        val files = current.activeFiles().filter { it.id in current.selectedFileIds }
        if (current.selectedFolderIds.isNotEmpty()) {
            mutableState.update { it.copy(error = "フォルダはオフライン保存対象外です。ファイルだけを選択してください。") }
            return
        }
        if (files.isEmpty()) return
        files.forEach(offlineManager::enqueue)
        mutableState.update {
            it.copy(
                selectedFileIds = emptySet(),
                selectedFolderIds = emptySet(),
                message = "${files.size}件の暗号化オフライン保存を開始しました。通知欄で進行状況を確認できます。",
            )
        }
    }

    fun openDeleteSelection() {
        val current = mutableState.value
        val count = current.selectedFileIds.size + current.selectedFolderIds.size
        if (current.busy || count == 0) return
        if (!canDeleteSelection(current.session, current.page)) {
            mutableState.update { it.copy(error = "この場所では削除できません。PWで解除したフォルダ内で操作してください。") }
            return
        }
        mutableState.update { it.copy(confirmingSelectionDelete = true, error = null) }
    }

    fun cancelDeleteSelection() = mutableState.update { it.copy(confirmingSelectionDelete = false) }

    fun confirmDeleteSelection() {
        val current = mutableState.value
        val currentPage = current.page ?: return
        val files = current.activeFiles().filter { it.id in current.selectedFileIds }
        val folders = current.activeFolders().filter { it.id in current.selectedFolderIds }
        if (current.busy || (files.isEmpty() && folders.isEmpty()) ||
            !canDeleteSelection(current.session, current.page)
        ) return
        val scopeRootId = if (current.session?.isSubAdmin == true) {
            current.folderStack.firstOrNull { it.isProtected }?.id
        } else {
            null
        }
        if (current.session?.isSubAdmin == true && scopeRootId == null) {
            mutableState.update {
                it.copy(
                    confirmingSelectionDelete = false,
                    error = "PWで解除したフォルダ内だけ削除できます。",
                )
            }
            return
        }
        val count = files.size + folders.size
        mutableState.update { it.copy(busy = true, confirmingSelectionDelete = false, error = null) }
        viewModelScope.launch {
            try {
                repository.deleteItems(files, folders, scopeRootId)
                val page = repository.listItems(currentPage.currentFolderId)
                mediaLibraryManager.refreshCloudAsync()
                mutableState.update {
                    it.copy(
                        busy = false,
                        page = page,
                        selectedFileIds = emptySet(),
                        selectedFolderIds = emptySet(),
                        message = if (current.session?.isAdmin == true) {
                            "${count}件をゴミ箱へ移動しました。"
                        } else {
                            "${count}件を削除しました。"
                        },
                    )
                }
            } catch (error: Exception) {
                val refreshedPage = runCatching { repository.listItems(currentPage.currentFolderId) }.getOrNull()
                mutableState.update {
                    it.copy(
                        busy = false,
                        page = refreshedPage ?: it.page,
                        selectedFileIds = emptySet(),
                        selectedFolderIds = emptySet(),
                        error = error.userMessage(),
                    )
                }
            }
        }
    }

    fun openMove(file: CloudFile) {
        if (mutableState.value.busy || !file.metadataDecrypted) return
        val current = mutableState.value
        val scopeRootId = if (current.session?.isSubAdmin == true) {
            current.folderStack.firstOrNull { it.isProtected }?.id
        } else {
            null
        }
        if (current.session?.isSubAdmin == true && scopeRootId == null) {
            mutableState.update { it.copy(error = "PWで解除したフォルダ内だけ移動できます。") }
            return
        }
        mutableState.update {
            it.copy(
                busy = true,
                pendingMoveFile = file,
                moveDestinations = emptyList(),
                error = null,
            )
        }
        viewModelScope.launch {
            runCatching { repository.listMoveDestinations(scopeRootId) }
                .onSuccess { destinations ->
                    mutableState.update {
                        it.copy(
                            busy = false,
                            moveDestinations = destinations.filterNot { destination ->
                                destination.id == file.folderId
                            },
                        )
                    }
                }
                .onFailure { error ->
                    mutableState.update {
                        it.copy(
                            busy = false,
                            pendingMoveFile = null,
                            moveDestinations = emptyList(),
                            error = error.userMessage(),
                        )
                    }
                }
        }
    }

    fun toggleSelection(file: CloudFile) = mutableState.update { state ->
        val selected = state.selectedFileIds.toMutableSet()
        if (!selected.add(file.id)) selected.remove(file.id)
        state.copy(selectedFileIds = selected)
    }

    fun toggleSelection(folder: CloudFolder) = mutableState.update { state ->
        val selected = state.selectedFolderIds.toMutableSet()
        if (!selected.add(folder.id)) selected.remove(folder.id)
        state.copy(selectedFolderIds = selected)
    }

    fun selectAll() = mutableState.update { state ->
        state.copy(
            selectedFileIds = state.activeFiles().mapTo(mutableSetOf()) { it.id },
            selectedFolderIds = state.activeFolders().mapTo(mutableSetOf()) { it.id },
        )
    }

    fun clearSelection() = mutableState.update {
        it.copy(selectedFileIds = emptySet(), selectedFolderIds = emptySet())
    }

    fun openFolderSecuritySelection() {
        val current = mutableState.value
        if (current.busy || current.selectedFileIds.isNotEmpty() || current.selectedFolderIds.size != 1) return
        val folder = current.activeFolders().firstOrNull { it.id in current.selectedFolderIds } ?: return
        if (current.session?.isSubAdmin == true && !folder.isUnlocked &&
            (folder.isProtected || current.page?.canTrashContents != true)
        ) {
            mutableState.update { it.copy(error = "先にフォルダのPWを解除してください。") }
            return
        }
        mutableState.update { it.copy(pendingFolderSecurity = folder, error = null) }
    }

    fun changePendingFolderPassword(password: String) {
        val current = mutableState.value
        val folder = current.pendingFolderSecurity ?: return
        if (current.busy) return
        mutableState.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            runCatching {
                repository.changeFolderPassword(folder, password)
                repository.listItems(current.page?.currentFolderId)
            }.onSuccess { page ->
                mediaLibraryManager.refreshCloudAsync()
                mutableState.update {
                    it.copy(
                        busy = false,
                        page = page,
                        pendingFolderSecurity = null,
                        selectedFolderIds = emptySet(),
                        message = "フォルダPWを変更しました。",
                    )
                }
            }.onFailure { error ->
                mutableState.update { it.copy(busy = false, error = error.userMessage()) }
            }
        }
    }

    fun lockPendingFolder() {
        val current = mutableState.value
        val folder = current.pendingFolderSecurity ?: return
        if (current.busy) return
        mutableState.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            runCatching {
                repository.lockFolder(folder)
                mediaLibraryManager.removeCloudPath(folder.id)
                repository.listItems(current.page?.currentFolderId)
            }.onSuccess { page ->
                mutableState.update {
                    it.copy(
                        busy = false,
                        page = page,
                        pendingFolderSecurity = null,
                        selectedFolderIds = emptySet(),
                        message = "フォルダを再ロックしました。",
                    )
                }
            }.onFailure { error ->
                mutableState.update { it.copy(busy = false, error = error.userMessage()) }
            }
        }
    }

    fun cancelFolderSecurity() = mutableState.update { it.copy(pendingFolderSecurity = null) }

    fun openMoveSelection() {
        val current = mutableState.value
        if (current.busy) return
        val files = current.activeFiles().filter { it.id in current.selectedFileIds }
        val folders = current.activeFolders().filter { it.id in current.selectedFolderIds }
        if (files.isEmpty() && folders.isEmpty()) return
        val scopeRootId = if (current.session?.isSubAdmin == true) {
            current.folderStack.firstOrNull { it.isProtected }?.id
        } else null
        if (current.session?.isSubAdmin == true && scopeRootId == null) {
            mutableState.update { it.copy(error = "PWで解除したフォルダ内だけ移動できます。") }
            return
        }
        mutableState.update {
            it.copy(
                busy = true,
                pendingMoveFiles = files,
                pendingMoveFolders = folders,
                moveDestinations = emptyList(),
                error = null,
            )
        }
        viewModelScope.launch {
            runCatching { repository.listMoveDestinations(scopeRootId) }
                .onSuccess { destinations ->
                    val excluded = folders.mapTo(mutableSetOf()) { it.id }
                    var changed: Boolean
                    do {
                        changed = false
                        destinations.forEach { destination ->
                            if (destination.parentId in excluded && excluded.add(destination.id)) changed = true
                        }
                    } while (changed)
                    val currentFolderId = current.page?.currentFolderId
                    mutableState.update {
                        it.copy(
                            busy = false,
                            moveDestinations = destinations.filterNot { destination ->
                                destination.id in excluded || destination.id == currentFolderId
                            },
                        )
                    }
                }
                .onFailure { error ->
                    mutableState.update {
                        it.copy(
                            busy = false,
                            pendingMoveFiles = emptyList(),
                            pendingMoveFolders = emptyList(),
                            error = error.userMessage(),
                        )
                    }
                }
        }
    }

    fun openMoveFolder(folder: CloudFolder) {
        if (mutableState.value.busy) return
        val current = mutableState.value
        val scopeRootId = if (current.session?.isSubAdmin == true) {
            current.folderStack.firstOrNull { it.isProtected }?.id
        } else {
            null
        }
        if (current.session?.isSubAdmin == true && scopeRootId == null) {
            mutableState.update { it.copy(error = "PWで解除したフォルダ内だけ移動できます。") }
            return
        }
        mutableState.update {
            it.copy(
                busy = true,
                pendingMoveFolder = folder,
                moveDestinations = emptyList(),
                error = null,
            )
        }
        viewModelScope.launch {
            runCatching { repository.listMoveDestinations(scopeRootId) }
                .onSuccess { destinations ->
                    val excluded = mutableSetOf(folder.id)
                    var changed: Boolean
                    do {
                        changed = false
                        destinations.forEach { destination ->
                            if (destination.parentId in excluded && excluded.add(destination.id)) changed = true
                        }
                    } while (changed)
                    mutableState.update {
                        it.copy(
                            busy = false,
                            moveDestinations = destinations.filterNot { destination ->
                                destination.id in excluded || destination.id == folder.parentId
                            },
                        )
                    }
                }
                .onFailure { error ->
                    mutableState.update {
                        it.copy(
                            busy = false,
                            pendingMoveFolder = null,
                            moveDestinations = emptyList(),
                            error = error.userMessage(),
                        )
                    }
                }
        }
    }

    fun moveFile(destinationFolderId: Long) {
        val current = mutableState.value
        val file = current.pendingMoveFile ?: return
        if (current.busy) return
        mutableState.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            runCatching {
                repository.moveFile(file, destinationFolderId)
                repository.listItems(current.page?.currentFolderId)
            }
                .onSuccess { page ->
                    mediaLibraryManager.refreshCloudAsync()
                    mutableState.update {
                        it.copy(
                            busy = false,
                            page = page,
                            pendingMoveFile = null,
                            moveDestinations = emptyList(),
                            message = "${file.name} を移動しました。",
                        )
                    }
                }
                .onFailure { error ->
                    mutableState.update { it.copy(busy = false, error = error.userMessage()) }
                }
        }
    }

    fun moveFolder(destinationFolderId: Long) {
        val current = mutableState.value
        val folder = current.pendingMoveFolder ?: return
        if (current.busy) return
        mutableState.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            runCatching {
                repository.moveFolder(folder, destinationFolderId)
                repository.listItems(current.page?.currentFolderId)
            }
                .onSuccess { page ->
                    mediaLibraryManager.refreshCloudAsync()
                    mutableState.update {
                        it.copy(
                            busy = false,
                            page = page,
                            pendingMoveFolder = null,
                            moveDestinations = emptyList(),
                            message = "${folder.name} を移動しました。",
                        )
                    }
                }
                .onFailure { error ->
                    mutableState.update { it.copy(busy = false, error = error.userMessage()) }
                }
        }
    }

    fun moveSelection(destinationFolderId: Long) {
        val current = mutableState.value
        val files = current.pendingMoveFiles
        val folders = current.pendingMoveFolders
        if (current.busy || (files.isEmpty() && folders.isEmpty())) return
        mutableState.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            runCatching {
                repository.moveItems(files, folders, destinationFolderId)
                repository.listItems(current.page?.currentFolderId)
            }
                .onSuccess { page ->
                    mediaLibraryManager.refreshCloudAsync()
                    mutableState.update {
                        it.copy(
                            busy = false,
                            page = page,
                            pendingMoveFiles = emptyList(),
                            pendingMoveFolders = emptyList(),
                            moveDestinations = emptyList(),
                            selectedFileIds = emptySet(),
                            selectedFolderIds = emptySet(),
                            message = "${files.size + folders.size}件を移動しました。",
                        )
                    }
                }
                .onFailure { error ->
                    mutableState.update { it.copy(busy = false, error = error.userMessage()) }
                }
        }
    }

    fun cancelMove() = mutableState.update {
        it.copy(
            pendingMoveFile = null,
            pendingMoveFolder = null,
            pendingMoveFiles = emptyList(),
            pendingMoveFolders = emptyList(),
            moveDestinations = emptyList(),
        )
    }

    fun openRename(file: CloudFile) {
        if (mutableState.value.busy || !file.metadataDecrypted) return
        mutableState.update { it.copy(pendingRenameFile = file, pendingRenameFolder = null, error = null) }
    }

    fun openRename(folder: CloudFolder) {
        if (mutableState.value.busy) return
        mutableState.update { it.copy(pendingRenameFolder = folder, pendingRenameFile = null, error = null) }
    }

    fun renamePending(newName: String) {
        val current = mutableState.value
        val file = current.pendingRenameFile
        val folder = current.pendingRenameFolder
        if (current.busy || (file == null && folder == null)) return
        mutableState.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            runCatching {
                if (file != null) repository.renameFile(file, newName)
                else repository.renameFolder(checkNotNull(folder), newName)
                repository.listItems(current.page?.currentFolderId)
            }
                .onSuccess { page ->
                    mediaLibraryManager.refreshCloudAsync()
                    mutableState.update {
                        it.copy(
                            busy = false,
                            page = page,
                            pendingRenameFile = null,
                            pendingRenameFolder = null,
                            message = "名前を変更しました。",
                        )
                    }
                }
                .onFailure { error ->
                    mutableState.update { it.copy(busy = false, error = error.userMessage()) }
                }
        }
    }

    fun cancelRename() = mutableState.update {
        it.copy(pendingRenameFile = null, pendingRenameFolder = null)
    }

    fun openShare(file: CloudFile) {
        if (mutableState.value.busy || !file.metadataDecrypted) return
        mutableState.update {
            it.copy(pendingShareFile = file, pendingShareFolder = null, shareResult = null, error = null)
        }
    }

    fun openShare(folder: CloudFolder) {
        if (mutableState.value.busy) return
        mutableState.update {
            it.copy(pendingShareFolder = folder, pendingShareFile = null, shareResult = null, error = null)
        }
    }

    fun openShareSelection() {
        val current = mutableState.value
        val files = current.activeFiles().filter { it.id in current.selectedFileIds }
        val folders = current.activeFolders().filter { it.id in current.selectedFolderIds }
        if (files.map { it.folderId }.distinct().size > 1) {
            mutableState.update { it.copy(error = "複数フォルダのファイルはフォルダごとに共有してください。") }
            return
        }
        when {
            folders.isEmpty() && files.size == 1 -> openShare(files.first())
            folders.isEmpty() && files.size in 2..100 -> mutableState.update {
                it.copy(
                    pendingShareFiles = files,
                    pendingShareFile = null,
                    pendingShareFolder = null,
                    shareResult = null,
                    error = null,
                )
            }
            folders.size == 1 && files.isEmpty() -> openShare(folders.first())
            else -> mutableState.update {
                it.copy(error = "共有は1つのフォルダ、または同じ場所のファイル1〜100件を選択してください。")
            }
        }
    }

    fun createShare(password: String, validDays: Int) {
        val current = mutableState.value
        val file = current.pendingShareFile
        val folder = current.pendingShareFolder
        val files = current.pendingShareFiles
        if (current.busy || (file == null && folder == null && files.isEmpty())) return
        if (validDays !in 1..3650) {
            mutableState.update { it.copy(error = "有効期間は1日から3650日の範囲で設定してください。") }
            return
        }
        val expiresAt = System.currentTimeMillis() / 1000 + validDays * 24L * 60L * 60L
        mutableState.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            runCatching {
                when {
                    files.isNotEmpty() -> repository.createShare(files, password, expiresAt)
                    file != null -> repository.createShare(file, password, expiresAt)
                    else -> repository.createShare(checkNotNull(folder), password, expiresAt)
                }
            }
                .onSuccess { result ->
                    mutableState.update {
                        it.copy(
                            busy = false,
                            pendingShareFile = null,
                            pendingShareFolder = null,
                            pendingShareFiles = emptyList(),
                            shareResult = result,
                            selectedFileIds = emptySet(),
                            selectedFolderIds = emptySet(),
                            message = "共有URLを発行しました。",
                        )
                    }
                }
                .onFailure { error ->
                    mutableState.update { it.copy(busy = false, error = error.userMessage()) }
                }
        }
    }

    fun cancelShare() = mutableState.update {
        it.copy(
            pendingShareFile = null,
            pendingShareFolder = null,
            pendingShareFiles = emptyList(),
            shareResult = null,
        )
    }

    fun openOffline() {
        if (mutableState.value.busy) return
        mutableState.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { repository.listOfflineEntries() } }
                .onSuccess { entries ->
                    mutableState.update {
                        it.copy(busy = false, showingOffline = true, offlineEntries = entries)
                    }
                }
                .onFailure { error ->
                    mutableState.update { it.copy(busy = false, error = error.userMessage()) }
                }
        }
    }

    fun deleteOffline(fileId: Long) {
        if (mutableState.value.busy) return
        mutableState.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { repository.deleteOfflineFile(fileId) } }
                .onSuccess { deleted ->
                    mutableState.update {
                        it.copy(
                            busy = false,
                            offlineEntries = if (deleted) {
                                it.offlineEntries.filterNot { entry -> entry.file.id == fileId }
                            } else {
                                it.offlineEntries
                            },
                            message = if (deleted) "端末保存データを削除しました。" else null,
                            error = if (deleted) null else "端末保存データを削除できませんでした。",
                        )
                    }
                }
                .onFailure { error ->
                    mutableState.update { it.copy(busy = false, error = error.userMessage()) }
                }
        }
    }

    fun deleteOfflineSelection(fileIds: Set<Long>) {
        if (mutableState.value.busy || fileIds.isEmpty()) return
        mutableState.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { repository.deleteOfflineFiles(fileIds) } }
                .onSuccess { count ->
                    mutableState.update {
                        it.copy(
                            busy = false,
                            offlineEntries = it.offlineEntries.filterNot { entry -> entry.file.id in fileIds },
                            message = "端末保存から${count}件を削除しました。",
                        )
                    }
                }
                .onFailure { error -> mutableState.update { it.copy(busy = false, error = error.userMessage()) } }
        }
    }

    fun refreshUsage() {
        if (mutableState.value.session?.isAdmin != true || mutableState.value.busy) return
        viewModelScope.launch {
            runCatching { repository.usage() to repository.usageDetails() }
                .onSuccess { (usage, details) ->
                    mutableState.update { it.copy(cloudUsage = usage, usageDetails = details) }
                }
                .onFailure { error -> mutableState.update { it.copy(error = error.userMessage()) } }
        }
    }

    fun openTrash() {
        if (mutableState.value.session?.isAdmin != true || mutableState.value.busy) return
        mutableState.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            runCatching { repository.listTrash() }
                .onSuccess { page -> mutableState.update { it.copy(busy = false, showingTrash = true, trashPage = page) } }
                .onFailure { error -> mutableState.update { it.copy(busy = false, error = error.userMessage()) } }
        }
    }

    fun restoreTrashFile(fileId: Long) = updateTrash("ファイルを復元しました。") {
        repository.restoreTrashFile(fileId)
    }

    fun permanentlyDeleteTrashFile(fileId: Long) = updateTrash("ファイルを完全に削除しました。") {
        repository.permanentlyDeleteTrashFile(fileId)
    }

    fun restoreTrashFolder(folderId: Long) = updateTrash("フォルダを復元しました。") {
        repository.restoreTrashFolder(folderId)
    }

    fun emptyTrash() = updateTrash("ゴミ箱を空にしました。") {
        var complete = false
        var attempts = 0
        while (!complete && attempts < 100) {
            complete = repository.emptyTrash()
            attempts += 1
        }
        check(complete) { "ゴミ箱の削除が完了していません。もう一度お試しください。" }
    }

    private fun updateTrash(message: String, operation: suspend () -> Unit) {
        if (mutableState.value.busy) return
        mutableState.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            runCatching {
                operation()
                repository.listTrash()
            }.onSuccess { page ->
                mediaLibraryManager.refreshCloudAsync()
                mutableState.update { it.copy(busy = false, trashPage = page, message = message) }
            }.onFailure { error -> mutableState.update { it.copy(busy = false, error = error.userMessage()) } }
        }
    }

    fun upload(uris: List<Uri>) {
        val folderId = mutableState.value.page?.currentFolderId ?: return
        if (uris.isEmpty()) return
        uploadManager.enqueue(folderId, uris)
        mutableState.update {
            it.copy(message = "${uris.size}件のアップロードを開始しました。通知欄で進行状況を確認できます。")
        }
    }

    fun cancelTransfer(batchId: String) {
        viewModelScope.launch {
            runCatching { transferCancellation.cancel(batchId) }
                .onFailure { error -> mutableState.update { it.copy(error = error.userMessage()) } }
        }
    }

    fun dismissTransferFailureNotice(noticeId: String) {
        transferStore.dismissFailureNotice(noticeId)
    }

    private suspend fun refreshVisibleFolderAfterUpload(batches: List<TransferBatchSnapshot>) {
        val current = mutableState.value
        val folderId = current.page?.currentFolderId ?: return
        if (batches.none { folderId in it.folderIds }) return
        runCatching { repository.listItems(folderId) }
            .onSuccess { refreshed ->
                mediaLibraryManager.refreshCloudAsync()
                mutableState.update { state ->
                    if (state.page?.currentFolderId == folderId) state.copy(page = refreshed) else state
                }
            }
    }

    fun openFile(file: CloudFile) = openFile(file, startAtBeginning = false)

    private fun openFile(file: CloudFile, startAtBeginning: Boolean) {
        if (!file.metadataDecrypted || file.mediaKind !in setOf("image", "video", "audio")) return
        imageLoadJob?.cancel()
        if (file.mediaKind != "image") {
            if (file.mediaKind == "video") playbackManager.stop()
            mutableState.update {
                it.copy(
                    selectedFile = file,
                    selectedFileStartsAtBeginning = startAtBeginning,
                    imageBitmap = null,
                    imageLoading = false,
                    imageError = null,
                )
            }
            return
        }
        mutableState.update {
            it.copy(
                selectedFile = file,
                selectedFileStartsAtBeginning = false,
                imageBitmap = null,
                imageLoading = true,
                imageError = null,
            )
        }
        imageLoadJob = viewModelScope.launch {
            runCatching { loadImage(file) }
                .onSuccess { bitmap ->
                    if (mutableState.value.selectedFile?.id == file.id) {
                        mutableState.update {
                            it.copy(imageBitmap = bitmap, imageLoading = false, imageError = null)
                        }
                    }
                }
                .onFailure { error ->
                    if (mutableState.value.selectedFile?.id == file.id) {
                        mutableState.update {
                            it.copy(imageBitmap = null, imageLoading = false, imageError = error.userMessage())
                        }
                    }
                }
        }
    }

    fun loadThumbnail(file: CloudFile) {
        if (!file.hasThumbnail || !file.metadataDecrypted ||
            mutableState.value.thumbnailBitmaps.containsKey(file.id) || thumbnailJobs.containsKey(file.id)
        ) return
        thumbnailJobs[file.id] = viewModelScope.launch {
            runCatching {
                val bytes = repository.loadThumbnail(file)
                try {
                    withContext(Dispatchers.Default) {
                        BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                            ?: error("サムネイルを表示できません。")
                    }
                } finally {
                    bytes.fill(0)
                }
            }.onSuccess { bitmap ->
                mutableState.update { current ->
                    val entries = LinkedHashMap(current.thumbnailBitmaps)
                    entries[file.id] = bitmap
                    while (entries.size > 96) {
                        val first = entries.entries.first()
                        entries.remove(first.key)?.recycle()
                    }
                    current.copy(thumbnailBitmaps = entries)
                }
            }
            thumbnailJobs.remove(file.id)
        }
    }

    fun closeFile() {
        imageLoadJob?.cancel()
        imageLoadJob = null
        mutableState.update {
            it.copy(
                selectedFile = null,
                selectedFileStartsAtBeginning = false,
                imageBitmap = null,
                imageLoading = false,
                imageError = null,
            )
        }
    }

    fun navigateImage(direction: Int) {
        val current = mutableState.value
        val selected = current.selectedFile ?: return
        val images = current.page?.files.orEmpty().filter { it.metadataDecrypted && it.mediaKind == "image" }
        val index = images.indexOfFirst { it.id == selected.id }
        if (index < 0 || images.isEmpty()) return
        val next = (index + direction).coerceIn(0, images.lastIndex)
        if (next != index) openFile(images[next])
    }

    fun navigateMedia(direction: Int, automaticRepeat: Boolean = false) {
        val current = mutableState.value
        val selected = current.selectedFile
        val currentFileId = selected?.id ?: playbackManager.currentFileId ?: return
        val mediaKind = selected?.mediaKind ?: "audio"
        val mediaFiles = current.activeFiles().filter {
            it.metadataDecrypted && it.mediaKind == mediaKind
        }
        val index = mediaFiles.indexOfFirst { it.id == currentFileId }
        if (index < 0 || mediaFiles.isEmpty()) return
        val next = nextMediaIndex(index, mediaFiles.size, direction, automaticRepeat) ?: return
        val nextFile = mediaFiles[next]
        if (selected != null) {
            openFile(nextFile, startAtBeginning = automaticRepeat)
        } else {
            playbackManager.playAudio(
                nextFile,
                playbackDataSource(nextFile),
                startAtBeginning = automaticRepeat,
            )
        }
    }

    fun playbackDataSource(file: CloudFile) = TCloudDataSource.Factory(repository, file)

    fun clearError() = mutableState.update { it.copy(error = null) }

    fun clearMessage() = mutableState.update { it.copy(message = null) }

    private fun Throwable.userMessage(): String = message?.takeIf { it.isNotBlank() }
        ?: "処理を完了できませんでした。"

    private suspend fun loadImage(file: CloudFile): Bitmap {
        val plain = repository.loadPlainFile(file, MAX_IMAGE_FILE_BYTES)
        return try {
            withContext(Dispatchers.Default) {
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(plain, 0, plain.size, bounds)
                check(bounds.outWidth > 0 && bounds.outHeight > 0) { "対応していない画像形式です。" }
                var sampleSize = 1
                while (bounds.outWidth / sampleSize > MAX_IMAGE_EDGE_PIXELS ||
                    bounds.outHeight / sampleSize > MAX_IMAGE_EDGE_PIXELS
                ) {
                    sampleSize *= 2
                }
                checkNotNull(
                    BitmapFactory.decodeByteArray(
                        plain,
                        0,
                        plain.size,
                        BitmapFactory.Options().apply {
                            inSampleSize = sampleSize
                            inPreferredConfig = Bitmap.Config.ARGB_8888
                        },
                    ),
                ) { "画像を表示用に変換できませんでした。" }
            }
        } finally {
            plain.fill(0)
        }
    }

    private companion object {
        const val MAX_IMAGE_FILE_BYTES = 128L * 1024 * 1024
        const val MAX_IMAGE_EDGE_PIXELS = 4096
    }
}

internal fun nextMediaIndex(
    currentIndex: Int,
    itemCount: Int,
    direction: Int,
    automaticRepeat: Boolean,
): Int? {
    if (itemCount <= 0 || currentIndex !in 0 until itemCount || direction == 0) return null
    val requested = currentIndex + direction
    return when {
        requested in 0 until itemCount -> requested
        automaticRepeat && direction > 0 -> 0
        automaticRepeat && direction < 0 -> itemCount - 1
        else -> null
    }
}
