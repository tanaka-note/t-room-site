package jp.tanaka.troom.calendar

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels

class MainActivity : ComponentActivity() {
    private val model: MainViewModel by viewModels()
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent { CalendarApp(model, this) }
    }
    override fun onResume() { super.onResume(); CalendarActivityWindow.foreground = true; CalendarActivityWindow.touch(); model.sync() }
    override fun onPause() { CalendarActivityWindow.foreground = false; super.onPause() }
    override fun onUserInteraction() { super.onUserInteraction(); CalendarActivityWindow.touch() }
}
