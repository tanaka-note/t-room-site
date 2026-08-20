package jp.tanaka.tcloud.media

import android.content.Context
import android.content.Intent
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.MimeTypes
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import jp.tanaka.tcloud.data.CloudFile
import jp.tanaka.tcloud.data.TCloudRepository
import jp.tanaka.tcloud.library.MediaSourceType
import jp.tanaka.tcloud.library.PlayableMediaItem
import jp.tanaka.tcloud.library.audioQueue
import jp.tanaka.tcloud.library.nextLibraryQueueIndex
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

enum class PlaybackMode {
    OFF,
    REPEAT_ALL,
    REPEAT_ONE,
}

@androidx.annotation.OptIn(UnstableApi::class)
class TCloudPlaybackManager(
    private val context: Context,
    private val repository: TCloudRepository,
) {
    private val mutablePlaybackMode = MutableStateFlow(PlaybackMode.OFF)
    val playbackMode: StateFlow<PlaybackMode> = mutablePlaybackMode.asStateFlow()
    private val mutableShuffle = MutableStateFlow(false)
    val shuffle: StateFlow<Boolean> = mutableShuffle.asStateFlow()

    val player: ExoPlayer = ExoPlayer.Builder(context).build().apply {
        setAudioAttributes(AudioAttributes.DEFAULT, true)
        setHandleAudioBecomingNoisy(true)
        setWakeMode(C.WAKE_MODE_LOCAL)
    }

    init {
        player.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(playbackState: Int) {
                if (playbackState == Player.STATE_ENDED && playbackMode.value != PlaybackMode.REPEAT_ONE) {
                    val index = queue.indexOfFirst { it.stableId == currentStableId }
                    if (index >= 0 && (index < queue.lastIndex || playbackMode.value == PlaybackMode.REPEAT_ALL)) {
                        skipNext(automaticRepeat = playbackMode.value == PlaybackMode.REPEAT_ALL)
                    } else {
                        recordCurrentPlayback()
                    }
                }
            }

            override fun onMediaMetadataChanged(mediaMetadata: MediaMetadata) {
                val item = currentItem ?: return
                metadataResolved?.invoke(
                    item,
                    mediaMetadata.title?.toString(),
                    mediaMetadata.artist?.toString(),
                    mediaMetadata.albumTitle?.toString(),
                    mediaMetadata.trackNumber,
                )
            }
        })
    }

    var currentFileId: Long? = null
        private set
    var currentTitle: String = ""
        private set
    var currentStableId: String? = null
        private set
    var currentItem: PlayableMediaItem? = null
        private set
    var statusText: String = "再生中"
        private set
    var stateChanged: (() -> Unit)? = null
    var playPrevious: ((Boolean) -> Unit)? = null
    var playNext: ((Boolean) -> Unit)? = null
    var playbackRecorded: ((PlayableMediaItem, Long, Long) -> Unit)? = null
    var metadataResolved: ((PlayableMediaItem, String?, String?, String?, Int?) -> Unit)? = null

    private var currentFactory: DataSource.Factory? = null
    private var queue: List<PlayableMediaItem> = emptyList()
    private var unshuffledQueue: List<PlayableMediaItem> = emptyList()

    fun playAudio(
        file: CloudFile,
        factory: DataSource.Factory,
        startAtBeginning: Boolean = false,
    ): ExoPlayer {
        queue = emptyList()
        unshuffledQueue = emptyList()
        currentStableId = "cloud:${file.id}"
        currentItem = null
        if (currentFileId == file.id && player.mediaItemCount > 0) {
            (factory as? AutoCloseable)?.close()
            if (startAtBeginning) player.seekTo(0L)
            if (!player.isPlaying) player.play()
            TCloudPlaybackService.start(context)
            stateChanged?.invoke()
            return player
        }
        closeFactory()
        currentFactory = factory
        currentFileId = file.id
        currentTitle = file.name
        applyPlayerRepeatMode(mutablePlaybackMode.value)
        val item = MediaItem.Builder()
            .setUri("tcloud://file/${file.id}")
            .setMimeType(playbackMimeType(file))
            .build()
        player.setMediaSource(ProgressiveMediaSource.Factory(factory).createMediaSource(item))
        player.prepare()
        player.playWhenReady = true
        TCloudPlaybackService.start(context)
        stateChanged?.invoke()
        return player
    }

    fun playQueue(
        items: List<PlayableMediaItem>,
        startStableId: String,
        startAtBeginning: Boolean = false,
    ): ExoPlayer {
        val playable = audioQueue(items)
        require(playable.any { it.stableId == startStableId }) { "再生する曲がライブラリにありません。" }
        unshuffledQueue = playable
        queue = if (mutableShuffle.value) shuffledKeepingCurrent(playable, startStableId) else playable
        playQueueItem(checkNotNull(queue.firstOrNull { it.stableId == startStableId }), startAtBeginning)
        return player
    }

    fun setShuffle(enabled: Boolean) {
        if (mutableShuffle.value == enabled) return
        mutableShuffle.value = enabled
        val stableId = currentStableId
        queue = if (enabled && stableId != null) shuffledKeepingCurrent(unshuffledQueue, stableId) else unshuffledQueue
        stateChanged?.invoke()
    }

    fun setPlaybackMode(mode: PlaybackMode, refreshNotification: Boolean = true) {
        applyPlayerRepeatMode(mode)
        mutablePlaybackMode.value = mode
        statusText = playbackStatusText(mode)
        if (refreshNotification && currentStableId != null) TCloudPlaybackService.refresh(context)
        stateChanged?.invoke()
    }

    fun skipPrevious(automaticRepeat: Boolean = false) {
        if (queue.isEmpty()) {
            playPrevious?.invoke(automaticRepeat)
            return
        }
        val index = queue.indexOfFirst { it.stableId == currentStableId }.coerceAtLeast(0)
        val target = nextLibraryQueueIndex(index, queue.size, -1, playbackMode.value == PlaybackMode.REPEAT_ALL) ?: 0
        playQueueItem(queue[target], startAtBeginning = true)
    }

    fun skipNext(automaticRepeat: Boolean = false) {
        if (queue.isEmpty()) {
            playNext?.invoke(automaticRepeat)
            return
        }
        val index = queue.indexOfFirst { it.stableId == currentStableId }.coerceAtLeast(0)
        val target = nextLibraryQueueIndex(
            index,
            queue.size,
            1,
            playbackMode.value == PlaybackMode.REPEAT_ALL || automaticRepeat,
        ) ?: return
        playQueueItem(queue[target], startAtBeginning = true)
    }

    fun stop() {
        recordCurrentPlayback()
        player.stop()
        player.clearMediaItems()
        currentFileId = null
        currentTitle = ""
        currentStableId = null
        currentItem = null
        queue = emptyList()
        unshuffledQueue = emptyList()
        statusText = "再生中"
        mutablePlaybackMode.value = PlaybackMode.OFF
        player.repeatMode = Player.REPEAT_MODE_OFF
        closeFactory()
        stateChanged?.invoke()
        context.stopService(Intent(context, TCloudPlaybackService::class.java))
    }

    private fun closeFactory() {
        (currentFactory as? AutoCloseable)?.close()
        currentFactory = null
    }

    fun createDataSourceFactory(item: PlayableMediaItem): DataSource.Factory = when (item.source) {
        MediaSourceType.LOCAL -> DefaultDataSource.Factory(context)
        MediaSourceType.CLOUD -> {
            val file = requireNotNull(item.cloudFile) { "T-Cloudファイル情報を確認できません。" }
            val folder = requireNotNull(item.cloudFolder) { "T-Cloudフォルダ情報を確認できません。" }
            repository.prepareCloudPlayback(file, folder)
            TCloudDataSource.Factory(repository, file)
        }
        MediaSourceType.YOUTUBE -> error("YouTubeは公式埋め込みPlayerで再生します。")
    }

    private fun playQueueItem(item: PlayableMediaItem, startAtBeginning: Boolean) {
        if (currentStableId == item.stableId && player.mediaItemCount > 0) {
            if (startAtBeginning) player.seekTo(0L)
            player.play()
            TCloudPlaybackService.start(context)
            stateChanged?.invoke()
            return
        }
        recordCurrentPlayback()
        closeFactory()
        val factory = createDataSourceFactory(item)
        currentFactory = factory
        currentStableId = item.stableId
        currentItem = item
        currentFileId = item.cloudFile?.id
        currentTitle = item.title
        playbackRecorded?.invoke(item, item.playbackPositionMs, item.durationMs)
        applyPlayerRepeatMode(mutablePlaybackMode.value)
        val mediaItem = MediaItem.Builder()
            .setMediaId(item.stableId)
            .setUri(if (item.source == MediaSourceType.CLOUD) "tcloud://file/${item.cloudFile?.id}" else item.playbackUri)
            .setMimeType(item.cloudFile?.let(::playbackMimeType))
            .build()
        player.setMediaSource(ProgressiveMediaSource.Factory(factory).createMediaSource(mediaItem))
        player.prepare()
        if (!startAtBeginning && item.playbackPositionMs > 0) player.seekTo(item.playbackPositionMs)
        player.playWhenReady = true
        TCloudPlaybackService.start(context)
        stateChanged?.invoke()
    }

    private fun recordCurrentPlayback() {
        currentItem?.let { item ->
            playbackRecorded?.invoke(item, player.currentPosition.coerceAtLeast(0L), player.duration.coerceAtLeast(0L))
        }
    }

    private fun shuffledKeepingCurrent(items: List<PlayableMediaItem>, stableId: String): List<PlayableMediaItem> {
        val current = items.firstOrNull { it.stableId == stableId } ?: return items.shuffled()
        return listOf(current) + items.filterNot { it.stableId == stableId }.shuffled()
    }

    private fun applyPlayerRepeatMode(mode: PlaybackMode) {
        player.repeatMode = playerRepeatMode(mode)
    }
}

internal fun playerRepeatMode(mode: PlaybackMode): Int =
    if (mode == PlaybackMode.REPEAT_ONE) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF

internal fun playbackStatusText(mode: PlaybackMode): String = when (mode) {
    PlaybackMode.OFF -> "再生中"
    PlaybackMode.REPEAT_ALL -> "全体リピート中"
    PlaybackMode.REPEAT_ONE -> "1曲リピート中"
}

@androidx.annotation.OptIn(UnstableApi::class)
internal fun playbackMimeType(file: CloudFile): String = when (file.name.substringAfterLast('.', "").lowercase()) {
    "flv" -> MimeTypes.VIDEO_FLV
    "mp4", "m4v", "mov" -> MimeTypes.VIDEO_MP4
    "mp3" -> MimeTypes.AUDIO_MPEG
    "m4a", "aac" -> MimeTypes.AUDIO_AAC
    else -> file.mimeType.ifBlank { "application/octet-stream" }
}
