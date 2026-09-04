package jp.tanaka.tcloud.media

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.session.MediaSession
import android.media.MediaMetadata
import android.media.session.PlaybackState
import android.os.Build
import android.os.IBinder
import androidx.core.content.ContextCompat
import androidx.media3.common.Player
import jp.tanaka.tcloud.MainActivity
import jp.tanaka.tcloud.TCloudApplication

class TCloudPlaybackService : Service(), Player.Listener {
    private lateinit var manager: TCloudPlaybackManager
    private lateinit var notificationManager: NotificationManager
    private lateinit var mediaSession: MediaSession

    override fun onCreate() {
        super.onCreate()
        manager = (application as TCloudApplication).playbackManager
        notificationManager = getSystemService(NotificationManager::class.java)
        createChannel()
        mediaSession = MediaSession(this, "T-Cloud Player").apply {
            setCallback(object : MediaSession.Callback() {
                override fun onPlay() = manager.player.play()
                override fun onPause() = manager.player.pause()
                override fun onStop() = stopPlayback()
                override fun onSkipToPrevious() {
                    manager.skipPrevious()
                }

                override fun onSkipToNext() {
                    manager.skipNext()
                }
            })
            isActive = true
        }
        manager.player.addListener(this)
        manager.stateChanged = ::updateNotification
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_PREVIOUS -> manager.skipPrevious()
            ACTION_TOGGLE -> if (manager.player.isPlaying) manager.player.pause() else manager.player.play()
            ACTION_NEXT -> manager.skipNext()
            ACTION_STOP -> {
                stopPlayback()
                return START_NOT_STICKY
            }
        }
        if (manager.currentStableId == null) {
            stopSelf()
            return START_NOT_STICKY
        }
        startAsForeground(buildNotification())
        updateNotification()
        return START_NOT_STICKY
    }

    override fun onIsPlayingChanged(isPlaying: Boolean) = updateNotification()

    override fun onPlaybackStateChanged(playbackState: Int) = updateNotification()

    override fun onDestroy() {
        manager.player.removeListener(this)
        manager.stateChanged = null
        mediaSession.isActive = false
        mediaSession.release()
        stopForeground(STOP_FOREGROUND_REMOVE)
        notificationManager.cancel(NOTIFICATION_ID)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun stopPlayback() {
        manager.stop()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun updateNotification() {
        if (manager.currentStableId == null) return
        val state = PlaybackState.Builder()
            .setActions(
                PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or
                    PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_STOP or
                    PlaybackState.ACTION_SKIP_TO_PREVIOUS or PlaybackState.ACTION_SKIP_TO_NEXT,
            )
            .setState(
                if (manager.player.isPlaying) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED,
                manager.player.currentPosition.coerceAtLeast(0L),
                if (manager.player.isPlaying) 1f else 0f,
            )
            .build()
        mediaSession.setPlaybackState(state)
        mediaSession.setMetadata(
            MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, manager.currentTitle)
                .putString(MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE, manager.statusText)
                .build(),
        )
        notificationManager.notify(NOTIFICATION_ID, buildNotification())
    }

    private fun buildNotification(): Notification {
        val openIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val toggleIntent = PendingIntent.getService(
            this,
            1,
            Intent(this, TCloudPlaybackService::class.java).setAction(ACTION_TOGGLE),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val previousIntent = PendingIntent.getService(
            this,
            3,
            Intent(this, TCloudPlaybackService::class.java).setAction(ACTION_PREVIOUS),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val nextIntent = PendingIntent.getService(
            this,
            4,
            Intent(this, TCloudPlaybackService::class.java).setAction(ACTION_NEXT),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stopIntent = PendingIntent.getService(
            this,
            2,
            Intent(this, TCloudPlaybackService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val toggleLabel = if (manager.player.isPlaying) "一時停止" else "再生"
        val toggleIcon = if (manager.player.isPlaying) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle(manager.currentTitle.ifBlank { "T-Cloud Player" })
            .setContentText(manager.statusText)
            .setContentIntent(openIntent)
            .setOngoing(manager.player.isPlaying)
            .setOnlyAlertOnce(true)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .addAction(Notification.Action.Builder(android.R.drawable.ic_media_previous, "前の曲", previousIntent).build())
            .addAction(Notification.Action.Builder(toggleIcon, toggleLabel, toggleIntent).build())
            .addAction(Notification.Action.Builder(android.R.drawable.ic_media_next, "次の曲", nextIntent).build())
            .addAction(Notification.Action.Builder(android.R.drawable.ic_menu_close_clear_cancel, "停止", stopIntent).build())
            .setStyle(
                Notification.MediaStyle()
                    .setMediaSession(mediaSession.sessionToken)
                    .setShowActionsInCompactView(0, 1, 2),
            )
            .build()
    }

    private fun startAsForeground(notification: Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun createChannel() {
        notificationManager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "T-Cloud 音楽再生", NotificationManager.IMPORTANCE_LOW).apply {
                description = "画面を閉じた後も音楽再生を継続し、操作状態を表示します。"
                setSound(null, null)
            },
        )
    }

    companion object {
        private const val CHANNEL_ID = "tcloud_playback"
        private const val NOTIFICATION_ID = 4050
        private const val ACTION_TOGGLE = "jp.tanaka.tcloud.PLAYBACK_TOGGLE"
        private const val ACTION_PREVIOUS = "jp.tanaka.tcloud.PLAYBACK_PREVIOUS"
        private const val ACTION_NEXT = "jp.tanaka.tcloud.PLAYBACK_NEXT"
        private const val ACTION_STOP = "jp.tanaka.tcloud.PLAYBACK_STOP"
        private const val ACTION_REFRESH = "jp.tanaka.tcloud.PLAYBACK_REFRESH"

        fun start(context: Context) {
            ContextCompat.startForegroundService(
                context,
                Intent(context, TCloudPlaybackService::class.java).setAction(ACTION_REFRESH),
            )
        }

        fun refresh(context: Context) = start(context)
    }
}
