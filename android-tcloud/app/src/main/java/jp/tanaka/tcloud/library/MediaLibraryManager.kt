package jp.tanaka.tcloud.library

import android.content.ContentResolver
import android.content.Context
import android.database.ContentObserver
import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import jp.tanaka.tcloud.data.TCloudApiException
import jp.tanaka.tcloud.data.TCloudRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

class MediaLibraryManager(
    context: Context,
    private val repository: TCloudRepository,
) {
    private val applicationContext = context.applicationContext
    private val store = MediaLibraryStore(applicationContext)
    private val scanner = LocalMediaScanner(applicationContext)
    private val artworkLoader = MediaArtworkLoader(applicationContext, repository)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val mutableState = MutableStateFlow(loadState())
    val state: StateFlow<MediaLibraryState> = mutableState.asStateFlow()
    private var mediaRefreshJob: Job? = null
    private val youtubeSearchRunner = YouTubeSearchRunner(
        scope = scope,
        search = repository::searchYouTube,
        onCleared = { query ->
            mutableState.update {
                it.copy(
                    youtubeSearchQuery = query,
                    youtubeSearchResults = emptyList(),
                    searchingYouTube = false,
                    youtubeSearchError = null,
                )
            }
        },
        onStarted = { query ->
            mutableState.update {
                it.copy(
                    youtubeSearchQuery = query,
                    youtubeSearchResults = emptyList(),
                    searchingYouTube = true,
                    youtubeSearchError = null,
                )
            }
        },
        onSuccess = { query, items ->
            mutableState.update {
                it.copy(
                    youtubeSearchQuery = query,
                    youtubeSearchResults = items,
                    searchingYouTube = false,
                    youtubeSearchError = null,
                    youtubeOnlineAvailable = true,
                )
            }
        },
        onFailure = { query, message, apiMissing ->
            mutableState.update {
                it.copy(
                    youtubeSearchQuery = query,
                    youtubeSearchResults = emptyList(),
                    searchingYouTube = false,
                    youtubeSearchError = message,
                    youtubeOnlineAvailable = !apiMissing,
                )
            }
        },
    )

    private val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
        override fun onChange(selfChange: Boolean) {
            mediaRefreshJob?.cancel()
            mediaRefreshJob = scope.launch {
                delay(750)
                refreshLocal()
            }
        }
    }

    init {
        applicationContext.contentResolver.registerContentObserver(
            MediaStore.Audio.Media.EXTERNAL_CONTENT_URI,
            true,
            observer,
        )
        applicationContext.contentResolver.registerContentObserver(
            MediaStore.Video.Media.EXTERNAL_CONTENT_URI,
            true,
            observer,
        )
    }

    fun refreshLocalAsync() {
        scope.launch { refreshLocal() }
    }

    suspend fun loadArtwork(item: PlayableMediaItem): Bitmap? = artworkLoader.load(item)

    suspend fun refreshLocal() {
        mutableState.update { it.copy(refreshingLocal = true, message = null) }
        val currentVersion = scanner.currentVersion()
        val currentPermissionMask = localPermissionMask()
        if (currentVersion.isNotBlank() && currentVersion != "legacy" &&
            currentVersion == store.readSetting(LOCAL_VERSION_KEY) &&
            currentPermissionMask == store.readSetting(LOCAL_PERMISSION_KEY)
        ) {
            reload(
                refreshingLocal = false,
                localPermission = canReadAudio(applicationContext) || canReadVideo(applicationContext),
            )
            return
        }
        runCatching { scanner.scan() }
            .onSuccess { result ->
                store.replaceLocal(result.items)
                store.writeSetting(LOCAL_VERSION_KEY, result.mediaStoreVersion)
                store.writeSetting(LOCAL_PERMISSION_KEY, localPermissionMask())
                reload(
                    refreshingLocal = false,
                    localPermission = result.audioPermission || result.videoPermission,
                )
            }
            .onFailure { error ->
                mutableState.update {
                    it.copy(refreshingLocal = false, message = error.message ?: "端末メディアを確認できませんでした。")
                }
            }
    }

    fun registerCloudRoot(folderId: Long) {
        store.addCloudRoot(folderId)
        scope.launch { refreshCloudRoot(folderId) }
    }

    fun refreshCloudAsync() {
        scope.launch {
            store.cloudRootIds().forEach { rootId -> refreshCloudRoot(rootId) }
        }
    }

    suspend fun refreshCloudRoot(folderId: Long) {
        mutableState.update { it.copy(refreshingCloud = true, message = null) }
        runCatching { repository.listPlayerMedia(folderId) }
            .onSuccess { records ->
                val items = records.mapNotNull { record ->
                    val folder = record.folder ?: return@mapNotNull null
                    val file = record.file
                    PlayableMediaItem(
                        stableId = "cloud:${file.id}",
                        source = MediaSourceType.CLOUD,
                        mediaType = if (file.mediaKind == "audio") LibraryMediaType.AUDIO else LibraryMediaType.VIDEO,
                        title = file.name.substringBeforeLast('.').ifBlank { file.name },
                        fileName = file.name,
                        artist = if (file.mediaKind == "audio") "不明なアーティスト" else "",
                        album = if (file.mediaKind == "audio") "不明なアルバム" else "",
                        durationMs = record.durationMs,
                        artworkUri = if (file.hasThumbnail) "https://tanaka-note.com/cloud/api/files/${file.id}/thumbnail" else "",
                        location = file.searchPath,
                        updatedAt = file.updatedAtMillis,
                        addedAt = file.createdAtMillis,
                        cloudFile = file,
                        cloudFolder = folder,
                        cloudPathFolderIds = record.pathFolderIds,
                    )
                }
                store.replaceCloudScope(folderId, items)
                reload(refreshingCloud = false)
            }
            .onFailure { error ->
                if (error is TCloudApiException && error.statusCode in setOf(401, 403, 404, 423)) {
                    store.removeCloudPath(folderId)
                }
                reload(refreshingCloud = false, message = error.message ?: "T-Cloudライブラリを更新できませんでした。")
            }
    }

    fun removeCloudPath(folderId: Long) {
        store.removeCloudPath(folderId)
        reload()
    }

    fun clearCloud() {
        store.clearCloud()
        store.clearCloudRoots()
        reload()
    }

    suspend fun saveYouTube(input: String): PlayableMediaItem {
        val videoId = parseYouTubeVideoId(input) ?: throw IllegalArgumentException("YouTube URLまたはvideo IDを確認してください。")
        val placeholder = PlayableMediaItem(
            stableId = "youtube:$videoId",
            source = MediaSourceType.YOUTUBE,
            mediaType = LibraryMediaType.VIDEO,
            title = "YouTube動画",
            fileName = youtubeWatchUrl(videoId),
            artworkUri = youtubeThumbnailUrl(videoId),
            location = "YouTube",
            playbackUri = youtubeWatchUrl(videoId),
            updatedAt = System.currentTimeMillis(),
            addedAt = System.currentTimeMillis(),
            youtubeVideoId = videoId,
        )
        store.upsertYouTube(placeholder)
        reload()
        return runCatching { repository.youtubeMetadata(videoId) }
            .map { metadata ->
                placeholder.copy(
                    title = metadata.title,
                    channel = metadata.channel,
                    artworkUri = metadata.thumbnailUrl.ifBlank { placeholder.artworkUri },
                    durationMs = metadata.durationMs,
                ).also(store::upsertYouTube)
            }
            .onSuccess { reload(youtubeOnlineAvailable = true) }
            .onFailure { error ->
                reload(youtubeOnlineAvailable = error !is TCloudApiException || error.statusCode != 503)
            }
            .getOrDefault(placeholder)
    }

    fun searchYouTube(query: String) {
        youtubeSearchRunner.submit(query)
    }

    fun clearYouTubeSearch() {
        youtubeSearchRunner.cancel()
    }

    fun setFavorite(item: PlayableMediaItem, enabled: Boolean) {
        ensureStored(item)
        store.setFavorite(item.stableId, enabled)
        reload()
    }

    fun setWatchLater(item: PlayableMediaItem, enabled: Boolean) {
        ensureStored(item)
        store.setWatchLater(item.stableId, enabled)
        reload()
    }

    fun setTags(item: PlayableMediaItem, tags: Set<String>) {
        ensureStored(item)
        store.setTags(item.stableId, tags)
        reload()
    }

    fun recordPlayback(stableId: String, positionMs: Long, durationMs: Long) {
        store.recordPlayback(stableId, positionMs, durationMs, System.currentTimeMillis())
        reload()
    }

    fun updatePlaybackMetadata(stableId: String, title: String?, artist: String?, album: String?, trackNumber: Int?) {
        store.updateCatalogMetadata(stableId, title, artist, album, trackNumber)
        reload()
    }

    fun createPlaylist(name: String): Long {
        val id = store.createPlaylist(name)
        reload()
        return id
    }

    fun addToPlaylist(playlistId: Long, item: PlayableMediaItem) {
        ensureStored(item)
        store.addToPlaylist(playlistId, item.stableId)
        reload()
    }

    fun refreshRecommendationsAsync(force: Boolean = false) {
        scope.launch { refreshRecommendations(force) }
    }

    suspend fun refreshRecommendations(force: Boolean = false) {
        val currentItems = store.readItems()
        val terms = recommendationTerms(currentItems)
        val libraryRecommendations = currentItems
            .filter { it.favorite || it.lastPlayedAt > 0 || it.watchLater }
            .sortedWith(compareByDescending<PlayableMediaItem> { it.favorite }.thenByDescending { it.lastPlayedAt })
            .take(12)
            .map { RecommendedMedia(it, recommendationReason(it, terms), saved = true) }
        val now = System.currentTimeMillis()
        val lastFetch = store.readSetting(YOUTUBE_RECOMMENDATION_FETCHED_KEY)?.toLongOrNull() ?: 0L
        var online = readCachedYouTubeRecommendations()
        var onlineAvailable = mutableState.value.youtubeOnlineAvailable
        if (terms.isNotEmpty() && (force || online.isEmpty() || now - lastFetch >= RECOMMENDATION_TTL_MS)) {
            val fetched = runCatching { repository.searchYouTube(terms.joinToString(" "), 8) }
            fetched.onSuccess { metadata ->
                online = metadata.map { it.toPlayableMediaItem() }
                writeCachedYouTubeRecommendations(online)
                store.writeSetting(YOUTUBE_RECOMMENDATION_FETCHED_KEY, now.toString())
                onlineAvailable = true
            }.onFailure { error ->
                if (error is TCloudApiException && error.statusCode == 503) onlineAvailable = false
            }
        }
        mutableState.update {
            val savedIds = currentItems.mapTo(mutableSetOf(), PlayableMediaItem::stableId)
            it.copy(
                recommendations = libraryRecommendations + online.filterNot { item -> item.stableId in savedIds }.map { item ->
                    RecommendedMedia(item, recommendationReason(item, terms), saved = false)
                },
                youtubeOnlineAvailable = onlineAvailable,
                refreshingYouTube = false,
            )
        }
    }

    private fun readCachedYouTubeRecommendations(): List<PlayableMediaItem> {
        val array = runCatching { JSONArray(store.readSetting(YOUTUBE_RECOMMENDATIONS_KEY).orEmpty()) }.getOrNull()
            ?: return emptyList()
        return buildList {
            for (index in 0 until array.length()) {
                val item = array.optJSONObject(index) ?: continue
                val id = item.optString("videoId")
                if (parseYouTubeVideoId(id) == null) continue
                add(
                    PlayableMediaItem(
                        stableId = "youtube:$id",
                        source = MediaSourceType.YOUTUBE,
                        mediaType = LibraryMediaType.VIDEO,
                        title = item.optString("title", "YouTube動画"),
                        channel = item.optString("channel", ""),
                        durationMs = item.optLong("durationMs", 0L),
                        artworkUri = item.optString("thumbnailUrl", youtubeThumbnailUrl(id)),
                        location = "YouTube",
                        playbackUri = youtubeWatchUrl(id),
                        youtubeVideoId = id,
                    ),
                )
            }
        }
    }

    private fun writeCachedYouTubeRecommendations(items: List<PlayableMediaItem>) {
        store.writeSetting(
            YOUTUBE_RECOMMENDATIONS_KEY,
            JSONArray(items.map { item ->
                JSONObject().put("videoId", item.youtubeVideoId).put("title", item.title)
                    .put("channel", item.channel).put("durationMs", item.durationMs)
                    .put("thumbnailUrl", item.artworkUri)
            }).toString(),
        )
    }

    private fun loadState(): MediaLibraryState {
        val items = store.readItems()
        return MediaLibraryState(items = items, playlists = store.readPlaylists(items))
    }

    private fun localPermissionMask(): String = "${if (canReadAudio(applicationContext)) 1 else 0}${if (canReadVideo(applicationContext)) 1 else 0}"

    fun ensureStored(item: PlayableMediaItem) {
        if (item.source == MediaSourceType.YOUTUBE && store.readItems().none { it.stableId == item.stableId }) {
            store.upsertYouTube(item.copy(addedAt = System.currentTimeMillis(), updatedAt = System.currentTimeMillis()))
            reload()
        }
    }

    private fun reload(
        refreshingLocal: Boolean = mutableState.value.refreshingLocal,
        refreshingCloud: Boolean = mutableState.value.refreshingCloud,
        localPermission: Boolean = mutableState.value.localPermissionGranted,
        youtubeOnlineAvailable: Boolean = mutableState.value.youtubeOnlineAvailable,
        message: String? = null,
    ) {
        val items = store.readItems()
        mutableState.update {
            it.copy(
                items = items,
                playlists = store.readPlaylists(items),
                refreshingLocal = refreshingLocal,
                refreshingCloud = refreshingCloud,
                localPermissionGranted = localPermission,
                youtubeOnlineAvailable = youtubeOnlineAvailable,
                message = message,
            )
        }
    }

    companion object {
        private const val LOCAL_VERSION_KEY = "local_media_store_version"
        private const val LOCAL_PERMISSION_KEY = "local_media_permissions"
        private const val YOUTUBE_RECOMMENDATIONS_KEY = "youtube_recommendations"
        private const val YOUTUBE_RECOMMENDATION_FETCHED_KEY = "youtube_recommendations_fetched_at"
        private const val RECOMMENDATION_TTL_MS = 6 * 60 * 60 * 1000L
    }
}
