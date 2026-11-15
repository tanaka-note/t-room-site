package jp.tanaka.troom.calendar

import android.app.Application
import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import androidx.work.*
import kotlinx.coroutines.*
import java.util.concurrent.TimeUnit

class CalendarApplication : Application() {
    lateinit var repository: CalendarRepository
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    lateinit var ready: Deferred<Unit>
    override fun onCreate() {
        super.onCreate()
        repository = CalendarRepository(this)
        ready = scope.async { repository.restore() }
        val work = PeriodicWorkRequestBuilder<CalendarSyncWorker>(15, TimeUnit.MINUTES)
            .setConstraints(Constraints.Builder().setRequiresStorageNotLow(true).build()).build()
        WorkManager.getInstance(this).enqueueUniquePeriodicWork("calendar-sync", ExistingPeriodicWorkPolicy.UPDATE, work)
    }
}
class CalendarSyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val app = applicationContext as CalendarApplication
        app.ready.await()
        if (app.repository.state.value.account == null) return Result.success()
        if (app.repository.state.value.account?.localOnly != true) {
            val connectivity = applicationContext.getSystemService(ConnectivityManager::class.java)
            val network = connectivity.getNetworkCapabilities(connectivity.activeNetwork)
            if (network?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) != true) return Result.success()
        }
        app.repository.sync(active = false)
        return if (app.repository.state.value.offline) Result.retry() else Result.success()
    }
}
