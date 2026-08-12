package jp.tanaka.tcloud.media

import android.net.Uri
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.BaseDataSource
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import jp.tanaka.tcloud.data.CloudFile
import jp.tanaka.tcloud.data.TCloudRepository
import java.io.Closeable
import kotlin.math.min

@androidx.annotation.OptIn(UnstableApi::class)
class TCloudDataSource private constructor(
    private val file: CloudFile,
    private val playbackCache: TCloudPlaybackCache,
) : BaseDataSource(true) {
    private var currentDataSpec: DataSpec? = null
    private var readPosition = 0L
    private var bytesRemaining = 0L
    private var cachedChunkIndex = -1
    private var cachedChunk: ByteArray? = null
    private val sourceUri = Uri.parse("tcloud://file/${file.id}")

    override fun open(dataSpec: DataSpec): Long {
        transferInitializing(dataSpec)
        require(dataSpec.position in 0..file.sizeBytes) { "再生位置が不正です。" }
        clearCurrentChunk()
        currentDataSpec = dataSpec
        readPosition = dataSpec.position
        val available = file.sizeBytes - readPosition
        bytesRemaining = if (dataSpec.length == C.LENGTH_UNSET.toLong()) {
            available
        } else {
            min(available, dataSpec.length)
        }
        transferStarted(dataSpec)
        return bytesRemaining
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        if (length == 0) return 0
        if (bytesRemaining == 0L) return C.RESULT_END_OF_INPUT
        val chunkSize = file.chunkSizeBytes
        val chunkIndex = (readPosition / chunkSize).toInt()
        if (cachedChunkIndex != chunkIndex) loadChunk(chunkIndex)
        val chunk = checkNotNull(cachedChunk)
        val offsetInChunk = (readPosition % chunkSize).toInt()
        val count = min(length.toLong(), min(bytesRemaining, (chunk.size - offsetInChunk).toLong())).toInt()
        if (count <= 0) return C.RESULT_END_OF_INPUT
        chunk.copyInto(buffer, offset, offsetInChunk, offsetInChunk + count)
        readPosition += count
        bytesRemaining -= count
        bytesTransferred(count)
        return count
    }

    override fun getUri(): Uri = sourceUri

    override fun close() {
        if (currentDataSpec != null) transferEnded()
        currentDataSpec = null
        clearCurrentChunk()
    }

    private fun loadChunk(index: Int) {
        cachedChunk = playbackCache.load(index)
        cachedChunkIndex = index
    }

    private fun clearCurrentChunk() {
        cachedChunk = null
        cachedChunkIndex = -1
    }

    class Factory(
        repository: TCloudRepository,
        private val file: CloudFile,
    ) : DataSource.Factory, Closeable {
        private val playbackCache = TCloudPlaybackCache(repository, file)

        override fun createDataSource(): DataSource = TCloudDataSource(file, playbackCache)

        override fun close() = playbackCache.close()
    }
}
