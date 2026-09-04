package jp.tanaka.tcloud.ui

import android.os.Build
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.isSystemInDarkTheme
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
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp

/** Stable brand colors. Surfaces and interactive colors come from MaterialTheme. */
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

internal object TCloudSpacing {
    val Xs = 4.dp
    val Sm = 8.dp
    val Md = 12.dp
    val Lg = 16.dp
    val Xl = 20.dp
    val Xxl = 24.dp
    val Section = 32.dp
}

internal object TCloudDimens {
    val ScreenPadding = TCloudSpacing.Xl
    val CompactScreenPadding = TCloudSpacing.Lg
    val ContentMaxWidth = 1040.dp
    val DialogMaxWidth = 560.dp
    val ItemVerticalPadding = TCloudSpacing.Md
    val ItemHorizontalPadding = TCloudSpacing.Md
    val ItemSpacing = TCloudSpacing.Sm
    val IconContainer = 48.dp
    val MinTouchTarget = 48.dp
    val ThumbnailRadius = 16.dp
    val ItemRadius = 20.dp
    val SearchRadius = 28.dp
    val DialogRadius = 28.dp
    val NavigationRailWidth = 88.dp
}

internal object TCloudElevation {
    val Resting = 0.dp
    val Raised = 2.dp
    val Floating = 6.dp
}

/** App-owned stable motion tokens; no alpha Material motion API is required. */
internal object TCloudMotion {
    const val Quick = 160
    const val Standard = 220
    const val Emphasized = 280
    val NaturalEasing = CubicBezierEasing(0.2f, 0f, 0f, 1f)
    val SpatialSpring = spring<Float>(
        dampingRatio = Spring.DampingRatioNoBouncy,
        stiffness = Spring.StiffnessMediumLow,
    )
    val PressSpring = spring<Float>(
        dampingRatio = Spring.DampingRatioMediumBouncy,
        stiffness = Spring.StiffnessMedium,
    )
}

private val TCloudLightScheme = lightColorScheme(
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

private val TCloudDarkScheme = darkColorScheme(
    primary = Color(0xFF8FD4CB),
    onPrimary = Color(0xFF003731),
    primaryContainer = Color(0xFF075049),
    onPrimaryContainer = Color(0xFFA9F0E6),
    secondary = Color(0xFFB1CCC6),
    secondaryContainer = Color(0xFF334B47),
    background = Color(0xFF0F1514),
    onBackground = Color(0xFFDDE5E2),
    surface = Color(0xFF121918),
    onSurface = Color(0xFFDDE5E2),
    surfaceVariant = Color(0xFF26302E),
    onSurfaceVariant = Color(0xFFBAC8C4),
    outline = Color(0xFF84938F),
    outlineVariant = Color(0xFF3E4A47),
    error = Color(0xFFFFB4AB),
)

private val TCloudShapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(12.dp),
    medium = RoundedCornerShape(TCloudDimens.ItemRadius),
    large = RoundedCornerShape(TCloudDimens.DialogRadius),
    extraLarge = RoundedCornerShape(36.dp),
)

private val TCloudTypography = Typography().let { base ->
    base.copy(
        headlineMedium = base.headlineMedium.copy(fontWeight = FontWeight.Bold),
        headlineSmall = base.headlineSmall.copy(fontWeight = FontWeight.Bold),
        titleLarge = base.titleLarge.copy(fontWeight = FontWeight.Bold),
        titleMedium = base.titleMedium.copy(fontWeight = FontWeight.SemiBold),
        labelLarge = base.labelLarge.copy(fontWeight = FontWeight.SemiBold),
    )
}

@Composable
private fun tCloudColorScheme(darkTheme: Boolean, dynamicColor: Boolean): ColorScheme {
    val context = LocalContext.current
    return when {
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && darkTheme ->
            dynamicDarkColorScheme(context)
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ->
            dynamicLightColorScheme(context)
        darkTheme -> TCloudDarkScheme
        else -> TCloudLightScheme
    }
}

@Composable
internal fun TCloudTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    dynamicColor: Boolean = true,
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = tCloudColorScheme(darkTheme, dynamicColor),
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
    val shift = with(LocalDensity.current) { 18.dp.toPx() }
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
                alpha = 0.88f + (0.12f * progress.value)
            },
    ) {
        content()
    }
}

@Composable
internal fun Modifier.tCloudPressScale(
    interactionSource: MutableInteractionSource,
): Modifier {
    val pressed by interactionSource.collectIsPressedAsState()
    val scale by animateFloatAsState(
        targetValue = if (pressed) 0.975f else 1f,
        animationSpec = TCloudMotion.PressSpring,
        label = "TCloud press scale",
    )
    return graphicsLayer {
        scaleX = scale
        scaleY = scale
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
        modifier = modifier.fillMaxWidth().clip(RoundedCornerShape(TCloudDimens.SearchRadius)),
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
            focusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
            unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainer,
            disabledContainerColor = MaterialTheme.colorScheme.surfaceContainerLow,
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
                color = MaterialTheme.colorScheme.secondaryContainer,
            ) {
                Icon(
                    imageVector = icon,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSecondaryContainer,
                    modifier = Modifier.padding(18.dp).size(34.dp),
                )
            }
            Spacer(Modifier.height(4.dp))
            Text(title, style = MaterialTheme.typography.titleMedium)
            Text(
                description,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium,
                textAlign = TextAlign.Center,
            )
            if (actionLabel != null && onAction != null) {
                Button(onClick = onAction, modifier = Modifier.padding(top = 8.dp)) {
                    Text(actionLabel)
                }
            }
        }
    }
}

@Preview(name = "Light", showBackground = true)
@Preview(name = "Dark", showBackground = true, uiMode = android.content.res.Configuration.UI_MODE_NIGHT_YES)
@Composable
private fun TCloudDesignPreview() {
    TCloudTheme(dynamicColor = false) {
        Surface(color = MaterialTheme.colorScheme.background) {
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
}
