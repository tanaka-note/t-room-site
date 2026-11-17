@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package jp.tanaka.troom.calendar

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp

data class CalendarPalette(val id: String, val name: String, val accent: Color, val lightAccent: Color, val soft: Color, val darkSoft: Color, val background: Color, val darkBackground: Color)

val calendarPalettes = listOf(
    CalendarPalette("blue", "ブルー", Color(0xFF286FA0), Color(0xFF9DCEF2), Color(0xFFE1EFFA), Color(0xFF253E50), Color(0xFFF7FBFF), Color(0xFF14212C)),
    CalendarPalette("mint", "ミント", Color(0xFF28745E), Color(0xFF98D7BE), Color(0xFFDEF2E8), Color(0xFF24473A), Color(0xFFF6FCF9), Color(0xFF14251F)),
    CalendarPalette("lavender", "ラベンダー", Color(0xFF7655A5), Color(0xFFD6B9F6), Color(0xFFEEE6F8), Color(0xFF413251), Color(0xFFFCF9FF), Color(0xFF231D2C)),
    CalendarPalette("rose", "ローズ", Color(0xFFA34569), Color(0xFFF4B2C8), Color(0xFFFAE4ED), Color(0xFF513042), Color(0xFFFFF8FB), Color(0xFF2A1C23)),
    CalendarPalette("peach", "ピーチ", Color(0xFF975B29), Color(0xFFEFC09A), Color(0xFFF9EADB), Color(0xFF4B392B), Color(0xFFFFFBF6), Color(0xFF281F18)),
    CalendarPalette("gray", "グレー", Color(0xFF536977), Color(0xFFBDCED8), Color(0xFFE7EEF2), Color(0xFF33444E), Color(0xFFF9FBFC), Color(0xFF1B242A)),
)

fun calendarColorScheme(theme: String, dark: Boolean): ColorScheme {
    val p = calendarPalettes.firstOrNull { it.id == theme } ?: calendarPalettes.first()
    val primary = if (dark) p.lightAccent else p.accent
    val container = if (dark) p.darkSoft else p.soft
    val background = if (dark) p.darkBackground else p.background
    val ink = if (dark) Color(0xFFEDF5FC) else Color(0xFF182935)
    val muted = if (dark) Color(0xFFB4C6D4) else Color(0xFF4E6272)
    val onPrimary = if (dark) p.darkBackground else Color.White
    val base = if (dark) darkColorScheme() else lightColorScheme()
    return base.copy(
        primary = primary, onPrimary = onPrimary, primaryContainer = container, onPrimaryContainer = ink,
        secondary = primary, onSecondary = onPrimary, secondaryContainer = container, onSecondaryContainer = ink,
        tertiary = primary, onTertiary = onPrimary, tertiaryContainer = container, onTertiaryContainer = ink,
        background = background, onBackground = ink, surface = background, onSurface = ink,
        surfaceVariant = container, onSurfaceVariant = muted, surfaceTint = primary,
        outline = lerp(muted, background, .25f), outlineVariant = lerp(muted, background, .7f),
        surfaceDim = lerp(background, container, .5f), surfaceBright = background,
        surfaceContainerLowest = background, surfaceContainerLow = lerp(background, container, .15f),
        surfaceContainer = lerp(background, container, .3f), surfaceContainerHigh = lerp(background, container, .45f),
        surfaceContainerHighest = lerp(background, container, .65f),
    )
}

@Composable fun AppearanceSettings(settings: CalendarSettings, onChange: (CalendarSettings) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("配色・表示", style = MaterialTheme.typography.titleSmall)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            calendarPalettes.forEach { palette ->
                val chosen = settings.theme == palette.id
                Column(Modifier.width(104.dp).border(if (chosen) 2.dp else 1.dp, if (chosen) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(12.dp))
                    .background(if (chosen) MaterialTheme.colorScheme.primaryContainer else Color.Transparent, RoundedCornerShape(12.dp))
                    .selectable(chosen, role = Role.RadioButton, onClick = { onChange(settings.copy(theme = palette.id)) }).padding(10.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Box(Modifier.size(30.dp).background(palette.accent, CircleShape), contentAlignment = Alignment.Center) { if (chosen) Icon(Icons.Default.Check, null, tint = Color.White, modifier = Modifier.size(18.dp)) }
                    Text(palette.name, style = MaterialTheme.typography.labelMedium)
                }
            }
        }
        Text("画面の明るさ", style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(top = 6.dp))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            listOf("system" to "端末に合わせる", "light" to "ライト", "dark" to "ダーク").forEach { (value, name) ->
                FilterChip(settings.appearance == value, onClick = { onChange(settings.copy(appearance = value)) }, label = { Text(name) }, leadingIcon = if (settings.appearance == value) ({ Icon(Icons.Default.Check, null, Modifier.size(16.dp)) }) else null)
            }
        }
    }
}

@Composable fun EventColorPicker(value: String, onChange: (String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text("予定の色", style = MaterialTheme.typography.labelLarge)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            eventColors.entries.forEachIndexed { index, (id, color) ->
                val chosen = value == id
                Column(Modifier.width(56.dp).selectable(chosen, role = Role.RadioButton, onClick = { onChange(id) }).padding(vertical = 5.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Box(Modifier.size(30.dp).background(color, CircleShape), contentAlignment = Alignment.Center) { if (chosen) Icon(Icons.Default.Check, null, tint = Color.White, modifier = Modifier.size(18.dp)) }
                    Text(colorNames[index], style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(top = 4.dp), maxLines = 1)
                }
            }
        }
    }
}
