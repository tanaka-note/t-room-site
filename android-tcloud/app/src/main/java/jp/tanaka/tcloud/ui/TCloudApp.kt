package jp.tanaka.tcloud.ui

import android.Manifest
import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.pm.ActivityInfo
import android.graphics.Bitmap
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.os.Build
import android.os.PowerManager
import android.app.Activity
import android.app.PictureInPictureParams
import android.util.Rational
import android.provider.Settings
import android.net.Uri
import android.widget.Toast
import android.view.View
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.WindowInsets
import android.view.WindowInsetsController
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.Image
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.rememberTransformableState
import androidx.compose.foundation.gestures.transformable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.InsertDriveFile
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.automirrored.filled.ViewList
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.CreateNewFolder
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.DownloadForOffline
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.OfflinePin
import androidx.compose.material.icons.filled.DeleteOutline
import androidx.compose.material.icons.filled.DeleteForever
import androidx.compose.material.icons.filled.RestoreFromTrash
import androidx.compose.material.icons.filled.ChevronLeft
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Settings as SettingsIcon
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.LockOpen
import androidx.compose.material.icons.filled.Movie
import androidx.compose.material.icons.filled.MusicNote
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.SelectAll
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.automirrored.filled.DriveFileMove
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material.icons.filled.GridView
import androidx.compose.material.icons.filled.Cast
import androidx.compose.material.icons.filled.PictureInPictureAlt
import androidx.compose.material.icons.filled.Repeat
import androidx.compose.material.icons.filled.RepeatOne
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material.icons.filled.SkipPrevious
import androidx.compose.material.icons.automirrored.filled.PlaylistPlay
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.draw.clip
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import jp.tanaka.tcloud.MainViewModel
import jp.tanaka.tcloud.R
import jp.tanaka.tcloud.TCloudApplication
import jp.tanaka.tcloud.data.CloudFile
import jp.tanaka.tcloud.data.CloudFolder
import jp.tanaka.tcloud.data.MoveDestination
import jp.tanaka.tcloud.data.ShareResult
import jp.tanaka.tcloud.data.CloudUsage
import jp.tanaka.tcloud.data.CloudUsageFolder
import jp.tanaka.tcloud.data.TrashPage
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.media3.ui.PlayerView
import java.text.DecimalFormat
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.security.SecureRandom
import jp.tanaka.tcloud.offline.TCloudOfflineStore
import jp.tanaka.tcloud.backup.CameraBackupSettings
import jp.tanaka.tcloud.backup.CameraBackupSourceFolder
import jp.tanaka.tcloud.media.TvCastLauncher
import jp.tanaka.tcloud.media.TCloudPlaybackManager
import kotlinx.coroutines.delay

private val TCloudBlue = Color(0xFF16756D)
private val TCloudBlueDark = Color(0xFF0F5B55)
private val TCloudBackground = Color(0xFFF4F7F8)
private val TCloudLine = Color(0xFFDCE2E7)
private val TCloudMuted = Color(0xFF68737D)
private val TCloudSelection = Color(0xFFE4F3F0)

private data class PendingCameraBackupSettings(
    val enabled: Boolean,
    val wifiOnly: Boolean,
    val chargingOnly: Boolean,
    val includeImages: Boolean,
    val includeVideos: Boolean,
    val allSourceFolders: Boolean,
    val sourceFolderIds: Set<String>,
)

@Composable
fun TCloudApp(viewModel: MainViewModel, pictureInPicture: Boolean = false) {
    val state by viewModel.state.collectAsState()
    val snackbar = remember { SnackbarHostState() }
    val context = LocalContext.current
    val playbackManager = remember {
        (context.applicationContext as TCloudApplication).playbackManager
    }
    DisposableEffect(viewModel, playbackManager) {
        playbackManager.playPrevious = { automatic -> viewModel.navigateMedia(-1, automatic) }
        playbackManager.playNext = { automatic -> viewModel.navigateMedia(1, automatic) }
        onDispose {
            playbackManager.playPrevious = null
            playbackManager.playNext = null
        }
    }
    val powerManager = remember { context.getSystemService(PowerManager::class.java) }
    var batteryOptimizationExcluded by remember {
        mutableStateOf(powerManager.isIgnoringBatteryOptimizations(context.packageName))
    }
    var showAppSettings by remember { mutableStateOf(false) }
    val batterySettingsLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) {
        batteryOptimizationExcluded = powerManager.isIgnoringBatteryOptimizations(context.packageName)
    }
    var pendingTransfer by remember { mutableStateOf<Pair<CloudFile, Boolean>?>(null) }
    var pendingSelectionTransfer by remember { mutableStateOf<Boolean?>(null) }
    var pendingCameraBackupSettings by remember { mutableStateOf<PendingCameraBackupSettings?>(null) }
    var pendingCameraFolderScan by remember { mutableStateOf(false) }
    var pendingAudioFile by remember { mutableStateOf<CloudFile?>(null) }

    fun hasCameraMediaPermission(includeImages: Boolean, includeVideos: Boolean): Boolean = when {
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE -> {
            val selectedAccess = context.checkSelfPermission(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) ==
                PackageManager.PERMISSION_GRANTED
            selectedAccess ||
                ((!includeImages || context.checkSelfPermission(Manifest.permission.READ_MEDIA_IMAGES) ==
                    PackageManager.PERMISSION_GRANTED) &&
                    (!includeVideos || context.checkSelfPermission(Manifest.permission.READ_MEDIA_VIDEO) ==
                        PackageManager.PERMISSION_GRANTED))
        }
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU ->
            (!includeImages || context.checkSelfPermission(Manifest.permission.READ_MEDIA_IMAGES) ==
                PackageManager.PERMISSION_GRANTED) &&
                (!includeVideos || context.checkSelfPermission(Manifest.permission.READ_MEDIA_VIDEO) ==
                    PackageManager.PERMISSION_GRANTED)
        else -> context.checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) ==
            PackageManager.PERMISSION_GRANTED
    }
    val filePicker = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenMultipleDocuments(),
    ) { uris ->
        uris.forEach { uri ->
            runCatching {
                context.contentResolver.takePersistableUriPermission(
                    uri,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION,
                )
            }
        }
        viewModel.upload(uris)
    }
    val uploadPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) filePicker.launch(arrayOf("*/*"))
    }
    val audioNotificationPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) {
        pendingAudioFile?.let(viewModel::openFile)
        pendingAudioFile = null
    }
    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { results ->
        val pendingSelection = pendingSelectionTransfer
        pendingSelectionTransfer = null
        val pending = pendingTransfer
        pendingTransfer = null
        if (pendingSelection != null && results.values.all { it }) {
            if (pendingSelection) viewModel.saveSelectionOffline() else viewModel.downloadSelection()
        } else if (pending != null && results.values.all { it }) {
            if (pending.second) viewModel.saveOffline(pending.first) else viewModel.download(pending.first)
        }
    }
    val cameraBackupPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { results ->
        if (pendingCameraFolderScan) {
            pendingCameraFolderScan = false
            viewModel.refreshCameraBackupSourceFolders()
            return@rememberLauncherForActivityResult
        }
        val pending = pendingCameraBackupSettings
        pendingCameraBackupSettings = null
        if (pending != null) {
            if (hasCameraMediaPermission(pending.includeImages, pending.includeVideos)) {
                viewModel.updateCameraBackup(
                    pending.enabled,
                    pending.wifiOnly,
                    pending.chargingOnly,
                    pending.includeImages,
                    pending.includeVideos,
                    pending.allSourceFolders,
                    pending.sourceFolderIds,
                )
            } else {
                viewModel.cameraBackupPermissionDenied()
            }
        }
    }

    fun transferPermissions(includeStorage: Boolean): Array<String> = buildList {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) add(Manifest.permission.POST_NOTIFICATIONS)
        if (includeStorage && Build.VERSION.SDK_INT <= Build.VERSION_CODES.P &&
            context.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED
        ) add(Manifest.permission.WRITE_EXTERNAL_STORAGE)
    }.toTypedArray()

    fun requestDownload(file: CloudFile) {
        val permissions = transferPermissions(includeStorage = true)
        if (permissions.isEmpty()) {
            viewModel.download(file)
        } else {
            pendingTransfer = file to false
            permissionLauncher.launch(permissions)
        }
    }

    fun requestOffline(file: CloudFile) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            pendingTransfer = file to true
            permissionLauncher.launch(arrayOf(Manifest.permission.POST_NOTIFICATIONS))
        } else {
            viewModel.saveOffline(file)
        }
    }


    fun requestSelectionDownload() {
        val permissions = transferPermissions(includeStorage = true)
        if (permissions.isEmpty()) {
            viewModel.downloadSelection()
        } else {
            pendingSelectionTransfer = false
            permissionLauncher.launch(permissions)
        }
    }

    fun requestSelectionOffline() {
        val permissions = transferPermissions(includeStorage = false)
        if (permissions.isEmpty()) {
            viewModel.saveSelectionOffline()
        } else {
            pendingSelectionTransfer = true
            permissionLauncher.launch(permissions)
        }
    }

    fun requestUpload() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            uploadPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            filePicker.launch(arrayOf("*/*"))
        }
    }

    fun requestOpenFile(file: CloudFile) {
        if (file.mediaKind == "audio" && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            pendingAudioFile = file
            audioNotificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            viewModel.openFile(file)
        }
    }

    fun requestCameraBackup(
        enabled: Boolean,
        wifiOnly: Boolean,
        chargingOnly: Boolean,
        includeImages: Boolean,
        includeVideos: Boolean,
        allSourceFolders: Boolean,
        sourceFolderIds: Set<String>,
    ) {
        if (!enabled) {
            viewModel.updateCameraBackup(
                false,
                wifiOnly,
                chargingOnly,
                includeImages,
                includeVideos,
                allSourceFolders,
                sourceFolderIds,
            )
            return
        }
        val permissions = when {
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE -> buildList {
                if (includeImages) add(Manifest.permission.READ_MEDIA_IMAGES)
                if (includeVideos) add(Manifest.permission.READ_MEDIA_VIDEO)
                add(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)
            }.toTypedArray()
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU -> buildList {
                if (includeImages) add(Manifest.permission.READ_MEDIA_IMAGES)
                if (includeVideos) add(Manifest.permission.READ_MEDIA_VIDEO)
            }.toTypedArray()
            else -> arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
        }.toMutableList().apply {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) add(Manifest.permission.POST_NOTIFICATIONS)
        }.filter {
            context.checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED
        }.toTypedArray()
        if (permissions.isEmpty()) {
            viewModel.updateCameraBackup(
                true,
                wifiOnly,
                chargingOnly,
                includeImages,
                includeVideos,
                allSourceFolders,
                sourceFolderIds,
            )
        } else {
            pendingCameraBackupSettings = PendingCameraBackupSettings(
                true,
                wifiOnly,
                chargingOnly,
                includeImages,
                includeVideos,
                allSourceFolders,
                sourceFolderIds,
            )
            cameraBackupPermissionLauncher.launch(permissions)
        }
    }

    fun requestCameraBackupSourceFolders(includeImages: Boolean, includeVideos: Boolean) {
        val permissions = when {
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE -> buildList {
                if (includeImages) add(Manifest.permission.READ_MEDIA_IMAGES)
                if (includeVideos) add(Manifest.permission.READ_MEDIA_VIDEO)
                add(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)
            }.toTypedArray()
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU -> buildList {
                if (includeImages) add(Manifest.permission.READ_MEDIA_IMAGES)
                if (includeVideos) add(Manifest.permission.READ_MEDIA_VIDEO)
            }.toTypedArray()
            else -> arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
        }.filter {
            context.checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED
        }.toTypedArray()
        if (permissions.isEmpty()) {
            viewModel.refreshCameraBackupSourceFolders()
        } else {
            pendingCameraFolderScan = true
            cameraBackupPermissionLauncher.launch(permissions)
        }
    }

    LaunchedEffect(state.error) {
        state.error?.let {
            snackbar.showSnackbar(it)
            viewModel.clearError()
        }
    }

    LaunchedEffect(state.message) {
        state.message?.let {
            snackbar.showSnackbar(it)
            viewModel.clearMessage()
        }
    }

    LaunchedEffect(showAppSettings) {
        while (showAppSettings) {
            delay(3_000)
            viewModel.refreshCameraBackupSettings()
        }
    }

    MaterialTheme(
        colorScheme = MaterialTheme.colorScheme.copy(
            primary = TCloudBlue,
            background = TCloudBackground,
            surface = Color.White,
        ),
    ) {
        Surface(modifier = Modifier.fillMaxSize(), color = TCloudBackground) {
            when {
                state.restoring -> LoadingScreen("ログイン状態を確認しています")
                state.session == null -> LoginScreen(
                    busy = state.busy,
                    snackbar = snackbar,
                    onLogin = viewModel::login,
                )
                state.selectedFile?.mediaKind == "image" -> ImageViewerScreen(
                    file = checkNotNull(state.selectedFile),
                    bitmap = state.imageBitmap,
                    loading = state.imageLoading,
                    error = state.imageError,
                    canGoPrevious = state.page?.files.orEmpty()
                        .filter { it.metadataDecrypted && it.mediaKind == "image" }
                        .indexOfFirst { it.id == state.selectedFile?.id } > 0,
                    canGoNext = state.page?.files.orEmpty()
                        .filter { it.metadataDecrypted && it.mediaKind == "image" }
                        .let { images -> images.indexOfFirst { it.id == state.selectedFile?.id } in 0 until images.lastIndex },
                    onPrevious = { viewModel.navigateImage(-1) },
                    onNext = { viewModel.navigateImage(1) },
                    onClose = viewModel::closeFile,
                )
                state.selectedFile != null && state.selectedFile?.mediaKind in setOf("video", "audio") -> {
                    val selectedMedia = checkNotNull(state.selectedFile)
                    val playbackFactory = remember(selectedMedia.id) {
                        viewModel.playbackDataSource(selectedMedia)
                    }
                    MediaPlayerScreen(
                        file = selectedMedia,
                        dataSourceFactory = playbackFactory,
                        playbackManager = playbackManager,
                        startAtBeginning = state.selectedFileStartsAtBeginning,
                        pictureInPicture = pictureInPicture,
                        onPlayPrevious = { viewModel.navigateMedia(-1) },
                        onPlayNext = { viewModel.navigateMedia(1) },
                        onAutomaticRepeatNext = { viewModel.navigateMedia(1, automaticRepeat = true) },
                        onClose = viewModel::closeFile,
                    )
                }
                state.showingTrash -> TrashScreen(
                    page = state.trashPage,
                    busy = state.busy,
                    snackbar = snackbar,
                    onRestoreFile = viewModel::restoreTrashFile,
                    onDeleteFile = viewModel::permanentlyDeleteTrashFile,
                    onRestoreFolder = viewModel::restoreTrashFolder,
                    onEmptyTrash = viewModel::emptyTrash,
                    onBack = { viewModel.goBack() },
                )
                state.showingOffline -> OfflineScreen(
                    entries = state.offlineEntries,
                    busy = state.busy,
                    snackbar = snackbar,
                    onOpenFile = ::requestOpenFile,
                    onDelete = viewModel::deleteOffline,
                    onDeleteSelection = viewModel::deleteOfflineSelection,
                    onBack = { viewModel.goBack() },
                )
                else -> FolderScreen(
                    accountName = state.session?.accountName.orEmpty(),
                    currentName = state.page?.currentFolder?.name ?: "ファイル",
                    currentFolderId = state.page?.currentFolder?.id,
                    canGoBack = state.folderStack.isNotEmpty(),
                    canUpload = state.session?.canUpload == true && state.page?.currentFolder != null,
                    canManageItems = state.session?.isAdmin == true ||
                        (state.session?.isSubAdmin == true && state.page?.currentFolder != null),
                    canDeleteItems = state.session?.isAdmin == true || state.page?.canTrashContents == true,
                    folders = state.page?.folders.orEmpty(),
                    files = state.page?.files.orEmpty(),
                    searchFolders = state.searchResults.folders,
                    searchFiles = state.searchResults.files,
                    searching = state.searching,
                    searchScannedCount = state.searchScannedCount,
                    searchTruncated = state.searchResults.truncated,
                    thumbnailBitmaps = state.thumbnailBitmaps,
                    selectedFileIds = state.selectedFileIds,
                    selectedFolderIds = state.selectedFolderIds,
                    busy = state.busy,
                    snackbar = snackbar,
                    onOpenFolder = viewModel::openFolder,
                    onOpenFile = ::requestOpenFile,
                    onRequestThumbnail = viewModel::loadThumbnail,
                    onDownload = ::requestDownload,
                    onOffline = ::requestOffline,
                    onMove = viewModel::openMove,
                    onMoveFolder = viewModel::openMoveFolder,
                    onRenameFile = viewModel::openRename,
                    onRenameFolder = viewModel::openRename,
                    onShareFile = viewModel::openShare,
                    onShareFolder = viewModel::openShare,
                    onToggleFileSelection = viewModel::toggleSelection,
                    onToggleFolderSelection = viewModel::toggleSelection,
                    onClearSelection = viewModel::clearSelection,
                    onSelectAll = viewModel::selectAll,
                    onMoveSelection = viewModel::openMoveSelection,
                    onShareSelection = viewModel::openShareSelection,
                    onDownloadSelection = ::requestSelectionDownload,
                    onOfflineSelection = ::requestSelectionOffline,
                    onDeleteSelection = viewModel::openDeleteSelection,
                    onFolderSecurity = viewModel::openFolderSecuritySelection,
                    onUpload = ::requestUpload,
                    onCreateFolder = viewModel::openCreateFolder,
                    onBack = viewModel::goBack,
                    onLogout = viewModel::logout,
                    onOpenOffline = viewModel::openOffline,
                    onOpenSettings = {
                        viewModel.refreshCameraBackupSettings()
                        viewModel.refreshCameraBackupSourceFolders()
                        viewModel.refreshUsage()
                        showAppSettings = true
                    },
                    onSearch = viewModel::search,
                )
            }

            state.pendingUnlock?.let { folder ->
                UnlockFolderDialog(
                    folder = folder,
                    busy = state.busy,
                    onUnlock = viewModel::unlockFolder,
                    onDismiss = viewModel::cancelUnlock,
                )
            }

            if (state.creatingFolder) {
                CreateFolderDialog(
                    topLevel = state.page?.currentFolder == null,
                    busy = state.busy,
                    onCreate = viewModel::createFolder,
                    onDismiss = viewModel::cancelCreateFolder,
                )
            }

            if (showAppSettings) {
                AppSettingsDialog(
                    batteryOptimizationExcluded = batteryOptimizationExcluded,
                    cameraBackupSettings = state.cameraBackupSettings,
                    cameraBackupSourceFolders = state.cameraBackupSourceFolders,
                    loadingCameraBackupSourceFolders = state.loadingCameraBackupSourceFolders,
                    isAdmin = state.session?.isAdmin == true,
                    cloudUsage = state.cloudUsage,
                    usageDetails = state.usageDetails,
                    currentFolderName = state.page?.currentFolder?.name,
                    canSetCameraBackupTarget = state.session?.canUpload == true &&
                        state.page?.currentFolder != null,
                    onRequestBatteryExclusion = {
                        val directIntent = Intent(
                            Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                            Uri.parse("package:${context.packageName}"),
                        )
                        runCatching { batterySettingsLauncher.launch(directIntent) }
                            .onFailure {
                                batterySettingsLauncher.launch(
                                    Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS),
                                )
                            }
                    },
                    onSetCameraBackupTarget = viewModel::setCurrentFolderAsCameraBackupTarget,
                    onSaveCameraBackup = ::requestCameraBackup,
                    onLoadCameraBackupSourceFolders = ::requestCameraBackupSourceFolders,
                    onRunCameraBackupNow = viewModel::runCameraBackupNow,
                    onOpenTrash = {
                        showAppSettings = false
                        viewModel.openTrash()
                    },
                    onDismiss = { showAppSettings = false },
                )
            }

            state.pendingMoveFile?.let { file ->
                MoveItemDialog(
                    itemName = file.name,
                    destinations = state.moveDestinations,
                    busy = state.busy,
                    onMove = viewModel::moveFile,
                    onDismiss = viewModel::cancelMove,
                )
            }
            state.pendingMoveFolder?.let { folder ->
                MoveItemDialog(
                    itemName = folder.name,
                    destinations = state.moveDestinations,
                    busy = state.busy,
                    onMove = viewModel::moveFolder,
                    onDismiss = viewModel::cancelMove,
                )
            }
            if (state.pendingMoveFiles.isNotEmpty() || state.pendingMoveFolders.isNotEmpty()) {
                MoveItemDialog(
                    itemName = "${state.pendingMoveFiles.size + state.pendingMoveFolders.size}件のデータ",
                    destinations = state.moveDestinations,
                    busy = state.busy,
                    onMove = viewModel::moveSelection,
                    onDismiss = viewModel::cancelMove,
                )
            }
            val renameName = state.pendingRenameFile?.name ?: state.pendingRenameFolder?.name
            if (renameName != null) {
                RenameItemDialog(
                    currentName = renameName,
                    busy = state.busy,
                    onRename = viewModel::renamePending,
                    onDismiss = viewModel::cancelRename,
                )
            }
            val shareName = state.pendingShareFile?.name ?: state.pendingShareFolder?.name
                ?: state.pendingShareFiles.takeIf { it.isNotEmpty() }?.let { "${it.size}件のファイル" }
            if (shareName != null) {
                ShareCreateDialog(
                    itemName = shareName,
                    busy = state.busy,
                    onCreate = viewModel::createShare,
                    onDismiss = viewModel::cancelShare,
                )
            }
            state.shareResult?.let { result ->
                ShareResultDialog(result = result, onDismiss = viewModel::cancelShare)
            }
            if (state.confirmingSelectionDelete) {
                DeleteSelectionDialog(
                    count = state.selectedFileIds.size + state.selectedFolderIds.size,
                    isAdmin = state.session?.isAdmin == true,
                    busy = state.busy,
                    onConfirm = viewModel::confirmDeleteSelection,
                    onDismiss = viewModel::cancelDeleteSelection,
                )
            }
            state.pendingFolderSecurity?.let { folder ->
                FolderSecurityDialog(
                    folder = folder,
                    busy = state.busy,
                    canRelock = state.session?.isSubAdmin == true && folder.isProtected,
                    onChangePassword = viewModel::changePendingFolderPassword,
                    onRelock = viewModel::lockPendingFolder,
                    onDismiss = viewModel::cancelFolderSecurity,
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ImageViewerScreen(
    file: CloudFile,
    bitmap: Bitmap?,
    loading: Boolean,
    error: String?,
    canGoPrevious: Boolean,
    canGoNext: Boolean,
    onPrevious: () -> Unit,
    onNext: () -> Unit,
    onClose: () -> Unit,
) {
    var scale by remember(file.id) { mutableStateOf(1f) }
    var offset by remember(file.id) { mutableStateOf(Offset.Zero) }
    val transformState = rememberTransformableState { zoomChange, panChange, _ ->
        val nextScale = (scale * zoomChange).coerceIn(1f, 6f)
        scale = nextScale
        offset = if (nextScale == 1f) Offset.Zero else offset + panChange
    }

    Scaffold(
        containerColor = Color.Black,
        topBar = {
            TopAppBar(
                title = { Text(file.name, maxLines = 1) },
                navigationIcon = {
                    IconButton(onClick = onClose) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "閉じる")
                    }
                },
            )
        },
    ) { padding ->
        Box(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentAlignment = Alignment.Center,
        ) {
            when {
                loading -> CircularProgressIndicator(color = Color.White)
                bitmap != null -> Image(
                    bitmap = bitmap.asImageBitmap(),
                    contentDescription = file.name,
                    contentScale = ContentScale.Fit,
                    modifier = Modifier
                        .fillMaxSize()
                        .graphicsLayer(
                            scaleX = scale,
                            scaleY = scale,
                            translationX = offset.x,
                            translationY = offset.y,
                        )
                        .transformable(transformState),
                )
                else -> Text(error ?: "画像を表示できませんでした。", color = Color.White)
            }
            if (scale == 1f) {
                IconButton(
                    onClick = onPrevious,
                    enabled = canGoPrevious && !loading,
                    modifier = Modifier.align(Alignment.CenterStart).size(56.dp),
                ) {
                    Icon(
                        Icons.Default.ChevronLeft,
                        contentDescription = "前の画像",
                        tint = if (canGoPrevious) Color.White else Color.Gray,
                        modifier = Modifier.size(42.dp),
                    )
                }
                IconButton(
                    onClick = onNext,
                    enabled = canGoNext && !loading,
                    modifier = Modifier.align(Alignment.CenterEnd).size(56.dp),
                ) {
                    Icon(
                        Icons.Default.ChevronRight,
                        contentDescription = "次の画像",
                        tint = if (canGoNext) Color.White else Color.Gray,
                        modifier = Modifier.size(42.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun LoadingScreen(message: String) {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            CircularProgressIndicator(color = TCloudBlue)
            Spacer(Modifier.height(16.dp))
            Text(message)
        }
    }
}

@Composable
private fun LoginScreen(
    busy: Boolean,
    snackbar: SnackbarHostState,
    onLogin: (String, String) -> Unit,
) {
    var loginId by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var passwordVisible by remember { mutableStateOf(false) }

    Scaffold(
        containerColor = TCloudBackground,
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        Box(
            modifier = Modifier.fillMaxSize().padding(padding).padding(horizontal = 20.dp),
            contentAlignment = Alignment.Center,
        ) {
            Surface(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(24.dp),
                color = Color.White,
                shadowElevation = 10.dp,
                tonalElevation = 0.dp,
            ) {
                Column(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 28.dp, vertical = 32.dp),
                    horizontalAlignment = Alignment.Start,
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Image(
                            painter = painterResource(R.drawable.tcloud_logo),
                            contentDescription = null,
                            modifier = Modifier.size(42.dp).clip(CircleShape),
                            contentScale = ContentScale.Crop,
                        )
                        Column {
                            Text("T-Cloud Player", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.ExtraBold)
                            Text("Cloud Storage", style = MaterialTheme.typography.labelMedium, color = TCloudMuted)
                        }
                    }
                    Spacer(Modifier.height(34.dp))
                    Text("PRIVATE STORAGE", color = TCloudBlue, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold)
                    Spacer(Modifier.height(8.dp))
                    Text("ログイン", style = MaterialTheme.typography.headlineLarge, fontWeight = FontWeight.ExtraBold)
                    Text("保存したファイルへ安全にアクセスします。", color = TCloudMuted, style = MaterialTheme.typography.bodyMedium)
                    Spacer(Modifier.height(28.dp))
                    OutlinedTextField(
                        value = loginId,
                        onValueChange = { loginId = it },
                        enabled = !busy,
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        label = { Text("ログインID") },
                    )
                    Spacer(Modifier.height(12.dp))
                    OutlinedTextField(
                        value = password,
                        onValueChange = { password = it },
                        enabled = !busy,
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        label = { Text("パスワード") },
                        visualTransformation = if (passwordVisible) VisualTransformation.None else PasswordVisualTransformation(),
                        trailingIcon = {
                            IconButton(onClick = { passwordVisible = !passwordVisible }) {
                                Icon(
                                    if (passwordVisible) Icons.Default.VisibilityOff else Icons.Default.Visibility,
                                    contentDescription = if (passwordVisible) "パスワードを隠す" else "パスワードを表示",
                                )
                            }
                        },
                    )
                    Spacer(Modifier.height(20.dp))
                    Button(
                        onClick = { onLogin(loginId, password) },
                        enabled = !busy && loginId.isNotBlank() && password.length >= 8,
                        modifier = Modifier.fillMaxWidth().height(50.dp),
                        shape = RoundedCornerShape(10.dp),
                    ) {
                        if (busy) CircularProgressIndicator(color = Color.White, strokeWidth = 2.dp)
                        else Text("ログイン", fontWeight = FontWeight.Bold)
                    }
                    Spacer(Modifier.height(16.dp))
                    Text(
                        "パスワードと復号鍵は端末内で保護され、Cloudflareへ送信しません。",
                        style = MaterialTheme.typography.bodySmall,
                        color = TCloudMuted,
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun FolderScreen(
    accountName: String,
    currentName: String,
    currentFolderId: Long?,
    canGoBack: Boolean,
    canUpload: Boolean,
    canManageItems: Boolean,
    canDeleteItems: Boolean,
    folders: List<CloudFolder>,
    files: List<CloudFile>,
    searchFolders: List<CloudFolder>,
    searchFiles: List<CloudFile>,
    searching: Boolean,
    searchScannedCount: Int,
    searchTruncated: Boolean,
    thumbnailBitmaps: Map<Long, Bitmap>,
    selectedFileIds: Set<Long>,
    selectedFolderIds: Set<Long>,
    busy: Boolean,
    snackbar: SnackbarHostState,
    onOpenFolder: (CloudFolder) -> Unit,
    onOpenFile: (CloudFile) -> Unit,
    onRequestThumbnail: (CloudFile) -> Unit,
    onDownload: (CloudFile) -> Unit,
    onOffline: (CloudFile) -> Unit,
    onMove: (CloudFile) -> Unit,
    onMoveFolder: (CloudFolder) -> Unit,
    onRenameFile: (CloudFile) -> Unit,
    onRenameFolder: (CloudFolder) -> Unit,
    onShareFile: (CloudFile) -> Unit,
    onShareFolder: (CloudFolder) -> Unit,
    onToggleFileSelection: (CloudFile) -> Unit,
    onToggleFolderSelection: (CloudFolder) -> Unit,
    onClearSelection: () -> Unit,
    onSelectAll: () -> Unit,
    onMoveSelection: () -> Unit,
    onShareSelection: () -> Unit,
    onDownloadSelection: () -> Unit,
    onOfflineSelection: () -> Unit,
    onDeleteSelection: () -> Unit,
    onFolderSecurity: () -> Unit,
    onUpload: () -> Unit,
    onCreateFolder: () -> Unit,
    onBack: () -> Boolean,
    onLogout: () -> Unit,
    onOpenOffline: () -> Unit,
    onOpenSettings: () -> Unit,
    onSearch: (String, String) -> Unit,
) {
    val selectionCount = selectedFileIds.size + selectedFolderIds.size
    val selectionMode = selectionCount > 0
    var selectionActionsExpanded by remember { mutableStateOf(false) }
    var searchQuery by remember(currentFolderId) { mutableStateOf("") }
    var kindFilter by remember(currentFolderId) { mutableStateOf("all") }
    LaunchedEffect(searchQuery, kindFilter, currentFolderId) {
        onSearch(searchQuery, kindFilter)
    }
    val context = LocalContext.current
    val viewPreferences = remember {
        context.getSharedPreferences("tcloud_folder_view", Context.MODE_PRIVATE)
    }
    val sortPreferences = remember {
        context.getSharedPreferences("tcloud_folder_sort", Context.MODE_PRIVATE)
    }
    val scrollPreferences = remember {
        context.getSharedPreferences("tcloud_folder_scroll", Context.MODE_PRIVATE)
    }
    val viewPreferenceKey = remember(accountName, currentFolderId) {
        "${accountName.hashCode()}-${currentFolderId ?: 0L}"
    }
    val sortPreferenceKey = remember(accountName, currentFolderId) {
        "${accountName.hashCode()}-${currentFolderId ?: 0L}"
    }
    val scrollPreferenceKey = remember(accountName, currentFolderId) {
        "${accountName.hashCode()}-${currentFolderId ?: 0L}"
    }
    val listState = remember(scrollPreferenceKey) {
        LazyListState(
            firstVisibleItemIndex = scrollPreferences.getInt("$scrollPreferenceKey-index", 0),
            firstVisibleItemScrollOffset = scrollPreferences.getInt("$scrollPreferenceKey-offset", 0),
        )
    }
    DisposableEffect(listState, scrollPreferenceKey) {
        onDispose {
            scrollPreferences.edit()
                .putInt("$scrollPreferenceKey-index", listState.firstVisibleItemIndex)
                .putInt("$scrollPreferenceKey-offset", listState.firstVisibleItemScrollOffset)
                .apply()
        }
    }
    var sortState by remember(sortPreferenceKey) {
        val saved = sortPreferences.getString(sortPreferenceKey, null)
        mutableStateOf(
            if (saved.isNullOrBlank()) defaultFolderSort(currentFolderId)
            else FolderSortState(saved, usesTypeDefaults = false),
        )
    }
    val defaultGridView = currentFolderId != null && folders.isEmpty() &&
        files.any { it.mediaKind == "image" || it.mediaKind == "video" }
    var gridView by remember(viewPreferenceKey) {
        mutableStateOf(
            if (viewPreferences.contains(viewPreferenceKey)) {
                viewPreferences.getBoolean(viewPreferenceKey, false)
            } else {
                defaultGridView
            },
        )
    }
    fun setGridView(enabled: Boolean) {
        gridView = enabled
        viewPreferences.edit().putBoolean(viewPreferenceKey, enabled).apply()
    }
    fun selectSort(key: String) {
        val next = nextFolderSort(sortState, key)
        sortState = next
        sortPreferences.edit().putString(sortPreferenceKey, next.mode).apply()
    }
    val sourceFolders = if (searchQuery.isBlank()) folders else searchFolders
    val sourceFiles = if (searchQuery.isBlank()) files else searchFiles
    val filteredFolders = remember(sourceFolders, searchQuery, sortState, kindFilter) {
        if (kindFilter != "all") emptyList()
        else if (searchQuery.isNotBlank()) sourceFolders
        else sortFolders(sourceFolders, "", sortState)
    }
    val filteredFiles = remember(sourceFiles, searchQuery, sortState, kindFilter) {
        val ordered = if (searchQuery.isNotBlank()) sourceFiles else sortFiles(sourceFiles, "", sortState)
        ordered.filter { file ->
            kindFilter == "all" || file.mediaKind == kindFilter
        }
    }
    Scaffold(
        containerColor = Color.White,
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            TopAppBar(
                navigationIcon = {
                    if (selectionMode) {
                        IconButton(onClick = onClearSelection, enabled = !busy) {
                            Icon(Icons.Default.Close, contentDescription = "選択解除")
                        }
                    } else if (canGoBack) {
                        IconButton(onClick = { onBack() }, enabled = !busy) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "戻る")
                        }
                    }
                },
                title = {
                    Column {
                        Text(
                            if (selectionMode) "${selectionCount}件を選択中" else currentName,
                            fontWeight = FontWeight.ExtraBold,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                        if (!selectionMode) {
                            Text(
                                if (canGoBack) "Cloud Storage" else "すべてのファイル",
                                style = MaterialTheme.typography.labelSmall,
                                color = TCloudMuted,
                            )
                        }
                    }
                },
                actions = {
                    if (selectionMode) {
                        IconButton(onClick = onSelectAll, enabled = !busy) {
                            Icon(Icons.Default.SelectAll, contentDescription = "すべて選択")
                        }
                        Box {
                            IconButton(
                                onClick = { selectionActionsExpanded = true },
                                enabled = !busy,
                            ) {
                                Icon(Icons.Default.MoreVert, contentDescription = "選択したデータの操作")
                            }
                            DropdownMenu(
                                expanded = selectionActionsExpanded,
                                onDismissRequest = { selectionActionsExpanded = false },
                            ) {
                                DropdownMenuItem(
                                    text = { Text("ダウンロード") },
                                    leadingIcon = { Icon(Icons.Default.Download, contentDescription = null) },
                                    onClick = {
                                        selectionActionsExpanded = false
                                        onDownloadSelection()
                                    },
                                )
                                DropdownMenuItem(
                                    text = { Text("オフライン保存") },
                                    leadingIcon = { Icon(Icons.Default.DownloadForOffline, contentDescription = null) },
                                    onClick = {
                                        selectionActionsExpanded = false
                                        onOfflineSelection()
                                    },
                                )
                                DropdownMenuItem(
                                    text = { Text("移動") },
                                    leadingIcon = {
                                        Icon(Icons.AutoMirrored.Filled.DriveFileMove, contentDescription = null)
                                    },
                                    onClick = {
                                        selectionActionsExpanded = false
                                        onMoveSelection()
                                    },
                                )
                                DropdownMenuItem(
                                    text = { Text("共有") },
                                    leadingIcon = { Icon(Icons.Default.Share, contentDescription = null) },
                                    onClick = {
                                        selectionActionsExpanded = false
                                        onShareSelection()
                                    },
                                )
                                if (selectedFileIds.isEmpty() && selectedFolderIds.size == 1) {
                                    DropdownMenuItem(
                                        text = { Text("PW・ロック") },
                                        leadingIcon = { Icon(Icons.Default.Lock, contentDescription = null) },
                                        onClick = {
                                            selectionActionsExpanded = false
                                            onFolderSecurity()
                                        },
                                    )
                                }
                                if (canDeleteItems) {
                                    DropdownMenuItem(
                                        text = { Text("削除", color = Color(0xFFB42318)) },
                                        leadingIcon = {
                                            Icon(
                                                Icons.Default.DeleteOutline,
                                                contentDescription = null,
                                                tint = Color(0xFFB42318),
                                            )
                                        },
                                        onClick = {
                                            selectionActionsExpanded = false
                                            onDeleteSelection()
                                        },
                                    )
                                }
                            }
                        }
                    } else {
                    IconButton(onClick = onOpenSettings, enabled = !busy) {
                        Icon(Icons.Default.SettingsIcon, contentDescription = "アプリ設定")
                    }
                    IconButton(onClick = onOpenOffline, enabled = !busy) {
                        Icon(Icons.Default.OfflinePin, contentDescription = "端末保存")
                    }
                    if (canUpload) {
                        IconButton(onClick = onCreateFolder, enabled = !busy) {
                            Icon(Icons.Default.CreateNewFolder, contentDescription = "新しいフォルダ")
                        }
                        IconButton(onClick = onUpload, enabled = !busy) {
                            Icon(Icons.Default.Add, contentDescription = "ファイルをアップロード")
                        }
                    }
                    IconButton(onClick = onLogout, enabled = !busy) {
                        Icon(Icons.AutoMirrored.Filled.Logout, contentDescription = "ログアウト")
                    }
                    }
                },
            )
        },
    ) { padding ->
        Box(modifier = Modifier.fillMaxSize().padding(padding)) {
            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                item(key = "toolbar") {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceEvenly,
                        ) {
                            listOf(
                                "all" to "すべて",
                                "image" to "写真",
                                "video" to "動画",
                                "audio" to "音楽",
                            ).forEach { (kind, label) ->
                                TextButton(onClick = { kindFilter = kind }, enabled = !busy) {
                                    Text(
                                        label,
                                        color = if (kindFilter == kind) TCloudBlueDark else TCloudMuted,
                                        fontWeight = if (kindFilter == kind) FontWeight.Bold else FontWeight.Normal,
                                    )
                                }
                            }
                        }
                        OutlinedTextField(
                            value = searchQuery,
                            onValueChange = { searchQuery = it },
                            modifier = Modifier.fillMaxWidth(),
                            singleLine = true,
                            leadingIcon = { Text("⌕", color = TCloudMuted) },
                            placeholder = {
                                Text(if (currentFolderId == null) "すべてのフォルダを検索" else "このフォルダ以下を検索")
                            },
                            shape = RoundedCornerShape(10.dp),
                        )
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            TCloudSortButton(
                                label = "更新",
                                selected = sortState.mode.startsWith("updated"),
                                descending = sortState.mode != "updated-asc",
                                onClick = { selectSort("updated") },
                                modifier = Modifier.weight(1f),
                            )
                            TCloudSortButton(
                                label = "名前",
                                selected = sortState.mode.startsWith("name"),
                                descending = sortState.mode == "name-desc",
                                onClick = { selectSort("name") },
                                modifier = Modifier.weight(1f),
                            )
                            TCloudSortButton(
                                label = "容量",
                                selected = sortState.mode.startsWith("size"),
                                descending = sortState.mode != "size-asc",
                                onClick = { selectSort("size") },
                                modifier = Modifier.weight(1f),
                            )
                        }
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                "${filteredFolders.size}フォルダ・${filteredFiles.size}ファイル",
                                style = MaterialTheme.typography.labelMedium,
                                color = TCloudMuted,
                                modifier = Modifier.weight(1f),
                            )
                            IconButton(
                                onClick = { setGridView(!gridView) },
                                enabled = !busy,
                            ) {
                                Icon(
                                    if (gridView) Icons.AutoMirrored.Filled.ViewList else Icons.Default.GridView,
                                    contentDescription = if (gridView) "横長表示へ切り替え" else "1:1表示へ切り替え",
                                    tint = TCloudBlue,
                                )
                            }
                        }
                        if (searching) {
                            LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                            Text(
                                if (searchScannedCount > 0) "配下を検索中：${searchScannedCount}件確認" else "配下を検索しています…",
                                style = MaterialTheme.typography.bodySmall,
                                color = TCloudMuted,
                            )
                        } else if (searchQuery.isNotBlank() && searchTruncated) {
                            Text(
                                "検索結果が多いため、先頭2,000件を表示しています。",
                                style = MaterialTheme.typography.bodySmall,
                                color = TCloudMuted,
                            )
                        }
                    }
                }
                if (filteredFolders.isEmpty() && filteredFiles.isEmpty()) {
                    item {
                        Text(
                            if (searchQuery.isBlank()) "表示できるデータはありません。" else "検索結果はありません。",
                            modifier = Modifier.padding(24.dp),
                            color = TCloudMuted,
                        )
                    }
                }
                if (!gridView) {
                    items(filteredFolders, key = { "folder-${it.id}" }) { folder ->
                        FolderRow(
                            folder = folder,
                            selected = folder.id in selectedFolderIds,
                            selectionMode = selectionMode,
                            canManage = canManageItems,
                            onOpenFolder = onOpenFolder,
                            onToggleSelection = onToggleFolderSelection,
                            onRename = onRenameFolder,
                            onMove = onMoveFolder,
                            onShare = onShareFolder,
                        )
                    }
                    items(filteredFiles, key = { "file-${it.id}" }) { file ->
                        FileRow(
                            file = file,
                            thumbnailBitmap = thumbnailBitmaps[file.id],
                            selected = file.id in selectedFileIds,
                            selectionMode = selectionMode,
                            canManage = canManageItems,
                            onOpenFile = onOpenFile,
                            onRequestThumbnail = onRequestThumbnail,
                            onToggleSelection = onToggleFileSelection,
                            onDownload = onDownload,
                            onOffline = onOffline,
                            onMove = onMove,
                            onRename = onRenameFile,
                            onShare = onShareFile,
                        )
                    }
                } else {
                    items(filteredFolders.chunked(2), key = { row -> "folder-grid-${row.first().id}" }) { row ->
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            row.forEach { folder ->
                                FolderGridCard(
                                    folder = folder,
                                    selected = folder.id in selectedFolderIds,
                                    selectionMode = selectionMode,
                                    canManage = canManageItems,
                                    onOpenFolder = onOpenFolder,
                                    onToggleSelection = onToggleFolderSelection,
                                    modifier = Modifier.weight(1f),
                                )
                            }
                            if (row.size == 1) Spacer(Modifier.weight(1f))
                        }
                    }
                    items(filteredFiles.chunked(2), key = { row -> "file-grid-${row.first().id}" }) { row ->
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            row.forEach { file ->
                                FileGridCard(
                                    file = file,
                                    thumbnailBitmap = thumbnailBitmaps[file.id],
                                    selected = file.id in selectedFileIds,
                                    selectionMode = selectionMode,
                                    canManage = canManageItems,
                                    onOpenFile = onOpenFile,
                                    onRequestThumbnail = onRequestThumbnail,
                                    onToggleSelection = onToggleFileSelection,
                                    modifier = Modifier.weight(1f),
                                )
                            }
                            if (row.size == 1) Spacer(Modifier.weight(1f))
                        }
                    }
                }
            }
            if (busy) {
                Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = TCloudBlue)
                }
            }
        }
    }
}

@Composable
private fun CreateFolderDialog(
    topLevel: Boolean,
    busy: Boolean,
    onCreate: (String, String) -> Unit,
    onDismiss: () -> Unit,
) {
    var name by remember { mutableStateOf("") }
    var passwordEnabled by remember(topLevel) { mutableStateOf(topLevel) }
    var password by remember { mutableStateOf("") }
    var passwordVisible by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text("新しいフォルダ") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text("フォルダ名") },
                    singleLine = true,
                    enabled = !busy,
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(
                        checked = passwordEnabled,
                        onCheckedChange = if (topLevel) null else { checked -> passwordEnabled = checked },
                        enabled = !busy && !topLevel,
                    )
                    Text(if (topLevel) "最上位フォルダのPW（必須）" else "このフォルダに個別PWを設定")
                }
                if (passwordEnabled) {
                    OutlinedTextField(
                        value = password,
                        onValueChange = { password = it },
                        label = { Text("フォルダPW") },
                        singleLine = true,
                        enabled = !busy,
                        modifier = Modifier.fillMaxWidth(),
                        visualTransformation = if (passwordVisible) VisualTransformation.None else PasswordVisualTransformation(),
                        trailingIcon = {
                            IconButton(onClick = { passwordVisible = !passwordVisible }) {
                                Icon(
                                    if (passwordVisible) Icons.Default.VisibilityOff else Icons.Default.Visibility,
                                    contentDescription = if (passwordVisible) "PWを隠す" else "PWを表示",
                                )
                            }
                        },
                    )
                    Text("4文字以上で設定してください。", style = MaterialTheme.typography.bodySmall, color = TCloudMuted)
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = { onCreate(name.trim(), if (passwordEnabled) password else "") },
                enabled = !busy && name.isNotBlank() && (!passwordEnabled || password.length >= 4),
            ) { Text(if (busy) "作成中…" else "作成") }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text("キャンセル") } },
    )
}

@Composable
private fun TCloudSortButton(
    label: String,
    selected: Boolean,
    descending: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(
        onClick = onClick,
        modifier = modifier,
        shape = RoundedCornerShape(9.dp),
        color = if (selected) TCloudSelection else Color.White,
        border = androidx.compose.foundation.BorderStroke(1.dp, if (selected) Color(0xFF9BCBC5) else TCloudLine),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 9.dp, vertical = 9.dp),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(label, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold)
            Spacer(Modifier.width(4.dp))
            Text(if (descending) "↓" else "↑", color = if (selected) TCloudBlueDark else TCloudMuted)
        }
    }
}

@Composable
private fun AppSettingsDialog(
    batteryOptimizationExcluded: Boolean,
    cameraBackupSettings: CameraBackupSettings,
    cameraBackupSourceFolders: List<CameraBackupSourceFolder>,
    loadingCameraBackupSourceFolders: Boolean,
    isAdmin: Boolean,
    cloudUsage: CloudUsage,
    usageDetails: List<CloudUsageFolder>,
    currentFolderName: String?,
    canSetCameraBackupTarget: Boolean,
    onRequestBatteryExclusion: () -> Unit,
    onSetCameraBackupTarget: () -> Unit,
    onSaveCameraBackup: (Boolean, Boolean, Boolean, Boolean, Boolean, Boolean, Set<String>) -> Unit,
    onLoadCameraBackupSourceFolders: (Boolean, Boolean) -> Unit,
    onRunCameraBackupNow: () -> Unit,
    onOpenTrash: () -> Unit,
    onDismiss: () -> Unit,
) {
    var backupEnabled by remember(cameraBackupSettings.enabled) {
        mutableStateOf(cameraBackupSettings.enabled)
    }
    var wifiOnly by remember(cameraBackupSettings.wifiOnly) {
        mutableStateOf(cameraBackupSettings.wifiOnly)
    }
    var chargingOnly by remember(cameraBackupSettings.chargingOnly) {
        mutableStateOf(cameraBackupSettings.chargingOnly)
    }
    var includeImages by remember(cameraBackupSettings.includeImages) {
        mutableStateOf(cameraBackupSettings.includeImages)
    }
    var includeVideos by remember(cameraBackupSettings.includeVideos) {
        mutableStateOf(cameraBackupSettings.includeVideos)
    }
    var allSourceFolders by remember(cameraBackupSettings.allSourceFolders) {
        mutableStateOf(cameraBackupSettings.allSourceFolders)
    }
    var selectedSourceFolderIds by remember(cameraBackupSettings.sourceFolderIds) {
        mutableStateOf(cameraBackupSettings.sourceFolderIds)
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("T-Cloud Player の設定") },
        text = {
            Column(
                modifier = Modifier.heightIn(max = 560.dp).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Text("正式名称：T-Cloud Storage")
                Text("対応：Android 8.0 以降")
                if (isAdmin) {
                    HorizontalDivider()
                    Text("クラウド使用状況", fontWeight = FontWeight.SemiBold)
                    Text("${cloudUsage.activeFileCount}ファイル・${formatBytes(cloudUsage.activeBytes)}")
                    Text(
                        "ゴミ箱：${cloudUsage.trashFileCount}ファイル・${formatBytes(cloudUsage.trashBytes)}",
                        style = MaterialTheme.typography.bodySmall,
                        color = TCloudMuted,
                    )
                    usageDetails.forEach { folder ->
                        Text(
                            "${folder.name}：${folder.fileCount}件・${formatBytes(folder.sizeBytes)}",
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                    TextButton(onClick = onOpenTrash) { Text("ゴミ箱を開く") }
                }
                Text(
                    if (batteryOptimizationExcluded) {
                        "バッテリー最適化：除外済み"
                    } else {
                        "長時間転送を安定させるため、バッテリー最適化から除外してください。"
                    },
                )
                if (!batteryOptimizationExcluded) {
                    Button(onClick = onRequestBatteryExclusion) { Text("Androidの許可画面を開く") }
                }
                HorizontalDivider()
                Text("カメラロール自動バックアップ", fontWeight = FontWeight.SemiBold)
                Text(
                    "保存先：${cameraBackupSettings.folderName}",
                    style = MaterialTheme.typography.bodyMedium,
                )
                if (canSetCameraBackupTarget) {
                    TextButton(onClick = onSetCameraBackupTarget) {
                        Text("「${currentFolderName.orEmpty()}」を保存先に設定")
                    }
                } else {
                    Text(
                        "保存先にしたいフォルダを開いてから設定してください。",
                        style = MaterialTheme.typography.bodySmall,
                        color = Color(0xFF667085),
                    )
                }
                SettingSwitchRow(
                    label = "自動バックアップ",
                    checked = backupEnabled,
                    enabled = cameraBackupSettings.hasTarget,
                    onCheckedChange = { backupEnabled = it },
                )
                SettingSwitchRow(
                    label = "写真を保存",
                    checked = includeImages,
                    enabled = true,
                    onCheckedChange = { includeImages = it },
                )
                SettingSwitchRow(
                    label = "動画を保存",
                    checked = includeVideos,
                    enabled = true,
                    onCheckedChange = { includeVideos = it },
                )
                HorizontalDivider()
                Text("バックアップ対象の端末フォルダ", fontWeight = FontWeight.SemiBold)
                SettingSwitchRow(
                    label = "すべての端末フォルダ",
                    checked = allSourceFolders,
                    enabled = true,
                    onCheckedChange = { selected ->
                        allSourceFolders = selected
                        if (!selected && selectedSourceFolderIds.isEmpty()) {
                            selectedSourceFolderIds = cameraBackupSourceFolders.mapTo(mutableSetOf()) { it.id }
                        }
                    },
                )
                if (!allSourceFolders) {
                    TextButton(
                        onClick = { onLoadCameraBackupSourceFolders(includeImages, includeVideos) },
                        enabled = !loadingCameraBackupSourceFolders,
                    ) {
                        Text(if (loadingCameraBackupSourceFolders) "端末フォルダを確認中…" else "端末フォルダを読み込む")
                    }
                    if (!loadingCameraBackupSourceFolders && cameraBackupSourceFolders.isEmpty()) {
                        Text(
                            "写真・動画へのアクセスを許可すると、CameraやScreenshotsなどを選択できます。",
                            style = MaterialTheme.typography.bodySmall,
                            color = TCloudMuted,
                        )
                    }
                    cameraBackupSourceFolders.forEach { source ->
                        val detail = buildList {
                            if (source.imageCount > 0) add("写真${source.imageCount}件")
                            if (source.videoCount > 0) add("動画${source.videoCount}件")
                        }.joinToString("・")
                        SettingSwitchRow(
                            label = "${source.name}（${detail}）",
                            checked = source.id in selectedSourceFolderIds,
                            enabled = true,
                            onCheckedChange = { checked ->
                                selectedSourceFolderIds = if (checked) {
                                    selectedSourceFolderIds + source.id
                                } else {
                                    selectedSourceFolderIds - source.id
                                }
                            },
                        )
                    }
                    Text(
                        "${selectedSourceFolderIds.size}フォルダを選択中",
                        style = MaterialTheme.typography.bodySmall,
                        color = TCloudMuted,
                    )
                }
                SettingSwitchRow(
                    label = "Wi-Fiなど従量課金なしの通信のみ",
                    checked = wifiOnly,
                    enabled = true,
                    onCheckedChange = { wifiOnly = it },
                )
                SettingSwitchRow(
                    label = "充電中のみ",
                    checked = chargingOnly,
                    enabled = true,
                    onCheckedChange = { chargingOnly = it },
                )
                Text(
                    "有効にした時点以降に選択した端末フォルダへ追加された写真・動画だけを暗号化して保存します。失敗分は次回自動で再試行します。",
                    style = MaterialTheme.typography.bodySmall,
                    color = Color(0xFF667085),
                )
                if (cameraBackupSettings.lastScanAtMillis > 0) {
                    Text(
                        "最終確認：${formatDateTime(cameraBackupSettings.lastScanAtMillis)}" +
                            "・${cameraBackupSettings.lastQueuedCount}件を処理",
                        style = MaterialTheme.typography.bodySmall,
                        color = TCloudMuted,
                    )
                }
                if (cameraBackupSettings.lastError.isNotBlank()) {
                    Text(
                        "確認が必要：${cameraBackupSettings.lastError}",
                        style = MaterialTheme.typography.bodySmall,
                        color = Color(0xFFB42318),
                    )
                }
                TextButton(
                    onClick = onRunCameraBackupNow,
                    enabled = cameraBackupSettings.enabled && cameraBackupSettings.hasTarget,
                ) { Text("今すぐ確認") }
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    onSaveCameraBackup(
                        backupEnabled,
                        wifiOnly,
                        chargingOnly,
                        includeImages,
                        includeVideos,
                        allSourceFolders,
                        selectedSourceFolderIds,
                    )
                    onDismiss()
                },
                enabled = !backupEnabled ||
                    (cameraBackupSettings.hasTarget && (includeImages || includeVideos) &&
                        (allSourceFolders || selectedSourceFolderIds.isNotEmpty())),
            ) { Text("保存") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("キャンセル") }
        },
    )
}

@Composable
private fun SettingSwitchRow(
    label: String,
    checked: Boolean,
    enabled: Boolean,
    onCheckedChange: (Boolean) -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(label, modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
        Switch(checked = checked, onCheckedChange = onCheckedChange, enabled = enabled)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TrashScreen(
    page: TrashPage,
    busy: Boolean,
    snackbar: SnackbarHostState,
    onRestoreFile: (Long) -> Unit,
    onDeleteFile: (Long) -> Unit,
    onRestoreFolder: (Long) -> Unit,
    onEmptyTrash: () -> Unit,
    onBack: () -> Unit,
) {
    var pendingPermanentDeleteId by remember { mutableStateOf<Long?>(null) }
    var confirmingEmptyTrash by remember { mutableStateOf(false) }
    Scaffold(
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            TopAppBar(
                title = { Text("ゴミ箱") },
                navigationIcon = {
                    IconButton(onClick = onBack, enabled = !busy) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "戻る")
                    }
                },
                actions = {
                    if (page.files.isNotEmpty() || page.folders.isNotEmpty()) {
                        TextButton(onClick = { confirmingEmptyTrash = true }, enabled = !busy) {
                            Text("すべて削除", color = Color(0xFFB42318))
                        }
                    }
                },
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (page.files.isEmpty() && page.folders.isEmpty()) {
                    item { Text("ゴミ箱は空です。", color = TCloudMuted, modifier = Modifier.padding(24.dp)) }
                }
                items(page.folders, key = { "trash-folder-${it.folder.id}" }) { item ->
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Icon(Icons.Default.Folder, contentDescription = null, tint = Color(0xFFD79A22))
                        Column(Modifier.weight(1f)) {
                            Text(item.folder.name.ifBlank { "フォルダ" }, fontWeight = FontWeight.Medium)
                            Text(
                                "${item.folder.fileCount}ファイル・${formatBytes(item.sizeBytes)}",
                                style = MaterialTheme.typography.bodySmall,
                                color = TCloudMuted,
                            )
                        }
                        IconButton(onClick = { onRestoreFolder(item.folder.id) }, enabled = !busy) {
                            Icon(Icons.Default.RestoreFromTrash, contentDescription = "復元")
                        }
                    }
                    HorizontalDivider(color = TCloudLine)
                }
                items(page.files, key = { "trash-file-${it.file.id}" }) { item ->
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Icon(fileIcon(item.file.mediaKind), contentDescription = null, tint = TCloudBlue)
                        Column(Modifier.weight(1f)) {
                            Text(item.file.name.ifBlank { "暗号化ファイル" }, fontWeight = FontWeight.Medium)
                            Text(
                                formatBytes(item.file.sizeBytes),
                                style = MaterialTheme.typography.bodySmall,
                                color = TCloudMuted,
                            )
                        }
                        IconButton(onClick = { onRestoreFile(item.file.id) }, enabled = !busy) {
                            Icon(Icons.Default.RestoreFromTrash, contentDescription = "復元")
                        }
                        IconButton(onClick = { pendingPermanentDeleteId = item.file.id }, enabled = !busy) {
                            Icon(Icons.Default.DeleteForever, contentDescription = "完全削除", tint = Color(0xFFB42318))
                        }
                    }
                    HorizontalDivider(color = TCloudLine)
                }
            }
            if (busy) Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = TCloudBlue)
            }
        }
    }
    pendingPermanentDeleteId?.let { fileId ->
        AlertDialog(
            onDismissRequest = { pendingPermanentDeleteId = null },
            title = { Text("完全に削除しますか？") },
            text = { Text("この操作は取り消せません。") },
            confirmButton = {
                Button(
                    onClick = {
                        pendingPermanentDeleteId = null
                        onDeleteFile(fileId)
                    },
                ) { Text("完全削除") }
            },
            dismissButton = {
                TextButton(onClick = { pendingPermanentDeleteId = null }) { Text("キャンセル") }
            },
        )
    }
    if (confirmingEmptyTrash) {
        AlertDialog(
            onDismissRequest = { confirmingEmptyTrash = false },
            title = { Text("ゴミ箱を空にしますか？") },
            text = { Text("ゴミ箱内のデータをすべて完全削除します。この操作は取り消せません。") },
            confirmButton = {
                Button(
                    onClick = {
                        confirmingEmptyTrash = false
                        onEmptyTrash()
                    },
                ) { Text("すべて完全削除") }
            },
            dismissButton = {
                TextButton(onClick = { confirmingEmptyTrash = false }) { Text("キャンセル") }
            },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun OfflineScreen(
    entries: List<TCloudOfflineStore.OfflineEntry>,
    busy: Boolean,
    snackbar: SnackbarHostState,
    onOpenFile: (CloudFile) -> Unit,
    onDelete: (Long) -> Unit,
    onDeleteSelection: (Set<Long>) -> Unit,
    onBack: () -> Unit,
) {
    var selectedIds by remember(entries) {
        mutableStateOf(emptySet<Long>())
    }
    Scaffold(
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            TopAppBar(
                title = { Text(if (selectedIds.isEmpty()) "端末保存" else "${selectedIds.size}件を選択中") },
                navigationIcon = {
                    IconButton(onClick = onBack, enabled = !busy) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "戻る")
                    }
                },
                actions = {
                    if (entries.isNotEmpty()) {
                        IconButton(onClick = {
                            selectedIds = if (selectedIds.size == entries.size) {
                                emptySet()
                            } else {
                                entries.mapTo(mutableSetOf()) { it.file.id }
                            }
                        }) { Icon(Icons.Default.SelectAll, contentDescription = "すべて選択") }
                    }
                    if (selectedIds.isNotEmpty()) {
                        IconButton(onClick = {
                            onDeleteSelection(selectedIds)
                            selectedIds = emptySet()
                        }) { Icon(Icons.Default.DeleteOutline, contentDescription = "選択削除") }
                    }
                },
            )
        },
    ) { padding ->
        Box(modifier = Modifier.fillMaxSize().padding(padding)) {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
            ) {
                if (entries.isEmpty()) {
                    item {
                        Text(
                            "端末に暗号化保存したファイルはありません。",
                            modifier = Modifier.padding(24.dp),
                            color = Color(0xFF667085),
                        )
                    }
                }
                items(entries, key = { "offline-${it.file.id}" }) { entry ->
                    Surface(
                        onClick = {
                            if (selectedIds.isNotEmpty()) {
                                selectedIds = if (entry.file.id in selectedIds) {
                                    selectedIds - entry.file.id
                                } else {
                                    selectedIds + entry.file.id
                                }
                            } else if (entry.file.metadataDecrypted) {
                                onOpenFile(entry.file)
                            }
                        },
                        color = Color.Transparent,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth().padding(vertical = 14.dp, horizontal = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            Checkbox(
                                checked = entry.file.id in selectedIds,
                                onCheckedChange = { checked ->
                                    selectedIds = if (checked) selectedIds + entry.file.id
                                    else selectedIds - entry.file.id
                                },
                            )
                            Icon(
                                if (entry.file.metadataDecrypted) fileIcon(entry.file.mediaKind) else Icons.Default.Lock,
                                contentDescription = null,
                                tint = TCloudBlue,
                            )
                            Column(modifier = Modifier.weight(1f)) {
                                Text(
                                    if (entry.file.metadataDecrypted) entry.file.name else "フォルダを解除すると表示できます",
                                    fontWeight = FontWeight.Medium,
                                )
                                Text(
                                    "${formatBytes(entry.file.sizeBytes)}・${formatDate(entry.expiresAtMillis)}まで",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = Color(0xFF667085),
                                )
                            }
                            IconButton(onClick = { onDelete(entry.file.id) }, enabled = !busy) {
                                Icon(Icons.Default.DeleteOutline, contentDescription = "端末保存から削除")
                            }
                        }
                    }
                    HorizontalDivider(color = Color(0xFFE7E9F0))
                }
            }
            if (busy) {
                Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = TCloudBlue)
                }
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun FolderGridCard(
    folder: CloudFolder,
    selected: Boolean,
    selectionMode: Boolean,
    canManage: Boolean,
    onOpenFolder: (CloudFolder) -> Unit,
    onToggleSelection: (CloudFolder) -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(
        color = if (selected) TCloudSelection else Color.White,
        shape = RoundedCornerShape(14.dp),
        border = androidx.compose.foundation.BorderStroke(
            1.dp,
            if (selected) Color(0xFF8FBAB5) else TCloudLine,
        ),
        shadowElevation = if (selected) 0.dp else 1.dp,
        modifier = modifier
            .aspectRatio(1f)
            .combinedClickable(
                onClick = {
                    if (selectionMode) onToggleSelection(folder) else onOpenFolder(folder)
                },
                onLongClick = { if (canManage) onToggleSelection(folder) },
            ),
    ) {
        Box(Modifier.fillMaxSize()) {
            Surface(
                shape = RoundedCornerShape(16.dp),
                color = Color(0xFFFFF4D8),
                modifier = Modifier.align(Alignment.Center).size(78.dp),
            ) {
                Icon(
                    Icons.Default.Folder,
                    contentDescription = null,
                    tint = Color(0xFFD79A22),
                    modifier = Modifier.padding(17.dp),
                )
            }
            Column(
                modifier = Modifier.align(Alignment.BottomStart).fillMaxWidth().padding(10.dp),
            ) {
                Text(
                    folder.name.ifBlank { "フォルダ" },
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                if (folder.searchPath.isNotBlank()) {
                    Text(
                        folder.searchPath,
                        style = MaterialTheme.typography.labelSmall,
                        color = TCloudMuted,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                Text(
                    "${folder.folderCount}フォルダ・${folder.fileCount}ファイル",
                    style = MaterialTheme.typography.labelSmall,
                    color = TCloudMuted,
                )
            }
            if (canManage) {
                Checkbox(
                    checked = selected,
                    onCheckedChange = { onToggleSelection(folder) },
                    modifier = Modifier.align(Alignment.TopEnd).padding(5.dp).size(34.dp),
                )
            }
            if (folder.isProtected) {
                Icon(
                    if (folder.isUnlocked) Icons.Default.LockOpen else Icons.Default.Lock,
                    contentDescription = null,
                    tint = TCloudMuted,
                    modifier = Modifier.align(Alignment.TopStart).padding(10.dp).size(20.dp),
                )
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun FileGridCard(
    file: CloudFile,
    thumbnailBitmap: Bitmap?,
    selected: Boolean,
    selectionMode: Boolean,
    canManage: Boolean,
    onOpenFile: (CloudFile) -> Unit,
    onRequestThumbnail: (CloudFile) -> Unit,
    onToggleSelection: (CloudFile) -> Unit,
    modifier: Modifier = Modifier,
) {
    LaunchedEffect(file.id, file.hasThumbnail, thumbnailBitmap) {
        if (file.hasThumbnail && thumbnailBitmap == null) onRequestThumbnail(file)
    }
    Surface(
        color = if (selected) TCloudSelection else Color.White,
        shape = RoundedCornerShape(14.dp),
        border = androidx.compose.foundation.BorderStroke(
            1.dp,
            if (selected) Color(0xFF8FBAB5) else TCloudLine,
        ),
        shadowElevation = if (selected) 0.dp else 1.dp,
        modifier = modifier
            .aspectRatio(1f)
            .combinedClickable(
                onClick = {
                    if (selectionMode) onToggleSelection(file) else onOpenFile(file)
                },
                onLongClick = { if (canManage && file.metadataDecrypted) onToggleSelection(file) },
            ),
    ) {
        Box(Modifier.fillMaxSize()) {
            if (thumbnailBitmap != null) {
                Image(
                    bitmap = thumbnailBitmap.asImageBitmap(),
                    contentDescription = null,
                    modifier = Modifier.fillMaxSize(),
                    contentScale = ContentScale.Crop,
                )
            } else {
                Box(
                    modifier = Modifier.fillMaxSize().padding(bottom = 48.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        fileIcon(file.mediaKind),
                        contentDescription = null,
                        tint = TCloudBlue,
                        modifier = Modifier.size(52.dp),
                    )
                }
            }
            Surface(
                color = Color.White.copy(alpha = 0.92f),
                modifier = Modifier.align(Alignment.BottomCenter).fillMaxWidth(),
            ) {
                Column(Modifier.padding(horizontal = 9.dp, vertical = 7.dp)) {
                    Text(
                        file.name.ifBlank { "暗号化ファイル" },
                        fontWeight = FontWeight.SemiBold,
                        style = MaterialTheme.typography.bodySmall,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (file.searchPath.isNotBlank()) {
                        Text(
                            file.searchPath,
                            style = MaterialTheme.typography.labelSmall,
                            color = TCloudMuted,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    Text(
                        formatBytes(file.sizeBytes),
                        style = MaterialTheme.typography.labelSmall,
                        color = TCloudMuted,
                    )
                }
            }
            if (canManage && file.metadataDecrypted) {
                Checkbox(
                    checked = selected,
                    onCheckedChange = { onToggleSelection(file) },
                    modifier = Modifier.align(Alignment.TopEnd).padding(5.dp).size(34.dp),
                )
            }
            if (!file.metadataDecrypted) {
                Icon(
                    Icons.Default.Lock,
                    contentDescription = "暗号化",
                    tint = TCloudMuted,
                    modifier = Modifier.align(Alignment.TopStart).padding(10.dp).size(20.dp),
                )
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun FolderRow(
    folder: CloudFolder,
    selected: Boolean,
    selectionMode: Boolean,
    canManage: Boolean,
    onOpenFolder: (CloudFolder) -> Unit,
    onToggleSelection: (CloudFolder) -> Unit,
    onRename: (CloudFolder) -> Unit,
    onMove: (CloudFolder) -> Unit,
    onShare: (CloudFolder) -> Unit,
) {
    var menuExpanded by remember(folder.id) { mutableStateOf(false) }
    Surface(
        color = if (selected) TCloudSelection else Color.White,
        shape = RoundedCornerShape(13.dp),
        border = androidx.compose.foundation.BorderStroke(
            1.dp,
            if (selected) Color(0xFF8FBAB5) else TCloudLine,
        ),
        shadowElevation = if (selected) 0.dp else 1.dp,
        modifier = Modifier
            .fillMaxWidth()
            .combinedClickable(
                onClick = {
                    if (selectionMode) onToggleSelection(folder) else onOpenFolder(folder)
                },
                onLongClick = { if (canManage) onToggleSelection(folder) },
            ),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(vertical = 13.dp, horizontal = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (selectionMode) {
                Checkbox(
                    checked = selected,
                    onCheckedChange = { onToggleSelection(folder) },
                )
            }
            Surface(shape = RoundedCornerShape(10.dp), color = Color(0xFFFFF4D8)) {
                Icon(
                    Icons.Default.Folder,
                    contentDescription = null,
                    tint = Color(0xFFD79A22),
                    modifier = Modifier.padding(9.dp).size(25.dp),
                )
            }
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    folder.name.ifBlank { "フォルダ" },
                    fontWeight = FontWeight.Medium,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                if (folder.searchPath.isNotBlank()) {
                    Text(
                        folder.searchPath,
                        style = MaterialTheme.typography.bodySmall,
                        color = TCloudMuted,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                Text(
                    "${folder.folderCount}フォルダ・${folder.fileCount}ファイル",
                    style = MaterialTheme.typography.bodySmall,
                    color = TCloudMuted,
                )
            }
            if (folder.isProtected) {
                Icon(
                    if (folder.isUnlocked) Icons.Default.LockOpen else Icons.Default.Lock,
                    contentDescription = if (folder.isUnlocked) "ロック解除済み" else "ロック中",
                    tint = Color(0xFF667085),
                )
            }
            if (!selectionMode && canManage) Box {
                IconButton(onClick = { menuExpanded = true }) {
                    Icon(Icons.Default.MoreVert, contentDescription = "操作", tint = Color(0xFF667085))
                }
                DropdownMenu(expanded = menuExpanded, onDismissRequest = { menuExpanded = false }) {
                    DropdownMenuItem(
                        text = { Text("名前変更") },
                        leadingIcon = { Icon(Icons.Default.Edit, contentDescription = null) },
                        onClick = { menuExpanded = false; onRename(folder) },
                    )
                    DropdownMenuItem(
                        text = { Text("移動") },
                        leadingIcon = { Icon(Icons.AutoMirrored.Filled.DriveFileMove, contentDescription = null) },
                        onClick = { menuExpanded = false; onMove(folder) },
                    )
                    DropdownMenuItem(
                        text = { Text("共有") },
                        leadingIcon = { Icon(Icons.Default.Share, contentDescription = null) },
                        onClick = { menuExpanded = false; onShare(folder) },
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun FileRow(
    file: CloudFile,
    thumbnailBitmap: Bitmap?,
    selected: Boolean,
    selectionMode: Boolean,
    canManage: Boolean,
    onOpenFile: (CloudFile) -> Unit,
    onRequestThumbnail: (CloudFile) -> Unit,
    onToggleSelection: (CloudFile) -> Unit,
    onDownload: (CloudFile) -> Unit,
    onOffline: (CloudFile) -> Unit,
    onMove: (CloudFile) -> Unit,
    onRename: (CloudFile) -> Unit,
    onShare: (CloudFile) -> Unit,
) {
    var menuExpanded by remember(file.id) { mutableStateOf(false) }
    LaunchedEffect(file.id, file.hasThumbnail, thumbnailBitmap) {
        if (file.hasThumbnail && thumbnailBitmap == null) onRequestThumbnail(file)
    }
    Surface(
        color = if (selected) TCloudSelection else Color.White,
        shape = RoundedCornerShape(13.dp),
        border = androidx.compose.foundation.BorderStroke(
            1.dp,
            if (selected) Color(0xFF8FBAB5) else TCloudLine,
        ),
        shadowElevation = if (selected) 0.dp else 1.dp,
        modifier = Modifier
            .fillMaxWidth()
            .combinedClickable(
                onClick = {
                    if (selectionMode) onToggleSelection(file) else onOpenFile(file)
                },
                onLongClick = { if (canManage && file.metadataDecrypted) onToggleSelection(file) },
            ),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(vertical = 13.dp, horizontal = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (selectionMode) {
                Checkbox(
                    checked = selected,
                    onCheckedChange = { onToggleSelection(file) },
                    enabled = file.metadataDecrypted,
                )
            }
            Surface(
                shape = RoundedCornerShape(10.dp),
                color = when (file.mediaKind) {
                    "image" -> Color(0xFFE7F4EF)
                    "video" -> Color(0xFFE8ECF8)
                    "audio" -> Color(0xFFF3EAF7)
                    else -> Color(0xFFF1F3F5)
                },
            ) {
                if (thumbnailBitmap != null) {
                    Image(
                        bitmap = thumbnailBitmap.asImageBitmap(),
                        contentDescription = null,
                        modifier = Modifier.size(44.dp),
                        contentScale = ContentScale.Crop,
                    )
                } else {
                    Icon(
                        fileIcon(file.mediaKind),
                        contentDescription = null,
                        tint = TCloudBlue,
                        modifier = Modifier.padding(9.dp).size(25.dp),
                    )
                }
            }
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    file.name.ifBlank { "暗号化ファイル" },
                    fontWeight = FontWeight.Medium,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                if (file.searchPath.isNotBlank()) {
                    Text(
                        file.searchPath,
                        style = MaterialTheme.typography.bodySmall,
                        color = TCloudMuted,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                Text(
                    formatBytes(file.sizeBytes),
                    style = MaterialTheme.typography.bodySmall,
                    color = TCloudMuted,
                )
            }
            if (file.cryptoVersion == 1 && !file.metadataDecrypted) {
                Icon(Icons.Default.Lock, contentDescription = "暗号化", tint = Color(0xFF667085))
            } else if (!selectionMode && canManage) {
                Box {
                    IconButton(onClick = { menuExpanded = true }) {
                        Icon(Icons.Default.MoreVert, contentDescription = "操作", tint = Color(0xFF667085))
                    }
                    DropdownMenu(expanded = menuExpanded, onDismissRequest = { menuExpanded = false }) {
                        DropdownMenuItem(
                            text = { Text("名前変更") },
                            leadingIcon = { Icon(Icons.Default.Edit, contentDescription = null) },
                            onClick = { menuExpanded = false; onRename(file) },
                        )
                        DropdownMenuItem(
                            text = { Text("移動") },
                            leadingIcon = { Icon(Icons.AutoMirrored.Filled.DriveFileMove, contentDescription = null) },
                            onClick = { menuExpanded = false; onMove(file) },
                        )
                        DropdownMenuItem(
                            text = { Text("共有") },
                            leadingIcon = { Icon(Icons.Default.Share, contentDescription = null) },
                            onClick = { menuExpanded = false; onShare(file) },
                        )
                        DropdownMenuItem(
                            text = { Text("オフライン保存") },
                            leadingIcon = { Icon(Icons.Default.DownloadForOffline, contentDescription = null) },
                            onClick = { menuExpanded = false; onOffline(file) },
                        )
                        DropdownMenuItem(
                            text = { Text("ダウンロード") },
                            leadingIcon = { Icon(Icons.Default.Download, contentDescription = null) },
                            onClick = { menuExpanded = false; onDownload(file) },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ShareCreateDialog(
    itemName: String,
    busy: Boolean,
    onCreate: (String, Int) -> Unit,
    onDismiss: () -> Unit,
) {
    val context = LocalContext.current
    var password by remember(itemName) { mutableStateOf("") }
    var validDays by remember(itemName) { mutableStateOf("7") }
    var passwordVisible by remember(itemName) { mutableStateOf(false) }
    fun generatePassword() {
        val alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!#%+-_"
        val random = ByteArray(28).also(SecureRandom()::nextBytes)
        password = buildString(random.size) {
            random.forEach { value -> append(alphabet[(value.toInt() and 0xff) % alphabet.length]) }
        }
        random.fill(0)
        context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(
            ClipData.newPlainText("T-Cloud 共有PW", password),
        )
    }
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text("共有URLを発行") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(itemName, style = MaterialTheme.typography.bodyMedium)
                OutlinedTextField(
                    value = password,
                    onValueChange = { if (it.length <= 128) password = it },
                    label = { Text("共有PW（12文字以上）") },
                    singleLine = true,
                    enabled = !busy,
                    visualTransformation = if (passwordVisible) VisualTransformation.None else PasswordVisualTransformation(),
                    trailingIcon = {
                        IconButton(onClick = { passwordVisible = !passwordVisible }) {
                            Icon(
                                if (passwordVisible) Icons.Default.VisibilityOff else Icons.Default.Visibility,
                                contentDescription = if (passwordVisible) "PWを隠す" else "PWを表示",
                            )
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                )
                TextButton(onClick = ::generatePassword, enabled = !busy) {
                    Text("強固なPWを生成してコピー")
                }
                OutlinedTextField(
                    value = validDays,
                    onValueChange = { value -> if (value.all(Char::isDigit) && value.length <= 4) validDays = value },
                    label = { Text("有効期間（日）") },
                    supportingText = { Text("1〜3650日。初期値は7日です。") },
                    singleLine = true,
                    enabled = !busy,
                    modifier = Modifier.fillMaxWidth(),
                )
                Text(
                    "共有先では、このPWだけで対象を開けます。フォルダPWや復号鍵は共有されません。",
                    style = MaterialTheme.typography.bodySmall,
                    color = Color(0xFF667085),
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = { onCreate(password, validDays.toIntOrNull() ?: 0) },
                enabled = !busy && password.length in 12..128 && (validDays.toIntOrNull() ?: 0) in 1..3650,
            ) { Text(if (busy) "発行中…" else "発行する") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !busy) { Text("キャンセル") }
        },
    )
}

@Composable
private fun ShareResultDialog(
    result: ShareResult,
    onDismiss: () -> Unit,
) {
    val context = LocalContext.current
    fun copy(label: String, value: String) {
        context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(
            ClipData.newPlainText(label, value),
        )
    }
    val combined = "【T-Cloud Storage 共有】\n\nURL\n${result.url}\n\nパスワード\n${result.password}"
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("共有URLを発行しました") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("URL", fontWeight = FontWeight.SemiBold)
                Text(result.url, style = MaterialTheme.typography.bodySmall)
                Text("パスワード", fontWeight = FontWeight.SemiBold)
                Text(result.password)
                Text(
                    "有効期限：${formatDate(result.expiresAt * 1000)}",
                    style = MaterialTheme.typography.bodySmall,
                    color = Color(0xFF667085),
                )
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
                    TextButton(onClick = { copy("T-Cloud 共有URL", result.url) }) { Text("URL") }
                    TextButton(onClick = { copy("T-Cloud 共有PW", result.password) }) { Text("PW") }
                    TextButton(onClick = { copy("T-Cloud 共有", combined) }) { Text("まとめて") }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("閉じる") } },
    )
}

@Composable
private fun DeleteSelectionDialog(
    count: Int,
    isAdmin: Boolean,
    busy: Boolean,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text("本当に削除しますか？") },
        text = {
            Text(
                if (isAdmin) {
                    "選択した${count}件をゴミ箱へ移動します。"
                } else {
                    "選択した${count}件を削除します。"
                },
            )
        },
        confirmButton = {
            TextButton(onClick = onConfirm, enabled = !busy) {
                Text(if (busy) "削除中…" else "はい", color = Color(0xFFB42318))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !busy) { Text("いいえ") }
        },
    )
}

@Composable
private fun RenameItemDialog(
    currentName: String,
    busy: Boolean,
    onRename: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    var name by remember(currentName) { mutableStateOf(currentName) }
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text("名前変更") },
        text = {
            OutlinedTextField(
                value = name,
                onValueChange = { if (it.length <= 240) name = it },
                label = { Text("新しい名前") },
                singleLine = true,
                enabled = !busy,
                modifier = Modifier.fillMaxWidth(),
            )
        },
        confirmButton = {
            TextButton(
                onClick = { onRename(name.trim()) },
                enabled = !busy && name.trim().isNotEmpty() && name.trim() != currentName,
            ) { Text(if (busy) "変更中…" else "変更する") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !busy) { Text("キャンセル") }
        },
    )
}

@Composable
private fun MoveItemDialog(
    itemName: String,
    destinations: List<MoveDestination>,
    busy: Boolean,
    onMove: (Long) -> Unit,
    onDismiss: () -> Unit,
) {
    var selectedId by remember(itemName) { mutableStateOf<Long?>(null) }
    var submitted by remember(itemName) { mutableStateOf(false) }
    val operationBusy = busy || submitted
    LaunchedEffect(busy) {
        if (submitted && !busy) submitted = false
    }
    AlertDialog(
        onDismissRequest = { if (!operationBusy) onDismiss() },
        title = { Text("移動先を選択") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(itemName, style = MaterialTheme.typography.bodyMedium)
                when {
                    busy && destinations.isEmpty() -> Box(
                        modifier = Modifier.fillMaxWidth().height(120.dp),
                        contentAlignment = Alignment.Center,
                    ) { CircularProgressIndicator(color = TCloudBlue) }
                    destinations.isEmpty() -> Text("選択できる移動先がありません。")
                    else -> LazyColumn(modifier = Modifier.fillMaxWidth().heightIn(max = 420.dp)) {
                        items(destinations, key = { "move-${it.id}" }) { destination ->
                            Surface(
                                onClick = { if (!operationBusy) selectedId = destination.id },
                                color = Color.Transparent,
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Row(
                                    modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    RadioButton(
                                        selected = selectedId == destination.id,
                                        onClick = { if (!operationBusy) selectedId = destination.id },
                                    )
                                    Text(
                                        text = "　".repeat(destination.depth.coerceAtMost(8)) + destination.name,
                                        modifier = Modifier.weight(1f),
                                    )
                                    if (destination.isProtected) {
                                        Icon(Icons.Default.Lock, contentDescription = "PW付き")
                                    }
                                }
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    val destinationId = selectedId ?: return@TextButton
                    if (operationBusy) return@TextButton
                    submitted = true
                    onMove(destinationId)
                },
                enabled = !operationBusy && selectedId != null,
            ) { Text(if (operationBusy && selectedId != null) "移動中…" else "移動する") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !operationBusy) { Text("キャンセル") }
        },
    )
}

@androidx.annotation.OptIn(UnstableApi::class)
@OptIn(ExperimentalMaterial3Api::class)
@SuppressLint("ClickableViewAccessibility")
@Composable
private fun MediaPlayerScreen(
    file: CloudFile,
    dataSourceFactory: androidx.media3.datasource.DataSource.Factory,
    playbackManager: TCloudPlaybackManager,
    startAtBeginning: Boolean,
    pictureInPicture: Boolean,
    onPlayPrevious: () -> Unit,
    onPlayNext: () -> Unit,
    onAutomaticRepeatNext: () -> Unit,
    onClose: () -> Unit,
) {
    val context = LocalContext.current
    val activity = context as? Activity
    val orientation = LocalConfiguration.current.orientation
    val isVideo = file.mediaKind == "video"
    val isAudio = file.mediaKind == "audio"
    var manualFullscreen by remember(file.id) { mutableStateOf(false) }
    var playbackMode by remember(file.id) {
        mutableStateOf(
            if (playbackManager.repeatAllEnabled) {
                PlaybackMode.REPEAT_ALL
            } else PlaybackMode.OFF,
        )
    }
    val isLandscape = orientation == Configuration.ORIENTATION_LANDSCAPE
    val isVideoFullscreen = isVideo && (isLandscape || manualFullscreen) && !pictureInPicture
    val playbackFactory = remember(file.id) { dataSourceFactory }
    val reusingBackgroundAudio = isAudio && playbackManager.currentFileId == file.id
    val player = remember(file.id) {
        if (isAudio) {
            playbackManager.playAudio(file, playbackFactory, startAtBeginning)
        } else ExoPlayer.Builder(context).build().apply {
            val mediaItem = MediaItem.Builder()
                .setUri("tcloud://file/${file.id}")
                .setMimeType(playbackMimeType(file))
                .build()
            setMediaSource(ProgressiveMediaSource.Factory(playbackFactory).createMediaSource(mediaItem))
            prepare()
            playWhenReady = true
        }
    }
    LaunchedEffect(player, file.id) {
        val resumePosition = context.readPlaybackPosition(file.id)
        if (startAtBeginning) {
            player.seekTo(0L)
        } else if (!reusingBackgroundAudio && resumePosition > 0L) {
            player.seekTo(resumePosition)
        }
        while (true) {
            delay(5_000)
            context.savePlaybackPosition(file.id, player.currentPosition, player.duration)
        }
    }
    LaunchedEffect(player, playbackMode, file.id) {
        if (isAudio) {
            playbackManager.setPlaybackStatus(playbackMode == PlaybackMode.REPEAT_ALL)
        } else {
            player.repeatMode = Player.REPEAT_MODE_OFF
            playbackManager.setPlaybackStatus(
                playbackMode == PlaybackMode.REPEAT_ALL,
                refreshNotification = false,
            )
        }
    }
    DisposableEffect(player, file.id, playbackMode) {
        val listener = object : Player.Listener {
            override fun onPlaybackStateChanged(playbackState: Int) {
                if (!isAudio && playbackState == Player.STATE_ENDED && playbackMode == PlaybackMode.REPEAT_ALL) {
                    onAutomaticRepeatNext()
                }
            }
        }
        player.addListener(listener)
        onDispose { player.removeListener(listener) }
    }
    DisposableEffect(player, context, file.id) {
        onDispose {
            context.savePlaybackPosition(file.id, player.currentPosition, player.duration)
            if (!isAudio) {
                player.stop()
                player.clearMediaItems()
                player.release()
                (playbackFactory as? AutoCloseable)?.close()
            }
        }
    }
    DisposableEffect(activity, file.id, isVideo) {
        if (isVideo) activity?.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR
        onDispose {
            activity?.setVideoSystemBarsHidden(false)
            if (isVideo) activity?.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        }
    }
    LaunchedEffect(activity, isVideoFullscreen) {
        activity?.setVideoSystemBarsHidden(isVideoFullscreen)
    }

    Scaffold(
        containerColor = Color.Black,
        topBar = {
            if (!pictureInPicture && !isVideoFullscreen) TopAppBar(
                title = {
                    Column {
                        Text(file.name, maxLines = 1)
                        if (playbackMode == PlaybackMode.REPEAT_ALL) {
                            Text(
                                "全体リピート中",
                                style = MaterialTheme.typography.labelSmall,
                                color = TCloudBlue,
                            )
                        }
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onClose) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "閉じる")
                    }
                },
                actions = {
                    if (isAudio) {
                        IconButton(onClick = onPlayPrevious) {
                            Icon(Icons.Default.SkipPrevious, contentDescription = "前の曲")
                        }
                        IconButton(onClick = onPlayNext) {
                            Icon(Icons.Default.SkipNext, contentDescription = "次の曲")
                        }
                    }
                    IconButton(
                        onClick = {
                            playbackMode = nextPlaybackMode(playbackMode, file.mediaKind)
                        },
                    ) {
                        Icon(
                            when (playbackMode) {
                                PlaybackMode.OFF -> Icons.Default.Repeat
                                PlaybackMode.REPEAT_ALL -> Icons.AutoMirrored.Filled.PlaylistPlay
                            },
                            contentDescription = when (playbackMode) {
                                PlaybackMode.OFF -> "再生後に停止"
                                PlaybackMode.REPEAT_ALL -> "全体リピート"
                            },
                            tint = if (playbackMode == PlaybackMode.OFF) TCloudMuted else TCloudBlue,
                        )
                    }
                    if (file.mediaKind == "video") {
                        IconButton(
                            onClick = {
                                val activity = context as? Activity
                                if (activity != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                                    val params = PictureInPictureParams.Builder()
                                        .setAspectRatio(Rational(16, 9))
                                        .build()
                                    activity.enterPictureInPictureMode(params)
                                }
                            },
                        ) {
                            Icon(Icons.Default.PictureInPictureAlt, contentDescription = "小窓で再生")
                        }
                        IconButton(
                            onClick = {
                                if (TvCastLauncher.launch(context)) {
                                    Toast.makeText(
                                        context,
                                        "テレビを選択すると、端末画面を安全に映せます。",
                                        Toast.LENGTH_LONG,
                                    ).show()
                                } else {
                                    Toast.makeText(
                                        context,
                                        "この端末ではテレビへの画面共有を開けませんでした。",
                                        Toast.LENGTH_LONG,
                                    ).show()
                                }
                            },
                        ) {
                            Icon(Icons.Default.Cast, contentDescription = "テレビに映す")
                        }
                    }
                },
            )
        },
    ) { padding ->
        AndroidView(
            modifier = Modifier.fillMaxSize().padding(padding),
            factory = { viewContext ->
                PlayerView(viewContext).apply {
                    useController = true
                    setShowBuffering(PlayerView.SHOW_BUFFERING_WHEN_PLAYING)
                    this.player = player
                    if (isVideo) {
                        val edgeSeekDetector = GestureDetector(
                            viewContext,
                            object : GestureDetector.SimpleOnGestureListener() {
                                override fun onDown(event: MotionEvent): Boolean = true

                                override fun onDoubleTap(event: MotionEvent): Boolean {
                                    val offset = if (event.x < width / 2f) -10_000L else 10_000L
                                    val duration = player.duration.takeIf { it > 0L } ?: Long.MAX_VALUE
                                    player.seekTo((player.currentPosition + offset).coerceIn(0L, duration))
                                    showController()
                                    return true
                                }
                            },
                        )
                        setOnTouchListener { _, event ->
                            edgeSeekDetector.onTouchEvent(event)
                            false
                        }
                        setFullscreenButtonClickListener { enterFullscreen ->
                            manualFullscreen = enterFullscreen
                            if (enterFullscreen) {
                                activity?.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR
                            } else {
                                activity?.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
                            }
                        }
                    }
                }
            },
            update = { playerView ->
                playerView.player = player
                if (isVideo) {
                    playerView.setFullscreenButtonState(isVideoFullscreen)
                    playerView.setFullscreenButtonClickListener { enterFullscreen ->
                        manualFullscreen = enterFullscreen
                        if (enterFullscreen) {
                            activity?.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR
                        } else {
                            activity?.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
                        }
                    }
                }
            },
        )
    }
}

internal enum class PlaybackMode {
    OFF,
    REPEAT_ALL,
}

internal fun nextPlaybackMode(current: PlaybackMode, @Suppress("UNUSED_PARAMETER") mediaKind: String): PlaybackMode =
    if (current == PlaybackMode.REPEAT_ALL) PlaybackMode.OFF else PlaybackMode.REPEAT_ALL

private const val PLAYBACK_POSITION_PREFERENCES = "tcloud_playback_positions"
private const val PLAYBACK_POSITION_MINIMUM_MS = 5_000L
private const val PLAYBACK_POSITION_FINISHED_MARGIN_MS = 10_000L

private fun Context.readPlaybackPosition(fileId: Long): Long =
    getSharedPreferences(PLAYBACK_POSITION_PREFERENCES, Context.MODE_PRIVATE)
        .getLong("position_$fileId", 0L)
        .coerceAtLeast(0L)

private fun Context.savePlaybackPosition(fileId: Long, positionMs: Long, durationMs: Long) {
    val preferences = getSharedPreferences(PLAYBACK_POSITION_PREFERENCES, Context.MODE_PRIVATE)
    val finished = durationMs > 0L && durationMs - positionMs <= PLAYBACK_POSITION_FINISHED_MARGIN_MS
    if (positionMs < PLAYBACK_POSITION_MINIMUM_MS || finished) {
        preferences.edit().remove("position_$fileId").apply()
    } else {
        preferences.edit().putLong("position_$fileId", positionMs).apply()
    }
}

private fun Activity.setVideoSystemBarsHidden(hidden: Boolean) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        window.insetsController?.let { controller ->
            if (hidden) {
                controller.hide(WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars())
                controller.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            } else {
                controller.show(WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars())
            }
        }
    } else {
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = if (hidden) {
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                View.SYSTEM_UI_FLAG_FULLSCREEN or
                View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
                View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
        } else {
            View.SYSTEM_UI_FLAG_VISIBLE
        }
    }
}

@androidx.annotation.OptIn(UnstableApi::class)
private fun playbackMimeType(file: CloudFile): String = when (file.name.substringAfterLast('.', "").lowercase()) {
    "flv" -> MimeTypes.VIDEO_FLV
    "mp4", "m4v", "mov" -> MimeTypes.VIDEO_MP4
    "mp3" -> MimeTypes.AUDIO_MPEG
    "m4a", "aac" -> MimeTypes.AUDIO_AAC
    else -> file.mimeType.ifBlank { "application/octet-stream" }
}

@Composable
private fun FolderSecurityDialog(
    folder: CloudFolder,
    busy: Boolean,
    canRelock: Boolean,
    onChangePassword: (String) -> Unit,
    onRelock: () -> Unit,
    onDismiss: () -> Unit,
) {
    var password by remember(folder.id) { mutableStateOf("") }
    var confirmation by remember(folder.id) { mutableStateOf("") }
    var visible by remember(folder.id) { mutableStateOf(false) }
    val valid = password.length >= 4 && password == confirmation
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text("${folder.name} のPW・ロック") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("PWを変更しても、保存済みデータを再アップロードする必要はありません。")
                OutlinedTextField(
                    value = password,
                    onValueChange = { password = it.take(128) },
                    label = { Text("新しいフォルダPW") },
                    singleLine = true,
                    visualTransformation = if (visible) VisualTransformation.None else PasswordVisualTransformation(),
                    trailingIcon = {
                        IconButton(onClick = { visible = !visible }) {
                            Icon(
                                if (visible) Icons.Default.VisibilityOff else Icons.Default.Visibility,
                                contentDescription = if (visible) "PWを隠す" else "PWを表示",
                            )
                        }
                    },
                )
                OutlinedTextField(
                    value = confirmation,
                    onValueChange = { confirmation = it.take(128) },
                    label = { Text("もう一度入力") },
                    singleLine = true,
                    visualTransformation = if (visible) VisualTransformation.None else PasswordVisualTransformation(),
                )
                if (confirmation.isNotEmpty() && confirmation != password) {
                    Text("PWが一致していません。", color = Color(0xFFB42318))
                }
                if (canRelock) {
                    HorizontalDivider()
                    Text("再ロックすると、この端末でも次回はフォルダPWの入力が必要です。")
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { onChangePassword(password) }, enabled = !busy && valid) {
                Text(if (busy) "変更中…" else "PWを変更")
            }
        },
        dismissButton = {
            Row {
                if (canRelock) {
                    TextButton(onClick = onRelock, enabled = !busy) { Text("再ロック") }
                }
                TextButton(onClick = onDismiss, enabled = !busy) { Text("閉じる") }
            }
        },
    )
}

@Composable
private fun UnlockFolderDialog(
    folder: CloudFolder,
    busy: Boolean,
    onUnlock: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    var password by remember(folder.id) { mutableStateOf("") }
    var visible by remember(folder.id) { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(folder.name.ifBlank { "フォルダを開く" }) },
        text = {
            OutlinedTextField(
                value = password,
                onValueChange = { password = it },
                enabled = !busy,
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                label = { Text("フォルダのパスワード") },
                visualTransformation = if (visible) VisualTransformation.None else PasswordVisualTransformation(),
                trailingIcon = {
                    IconButton(onClick = { visible = !visible }) {
                        Icon(
                            if (visible) Icons.Default.VisibilityOff else Icons.Default.Visibility,
                            contentDescription = if (visible) "パスワードを隠す" else "パスワードを表示",
                        )
                    }
                },
            )
        },
        confirmButton = {
            TextButton(onClick = { onUnlock(password) }, enabled = !busy && password.length >= 4) {
                Text(if (busy) "確認中…" else "開く")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !busy) { Text("キャンセル") }
        },
    )
}

private fun fileIcon(mediaKind: String): ImageVector = when (mediaKind) {
    "image" -> Icons.Default.Image
    "video" -> Icons.Default.Movie
    "audio" -> Icons.Default.MusicNote
    else -> Icons.AutoMirrored.Filled.InsertDriveFile
}

private fun formatBytes(bytes: Long): String {
    if (bytes < 1024) return "${bytes} B"
    val units = listOf("KB", "MB", "GB", "TB")
    var value = bytes.toDouble()
    var unit = -1
    do {
        value /= 1024
        unit += 1
    } while (value >= 1024 && unit < units.lastIndex)
    return "${DecimalFormat("0.#").format(value)} ${units[unit]}"
}

private fun formatDate(epochMillis: Long): String =
    SimpleDateFormat("yyyy年M月d日", Locale.JAPAN).format(Date(epochMillis))

private fun formatDateTime(epochMillis: Long): String =
    if (epochMillis <= 0) "—" else SimpleDateFormat("M月d日 HH:mm", Locale.JAPAN).format(Date(epochMillis))
