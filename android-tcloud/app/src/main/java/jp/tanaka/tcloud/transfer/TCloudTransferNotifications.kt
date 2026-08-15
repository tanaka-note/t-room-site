package jp.tanaka.tcloud.transfer

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.work.ForegroundInfo
import jp.tanaka.tcloud.R

internal class TCloudTransferNotifications(private val context: Context) {
    private val manager = context.getSystemService(Service.NOTIFICATION_SERVICE) as NotificationManager

    fun foreground(batch: TransferBatchSnapshot): ForegroundInfo {
        createChannel()
        val notification = build(
            batch = batch,
            title = title(batch.direction, completed = false),
            text = transferProgressText(batch),
            ongoing = true,
            cancelAction = cancelPendingIntent(batch.id),
        )
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ForegroundInfo(notificationId(batch.id), notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            ForegroundInfo(notificationId(batch.id), notification)
        }
    }

    fun showFinal(batch: TransferBatchSnapshot) {
        createChannel()
        val cancelled = batch.status == TransferStatus.CANCELLED
        manager.notify(
            notificationId(batch.id),
            build(
                batch = batch,
                title = if (cancelled) cancelledTitle(batch.direction) else title(batch.direction, completed = true),
                text = if (cancelled) "${batch.total}件の転送を中止しました" else transferResultText(batch),
                ongoing = false,
                cancelAction = null,
            ),
        )
    }

    private fun build(
        batch: TransferBatchSnapshot,
        title: String,
        text: String,
        ongoing: Boolean,
        cancelAction: android.app.PendingIntent?,
    ): Notification = Notification.Builder(context, CHANNEL_ID)
        .setSmallIcon(
            if (batch.direction == TransferDirection.DOWNLOAD) {
                R.drawable.ic_stat_cloud_download
            } else {
                R.drawable.ic_stat_cloud_upload
            },
        )
        .setContentTitle(title)
        .setContentText(text)
        .setStyle(
            Notification.BigTextStyle().bigText(
                text,
            ),
        )
        .setOnlyAlertOnce(true)
        .setOngoing(ongoing)
        .setAutoCancel(!ongoing)
        .setProgress(100, batch.overallProgress, false)
        .apply {
            if (cancelAction != null) {
                addAction(Notification.Action.Builder(null, "中止", cancelAction).build())
            }
        }
        .build()

    private fun title(direction: TransferDirection, completed: Boolean): String {
        val operation = when (direction) {
            TransferDirection.DOWNLOAD -> "ダウンロード"
            TransferDirection.UPLOAD -> "アップロード"
            TransferDirection.CAMERA_BACKUP -> "バックアップ"
        }
        return "T-Cloud $operation${if (completed) "完了" else "中"}"
    }

    private fun cancelledTitle(direction: TransferDirection): String {
        val operation = when (direction) {
            TransferDirection.DOWNLOAD -> "ダウンロード"
            TransferDirection.UPLOAD -> "アップロード"
            TransferDirection.CAMERA_BACKUP -> "バックアップ"
        }
        return "T-Cloud ${operation}中止"
    }

    private fun cancelPendingIntent(batchId: String): PendingIntent = PendingIntent.getBroadcast(
        context,
        notificationId(batchId),
        Intent(context, TCloudTransferCancelReceiver::class.java)
            .setAction(TCloudTransferCancelReceiver.ACTION_CANCEL)
            .putExtra(TCloudTransferCancelReceiver.EXTRA_BATCH_ID, batchId),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    private fun createChannel() {
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                "T-Cloud 転送",
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply {
                description = "アップロードとダウンロードの進行状況"
                setShowBadge(false)
            },
        )
    }

    companion object {
        private const val CHANNEL_ID = "tcloud_transfers_v2"

        internal fun notificationId(batchId: String): Int =
            120_000 + ((batchId.hashCode() and Int.MAX_VALUE) % (Int.MAX_VALUE - 120_000))
    }
}
