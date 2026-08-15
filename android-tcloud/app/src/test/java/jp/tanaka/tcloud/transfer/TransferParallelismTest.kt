package jp.tanaka.tcloud.transfer

import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Semaphore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TransferParallelismTest {
    @Test
    fun `delayed fake repository processes one four five ten and thirty with a maximum of four`() = runBlocking {
        listOf(1, 4, 5, 10, 30).forEach { itemCount ->
            val active = AtomicInteger(0)
            val peak = AtomicInteger(0)
            val completed = AtomicInteger(0)

            val results = runFileTransfers((0 until itemCount).toList(), Semaphore(4)) { item ->
                val now = active.incrementAndGet()
                peak.updateAndGet { previous -> maxOf(previous, now) }
                delay(12)
                active.decrementAndGet()
                completed.incrementAndGet()
                item
            }

            assertEquals((0 until itemCount).toList(), results)
            assertEquals(itemCount, completed.get())
            assertEquals(minOf(itemCount, 4), peak.get())
            assertEquals(0, active.get())
        }
    }

    @Test
    fun `two batches share one application wide four permit gate`() = runBlocking {
        val gate = Semaphore(4)
        val active = AtomicInteger(0)
        val peak = AtomicInteger(0)

        coroutineScope {
            val first = async { delayedBatch(10, gate, active, peak) }
            val second = async { delayedBatch(10, gate, active, peak) }
            first.await()
            second.await()
        }

        assertEquals(4, peak.get())
        assertEquals(0, active.get())
    }

    @Test
    fun `one failed file is isolated and retry outcome does not stop siblings`() = runBlocking {
        val completed = mutableListOf<Int>()
        val results = runFileTransfers((0 until 10).toList(), Semaphore(4)) { item ->
            delay(5)
            synchronized(completed) { completed += item }
            if (item == 3) TransferItemOutcome.RETRY else TransferItemOutcome.FINISHED
        }

        assertEquals(10, completed.size)
        assertEquals(1, results.count { it == TransferItemOutcome.RETRY })
        assertEquals(9, results.count { it == TransferItemOutcome.FINISHED })
    }

    @Test
    fun `cancellation releases every global permit`() = runBlocking {
        val gate = Semaphore(4)
        val active = AtomicInteger(0)
        val job = launch {
            runFileTransfers((0 until 30).toList(), gate) {
                active.incrementAndGet()
                try {
                    delay(10_000)
                } finally {
                    active.decrementAndGet()
                }
            }
        }

        while (active.get() < 4) delay(5)
        job.cancelAndJoin()

        assertEquals(0, active.get())
        assertEquals(4, gate.availablePermits)
    }

    private suspend fun delayedBatch(
        count: Int,
        gate: Semaphore,
        active: AtomicInteger,
        peak: AtomicInteger,
    ) {
        runFileTransfers((0 until count).toList(), gate) {
            val now = active.incrementAndGet()
            peak.updateAndGet { previous -> maxOf(previous, now) }
            try {
                delay(10)
            } finally {
                active.decrementAndGet()
            }
        }
    }
}
