package jp.tanaka.tcloud.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant
import kotlin.math.min

private const val T_CLOUD_ORIGIN = "https://tanaka-note.com"

internal fun cloudSearchQueryParameters(
    folderId: Long?,
    query: String,
    kind: String,
    folderOffset: Int?,
    fileOffset: Int?,
    pageSize: Int,
): LinkedHashMap<String, String> = linkedMapOf(
    "q" to query,
    "recursive" to "1",
    "pageSize" to pageSize.coerceIn(1, 250).toString(),
    "sort" to "updated-desc",
).apply {
    folderId?.let { put("folderId", it.toString()) }
    if (kind.isNotBlank() && kind != "all") put("kind", kind)
    folderOffset?.let { put("folderOffset", it.toString()) }
    fileOffset?.let { put("fileOffset", it.toString()) }
    if (folderOffset == null) put("filesOnly", "1")
    if (fileOffset == null) put("foldersOnly", "1")
}

internal fun tCloudApiHeaders(method: String): Map<String, String> = buildMap {
    put("Accept", "application/json")
    put("User-Agent", "T-Cloud-Android/0.1")
    if (method.uppercase() !in setOf("GET", "HEAD")) {
        // Worker の CSRF 保護へ、ネイティブアプリからの正規の変更要求であることを明示する。
        // 本文を持たない DELETE でも JSON を宣言し、端末依存の既定値を送信させない。
        put("Origin", T_CLOUD_ORIGIN)
        put("Content-Type", "application/json; charset=utf-8")
    }
}

class TCloudApi(
    private val sessionStore: SecureSessionStore,
) {
    suspend fun authMode(): AuthMode = request("GET", "/auth-mode").let { json ->
        AuthMode(
            mode = json.optString("mode", "legacy"),
            credentialSalt = json.optString("credentialSalt", ""),
        )
    }

    suspend fun session(): Session = request("GET", "/session").toSession()

    suspend fun login(loginId: String, authProof: String): Session {
        val body = JSONObject()
            .put("loginId", loginId.trim().lowercase())
            .put("authProof", authProof)
        return request("POST", "/login", body).toSession()
    }

    suspend fun logout() {
        runCatching { request("POST", "/logout", JSONObject()) }
        sessionStore.clear()
    }

    suspend fun cryptoConfig(): CryptoConfig {
        val json = request("GET", "/crypto-config")
        return CryptoConfig(
            initialized = json.optBooleanCompat("initialized"),
            cryptoVersion = json.optInt("cryptoVersion", 1),
            publicKeyJwk = json.optJSONObject("publicKeyJwk")?.toString().orEmpty(),
            adminPrivateCipher = json.optString("adminPrivateCipher", ""),
            adminPrivateIv = json.optString("adminPrivateIv", ""),
        )
    }

    suspend fun createFolder(parentId: Long?, payload: EncryptedFolderPayload): Long {
        val body = JSONObject()
            .put("name", payload.name)
            .put("parentId", parentId)
            .put("cryptoVersion", payload.cryptoVersion)
            .put("encryptedName", payload.encryptedName)
            .put("nameIv", payload.nameIv)
            .put("adminWrappedKey", payload.adminWrappedKey)
            .put("parentWrappedKey", payload.parentWrappedKey)
            .put("parentWrapIv", payload.parentWrapIv)
        if (payload.authProof.isNotBlank()) {
            body.put("authProof", payload.authProof)
                .put("passwordSalt", payload.passwordSalt)
                .put("passwordWrappedKey", payload.passwordWrappedKey)
                .put("passwordWrapIv", payload.passwordWrapIv)
        }
        return request("POST", "/folders", body).getLong("id")
    }


    suspend fun unlockFolder(folderId: Long, authProof: String): CloudFolder? {
        val json = request(
            method = "POST",
            path = "/folders/$folderId/unlock",
            body = JSONObject().put("authProof", authProof),
        )
        return json.optJSONObject("folder")?.toFolder()
    }

    suspend fun listItems(folderId: Long? = null): FolderPage {
        val suffix = folderId?.let { "?folderId=$it&sort=name-asc" } ?: "?sort=name-asc"
        val json = request("GET", "/items$suffix")
        return FolderPage(
            currentFolder = json.optJSONObject("folder")?.toFolder(),
            breadcrumbs = json.optJSONArray("breadcrumbs").orEmpty().mapObjects { it.toFolder() },
            folders = json.optJSONArray("folders").orEmpty().mapObjects { it.toFolder() },
            files = json.optJSONArray("files").orEmpty().mapObjects { it.toCloudFile() },
            canTrashContents = json.optBooleanCompat("canTrashContents"),
        )
    }

    suspend fun searchItems(
        folderId: Long?,
        query: String,
        kind: String,
        folderOffset: Int?,
        fileOffset: Int?,
        pageSize: Int = 250,
    ): CloudSearchPage {
        val parameters = cloudSearchQueryParameters(
            folderId = folderId,
            query = query,
            kind = kind,
            folderOffset = folderOffset,
            fileOffset = fileOffset,
            pageSize = pageSize,
        )
        val suffix = parameters.entries.joinToString("&", prefix = "?") { (key, value) ->
            "${java.net.URLEncoder.encode(key, Charsets.UTF_8.name())}=" +
                java.net.URLEncoder.encode(value, Charsets.UTF_8.name())
        }
        val json = request("GET", "/items$suffix")
        return CloudSearchPage(
            folders = json.optJSONArray("folders").orEmpty().mapObjects { it.toFolder() },
            files = json.optJSONArray("files").orEmpty().mapObjects { it.toCloudFile() },
            keyFolders = json.optJSONArray("searchFolders").orEmpty().mapObjects { it.toFolder() },
            nextFolderOffset = json.optIntOrNull("nextFolderOffset"),
            nextFileOffset = json.optIntOrNull("nextFileOffset"),
        )
    }

    suspend fun listPlayerMedia(
        rootFolderId: Long,
        offset: Int,
        pageSize: Int = 200,
    ): CloudPlayerMediaPage {
        val suffix = "?rootFolderId=$rootFolderId&offset=${offset.coerceAtLeast(0)}" +
            "&pageSize=${pageSize.coerceIn(1, 250)}"
        val json = request("GET", "/player/media$suffix")
        return CloudPlayerMediaPage(
            files = json.optJSONArray("files").orEmpty().mapObjects { item ->
                CloudPlayerMedia(
                    file = item.toCloudFile(),
                    pathFolderIds = item.optJSONArray("pathFolderIds").orEmpty().mapLongs(),
                    durationMs = item.optLong("durationMs", 0L).coerceAtLeast(0L),
                )
            },
            keyFolders = json.optJSONArray("keyFolders").orEmpty().mapObjects { it.toFolder() },
            nextOffset = json.optIntOrNull("nextOffset"),
        )
    }

    suspend fun youtubeMetadata(videoId: String): YouTubeVideoMetadata =
        request("GET", "/player/youtube/metadata?videoId=${encode(videoId)}").toYouTubeMetadata()

    suspend fun searchYouTube(query: String, maxResults: Int = 8): List<YouTubeVideoMetadata> =
        request(
            "GET",
            "/player/youtube/search?q=${encode(query)}&maxResults=${maxResults.coerceIn(1, 10)}",
        ).optJSONArray("items").orEmpty().mapObjects { it.toYouTubeMetadata() }

    suspend fun listMoveDestinations(scopeRootId: Long?): List<MoveDestination> {
        val suffix = scopeRootId?.let { "?scopeRootId=$it" }.orEmpty()
        return request("GET", "/move-destinations$suffix")
            .optJSONArray("folders")
            .orEmpty()
            .mapObjects { item ->
                MoveDestination(
                    id = item.getLong("id"),
                    parentId = item.optLongOrNull("parentId"),
                    name = item.optString("name", "フォルダ"),
                    isProtected = item.optBooleanCompat("isProtected"),
                    depth = item.optInt("depth", 0),
                )
            }
    }

    suspend fun usage(): CloudUsage {
        val json = request("GET", "/usage")
        return CloudUsage(
            activeFileCount = json.optInt("activeFileCount", 0),
            activeBytes = json.optLong("activeBytes", 0),
            trashFileCount = json.optInt("trashFileCount", 0),
            trashBytes = json.optLong("trashBytes", 0),
        )
    }

    suspend fun usageDetails(): List<CloudUsageFolder> = request("GET", "/usage-details")
        .optJSONArray("folders")
        .orEmpty()
        .mapObjects { item ->
            CloudUsageFolder(
                id = item.getLong("id"),
                name = item.optString("name", "フォルダ"),
                fileCount = item.optInt("fileCount", 0),
                sizeBytes = item.optLong("sizeBytes", 0),
            )
        }

    suspend fun listTrash(): TrashPage {
        val json = request("GET", "/trash")
        val files = json.optJSONArray("files").orEmpty().mapObjects { item ->
            val folder = CloudFolder(
                id = item.getLong("folderId"),
                parentId = null,
                name = "",
                cryptoVersion = item.optInt("folderCryptoVersion", 0),
                encryptedName = item.optString("folderEncryptedName", ""),
                nameIv = item.optString("folderNameIv", ""),
                passwordSalt = item.optString("folderPasswordSalt", ""),
                passwordWrappedKey = item.optString("folderPasswordWrappedKey", ""),
                passwordWrapIv = item.optString("folderPasswordWrapIv", ""),
                adminWrappedKey = item.optString("folderAdminWrappedKey", ""),
                parentWrappedKey = "",
                parentWrapIv = "",
                isProtected = item.optString("folderPasswordWrappedKey", "").isNotBlank(),
                isUnlocked = true,
                fileCount = 0,
                folderCount = 0,
            )
            TrashFile(
                file = item.toCloudFile(),
                folder = folder,
                deletedAtMillis = item.optInstantMillis("deletedAt"),
            )
        }
        val folders = json.optJSONArray("folders").orEmpty().mapObjects { item ->
            TrashFolder(
                folder = item.toFolder(),
                sizeBytes = item.optLong("sizeBytes", 0),
                deletedAtMillis = item.optInstantMillis("deletedAt"),
            )
        }
        return TrashPage(files, folders)
    }

    suspend fun restoreFile(fileId: Long) {
        request("POST", "/files/$fileId/restore", JSONObject())
    }

    suspend fun permanentlyDeleteFile(fileId: Long) {
        request("DELETE", "/files/$fileId/permanent")
    }

    suspend fun restoreFolder(folderId: Long) {
        request("POST", "/folders/$folderId/restore", JSONObject())
    }

    suspend fun emptyTrash(): Boolean = request("DELETE", "/trash", JSONObject()).optBoolean("ok", false)

    suspend fun moveFile(fileId: Long, folderId: Long, wrapped: WrappedFileKey) {
        request(
            method = "PATCH",
            path = "/files/$fileId",
            body = JSONObject()
                .put("folderId", folderId)
                .put("wrappedFileKey", wrapped.wrappedFileKey)
                .put("fileKeyIv", wrapped.fileKeyIv),
        )
    }

    suspend fun renameFile(fileId: Long, metadata: EncryptedFileMetadata) {
        request(
            method = "PATCH",
            path = "/files/$fileId",
            body = JSONObject()
                .put("encryptedMetadata", metadata.encryptedMetadata)
                .put("metadataIv", metadata.metadataIv),
        )
    }

    suspend fun renameFolder(folderId: Long, name: String) {
        request(
            method = "PATCH",
            path = "/folders/$folderId",
            body = JSONObject()
                .put("name", name)
                .put("passwordAction", "keep"),
        )
    }

    suspend fun changeFolderPassword(folderId: Long, name: String, password: FolderPasswordPackage) {
        request(
            "PATCH",
            "/folders/$folderId",
            JSONObject()
                .put("name", name)
                .put("passwordAction", "replace")
                .put("authProof", password.authProof)
                .put("passwordSalt", password.passwordSalt)
                .put("passwordWrappedKey", password.passwordWrappedKey)
                .put("passwordWrapIv", password.passwordWrapIv),
        )
    }

    suspend fun lockFolder(folderId: Long) {
        request("DELETE", "/folders/$folderId/unlock")
    }


    suspend fun moveFolder(
        folderId: Long,
        name: String,
        parentId: Long,
        wrapped: WrappedFolderKey,
    ) {
        request(
            method = "PATCH",
            path = "/folders/$folderId",
            body = JSONObject()
                .put("name", name)
                .put("passwordAction", "keep")
                .put("parentId", parentId)
                .put("parentWrappedKey", wrapped.parentWrappedKey)
                .put("parentWrapIv", wrapped.parentWrapIv),
        )
    }

    suspend fun deleteFile(fileId: Long) {
        request(method = "DELETE", path = "/files/$fileId")
    }

    suspend fun deleteFolder(folderId: Long) {
        request(method = "DELETE", path = "/folders/$folderId")
    }

    suspend fun createShare(payload: SharePayload): String {
        val selectedFiles = JSONArray().apply {
            payload.selectedFiles.forEach { selected ->
                put(
                    JSONObject().put("id", selected.id).apply {
                        selected.shareWrappedFileKey?.let { put("shareWrappedFileKey", it) }
                        selected.shareFileKeyIv?.let { put("shareFileKeyIv", it) }
                    },
                )
            }
        }
        val json = request(
            method = "POST",
            path = "/shares",
            body = JSONObject()
                .put("token", payload.token)
                .put("targetType", payload.targetType)
                .put("targetId", payload.targetId)
                .put("expiresAt", payload.expiresAt)
                .put("authProof", payload.authProof)
                .put("encryptedToken", payload.encryptedToken)
                .put("tokenIv", payload.tokenIv)
                .put("passwordSalt", payload.passwordSalt)
                .put("passwordWrappedKey", payload.passwordWrappedKey)
                .put("passwordWrapIv", payload.passwordWrapIv)
                .apply { if (payload.selectedFiles.isNotEmpty()) put("selectedFiles", selectedFiles) },
        )
        return json.getString("sharePath")
    }

    suspend fun downloadEncryptedChunk(file: CloudFile, index: Int): ByteArray =
        withContext(Dispatchers.IO) {
            require(index in 0 until file.chunkCount) { "ダウンロード範囲が不正です。" }
            val plainOffset = index * file.chunkSizeBytes
            val plainLength = min(file.chunkSizeBytes, file.sizeBytes - plainOffset)
            require(plainLength > 0) { "ダウンロード範囲が不正です。" }
            val encryptedOffset = index * (file.chunkSizeBytes + ENCRYPTED_CHUNK_OVERHEAD)
            val encryptedLength = plainLength + ENCRYPTED_CHUNK_OVERHEAD
            val rangeEnd = encryptedOffset + encryptedLength - 1
            val connection = (URL("$BASE_URL/files/${file.id}/download").openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 20_000
                readTimeout = 120_000
                instanceFollowRedirects = false
                setRequestProperty("Accept", "application/octet-stream")
                setRequestProperty("Range", "bytes=$encryptedOffset-$rangeEnd")
                setRequestProperty("User-Agent", "T-Cloud-Android/0.1")
                sessionStore.readSessionCookie()?.let { setRequestProperty("Cookie", it) }
            }
            try {
                val status = connection.responseCode
                if (status != HttpURLConnection.HTTP_PARTIAL &&
                    !(status == HttpURLConnection.HTTP_OK && file.chunkCount == 1)
                ) {
                    val error = connection.errorStream?.bufferedReader(Charsets.UTF_8)
                        ?.use { it.readText() }
                        .orEmpty()
                    if (status == HttpURLConnection.HTTP_UNAUTHORIZED) sessionStore.clear()
                    throw TCloudApiException(
                        status,
                        error.ifBlank { "暗号データを取得できませんでした。" },
                        connection.retryAfterMillis(),
                    )
                }
                val bytes = connection.inputStream.use { it.readBytes() }
                check(bytes.size.toLong() == encryptedLength) {
                    "取得した暗号データの容量が一致しません。"
                }
                bytes
            } finally {
                connection.disconnect()
            }
        }

    suspend fun downloadThumbnail(fileId: Long): ByteArray = withContext(Dispatchers.IO) {
        val connection = (URL("$BASE_URL/files/$fileId/thumbnail").openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 20_000
            readTimeout = 60_000
            instanceFollowRedirects = false
            setRequestProperty("Accept", "application/octet-stream")
            setRequestProperty("User-Agent", "T-Cloud-Android/0.3")
            sessionStore.readSessionCookie()?.let { setRequestProperty("Cookie", it) }
        }
        try {
            val status = connection.responseCode
            if (status !in 200..299) {
                if (status == HttpURLConnection.HTTP_UNAUTHORIZED) sessionStore.clear()
                throw TCloudApiException(status, "サムネイルを取得できませんでした。", connection.retryAfterMillis())
            }
            connection.inputStream.use { it.readBytes() }
        } finally {
            connection.disconnect()
        }
    }

    suspend fun createUpload(payload: EncryptedFilePayload): UploadTicket {
        val body = JSONObject()
            .put("cryptoVersion", payload.cryptoVersion)
            .put("folderId", payload.folderId)
            .put("sizeBytes", payload.sizeBytes)
            .put("encryptedMetadata", payload.encryptedMetadata)
            .put("metadataIv", payload.metadataIv)
            .put("wrappedFileKey", payload.wrappedFileKey)
            .put("fileKeyIv", payload.fileKeyIv)
            .put("encryptedSizeBytes", payload.encryptedSizeBytes)
            .put("chunkSizeBytes", payload.chunkSizeBytes)
            .put("chunkCount", payload.chunkCount)
        val json = request("POST", "/uploads", body)
        return UploadTicket(
            id = json.getLong("id"),
            uploadId = json.getString("uploadId"),
            chunkSize = json.getLong("chunkSize"),
        )
    }

    suspend fun uploadPart(fileId: Long, partNumber: Int, encryptedBytes: ByteArray): UploadedPart =
        withContext(Dispatchers.IO) {
            val connection = (URL("$BASE_URL/uploads/$fileId/parts/$partNumber").openConnection() as HttpURLConnection).apply {
                requestMethod = "PUT"
                connectTimeout = 20_000
                readTimeout = 120_000
                doOutput = true
                instanceFollowRedirects = false
                setRequestProperty("Accept", "application/json")
                setRequestProperty("Content-Type", "application/octet-stream")
                setRequestProperty("User-Agent", "T-Cloud-Android/0.1")
                sessionStore.readSessionCookie()?.let { setRequestProperty("Cookie", it) }
                setFixedLengthStreamingMode(encryptedBytes.size)
            }
            try {
                connection.outputStream.use { it.write(encryptedBytes) }
                val status = connection.responseCode
                val stream = if (status in 200..299) connection.inputStream else connection.errorStream
                val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
                val json = if (text.isBlank()) JSONObject() else JSONObject(text)
                if (status !in 200..299) {
                    if (status == HttpURLConnection.HTTP_UNAUTHORIZED) sessionStore.clear()
                    throw TCloudApiException(
                        status,
                        json.optString("error", "暗号チャンクを保存できませんでした。"),
                        connection.retryAfterMillis(),
                    )
                }
                UploadedPart(json.getInt("partNumber"), json.getString("etag"))
            } finally {
                connection.disconnect()
            }
        }

    suspend fun completeUpload(fileId: Long, parts: List<UploadedPart>) {
        val body = JSONObject().put(
            "parts",
            JSONArray().apply {
                parts.forEach { part ->
                    put(JSONObject().put("partNumber", part.partNumber).put("etag", part.etag))
                }
            },
        )
        request("POST", "/uploads/$fileId/complete", body)
    }

    suspend fun putThumbnail(fileId: Long, encryptedBytes: ByteArray) = withContext(Dispatchers.IO) {
        val connection = (URL("$BASE_URL/files/$fileId/thumbnail").openConnection() as HttpURLConnection).apply {
            requestMethod = "PUT"
            connectTimeout = 20_000
            readTimeout = 60_000
            doOutput = true
            instanceFollowRedirects = false
            setRequestProperty("Accept", "application/json")
            setRequestProperty("Content-Type", "application/octet-stream")
            setRequestProperty("Origin", T_CLOUD_ORIGIN)
            setRequestProperty("User-Agent", "T-Cloud-Android/0.5")
            sessionStore.readSessionCookie()?.let { setRequestProperty("Cookie", it) }
            setFixedLengthStreamingMode(encryptedBytes.size)
        }
        try {
            connection.outputStream.use { it.write(encryptedBytes) }
            val status = connection.responseCode
            if (status !in 200..299) {
                val error = connection.errorStream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
                if (status == HttpURLConnection.HTTP_UNAUTHORIZED) sessionStore.clear()
                throw TCloudApiException(
                    status,
                    error.ifBlank { "サムネイルを保存できませんでした。" },
                    connection.retryAfterMillis(),
                )
            }
        } finally {
            connection.disconnect()
        }
    }

    suspend fun cancelUpload(fileId: Long) {
        try {
            request("DELETE", "/uploads/$fileId")
        } catch (error: TCloudApiException) {
            if (error.statusCode != HttpURLConnection.HTTP_NOT_FOUND) throw error
        }
    }

    suspend fun isUploadReady(fileId: Long): Boolean = try {
        request("GET", "/files/$fileId")
        true
    } catch (error: TCloudApiException) {
        if (error.statusCode == HttpURLConnection.HTTP_NOT_FOUND) false else throw error
    }

    private suspend fun request(method: String, path: String, body: JSONObject? = null): JSONObject =
        withContext(Dispatchers.IO) {
            val connection = (URL("$BASE_URL$path").openConnection() as HttpURLConnection).apply {
                requestMethod = method
                connectTimeout = 20_000
                readTimeout = 60_000
                instanceFollowRedirects = false
                tCloudApiHeaders(method).forEach(::setRequestProperty)
                sessionStore.readSessionCookie()?.let { setRequestProperty("Cookie", it) }
                if (body != null) {
                    doOutput = true
                }
            }
            try {
                body?.toString()?.toByteArray(Charsets.UTF_8)?.let { bytes ->
                    connection.setFixedLengthStreamingMode(bytes.size)
                    connection.outputStream.use { it.write(bytes) }
                }
                val status = connection.responseCode
                connection.headerFields.entries
                    .firstOrNull { it.key?.equals("Set-Cookie", ignoreCase = true) == true }
                    ?.value
                    ?.firstOrNull { it.startsWith("troom_cloud_session=") }
                    ?.substringBefore(';')
                    ?.let(sessionStore::saveSessionCookie)
                val stream = if (status in 200..299) connection.inputStream else connection.errorStream
                val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
                val json = if (text.isBlank()) JSONObject() else JSONObject(text)
                if (status !in 200..299) {
                    val isCredentialCheck = path == "/login" ||
                        Regex("^/folders/\\d+/unlock$").matches(path)
                    if (status == 401 && !isCredentialCheck) sessionStore.clear()
                    throw TCloudApiException(
                        status,
                        json.optString("error", "通信に失敗しました。"),
                        connection.retryAfterMillis(),
                    )
                }
                json
            } finally {
                connection.disconnect()
            }
        }

    private fun HttpURLConnection.retryAfterMillis(): Long? {
        val value = getHeaderField("Retry-After")?.trim().orEmpty()
        if (value.isBlank()) return null
        value.toLongOrNull()?.let { seconds ->
            return (seconds.coerceAtLeast(0) * 1_000L).coerceAtMost(15 * 60_000L)
        }
        return runCatching {
            val retryAt = java.time.ZonedDateTime.parse(
                value,
                java.time.format.DateTimeFormatter.RFC_1123_DATE_TIME,
            ).toInstant().toEpochMilli()
            (retryAt - System.currentTimeMillis()).coerceIn(0, 15 * 60_000L)
        }.getOrNull()
    }

    private fun JSONObject.toSession() = Session(
        authenticated = optBooleanCompat("authenticated"),
        role = optString("role", ""),
        accountName = optString("accountName", ""),
        loginId = optString("loginId", ""),
        canUpload = optBooleanCompat("canUpload"),
        canDelete = optBooleanCompat("canDelete"),
    )

    private fun JSONObject.toFolder() = CloudFolder(
        id = optLong("id"),
        parentId = optLongOrNull("parentId") ?: optLongOrNull("parent_id"),
        name = optString("name", ""),
        cryptoVersion = optInt("cryptoVersion", 0),
        encryptedName = optString("encryptedName", ""),
        nameIv = optString("nameIv", ""),
        passwordSalt = optString("passwordSalt", ""),
        passwordWrappedKey = optString("passwordWrappedKey", ""),
        passwordWrapIv = optString("passwordWrapIv", ""),
        adminWrappedKey = optString("adminWrappedKey", ""),
        parentWrappedKey = optString("parentWrappedKey", ""),
        parentWrapIv = optString("parentWrapIv", ""),
        isProtected = optBooleanCompat("isProtected", "is_protected"),
        isUnlocked = optBooleanCompat("isUnlocked", "adminAccess"),
        fileCount = optInt("fileCount", 0),
        folderCount = optInt("folderCount", 0),
        createdAtMillis = optInstantMillis("createdAt"),
        updatedAtMillis = optInstantMillis("updatedAt"),
        searchPath = optString("searchPath", ""),
        searchDepth = optInt("searchDepth", 0),
    )

    private fun JSONObject.toCloudFile() = CloudFile(
        id = getLong("id"),
        folderId = getLong("folderId"),
        name = optString("name", ""),
        mimeType = optString("mimeType", "application/octet-stream"),
        mediaKind = optString("mediaKind", "other"),
        sizeBytes = optLong("sizeBytes"),
        cryptoVersion = optInt("cryptoVersion", 0),
        encryptedMetadata = optString("encryptedMetadata", ""),
        metadataIv = optString("metadataIv", ""),
        wrappedFileKey = optString("wrappedFileKey", ""),
        fileKeyIv = optString("fileKeyIv", ""),
        chunkSizeBytes = optLong("chunkSizeBytes"),
        chunkCount = optInt("chunkCount"),
        hasThumbnail = optBooleanCompat("hasThumbnail"),
        lastModified = optLong("lastModified", 0),
        createdAtMillis = optInstantMillis("createdAt"),
        updatedAtMillis = optInstantMillis("updatedAt"),
        searchPath = optString("searchPath", ""),
        searchDepth = optInt("searchDepth", 0),
    )

    private fun JSONObject.toYouTubeMetadata() = YouTubeVideoMetadata(
        videoId = getString("videoId"),
        title = optString("title", "YouTube動画"),
        channel = optString("channel", ""),
        thumbnailUrl = optString("thumbnailUrl", ""),
        durationMs = optLong("durationMs", 0L).coerceAtLeast(0L),
        embeddable = optBooleanCompat("embeddable"),
    )

    private fun JSONArray?.orEmpty(): JSONArray = this ?: JSONArray()

    private inline fun <T> JSONArray.mapObjects(transform: (JSONObject) -> T): List<T> =
        buildList(length()) {
            for (index in 0 until length()) add(transform(getJSONObject(index)))
        }

    private fun JSONArray.mapLongs(): List<Long> = buildList(length()) {
        for (index in 0 until length()) add(optLong(index))
    }

    private fun encode(value: String): String = java.net.URLEncoder.encode(value, Charsets.UTF_8.name())

    private fun JSONObject.optLongOrNull(name: String): Long? =
        if (isNull(name) || !has(name)) null else optLong(name)

    private fun JSONObject.optIntOrNull(name: String): Int? =
        if (isNull(name) || !has(name)) null else optInt(name)

    private fun JSONObject.optBooleanCompat(vararg names: String): Boolean {
        for (name in names) {
            if (!has(name) || isNull(name)) continue
            return when (val value = opt(name)) {
                is Boolean -> value
                is Number -> value.toInt() != 0
                is String -> value == "1" || value.equals("true", ignoreCase = true)
                else -> false
            }
        }
        return false
    }

    private fun JSONObject.optInstantMillis(name: String): Long {
        val raw = optString(name, "").trim()
        if (raw.isEmpty()) return 0
        val normalized = if (raw.endsWith("Z") || raw.contains('+')) raw else raw.replace(' ', 'T') + "Z"
        return runCatching { Instant.parse(normalized).toEpochMilli() }.getOrDefault(0)
    }

    private companion object {
        const val BASE_URL = "https://tanaka-note.com/cloud/api"
        const val ENCRYPTED_CHUNK_OVERHEAD = 32L
    }
}
