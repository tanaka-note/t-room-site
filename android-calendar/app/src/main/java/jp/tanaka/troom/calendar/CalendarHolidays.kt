package jp.tanaka.troom.calendar

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.util.AtomicFile
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.FileNotFoundException
import java.net.HttpURLConnection
import java.net.URL
import java.nio.ByteBuffer
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

private const val CABINET_HOLIDAY_CSV = "https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv"
private const val MAX_HOLIDAY_BYTES = 256 * 1024
private val HOLIDAY_CSV_HEADER = listOf("国民の祝日・休日月日", "国民の祝日・休日名称")
private val HOLIDAY_CSV_DATE = Regex("""(\d{4})/(\d{1,2})/(\d{1,2})""")
private val HOLIDAY_CSV_NAME = Regex("""(?:"((?:[^"]|"")*)"|([^",]+))""")
private val HOLIDAY_CHECK_INTERVAL = Duration.ofDays(1)
private val HOLIDAY_RETRY_INTERVAL = Duration.ofHours(1)

internal data class HolidaySnapshot(val dates: Map<LocalDate, String>, val checkedAt: Instant? = null) {
    val throughYear = dates.keys.maxOf { it.year }
}

internal interface HolidayCache {
    fun read(): HolidaySnapshot?
    fun write(snapshot: HolidaySnapshot)
}

internal class CalendarHolidays(
    private val bundled: HolidaySnapshot,
    private val cache: HolidayCache,
    private val isOnline: () -> Boolean,
    private val fetch: () -> ByteArray,
    private val now: () -> Instant = Instant::now,
) {
    private val mutable = MutableStateFlow(bundled.copy(checkedAt = null))
    val state = mutable.asStateFlow()
    private val mutex = Mutex()
    private var cacheLoaded = false
    private var lastAttempt: Instant? = null
    private val bundledCounts = bundled.dates.keys.groupingBy { it.year }.eachCount()

    suspend fun refreshIfDue() = withContext(Dispatchers.IO) {
        if (!mutex.tryLock()) return@withContext
        try {
            val startedAt = now()
            if (!cacheLoaded) loadCache(startedAt)
            val current = mutable.value
            if (current.checkedAt.isRecent(startedAt, HOLIDAY_CHECK_INTERVAL) ||
                lastAttempt.isRecent(startedAt, HOLIDAY_RETRY_INTERVAL) || !isOnline()
            ) return@withContext

            lastAttempt = startedAt
            val next = HolidaySnapshot(parseHolidayCsv(fetch()), now())
            if (!hasCompleteYears(next, current.throughYear)) return@withContext
            cache.write(next)
            mutable.value = next
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            // The bundled or last verified local copy remains usable without a connection.
        } finally {
            mutex.unlock()
        }
    }

    private fun loadCache(at: Instant) {
        cacheLoaded = true
        val stored = try {
            cache.read()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            null
        } ?: return
        val cachedAt = stored.checkedAt ?: return
        val bundledAt = bundled.checkedAt ?: Instant.EPOCH
        if (cachedAt >= bundledAt && hasCompleteYears(stored, bundled.throughYear)) {
            mutable.value = if (cachedAt <= at) stored else stored.copy(checkedAt = null)
        }
    }

    private fun hasCompleteYears(snapshot: HolidaySnapshot, previousYear: Int): Boolean {
        if (snapshot.throughYear < previousYear) return false
        val counts = snapshot.dates.keys.groupingBy { it.year }.eachCount()
        return (bundledCounts.keys.min()..snapshot.throughYear).all { year ->
            // Historic years may have fewer holidays than the 16 statutory holidays today.
            val minimum = minOf(bundledCounts[year] ?: 16, 16)
            (counts[year] ?: 0) >= minimum && LocalDate.of(year, 1, 1) in snapshot.dates
        }
    }

    companion object {
        fun create(context: Context): CalendarHolidays {
            val bundled = context.assets.open("holidays.json").bufferedReader().use {
                val json = JSONObject(it.readText())
                val timestamp = LocalDate.parse(json.getString("retrievedAt"))
                    .atStartOfDay(ZoneId.of("Asia/Tokyo")).toInstant()
                HolidaySnapshot(parseHolidayMap(json.getJSONObject("holidays")), timestamp)
            }
            return CalendarHolidays(
                bundled = bundled,
                cache = HolidayFileCache(AtomicFile(context.noBackupFilesDir.resolve("calendar-holidays.json"))),
                isOnline = {
                    val connectivity = context.getSystemService(ConnectivityManager::class.java)
                    connectivity.getNetworkCapabilities(connectivity.activeNetwork)
                        ?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true
                },
                fetch = ::downloadHolidays,
            )
        }
    }
}

private fun Instant?.isRecent(at: Instant, interval: Duration): Boolean =
    this != null && this <= at && Duration.between(this, at) < interval

internal fun parseHolidayCsv(bytes: ByteArray): Map<LocalDate, String> {
    require(bytes.size in 1..MAX_HOLIDAY_BYTES)
    val text = charset("Shift_JIS").newDecoder().decode(ByteBuffer.wrap(bytes)).toString()
    val lines = text.lineSequence().iterator()
    require(lines.hasNext() && lines.next().split(',').map { it.trim().removeSurrounding("\"") } == HOLIDAY_CSV_HEADER)
    val dates = linkedMapOf<LocalDate, String>()
    for (line in lines) {
        if (line.isBlank()) continue
        val columns = line.split(',', limit = 2)
        require(columns.size == 2)
        val match = requireNotNull(HOLIDAY_CSV_DATE.matchEntire(columns[0].trim().removeSurrounding("\"")))
        val (year, month, day) = match.destructured
        val date = LocalDate.of(year.toInt(), month.toInt(), day.toInt())
        val nameMatch = requireNotNull(HOLIDAY_CSV_NAME.matchEntire(columns[1].trim()))
        val name = nameMatch.groupValues[1].ifEmpty { nameMatch.groupValues[2] }.replace("\"\"", "\"").trim()
        require(name.isValidHolidayName() && dates.putIfAbsent(date, name) == null)
    }
    require(dates.isNotEmpty())
    return dates
}

private fun String.isValidHolidayName() = length in 1..100 && isNotBlank() && none { it.isISOControl() }

private fun parseHolidayMap(values: JSONObject): Map<LocalDate, String> =
    values.keys().asSequence().associate { rawDate ->
        val date = LocalDate.parse(rawDate)
        val name = values.getString(rawDate)
        require(date.toString() == rawDate && name.isValidHolidayName())
        date to name
    }

private fun downloadHolidays(): ByteArray {
    val connection = URL(CABINET_HOLIDAY_CSV).openConnection() as HttpURLConnection
    try {
        connection.instanceFollowRedirects = false
        connection.connectTimeout = 5_000
        connection.readTimeout = 5_000
        connection.useCaches = false
        check(connection.responseCode == HttpURLConnection.HTTP_OK)
        return connection.inputStream.use { it.readNBytes(MAX_HOLIDAY_BYTES + 1) }
    } finally {
        connection.disconnect()
    }
}

private class HolidayFileCache(private val file: AtomicFile) : HolidayCache {
    override fun read(): HolidaySnapshot? {
        val bytes = try {
            file.openRead().use { it.readNBytes(MAX_HOLIDAY_BYTES + 1) }
        } catch (_: FileNotFoundException) {
            return null
        }
        require(bytes.size in 1..MAX_HOLIDAY_BYTES)
        val json = JSONObject(bytes.toString(Charsets.UTF_8))
        return HolidaySnapshot(parseHolidayMap(json.getJSONObject("holidays")), Instant.parse(json.getString("checkedAt")))
    }

    override fun write(snapshot: HolidaySnapshot) {
        val dates = JSONObject()
        snapshot.dates.forEach { (date, name) -> dates.put(date.toString(), name) }
        val bytes = JSONObject().put("checkedAt", requireNotNull(snapshot.checkedAt).toString())
            .put("holidays", dates).toString().toByteArray()
        require(bytes.size <= MAX_HOLIDAY_BYTES)
        val output = file.startWrite()
        try {
            output.write(bytes)
            output.fd.sync()
            file.finishWrite(output)
        } catch (failure: Exception) {
            file.failWrite(output)
            throw failure
        }
    }
}
