package jp.tanaka.troom.ai.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext

private val LightColors = lightColorScheme(
    primary = Color(0xFF5553D6),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFE4E2FF),
    onPrimaryContainer = Color(0xFF17135F),
    secondary = Color(0xFF4F6355),
    secondaryContainer = Color(0xFFD2E8D6),
    surface = Color(0xFFFBF9FF),
    surfaceContainer = Color(0xFFF0EEF6),
    background = Color(0xFFFBF9FF),
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFFC5C1FF),
    primaryContainer = Color(0xFF3D3BAF),
    secondary = Color(0xFFB6CCBC),
    background = Color(0xFF121217),
    surface = Color(0xFF121217),
    surfaceContainer = Color(0xFF232229),
)

@Composable
fun AiChatTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val context = LocalContext.current
    val colors = if (Build.VERSION.SDK_INT >= 31) {
        if (dark) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
    } else if (dark) DarkColors else LightColors
    MaterialTheme(colorScheme = colors, typography = androidx.compose.material3.Typography(), content = content)
}
