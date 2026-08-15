package jp.tanaka.tcloud.media

import android.content.Context
import android.content.Intent
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import jp.tanaka.tcloud.data.CloudFile
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
) {
    private val mutablePlaybackMode = MutableStateFlow(PlaybackMode.OFF)
    val playbackMode: StateFlow<PlaybackMode> = mutablePlaybackMode.asStateFlow()

    val player: ExoPlayer = ExoPlayer.Builder(context).build().apply {
        setAudioAttributes(AudioAttributes.DEFAULT, true)
        setHandleAudioBecomingNoisy(true)
        setWakeMode(C.WAKE_MODE_LOCAL)
    }

    init {
        player.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(playbackState: Int) {
                if (playbackState == Player.STATE_ENDED && playbackMode.value == PlaybackMode.REPEAT_ALL) {
                    skipNext(automaticRepeat = true)
                }
            }
        })
    }

    var currentFileId: Long? = null
        private set
    var currentTitle: String = ""
        private set
    var statusText: String = "再生中"
        private set
    var stateChanged: (() -> Unit)? = null
    var playPrevious: ((Boolean) -> Unit)? = null
    var playNext: ((Boolean) -> Unit)? = null

    private var currentFactory: DataSource.Factory? = null

    fun playAudio(
        file: CloudFile,
        factory: DataSource.Factory,
        startAtBeginning: Boolean = false,
    ): ExoPlayer {
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

    fun setPlaybackMode(mode: PlaybackMode, refreshNotification: Boolean = true) {
        applyPlayerRepeatMode(mode)
        mutablePlaybackMode.value = mode
        statusText = playbackStatusText(mode)
        if (refreshNotification && currentFileId != null) TCloudPlaybackService.refresh(context)
        stateChanged?.invoke()
    }

    fun skipPrevious(automaticRepeat: Boolean = false) = playPrevious?.invoke(automaticRepeat)

    fun skipNext(automaticRepeat: Boolean = false) = playNext?.invoke(automaticRepeat)

    fun stop() {
        player.stop()
        player.clearMediaItems()
        currentFileId = null
        currentTitle = ""
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
