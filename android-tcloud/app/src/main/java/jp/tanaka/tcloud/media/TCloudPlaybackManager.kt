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

@androidx.annotation.OptIn(UnstableApi::class)
class TCloudPlaybackManager(
    private val context: Context,
) {
    private var continuousPlayback = false
    private var repeatOnePlayback = false

    val player: ExoPlayer = ExoPlayer.Builder(context).build().apply {
        setAudioAttributes(AudioAttributes.DEFAULT, true)
        setHandleAudioBecomingNoisy(true)
        setWakeMode(C.WAKE_MODE_LOCAL)
    }

    init {
        player.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(playbackState: Int) {
                if (playbackState == Player.STATE_ENDED && continuousPlayback) skipNext()
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
    var playPrevious: (() -> Unit)? = null
    var playNext: (() -> Unit)? = null

    private var currentFactory: DataSource.Factory? = null

    fun playAudio(file: CloudFile, factory: DataSource.Factory): ExoPlayer {
        if (currentFileId == file.id && player.mediaItemCount > 0) {
            (factory as? AutoCloseable)?.close()
            if (!player.isPlaying) player.play()
            TCloudPlaybackService.start(context)
            stateChanged?.invoke()
            return player
        }
        closeFactory()
        currentFactory = factory
        currentFileId = file.id
        currentTitle = file.name
        player.repeatMode = if (repeatOnePlayback) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF
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

    fun setPlaybackStatus(repeatOne: Boolean, continuous: Boolean) {
        repeatOnePlayback = repeatOne
        player.repeatMode = if (repeatOne) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF
        continuousPlayback = continuous
        statusText = playbackStatusText(repeatOne, continuous)
        TCloudPlaybackService.refresh(context)
        stateChanged?.invoke()
    }

    fun skipPrevious() = playPrevious?.invoke()

    fun skipNext() = playNext?.invoke()

    fun stop() {
        player.stop()
        player.clearMediaItems()
        currentFileId = null
        currentTitle = ""
        statusText = "再生中"
        continuousPlayback = false
        repeatOnePlayback = false
        closeFactory()
        stateChanged?.invoke()
        context.stopService(Intent(context, TCloudPlaybackService::class.java))
    }

    private fun closeFactory() {
        (currentFactory as? AutoCloseable)?.close()
        currentFactory = null
    }
}

internal fun playbackStatusText(repeatOne: Boolean, continuous: Boolean): String = when {
    repeatOne -> "リピート再生中"
    continuous -> "連続再生中"
    else -> "再生中"
}

internal fun playbackMimeType(file: CloudFile): String = when (file.name.substringAfterLast('.', "").lowercase()) {
    "flv" -> MimeTypes.VIDEO_FLV
    "mp4", "m4v", "mov" -> MimeTypes.VIDEO_MP4
    "mp3" -> MimeTypes.AUDIO_MPEG
    "m4a", "aac" -> MimeTypes.AUDIO_AAC
    else -> file.mimeType.ifBlank { "application/octet-stream" }
}
