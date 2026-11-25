package jp.tanaka.troom.calendar

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import android.provider.Settings
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

private const val EXIT_CONFIRMATION_MILLIS = 2_000L

class MainActivity : ComponentActivity() {
    private val model: MainViewModel by viewModels()
    internal var missingReminderPermission by mutableStateOf<ReminderPermission?>(null)
        private set
    // Keep the current screen and any unfinished input when a permission is removed in Settings.
    internal var calendarOpened by mutableStateOf(false)
        private set
    private val notificationPermission = Manifest.permission.POST_NOTIFICATIONS
    private var exitRequestedAt: Long? = null
    private var exitToast: Toast? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        refreshReminderPermission()
        enableEdgeToEdge()
        setContent { CalendarApp(model, this) }
    }

    override fun onResume() {
        super.onResume()
        val permissionsRestored = refreshReminderPermission()
        CalendarActivityWindow.foreground = true
        CalendarActivityWindow.touch()
        model.sync(retryRemindersFirst = permissionsRestored)
    }

    override fun onPause() {
        clearExitConfirmation()
        CalendarActivityWindow.foreground = false
        super.onPause()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (!hasFocus) clearExitConfirmation()
    }

    internal fun requestExitConfirmation() {
        val now = SystemClock.elapsedRealtime()
        val previous = exitRequestedAt
        if (previous != null && now - previous <= EXIT_CONFIRMATION_MILLIS) {
            closeCalendar()
            return
        }
        clearExitConfirmation()
        exitRequestedAt = now
        exitToast = Toast.makeText(this, "もう一度戻るとアプリを閉じます", Toast.LENGTH_SHORT).also { it.show() }
    }

    internal fun clearExitConfirmation() {
        exitRequestedAt = null
        exitToast?.cancel()
        exitToast = null
    }

    internal fun closeCalendar() {
        clearExitConfirmation()
        moveTaskToBack(true)
    }

    override fun onUserInteraction() {
        super.onUserInteraction()
        CalendarActivityWindow.touch()
    }

    private fun refreshReminderPermission(): Boolean {
        val wasBlocked = missingReminderPermission != null
        missingReminderPermission = ReminderScheduler.missingPermission(this)
        if (missingReminderPermission == null) calendarOpened = true
        return wasBlocked && missingReminderPermission == null
    }

    internal fun onNotificationPermissionResult() {
        if (refreshReminderPermission()) model.sync(retryRemindersFirst = true)
    }

    internal fun requestReminderPermission(permission: ReminderPermission, requestNotifications: (String) -> Unit): Boolean {
        val settings = when (permission) {
            ReminderPermission.NOTIFICATIONS -> {
                val preferences = getPreferences(MODE_PRIVATE)
                val requested = preferences.getBoolean("notificationPermissionRequested", false)
                val permissionDenied = checkSelfPermission(notificationPermission) != PackageManager.PERMISSION_GRANTED
                if (permissionDenied && (!requested || shouldShowRequestPermissionRationale(notificationPermission))) {
                    preferences.edit().putBoolean("notificationPermissionRequested", true).apply()
                    requestNotifications(notificationPermission)
                    return true
                }
                Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
            }
            ReminderPermission.EXACT_ALARMS ->
                Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.fromParts("package", packageName, null))
        }
        return try {
            startActivity(settings)
            true
        } catch (_: ActivityNotFoundException) {
            false
        }
    }
}
