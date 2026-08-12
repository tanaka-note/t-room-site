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
import jp.tanaka.tcloud.data.MoveDestination
import jp.tanaka.tcloud.data.Session
import jp.tanaka.tcloud.data.ShareResult
import jp.tanaka.tcloud.data.TCloudRepository
import jp.tanaka.tcloud.transfer.TCloudDownloadManager
import jp.tanaka.tcloud.transfer.TCloudUploadManager
import jp.tanaka.tcloud.media.TCloudDataSource
import jp.tanaka.tcloud.offline.TCloudOfflineManager
import jp.tanaka.tcloud.offline.TCloudOfflineStore
import jp.tanaka.tcloud.backup.CameraBackupManager
import jp.tanaka.tcloud.backup.CameraBackupSettings
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.withContext

data class MainUiState(
    val restoring: Boolean = true,
    val busy: Boolean = false,
    val session: Session? = null,
    val page: FolderPage? = null,
    val folderStack: List<CloudFolder> = emptyList(),
    val pendingUnlock: CloudFolder? = null,
    val selectedFile: CloudFile? = null,
    val imageBitmap: Bitmap? = null,
    val imageLoading: Boolean = false,
    val imageError: String? = null,
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
    val cameraBackupSettings: CameraBackupSettings = CameraBackupSettings(),
    val showingOffline: Boolean = false,
    val offlineEntries: List<TCloudOfflineStore.OfflineEntry> = emptyList(),
    val message: String? = null,
    val error: String? = null,
)

class MainViewModel(
    private val repository: TCloudRepository,
    private val downloadManager: TCloudDownloadManager,
    private val uploadManager: TCloudUploadManager,
    private val offlineManager: TCloudOfflineManager,
    private val cameraBackupManager: CameraBackupManager,
) : ViewModel() {
    private val mutableState = MutableStateFlow(MainUiState())
    val state: StateFlow<MainUiState> = mutableState.asStateFlow()
    private var imageLoadJob: Job? = null

    init {
        viewModelScope.launch {
            runCatching { repository.restore() }
                .onSuccess { (session, page) ->
                    mutableState.value = MainUiState(
                        restoring = false,
                        session = session.takeIf { it.authenticated },
                        page = page,
                        cameraBackupSettings = cameraBackupManager.settings(),
                    )
                }
                .onFailure { error ->
                    mutableState.value = MainUiState(restoring = false, error = error.userMessage())
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

    private fun showOpenedFolder(folder: CloudFolder, page: FolderPage) {
        mutableState.update {
            it.copy(
                busy = false,
                page = page,
                folderStack = it.folderStack + folder,
                pendingUnlock = null,
                error = null,
            )
        }
    }

    fun goBack(): Boolean {
        val current = mutableState.value
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
        if (current.selectedFileIds.isNotEmpty() || current.selectedFolderIds.isNotEmpty()) {
            clearSelection()
            return true
        }
        if (current.showingOffline) {
            mutableState.update { it.copy(showingOffline = false, offlineEntries = emptyList()) }
            return true
        }
        if (current.folderStack.isEmpty() || current.busy) return false
        val nextStack = current.folderStack.dropLast(1)
        val parentId = nextStack.lastOrNull()?.id
        mutableState.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            runCatching { repository.listItems(parentId) }
                .onSuccess { page ->
                    mutableState.update { it.copy(busy = false, page = page, folderStack = nextStack) }
                }
                .onFailure { error ->
                    mutableState.update { it.copy(busy = false, error = error.userMessage()) }
                }
        }
        return true
    }

    fun logout() {
        viewModelScope.launch {
            val backup = cameraBackupManager.settings()
            if (backup.enabled) cameraBackupManager.update(false, backup.wifiOnly, backup.chargingOnly)
            repository.logout()
            mutableState.value = MainUiState(
                restoring = false,
                cameraBackupSettings = cameraBackupManager.settings(),
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

    fun updateCameraBackup(enabled: Boolean, wifiOnly: Boolean, chargingOnly: Boolean) {
        runCatching { cameraBackupManager.update(enabled, wifiOnly, chargingOnly) }
            .onSuccess { settings ->
                mutableState.update {
                    it.copy(
                        cameraBackupSettings = settings,
                        message = if (enabled) {
                            "カメラロール自動バックアップを有効にしました。今後追加される写真・動画が対象です。"
                        } else {
                            "カメラロール自動バックアップを停止しました。"
                        },
                    )
                }
            }
            .onFailure { error -> mutableState.update { it.copy(error = error.userMessage()) } }
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
        val files = current.page?.files.orEmpty().filter { it.id in current.selectedFileIds }
        if (current.selectedFolderIds.isNotEmpty()) {
            mutableState.update { it.copy(error = "フォルダはダウンロード対象外です。ファイルだけを選択してください。") }
            return
        }
        if (files.isEmpty()) return
        files.forEach(downloadManager::enqueue)
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
        val files = current.page?.files.orEmpty().filter { it.id in current.selectedFileIds }
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
        if (current.page?.canTrashContents != true) {
            mutableState.update { it.copy(error = "この場所では削除できません。PWで解除したフォルダ内で操作してください。") }
            return
        }
        mutableState.update { it.copy(confirmingSelectionDelete = true, error = null) }
    }

    fun cancelDeleteSelection() = mutableState.update { it.copy(confirmingSelectionDelete = false) }

    fun confirmDeleteSelection() {
        val current = mutableState.value
        val files = current.page?.files.orEmpty().filter { it.id in current.selectedFileIds }
        val folders = current.page?.folders.orEmpty().filter { it.id in current.selectedFolderIds }
        if (current.busy || (files.isEmpty() && folders.isEmpty()) || current.page?.canTrashContents != true) return
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
                val page = repository.listItems(current.page.currentFolderId)
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
                val refreshedPage = runCatching { repository.listItems(current.page.currentFolderId) }.getOrNull()
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
            selectedFileIds = state.page?.files.orEmpty().filter { it.metadataDecrypted }.mapTo(mutableSetOf()) { it.id },
            selectedFolderIds = state.page?.folders.orEmpty().mapTo(mutableSetOf()) { it.id },
        )
    }

    fun clearSelection() = mutableState.update {
        it.copy(selectedFileIds = emptySet(), selectedFolderIds = emptySet())
    }

    fun openMoveSelection() {
        val current = mutableState.value
        if (current.busy) return
        val files = current.page?.files.orEmpty().filter { it.id in current.selectedFileIds }
        val folders = current.page?.folders.orEmpty().filter { it.id in current.selectedFolderIds }
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
        val files = current.page?.files.orEmpty().filter { it.id in current.selectedFileIds }
        val folders = current.page?.folders.orEmpty().filter { it.id in current.selectedFolderIds }
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

    fun upload(uris: List<Uri>) {
        val folderId = mutableState.value.page?.currentFolderId ?: return
        if (uris.isEmpty()) return
        uploadManager.enqueue(folderId, uris)
        mutableState.update {
            it.copy(message = "${uris.size}件のアップロードを開始しました。通知欄で進行状況を確認できます。")
        }
    }

    fun openFile(file: CloudFile) {
        if (!file.metadataDecrypted || file.mediaKind !in setOf("image", "video", "audio")) return
        imageLoadJob?.cancel()
        if (file.mediaKind != "image") {
            mutableState.update {
                it.copy(selectedFile = file, imageBitmap = null, imageLoading = false, imageError = null)
            }
            return
        }
        mutableState.update {
            it.copy(selectedFile = file, imageBitmap = null, imageLoading = true, imageError = null)
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

    fun closeFile() {
        imageLoadJob?.cancel()
        imageLoadJob = null
        mutableState.update {
            it.copy(selectedFile = null, imageBitmap = null, imageLoading = false, imageError = null)
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
