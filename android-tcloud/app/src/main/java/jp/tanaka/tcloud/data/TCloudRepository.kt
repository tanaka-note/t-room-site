package jp.tanaka.tcloud.data

import jp.tanaka.tcloud.crypto.TCloudCrypto
import jp.tanaka.tcloud.offline.TCloudOfflineStore
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import java.io.OutputStream
import java.io.Closeable
import java.security.PrivateKey
import java.util.concurrent.ConcurrentHashMap

class FolderPasswordRequiredException(
    val folder: CloudFolder,
) : Exception("「${folder.name}」のパスワードを入力してください。")

class TCloudRepository(
    private val api: TCloudApi,
    private val sessionStore: SecureSessionStore,
    private val offlineStore: TCloudOfflineStore,
) {
    private val keyLock = Any()
    private val folderKeys = ConcurrentHashMap<Long, ByteArray>()
    private val knownFolders = ConcurrentHashMap<Long, CloudFolder>()
    @Volatile private var session: Session? = null
    @Volatile private var adminPrivateKey: PrivateKey? = null

    suspend fun restore(): Pair<Session, FolderPage?> {
        val restoredSession = api.session()
        if (!restoredSession.authenticated) return restoredSession to null
        session = restoredSession
        if (restoredSession.isAdmin && !prepareAdminKey()) {
            api.logout()
            session = null
            return Session(authenticated = false) to null
        }
        return restoredSession to listItems(null)
    }

    suspend fun login(loginId: String, password: String): Pair<Session, FolderPage> {
        val authMode = api.authMode()
        check(authMode.mode == "proof") {
            "Androidアプリで利用できる暗号認証がCloudflare側に設定されていません。"
        }
        check(authMode.credentialSalt.isNotBlank()) {
            "認証互換情報を取得できませんでした。アプリを更新して再試行してください。"
        }
        val credentials = TCloudCrypto.deriveAccountCredentials(
            password = password,
            loginId = loginId,
            credentialSalt = authMode.credentialSalt,
        )
        try {
            val loggedInSession = api.login(loginId, credentials.authProof)
            session = loggedInSession
            if (loggedInSession.isAdmin) {
                sessionStore.saveAccountKey(credentials.accountKey)
                check(prepareAdminKey()) { "管理者の暗号鍵を解除できませんでした。" }
            } else {
                // 副管理者のアカウント鍵は管理者秘密鍵の復号には利用させない。
                sessionStore.clearAccountKey()
                adminPrivateKey = null
            }
            return loggedInSession to listItems(null)
        } finally {
            credentials.accountKey.fill(0)
        }
    }

    suspend fun openFolder(folder: CloudFolder): FolderPage {
        prepareFolderKey(folder).fill(0)
        return listItems(folder.id)
    }

    suspend fun loadThumbnail(file: CloudFile): ByteArray {
        require(file.hasThumbnail && file.metadataDecrypted) { "サムネイルを表示できません。" }
        val envelope = api.downloadThumbnail(file.id)
        if (file.cryptoVersion != 1) return envelope
        val folder = knownFolders[file.folderId]
            ?: throw IllegalStateException("フォルダの暗号鍵を確認できません。")
        val folderKey = prepareFolderKey(folder)
        return try {
            TCloudCrypto.decryptThumbnail(file, folderKey, envelope)
        } finally {
            envelope.fill(0)
            folderKey.fill(0)
        }
    }

    suspend fun createFolder(parentId: Long?, name: String, password: String): FolderPage {
        val parentKey = parentId?.let { id ->
            val parent = knownFolders[id]
                ?: throw IllegalStateException("親フォルダの暗号鍵を確認できません。")
            prepareFolderKey(parent)
        }
        val config = api.cryptoConfig()
        check(config.initialized && config.publicKeyJwk.isNotBlank()) {
            "暗号化設定を確認できません。"
        }
        val payload = try {
            TCloudCrypto.createFolderPackage(name, password, config.publicKeyJwk, parentKey)
        } finally {
            parentKey?.fill(0)
        }
        try {
            val id = api.createFolder(parentId, payload)
            cacheFolderKey(id, payload.folderKey, persist = true)
            return listItems(parentId)
        } finally {
            payload.folderKey.fill(0)
        }
    }

    suspend fun unlockAndOpenFolder(folder: CloudFolder, password: String): FolderPage {
        val credentials = TCloudCrypto.deriveFolderCredentials(folder, password)
        try {
            api.unlockFolder(folder.id, credentials.authProof)
            cacheFolderKey(folder.id, credentials.folderKey, persist = true)
            return listItems(folder.id)
        } finally {
            credentials.folderKey.fill(0)
        }
    }

    suspend fun logout() {
        clearMemoryKeys()
        api.logout()
        session = null
    }

    suspend fun listItems(folderId: Long?): FolderPage = decryptPage(api.listItems(folderId))

    suspend fun listPlayerMedia(rootFolderId: Long): List<CloudPlayerMedia> {
        val results = linkedMapOf<Long, CloudPlayerMedia>()
        var offset: Int? = 0
        var pages = 0
        while (offset != null && pages < MAX_PLAYER_MEDIA_PAGES) {
            currentCoroutineContext().ensureActive()
            val page = api.listPlayerMedia(rootFolderId, offset)
            page.keyFolders.forEach { knownFolders[it.id] = it }
            val visibleFolders = linkedMapOf<Long, CloudFolder>()
            page.keyFolders.forEach { folder ->
                val visible = runCatching {
                    val key = prepareFolderKey(folder)
                    try {
                        folder.copy(
                            name = if (folder.encryptedName.isNotBlank()) {
                                TCloudCrypto.decryptFolderName(folder, key)
                            } else {
                                folder.name
                            },
                            isUnlocked = true,
                        )
                    } finally {
                        key.fill(0)
                    }
                }.getOrNull() ?: return@forEach
                knownFolders[folder.id] = visible
                visibleFolders[folder.id] = visible
            }
            page.files.forEach { record ->
                val folder = visibleFolders[record.file.folderId] ?: knownFolders[record.file.folderId]
                    ?: return@forEach
                val key = runCatching { prepareFolderKey(folder) }.getOrNull() ?: return@forEach
                val metadata = try {
                    runCatching { TCloudCrypto.decryptFileMetadata(record.file, key) }.getOrNull()
                } finally {
                    key.fill(0)
                } ?: return@forEach
                val file = record.file.copy(
                    name = metadata.name,
                    mimeType = metadata.mimeType,
                    mediaKind = metadata.mediaKind,
                    lastModified = metadata.lastModified,
                    metadataDecrypted = true,
                    searchPath = record.pathFolderIds.mapNotNull { visibleFolders[it]?.name ?: knownFolders[it]?.name }
                        .joinToString(" / "),
                )
                if (file.mediaKind in setOf("audio", "video")) {
                    results[file.id] = record.copy(file = file, folder = folder)
                }
            }
            offset = page.nextOffset
            pages += 1
        }
        return results.values.toList()
    }

    fun prepareCloudPlayback(file: CloudFile, folder: CloudFolder) {
        knownFolders[folder.id] = folder
        prepareFolderKey(folder).fill(0)
    }

    suspend fun youtubeMetadata(videoId: String): YouTubeVideoMetadata = api.youtubeMetadata(videoId)

    suspend fun searchYouTube(query: String, maxResults: Int = 8): List<YouTubeVideoMetadata> =
        api.searchYouTube(query, maxResults)

    suspend fun searchItems(
        folderId: Long?,
        query: String,
        kind: String,
        onProgress: (Int) -> Unit = {},
    ): CloudSearchResults {
        val normalizedQuery = query.trim().lowercase()
        if (normalizedQuery.isBlank()) return CloudSearchResults()
        var folderOffset: Int? = 0
        var fileOffset: Int? = 0
        var scanned = 0
        var pages = 0
        val folders = linkedMapOf<Long, CloudFolder>()
        val files = linkedMapOf<Long, CloudFile>()
        while ((folderOffset != null || fileOffset != null) && pages < MAX_SEARCH_PAGES &&
            folders.size + files.size < MAX_SEARCH_RESULTS
        ) {
            currentCoroutineContext().ensureActive()
            val page = api.searchItems(
                folderId = folderId,
                query = normalizedQuery,
                kind = kind,
                folderOffset = folderOffset,
                fileOffset = fileOffset,
            )
            page.keyFolders.forEach { folder ->
                knownFolders[folder.id] = folder
                runCatching { prepareFolderKey(folder).fill(0) }
            }
            page.folders.forEach { folder ->
                knownFolders[folder.id] = folder
                val visible = runCatching {
                    val key = prepareFolderKey(folder)
                    try {
                        if (folder.name.isBlank() || folder.name == "[encrypted]") {
                            folder.copy(name = TCloudCrypto.decryptFolderName(folder, key), isUnlocked = true)
                        } else {
                            folder.copy(isUnlocked = true)
                        }
                    } finally {
                        key.fill(0)
                    }
                }.getOrDefault(folder)
                if (visible.name.contains(normalizedQuery, ignoreCase = true)) folders[visible.id] = visible
            }
            page.files.forEach { file ->
                val parent = knownFolders[file.folderId] ?: return@forEach
                val visible = runCatching {
                    val key = prepareFolderKey(parent)
                    try {
                        val metadata = TCloudCrypto.decryptFileMetadata(file, key)
                        file.copy(
                            name = metadata.name,
                            mimeType = metadata.mimeType,
                            mediaKind = metadata.mediaKind,
                            lastModified = metadata.lastModified,
                            metadataDecrypted = true,
                        )
                    } finally {
                        key.fill(0)
                    }
                }.getOrNull() ?: return@forEach
                if (visible.name.contains(normalizedQuery, ignoreCase = true) &&
                    (kind.isBlank() || kind == "all" || visible.mediaKind == kind)
                ) files[visible.id] = visible
            }
            scanned += page.folders.size + page.files.size
            onProgress(scanned)
            folderOffset = page.nextFolderOffset
            fileOffset = page.nextFileOffset
            pages += 1
        }
        val orderedFolders = folders.values.sortedWith(searchResultComparator(normalizedQuery))
        val orderedFiles = files.values.sortedWith(searchResultComparator(normalizedQuery))
        return CloudSearchResults(
            folders = orderedFolders.take(MAX_SEARCH_RESULTS),
            files = orderedFiles.take((MAX_SEARCH_RESULTS - orderedFolders.size).coerceAtLeast(0)),
            truncated = folderOffset != null || fileOffset != null,
        )
    }

    private fun <T> searchResultComparator(query: String): Comparator<T> where T : Any =
        Comparator { left, right ->
            val leftDepth = when (left) {
                is CloudFolder -> left.searchDepth
                is CloudFile -> left.searchDepth
                else -> 0
            }
            val rightDepth = when (right) {
                is CloudFolder -> right.searchDepth
                is CloudFile -> right.searchDepth
                else -> 0
            }
            val leftName = when (left) {
                is CloudFolder -> left.name
                is CloudFile -> left.name
                else -> ""
            }
            val rightName = when (right) {
                is CloudFolder -> right.name
                is CloudFile -> right.name
                else -> ""
            }
            compareSearchResultValues(leftDepth, leftName, rightDepth, rightName, query)
        }

    suspend fun usage(): CloudUsage = api.usage()

    suspend fun usageDetails(): List<CloudUsageFolder> = api.usageDetails()

    suspend fun listTrash(): TrashPage {
        check(session?.isAdmin == true) { "ゴミ箱は管理者のみ確認できます。" }
        val page = api.listTrash()
        val files = page.files.map { item ->
            knownFolders[item.folder.id] = item.folder
            val key = runCatching { prepareFolderKey(item.folder) }.getOrNull()
                ?: return@map item
            try {
                val metadata = TCloudCrypto.decryptFileMetadata(item.file, key)
                item.copy(
                    file = item.file.copy(
                        name = metadata.name,
                        mimeType = metadata.mimeType,
                        mediaKind = metadata.mediaKind,
                        lastModified = metadata.lastModified,
                        metadataDecrypted = true,
                    ),
                )
            } finally {
                key.fill(0)
            }
        }
        val folders = page.folders.map { item ->
            knownFolders[item.folder.id] = item.folder
            val key = runCatching { prepareFolderKey(item.folder) }.getOrNull()
                ?: return@map item
            try {
                item.copy(
                    folder = item.folder.copy(
                        name = TCloudCrypto.decryptFolderName(item.folder, key),
                        isUnlocked = true,
                    ),
                )
            } finally {
                key.fill(0)
            }
        }
        return TrashPage(files, folders)
    }

    suspend fun restoreTrashFile(fileId: Long) = api.restoreFile(fileId)

    suspend fun permanentlyDeleteTrashFile(fileId: Long) {
        api.permanentlyDeleteFile(fileId)
        offlineStore.delete(fileId)
    }

    suspend fun restoreTrashFolder(folderId: Long) = api.restoreFolder(folderId)

    suspend fun emptyTrash(): Boolean = api.emptyTrash()

    suspend fun loadFileForBackground(folderId: Long, fileId: Long): CloudFile {
        if (session?.authenticated != true) {
            val (restoredSession) = restore()
            check(restoredSession.authenticated) { "ログインし直してください。" }
        }
        return listItems(folderId).files.firstOrNull { it.id == fileId }
            ?: error("対象ファイルが見つかりません。")
    }

    suspend fun downloadDecryptedFile(
        file: CloudFile,
        output: OutputStream,
        onProgress: suspend (downloadedBytes: Long, totalBytes: Long) -> Unit = { _, _ -> },
    ) {
        val folder = knownFolders[file.folderId]
            ?: error("保存先フォルダの暗号情報を確認できません。")
        val folderKey = prepareFolderKey(folder)
        try {
            TCloudCrypto.createFileDecryptor(file, folderKey).use { decryptor ->
                TCloudPlainDownload.writeDecrypted(
                    file = file,
                    decryptor = decryptor,
                    output = output,
                    loadEncryptedChunk = { index -> api.downloadEncryptedChunk(file, index) },
                    onProgress = onProgress,
                )
            }
        } finally {
            folderKey.fill(0)
        }
    }

    fun createPlaybackSession(file: CloudFile): PlaybackSession {
        val folder = knownFolders[file.folderId]
            ?: error("保存先フォルダの暗号情報を確認できません。")
        val folderKey = prepareFolderKey(folder)
        return try {
            PlaybackSession(
                file = file,
                decryptor = TCloudCrypto.createFileDecryptor(file, folderKey),
                api = api,
                offlineStore = offlineStore,
            )
        } finally {
            folderKey.fill(0)
        }
    }

    suspend fun prepareUpload(
        folderId: Long,
        name: String,
        mimeType: String,
        mediaKind: String,
        lastModified: Long,
        sizeBytes: Long,
    ): TCloudCrypto.PreparedFile {
        if (session?.authenticated != true) {
            val restoredSession = restore().first
            check(restoredSession.authenticated) { "ログインし直してください。" }
        }
        if (!knownFolders.containsKey(folderId)) listItems(folderId)
        val folder = knownFolders[folderId] ?: error("保存先フォルダが見つかりません。")
        val folderKey = prepareFolderKey(folder)
        return try {
            TCloudCrypto.createFilePackage(
                folderId = folderId,
                folderKey = folderKey,
                name = name,
                mimeType = mimeType,
                mediaKind = mediaKind,
                lastModified = lastModified,
                sizeBytes = sizeBytes,
            )
        } finally {
            folderKey.fill(0)
        }
    }

    suspend fun createUpload(payload: EncryptedFilePayload): UploadTicket = api.createUpload(payload)

    suspend fun uploadPart(fileId: Long, partNumber: Int, bytes: ByteArray): UploadedPart =
        api.uploadPart(fileId, partNumber, bytes)

    suspend fun completeUpload(fileId: Long, parts: List<UploadedPart>) = api.completeUpload(fileId, parts)

    suspend fun putThumbnail(fileId: Long, encryptedBytes: ByteArray) = api.putThumbnail(fileId, encryptedBytes)

    suspend fun cancelUpload(fileId: Long) = api.cancelUpload(fileId)

    suspend fun isUploadReady(fileId: Long): Boolean = api.isUploadReady(fileId)

    suspend fun listMoveDestinations(scopeRootId: Long?): List<MoveDestination> =
        api.listMoveDestinations(scopeRootId)

    suspend fun moveFile(file: CloudFile, destinationFolderId: Long): CloudFile {
        require(file.folderId != destinationFolderId) { "現在と同じフォルダが選択されています。" }
        val sourceFolder = knownFolders[file.folderId]
            ?: error("移動元フォルダの暗号情報を確認できません。")
        val destinationPage = api.listItems(destinationFolderId)
        destinationPage.currentFolder?.let { knownFolders[it.id] = it }
        destinationPage.breadcrumbs.forEach { knownFolders[it.id] = it }
        val destinationFolder = destinationPage.currentFolder
            ?: error("移動先フォルダを確認できません。")

        // 配下フォルダを初めて開く場合も、解除済みの親鍵から順番に鍵を復元する。
        destinationPage.breadcrumbs.forEach { folder ->
            runCatching { prepareFolderKey(folder).fill(0) }
        }

        val sourceKey = prepareFolderKey(sourceFolder)
        val destinationKey = prepareFolderKey(destinationFolder)
        return try {
            val wrapped = TCloudCrypto.rewrapFileForFolder(file, sourceKey, destinationKey)
            api.moveFile(file.id, destinationFolderId, wrapped)
            file.copy(
                folderId = destinationFolderId,
                wrappedFileKey = wrapped.wrappedFileKey,
                fileKeyIv = wrapped.fileKeyIv,
            ).also(offlineStore::updateEncryptedMetadata)
        } finally {
            sourceKey.fill(0)
            destinationKey.fill(0)
        }
    }

    suspend fun renameFile(file: CloudFile, newName: String): CloudFile {
        val sourceFolder = knownFolders[file.folderId]
            ?: error("ファイルの保存先を確認できません。")
        val folderKey = prepareFolderKey(sourceFolder)
        return try {
            val encrypted = TCloudCrypto.encryptRenamedFileMetadata(file, folderKey, newName)
            api.renameFile(file.id, encrypted)
            file.copy(
                name = newName.trim(),
                encryptedMetadata = encrypted.encryptedMetadata,
                metadataIv = encrypted.metadataIv,
            ).also(offlineStore::updateEncryptedMetadata)
        } finally {
            folderKey.fill(0)
        }
    }

    suspend fun renameFolder(folder: CloudFolder, newName: String): CloudFolder {
        val cleanName = newName.trim()
        require(cleanName.isNotEmpty() && cleanName.length <= 240) { "フォルダ名を確認してください。" }
        prepareFolderKey(folder).fill(0)
        api.renameFolder(folder.id, cleanName)
        return folder.copy(name = cleanName).also { knownFolders[folder.id] = it }
    }

    suspend fun changeFolderPassword(folder: CloudFolder, newPassword: String): CloudFolder {
        val folderKey = prepareFolderKey(folder)
        return try {
            val password = TCloudCrypto.rewrapFolderPassword(folderKey, newPassword)
            api.changeFolderPassword(folder.id, folder.name, password)
            folder.copy(
                passwordSalt = password.passwordSalt,
                passwordWrappedKey = password.passwordWrappedKey,
                passwordWrapIv = password.passwordWrapIv,
                isProtected = true,
                isUnlocked = true,
            ).also {
                knownFolders[folder.id] = it
                cacheFolderKey(folder.id, folderKey, persist = true)
            }
        } finally {
            folderKey.fill(0)
        }
    }

    suspend fun lockFolder(folder: CloudFolder) {
        check(session?.isSubAdmin == true) { "再ロックは副管理者アカウントで利用できます。" }
        check(folder.isProtected) { "PW付きフォルダだけ再ロックできます。" }
        api.lockFolder(folder.id)
        forgetFolderTree(folder.id)
    }

    suspend fun moveFolder(folder: CloudFolder, destinationParentId: Long): CloudFolder {
        require(folder.id != destinationParentId && folder.parentId != destinationParentId) {
            "現在と同じ移動先が選択されています。"
        }
        val destinationPage = api.listItems(destinationParentId)
        destinationPage.currentFolder?.let { knownFolders[it.id] = it }
        destinationPage.breadcrumbs.forEach { knownFolders[it.id] = it }
        destinationPage.folders.forEach { knownFolders[it.id] = it }
        val destinationParent = destinationPage.currentFolder
            ?: error("移動先フォルダを確認できません。")
        val folderKey = prepareFolderKey(folder)
        val destinationKey = prepareFolderKey(destinationParent)
        return try {
            val wrapped = TCloudCrypto.rewrapFolderForParent(folderKey, destinationKey)
            api.moveFolder(folder.id, folder.name, destinationParentId, wrapped)
            folder.copy(
                parentId = destinationParentId,
                parentWrappedKey = wrapped.parentWrappedKey,
                parentWrapIv = wrapped.parentWrapIv,
            ).also { knownFolders[folder.id] = it }
        } finally {
            folderKey.fill(0)
            destinationKey.fill(0)
        }
    }

    suspend fun createShare(file: CloudFile, password: String, expiresAt: Long): ShareResult {
        val sourceFolder = knownFolders[file.folderId]
            ?: error("共有元フォルダを確認できません。")
        val folderKey = prepareFolderKey(sourceFolder)
        return try {
            val payload = TCloudCrypto.createFileSharePayload(file, folderKey, password, expiresAt)
            val path = api.createShare(payload)
            ShareResult("$PUBLIC_ORIGIN$path", password, expiresAt)
        } finally {
            folderKey.fill(0)
        }
    }

    suspend fun createShare(folder: CloudFolder, password: String, expiresAt: Long): ShareResult {
        val folderKey = prepareFolderKey(folder)
        return try {
            val payload = TCloudCrypto.createFolderSharePayload(folder, folderKey, password, expiresAt)
            val path = api.createShare(payload)
            ShareResult("$PUBLIC_ORIGIN$path", password, expiresAt)
        } finally {
            folderKey.fill(0)
        }
    }

    suspend fun createShare(files: List<CloudFile>, password: String, expiresAt: Long): ShareResult {
        require(files.size in 2..100) { "共有するファイルは2件以上100件以内で選択してください。" }
        require(files.map { it.folderId }.distinct().size == 1) { "同じフォルダ内のファイルを選択してください。" }
        val sourceFolder = knownFolders[files.first().folderId]
            ?: error("共有元フォルダを確認できません。")
        val folderKey = prepareFolderKey(sourceFolder)
        return try {
            val payload = TCloudCrypto.createFileSelectionSharePayload(files, folderKey, password, expiresAt)
            val path = api.createShare(payload)
            ShareResult("$PUBLIC_ORIGIN$path", password, expiresAt)
        } finally {
            folderKey.fill(0)
        }
    }

    suspend fun moveItems(
        files: List<CloudFile>,
        folders: List<CloudFolder>,
        destinationFolderId: Long,
    ) {
        require(files.isNotEmpty() || folders.isNotEmpty()) { "移動するデータを選択してください。" }
        val destinationPage = api.listItems(destinationFolderId)
        destinationPage.currentFolder?.let { knownFolders[it.id] = it }
        destinationPage.breadcrumbs.forEach { knownFolders[it.id] = it }
        destinationPage.folders.forEach { knownFolders[it.id] = it }
        val destinationFolder = destinationPage.currentFolder
            ?: error("移動先フォルダを確認できません。")
        destinationPage.breadcrumbs.forEach { breadcrumb ->
            runCatching { prepareFolderKey(breadcrumb).fill(0) }
        }
        val destinationKey = prepareFolderKey(destinationFolder)
        val sourceKeys = mutableMapOf<Long, ByteArray>()
        try {
            val filePackages = files.map { file ->
                require(file.folderId != destinationFolderId) { "現在と同じフォルダが選択されています。" }
                val sourceFolder = knownFolders[file.folderId]
                    ?: error("移動元フォルダの暗号情報を確認できません。")
                val sourceKey = sourceKeys.getOrPut(sourceFolder.id) { prepareFolderKey(sourceFolder) }
                file to TCloudCrypto.rewrapFileForFolder(file, sourceKey, destinationKey)
            }
            val folderPackages = folders.map { folder ->
                require(folder.id != destinationFolderId && folder.parentId != destinationFolderId) {
                    "現在と同じ移動先が選択されています。"
                }
                val sourceKey = sourceKeys.getOrPut(folder.id) { prepareFolderKey(folder) }
                folder to TCloudCrypto.rewrapFolderForParent(sourceKey, destinationKey)
            }
            filePackages.forEach { (file, wrapped) ->
                api.moveFile(file.id, destinationFolderId, wrapped)
                offlineStore.updateEncryptedMetadata(
                    file.copy(
                        folderId = destinationFolderId,
                        wrappedFileKey = wrapped.wrappedFileKey,
                        fileKeyIv = wrapped.fileKeyIv,
                    ),
                )
            }
            folderPackages.forEach { (folder, wrapped) ->
                api.moveFolder(folder.id, folder.name, destinationFolderId, wrapped)
                knownFolders[folder.id] = folder.copy(
                    parentId = destinationFolderId,
                    parentWrappedKey = wrapped.parentWrappedKey,
                    parentWrapIv = wrapped.parentWrapIv,
                )
            }
        } finally {
            destinationKey.fill(0)
            sourceKeys.values.forEach { it.fill(0) }
        }
    }

    suspend fun deleteItems(
        files: List<CloudFile>,
        folders: List<CloudFolder>,
        scopeRootId: Long?,
    ) {
        require(files.isNotEmpty() || folders.isNotEmpty()) { "削除するデータを選択してください。" }

        // フォルダ削除後は配下構造を取得できないため、端末保存の掃除対象を先に確定する。
        val offlineFolderIds = folders.mapTo(mutableSetOf()) { it.id }
        if (folders.isNotEmpty()) {
            runCatching { api.listMoveDestinations(scopeRootId) }
                .getOrDefault(emptyList())
                .let { destinations ->
                    var changed: Boolean
                    do {
                        changed = false
                        destinations.forEach { destination ->
                            if (destination.parentId in offlineFolderIds && offlineFolderIds.add(destination.id)) {
                                changed = true
                            }
                        }
                    } while (changed)
                }
        }

        var completed = 0
        try {
            files.forEach { file ->
                api.deleteFile(file.id)
                offlineStore.delete(file.id)
                completed += 1
            }
            folders.forEach { folder ->
                api.deleteFolder(folder.id)
                completed += 1
            }
            offlineStore.deleteForFolders(offlineFolderIds)
        } catch (error: Exception) {
            throw IllegalStateException(
                if (completed > 0) {
                    "${completed}件を削除した後に処理が停止しました。一覧を更新して残りを確認してください。"
                } else {
                    error.message ?: "削除を完了できませんでした。"
                },
                error,
            )
        }
    }

    suspend fun downloadEncryptedChunk(file: CloudFile, index: Int): ByteArray =
        api.downloadEncryptedChunk(file, index)

    suspend fun loadPlainFile(file: CloudFile, maximumBytes: Long): ByteArray {
        require(file.sizeBytes in 1..maximumBytes && file.sizeBytes <= Int.MAX_VALUE) {
            "この画像は端末で安全に表示できる容量を超えています。ダウンロードして確認してください。"
        }
        val result = ByteArray(file.sizeBytes.toInt())
        var offset = 0
        var completed = false
        try {
            createPlaybackSession(file).use { playback ->
                for (index in 0 until file.chunkCount) {
                    currentCoroutineContext().ensureActive()
                    val plain = playback.loadPlainChunk(index)
                    try {
                        plain.copyInto(result, destinationOffset = offset)
                        offset += plain.size
                    } finally {
                        plain.fill(0)
                    }
                }
            }
            check(offset == result.size) { "復号後の画像容量が一致しません。" }
            completed = true
            return result
        } finally {
            if (!completed) result.fill(0)
        }
    }

    fun listOfflineEntries(): List<TCloudOfflineStore.OfflineEntry> =
        offlineStore.listCompleted().map { entry ->
            val folder = knownFolders[entry.file.folderId] ?: return@map entry
            val folderKey = runCatching { prepareFolderKey(folder) }.getOrNull() ?: return@map entry
            try {
                val metadata = runCatching { TCloudCrypto.decryptFileMetadata(entry.file, folderKey) }
                    .getOrNull() ?: return@map entry
                entry.copy(
                    file = entry.file.copy(
                        name = metadata.name,
                        mimeType = metadata.mimeType,
                        mediaKind = metadata.mediaKind,
                        lastModified = metadata.lastModified,
                        metadataDecrypted = true,
                    ),
                )
            } finally {
                folderKey.fill(0)
            }
        }

    fun deleteOfflineFile(fileId: Long): Boolean = offlineStore.delete(fileId)

    fun deleteOfflineFiles(fileIds: Set<Long>): Int = fileIds.count(offlineStore::delete)

    private suspend fun prepareAdminKey(): Boolean {
        if (adminPrivateKey != null) return true
        val accountKey = sessionStore.readAccountKey() ?: return false
        return try {
            val config = api.cryptoConfig()
            if (!config.initialized || config.cryptoVersion != 1 ||
                config.adminPrivateCipher.isBlank() || config.adminPrivateIv.isBlank()
            ) {
                false
            } else {
                adminPrivateKey = TCloudCrypto.unlockAdminPrivateKey(
                    accountKey = accountKey,
                    adminPrivateCipher = config.adminPrivateCipher,
                    adminPrivateIv = config.adminPrivateIv,
                )
                true
            }
        } finally {
            accountKey.fill(0)
        }
    }

    private fun prepareFolderKey(folder: CloudFolder): ByteArray = synchronized(keyLock) {
        val currentSession = checkNotNull(session) { "ログイン状態を確認してください。" }
        if (currentSession.isSubAdmin && folder.isProtected && !folder.isUnlocked) {
            throw FolderPasswordRequiredException(folder)
        }
        folderKeys[folder.id]?.let { return@synchronized it.copyOf() }
        sessionStore.readFolderKey(folder.id)?.let { stored ->
            cacheFolderKey(folder.id, stored, persist = false)
            stored.fill(0)
            return@synchronized folderKeys.getValue(folder.id).copyOf()
        }

        if (currentSession.isAdmin) {
            val privateKey = checkNotNull(adminPrivateKey) { "管理者鍵が解除されていません。" }
            val key = TCloudCrypto.unlockFolderAsAdmin(folder, privateKey)
            cacheFolderKey(folder.id, key, persist = false)
            key.fill(0)
            return@synchronized folderKeys.getValue(folder.id).copyOf()
        }

        if (folder.isProtected) throw FolderPasswordRequiredException(folder)
        val parentId = folder.parentId ?: throw FolderPasswordRequiredException(folder)
        val parentKey = folderKeys[parentId]?.copyOf()
            ?: sessionStore.readFolderKey(parentId)?.also { stored ->
                cacheFolderKey(parentId, stored, persist = false)
            }
            ?: throw FolderPasswordRequiredException(folder)
        try {
            val key = TCloudCrypto.unlockFolderFromParent(folder, parentKey)
            cacheFolderKey(folder.id, key, persist = true)
            key.fill(0)
            folderKeys.getValue(folder.id).copyOf()
        } finally {
            parentKey.fill(0)
        }
    }

    private fun decryptPage(page: FolderPage): FolderPage {
        page.currentFolder?.let { knownFolders[it.id] = it }
        page.breadcrumbs.forEach { knownFolders[it.id] = it }
        page.folders.forEach { knownFolders[it.id] = it }
        val currentFolder = page.currentFolder
        val folderKey = currentFolder?.let { folder ->
            runCatching { prepareFolderKey(folder) }.getOrNull()
        }

        val visibleFiles = if (folderKey == null) page.files else try {
            page.files.map { file ->
                runCatching { TCloudCrypto.decryptFileMetadata(file, folderKey) }.fold(
                    onSuccess = { metadata ->
                        file.copy(
                            name = metadata.name,
                            mimeType = metadata.mimeType,
                            mediaKind = metadata.mediaKind,
                            lastModified = metadata.lastModified,
                            metadataDecrypted = true,
                        )
                    },
                    onFailure = { file.copy(name = "復号できないファイル #${file.id}") },
                )
            }
        } finally {
            folderKey.fill(0)
        }

        val visibleFolders = page.folders.map { folder ->
            val canReuseKey = if (session?.isAdmin == true || !folder.isProtected) {
                true
            } else {
                hasStoredFolderKey(folder.id)
            }
            folder.copy(isUnlocked = folder.isUnlocked && canReuseKey)
        }
        return page.copy(folders = visibleFolders, files = visibleFiles)
    }

    private fun hasStoredFolderKey(folderId: Long): Boolean {
        if (folderKeys.containsKey(folderId)) return true
        val key = sessionStore.readFolderKey(folderId) ?: return false
        key.fill(0)
        return true
    }

    private fun cacheFolderKey(folderId: Long, key: ByteArray, persist: Boolean) = synchronized(keyLock) {
        folderKeys.remove(folderId)?.fill(0)
        folderKeys[folderId] = key.copyOf()
        if (persist) {
            sessionStore.saveFolderKey(
                folderId = folderId,
                folderKey = key,
                expiresAtEpochSeconds = System.currentTimeMillis() / 1000 + FOLDER_KEY_TTL_SECONDS,
            )
        }
    }

    private fun clearMemoryKeys() = synchronized(keyLock) {
        folderKeys.values.forEach { it.fill(0) }
        folderKeys.clear()
        knownFolders.clear()
        adminPrivateKey = null
    }

    private fun forgetFolderTree(rootId: Long) = synchronized(keyLock) {
        val targets = mutableSetOf(rootId)
        var changed: Boolean
        do {
            changed = false
            knownFolders.values.forEach { folder ->
                if (folder.parentId in targets && targets.add(folder.id)) changed = true
            }
        } while (changed)
        targets.forEach { id ->
            folderKeys.remove(id)?.fill(0)
            sessionStore.removeFolderKey(id)
        }
    }

    private companion object {
        const val PUBLIC_ORIGIN = "https://tanaka-note.com"
        const val FOLDER_KEY_TTL_SECONDS = 30L * 24 * 60 * 60
        const val MAX_SEARCH_RESULTS = 2_000
        const val MAX_SEARCH_PAGES = 4_000
        const val MAX_PLAYER_MEDIA_PAGES = 20_000
    }

    class PlaybackSession internal constructor(
        val file: CloudFile,
        private val decryptor: TCloudCrypto.FileDecryptor,
        private val api: TCloudApi,
        private val offlineStore: TCloudOfflineStore,
    ) : Closeable {
        suspend fun loadPlainChunk(index: Int): ByteArray {
            val envelope = offlineStore.readEncryptedChunk(file, index)
                ?: api.downloadEncryptedChunk(file, index)
            return try {
                decryptor.decryptChunk(envelope, index)
            } finally {
                envelope.fill(0)
            }
        }

        override fun close() = decryptor.close()
    }
}

internal fun compareSearchResultValues(
    leftDepth: Int,
    leftName: String,
    rightDepth: Int,
    rightName: String,
    query: String,
): Int {
    if (leftDepth != rightDepth) return leftDepth.compareTo(rightDepth)
    val rankDifference = searchNameMatchRank(leftName, query) - searchNameMatchRank(rightName, query)
    if (rankDifference != 0) return rankDifference
    return leftName.compareTo(rightName, ignoreCase = true)
}

internal fun searchNameMatchRank(name: String, query: String): Int {
    val normalizedName = name.trim().lowercase()
    val normalizedQuery = query.trim().lowercase()
    return when {
        normalizedName == normalizedQuery -> 0
        normalizedName.startsWith(normalizedQuery) -> 1
        normalizedName.contains(normalizedQuery) -> 2
        else -> 3
    }
}
