package jp.tanaka.tcloud.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.FolderOpen
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.Typography
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp

internal object TCloudColors {
    val Primary = Color(0xFF16756D)
    val PrimaryStrong = Color(0xFF0F5B55)
    val AppBackground = Color(0xFFF6F9F9)
    val Surface = Color(0xFFFCFDFD)
    val SurfaceMuted = Color(0xFFEEF4F3)
    val Selection = Color(0xFFDDF1EE)
    val MutedText = Color(0xFF65736F)
    val FolderContainer = Color(0xFFFFF1CE)
    val FolderIcon = Color(0xFFC9860D)
    val ImageContainer = Color(0xFFE4F3ED)
    val VideoContainer = Color(0xFFE8EDF8)
    val AudioContainer = Color(0xFFF2E9F5)
    val FileContainer = Color(0xFFEDF1F1)
    val Destructive = Color(0xFFB3261E)
}

internal object TCloudDimens {
    val ScreenPadding = 20.dp
    val CompactScreenPadding = 16.dp
    val ContentMaxWidth = 920.dp
    val ItemVerticalPadding = 12.dp
    val ItemHorizontalPadding = 12.dp
    val ItemSpacing = 8.dp
    val IconContainer = 48.dp
    val ThumbnailRadius = 14.dp
    val ItemRadius = 18.dp
    val SearchRadius = 28.dp
    val DialogRadius = 28.dp
}

internal object TCloudMotion {
    const val Quick = 160
    const val Standard = 220
    const val Emphasized = 280
    val NaturalEasing = CubicBezierEasing(0.2f, 0f, 0f, 1f)
}

private val TCloudColorScheme = lightColorScheme(
    primary = TCloudColors.Primary,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFC7EAE5),
    onPrimaryContainer = Color(0xFF00201D),
    secondary = Color(0xFF4B635F),
    secondaryContainer = Color(0xFFCDE8E3),
    background = TCloudColors.AppBackground,
    onBackground = Color(0xFF18201E),
    surface = TCloudColors.Surface,
    onSurface = Color(0xFF18201E),
    surfaceVariant = TCloudColors.SurfaceMuted,
    onSurfaceVariant = TCloudColors.MutedText,
    outline = Color(0xFF73817E),
    outlineVariant = Color(0xFFC2CDCA),
    error = TCloudColors.Destructive,
)

private val TCloudShapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(12.dp),
    medium = RoundedCornerShape(TCloudDimens.ItemRadius),
    large = RoundedCornerShape(TCloudDimens.DialogRadius),
    extraLarge = RoundedCornerShape(32.dp),
)

private val TCloudTypography = Typography().let { base ->
    base.copy(
        headlineSmall = base.headlineSmall.copy(fontWeight = FontWeight.Bold),
        titleLarge = base.titleLarge.copy(fontWeight = FontWeight.Bold),
        titleMedium = base.titleMedium.copy(fontWeight = FontWeight.SemiBold),
    )
}

@Composable
internal fun TCloudTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = TCloudColorScheme,
        shapes = TCloudShapes,
        typography = TCloudTypography,
        content = content,
    )
}

@Composable
internal fun TCloudEntrance(
    direction: Int,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    val progress = remember { Animatable(0f) }
    val shift = with(LocalDensity.current) { 22.dp.toPx() }
    LaunchedEffect(Unit) {
        progress.animateTo(
            targetValue = 1f,
            animationSpec = tween(TCloudMotion.Standard, easing = TCloudMotion.NaturalEasing),
        )
    }
    Box(
        modifier = modifier
            .fillMaxSize()
            .graphicsLayer {
                translationX = direction.coerceIn(-1, 1) * shift * (1f - progress.value)
                alpha = 0.82f + (0.18f * progress.value)
            },
    ) {
        content()
    }
}

@Composable
internal fun TCloudSearchField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
) {
    TextField(
        value = value,
        onValueChange = onValueChange,
        modifier = modifier.fillMaxWidth(),
        singleLine = true,
        placeholder = { Text(placeholder) },
        leadingIcon = { Icon(Icons.Default.Search, contentDescription = null) },
        trailingIcon = {
            if (value.isNotEmpty()) {
                IconButton(onClick = { onValueChange("") }) {
                    Icon(Icons.Default.Close, contentDescription = "検索文字を消去")
                }
            }
        },
        shape = RoundedCornerShape(TCloudDimens.SearchRadius),
        colors = TextFieldDefaults.colors(
            focusedContainerColor = MaterialTheme.colorScheme.surfaceVariant,
            unfocusedContainerColor = MaterialTheme.colorScheme.surfaceVariant,
            disabledContainerColor = MaterialTheme.colorScheme.surfaceVariant,
            focusedIndicatorColor = Color.Transparent,
            unfocusedIndicatorColor = Color.Transparent,
            disabledIndicatorColor = Color.Transparent,
        ),
    )
}

@Composable
internal fun TCloudIconContainer(
    icon: ImageVector,
    contentDescription: String?,
    containerColor: Color,
    iconColor: Color,
    modifier: Modifier = Modifier,
) {
    Surface(
        modifier = modifier.size(TCloudDimens.IconContainer),
        shape = RoundedCornerShape(TCloudDimens.ThumbnailRadius),
        color = containerColor,
    ) {
        Box(contentAlignment = Alignment.Center) {
            Icon(
                imageVector = icon,
                contentDescription = contentDescription,
                tint = iconColor,
                modifier = Modifier.size(26.dp),
            )
        }
    }
}

@Composable
internal fun TCloudEmptyState(
    icon: ImageVector,
    title: String,
    description: String,
    modifier: Modifier = Modifier,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
) {
    Box(
        modifier = modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 40.dp),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            modifier = Modifier.widthIn(max = 360.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Surface(
                shape = RoundedCornerShape(24.dp),
                color = MaterialTheme.colorScheme.surfaceVariant,
            ) {
                Icon(
                    imageVector = icon,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.padding(18.dp).size(34.dp),
                )
            }
            Spacer(Modifier.height(4.dp))
            Text(title, style = MaterialTheme.typography.titleMedium)
            Text(
                description,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium,
            )
            if (actionLabel != null && onAction != null) {
                Button(onClick = onAction, modifier = Modifier.padding(top = 8.dp)) {
                    Text(actionLabel)
                }
            }
        }
    }
}

@Preview(showBackground = true, backgroundColor = 0xFFF6F9F9)
@Composable
private fun TCloudDesignPreview() {
    TCloudTheme {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            TCloudSearchField("", {}, "ファイルを検索")
            TCloudEmptyState(
                icon = Icons.Default.FolderOpen,
                title = "フォルダは空です",
                description = "アップロードまたは新しいフォルダを作成できます。",
            )
        }
    }
}
