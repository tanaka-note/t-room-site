package jp.tanaka.tcloud.media

import jp.tanaka.tcloud.data.CloudFile
import jp.tanaka.tcloud.data.TCloudRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import java.io.Closeable
import java.util.LinkedHashMap
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 再生中に復号済みチャンクをメモリへ保持する共有LRUキャッシュ。
 * 平文をR2や端末の永続領域へ書かず、閉じる際に保持領域をゼロクリアする。
 */
internal class TCloudPlaybackCache private constructor(
    private val chunkCount: Int,
    private val maximumBytes: Long,
    private val loader: (Int) -> ByteArray,
    private val executor: ExecutorService,
    private val prefetchEnabled: Boolean,
    private val closeLoader: () -> Unit,
) : Closeable {
    private val closed = AtomicBoolean(false)
    private val cacheLock = Any()
    private val cached = LinkedHashMap<Int, ByteArray>(8, 0.75f, true)
    private val inFlight = ConcurrentHashMap<Int, CompletableFuture<ByteArray>>()
    private var cachedBytes = 0L

    constructor(repository: TCloudRepository, file: CloudFile) : this(
        chunkCount = file.chunkCount,
        maximumBytes = recommendedMemoryBytes(),
        sessionLoader = SessionLoader(repository.createPlaybackSession(file)),
    )

    private constructor(
        chunkCount: Int,
        maximumBytes: Long,
        sessionLoader: SessionLoader,
    ) : this(
        chunkCount = chunkCount,
        maximumBytes = maximumBytes,
        loader = sessionLoader::load,
        executor = Executors.newFixedThreadPool(2) { runnable ->
            Thread(runnable, "tcloud-playback-cache").apply { isDaemon = true }
        },
        prefetchEnabled = true,
        closeLoader = sessionLoader::close,
    )

    internal constructor(
        chunkCount: Int,
        maximumBytes: Long,
        loader: (Int) -> ByteArray,
    ) : this(
        chunkCount = chunkCount,
        maximumBytes = maximumBytes,
        loader = loader,
        executor = Executors.newFixedThreadPool(2) { runnable ->
            Thread(runnable, "tcloud-playback-cache-test").apply { isDaemon = true }
        },
        prefetchEnabled = false,
        closeLoader = {},
    )

    fun load(index: Int): ByteArray {
        check(!closed.get()) { "再生キャッシュは終了しています。" }
        require(index in 0 until chunkCount) { "再生チャンク番号が不正です。" }
        synchronized(cacheLock) { cached[index]?.let { return it } }

        val future = inFlight.computeIfAbsent(index) { requested ->
            CompletableFuture.supplyAsync({ loadAndCache(requested) }, executor)
        }
        return try {
            future.get()
        } finally {
            inFlight.remove(index, future)
        }.also { if (prefetchEnabled) prefetch(index + 1) }
    }

    private fun prefetch(index: Int) {
        if (closed.get() || index !in 0 until chunkCount) return
        synchronized(cacheLock) { if (cached.containsKey(index)) return }
        val future = inFlight.computeIfAbsent(index) { requested ->
            CompletableFuture.supplyAsync({ loadAndCache(requested) }, executor)
        }
        future.whenComplete { _, _ -> inFlight.remove(index, future) }
    }

    private fun loadAndCache(index: Int): ByteArray {
        synchronized(cacheLock) { cached[index]?.let { return it } }
        val loaded = loader(index)
        if (closed.get()) {
            loaded.fill(0)
            error("再生キャッシュは終了しています。")
        }
        synchronized(cacheLock) {
            if (closed.get()) {
                loaded.fill(0)
                error("再生キャッシュは終了しています。")
            }
            cached[index]?.let { existing ->
                loaded.fill(0)
                return existing
            }
            cached[index] = loaded
            cachedBytes += loaded.size
            // 最大チャンクが上限を超える場合でも、再生中の1チャンクは保持する。
            while (cachedBytes > maximumBytes && cached.size > 1) {
                val eldest = cached.entries.iterator().next()
                cached.remove(eldest.key)
                cachedBytes -= eldest.value.size
                eldest.value.fill(0)
            }
            return loaded
        }
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        inFlight.values.forEach { it.cancel(true) }
        inFlight.clear()
        executor.shutdownNow()
        synchronized(cacheLock) {
            cached.values.forEach { it.fill(0) }
            cached.clear()
            cachedBytes = 0
        }
        closeLoader()
    }

    internal fun cachedIndexes(): Set<Int> = synchronized(cacheLock) { cached.keys.toSet() }

    private companion object {
        fun recommendedMemoryBytes(): Long {
            val heap = Runtime.getRuntime().maxMemory()
            return (heap / 8).coerceIn(32L * 1024 * 1024, 128L * 1024 * 1024)
        }
    }

    private class SessionLoader(
        private val session: TCloudRepository.PlaybackSession,
    ) : Closeable {
        @Synchronized
        fun load(index: Int): ByteArray = runBlocking(Dispatchers.IO) {
            session.loadPlainChunk(index)
        }

        @Synchronized
        override fun close() = session.close()
    }
}
