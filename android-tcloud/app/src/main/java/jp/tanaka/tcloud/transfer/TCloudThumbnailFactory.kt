package jp.tanaka.tcloud.transfer

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import android.net.Uri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream

internal object TCloudThumbnailFactory {
    suspend fun create(context: Context, uri: Uri, mediaKind: String): ByteArray? =
        withContext(Dispatchers.IO) {
            val bitmap = when (mediaKind) {
                "image" -> decodeSampledImage(context, uri)
                "video" -> videoFrame(context, uri)
                else -> null
            } ?: return@withContext null
            try {
                val scaled = scale(bitmap)
                try {
                    ByteArrayOutputStream().use { output ->
                        check(scaled.compress(Bitmap.CompressFormat.JPEG, 82, output)) {
                            "サムネイルを作成できませんでした。"
                        }
                        output.toByteArray().takeIf { it.size <= MAX_THUMBNAIL_BYTES }
                    }
                } finally {
                    if (scaled !== bitmap) scaled.recycle()
                }
            } finally {
                bitmap.recycle()
            }
        }

    private fun decodeSampledImage(context: Context, uri: Uri): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while (bounds.outWidth / sample > MAX_EDGE * 2 || bounds.outHeight / sample > MAX_EDGE * 2) {
            sample *= 2
        }
        val options = BitmapFactory.Options().apply {
            inSampleSize = sample
            inPreferredConfig = Bitmap.Config.ARGB_8888
        }
        return context.contentResolver.openInputStream(uri)?.use {
            BitmapFactory.decodeStream(it, null, options)
        }
    }

    private fun videoFrame(context: Context, uri: Uri): Bitmap? {
        val retriever = MediaMetadataRetriever()
        return try {
            retriever.setDataSource(context, uri)
            retriever.getFrameAtTime(1_000_000, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
                ?: retriever.frameAtTime
        } finally {
            retriever.release()
        }
    }

    private fun scale(bitmap: Bitmap): Bitmap {
        val largest = maxOf(bitmap.width, bitmap.height)
        if (largest <= MAX_EDGE) return bitmap
        val ratio = MAX_EDGE.toFloat() / largest
        return Bitmap.createScaledBitmap(
            bitmap,
            (bitmap.width * ratio).toInt().coerceAtLeast(1),
            (bitmap.height * ratio).toInt().coerceAtLeast(1),
            true,
        )
    }

    private const val MAX_EDGE = 512
    private const val MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024
}
