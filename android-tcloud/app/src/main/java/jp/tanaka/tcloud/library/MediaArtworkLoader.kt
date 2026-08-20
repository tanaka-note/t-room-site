package jp.tanaka.tcloud.library

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.util.LruCache
import android.util.Size
import jp.tanaka.tcloud.data.TCloudRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL
import java.io.ByteArrayOutputStream

class MediaArtworkLoader(
    context: Context,
    private val repository: TCloudRepository,
) {
    private val applicationContext = context.applicationContext
    private val cache = LruCache<String, Bitmap>(24)

    suspend fun load(item: PlayableMediaItem): Bitmap? = withContext(Dispatchers.IO) {
        cache.get(item.stableId)?.takeUnless(Bitmap::isRecycled)?.let { return@withContext it }
        val bitmap = runCatching {
            when (item.source) {
                MediaSourceType.LOCAL -> loadLocal(item)
                MediaSourceType.CLOUD -> item.cloudFile?.takeIf { it.hasThumbnail }
                    ?.also { file -> item.cloudFolder?.let { repository.prepareCloudPlayback(file, it) } }
                    ?.let { repository.loadThumbnail(it) }
                    ?.let(::decodeBytes)
                MediaSourceType.YOUTUBE -> loadRemoteThumbnail(item.artworkUri)
            }
        }.getOrNull()
        bitmap?.let { cache.put(item.stableId, it) }
        bitmap
    }

    private fun loadLocal(item: PlayableMediaItem): Bitmap? {
        val uri = Uri.parse(item.artworkUri.ifBlank { item.playbackUri })
        if (item.mediaType == LibraryMediaType.VIDEO && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            return applicationContext.contentResolver.loadThumbnail(uri, Size(320, 180), null)
        }
        return applicationContext.contentResolver.openInputStream(uri)?.use { stream ->
            BitmapFactory.decodeStream(stream)
        }
    }

    private fun loadRemoteThumbnail(value: String): Bitmap? {
        if (!value.startsWith("https://i.ytimg.com/")) return null
        val connection = URL(value).openConnection() as HttpURLConnection
        return try {
            connection.connectTimeout = 10_000
            connection.readTimeout = 15_000
            connection.instanceFollowRedirects = false
            if (connection.responseCode !in 200..299 || connection.contentLengthLong > MAX_ARTWORK_BYTES) return null
            val bytes = connection.inputStream.use { stream ->
                val output = ByteArrayOutputStream()
                val buffer = ByteArray(16 * 1024)
                while (output.size() <= MAX_ARTWORK_BYTES.toInt()) {
                    val read = stream.read(buffer)
                    if (read < 0) break
                    output.write(buffer, 0, read)
                }
                output.toByteArray()
            }
            if (bytes.size > MAX_ARTWORK_BYTES) null else BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        } finally {
            connection.disconnect()
        }
    }

    private fun decodeBytes(bytes: ByteArray): Bitmap? = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)

    companion object {
        private const val MAX_ARTWORK_BYTES = 2L * 1024 * 1024
    }
}
