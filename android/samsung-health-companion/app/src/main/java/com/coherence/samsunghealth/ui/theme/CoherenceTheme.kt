package com.coherence.samsunghealth.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.coherence.samsunghealth.data.model.ThemeMode

// ── Semantic category colors ────────────────────────────────────────────────────

@Immutable
data class CategoryColors(
  val health: Color,
  val healthContainer: Color,
  val productivity: Color,
  val productivityContainer: Color,
  val ai: Color,
  val aiContainer: Color,
  val energy: Color,
  val energyContainer: Color,
  val error: Color,
  val errorContainer: Color,
)

@Immutable
data class CoherenceTokens(
  // Spacing scale
  val spacingXs: Dp = 4.dp,
  val spacingSm: Dp = 8.dp,
  val spacingMd: Dp = 12.dp,
  val spacingLg: Dp = 16.dp,
  val spacingXl: Dp = 24.dp,
  val spacingXxl: Dp = 32.dp,
  // Corner radius scale
  val cornerSm: Dp = 8.dp,
  val cornerMd: Dp = 12.dp,
  val cornerLg: Dp = 16.dp,
  val cornerXl: Dp = 24.dp,
  // Elevation scale
  val elevationNone: Dp = 0.dp,
  val elevationLow: Dp = 1.dp,
  val elevationMedium: Dp = 2.dp,
  val elevationHigh: Dp = 4.dp,
  // Category colors
  val categoryColors: CategoryColors,
)

private val LightCategoryColors = CategoryColors(
  health = Color(0xFF2E7D32),
  healthContainer = Color(0xFFE8F5E9),
  productivity = Color(0xFF1565C0),
  productivityContainer = Color(0xFFE3F2FD),
  ai = Color(0xFF7B1FA2),
  aiContainer = Color(0xFFF3E5F5),
  energy = Color(0xFFF57F17),
  energyContainer = Color(0xFFFFF8E1),
  error = Color(0xFFC62828),
  errorContainer = Color(0xFFFFEBEE),
)

private val DarkCategoryColors = CategoryColors(
  health = Color(0xFF81C784),
  healthContainer = Color(0xFF1B3A1D),
  productivity = Color(0xFF90CAF9),
  productivityContainer = Color(0xFF0D2744),
  ai = Color(0xFFCE93D8),
  aiContainer = Color(0xFF2A1233),
  energy = Color(0xFFFFD54F),
  energyContainer = Color(0xFF3E2D05),
  error = Color(0xFFEF9A9A),
  errorContainer = Color(0xFF3D1212),
)

private val LightTokens = CoherenceTokens(categoryColors = LightCategoryColors)
private val DarkTokens = CoherenceTokens(categoryColors = DarkCategoryColors)

val LocalCoherenceTokens = staticCompositionLocalOf { LightTokens }

// ── Color schemes — Basquiat Paper / Ink (Phase E.3) ────────────────────────────
// Maps handoff/design-tokens.md §Color onto Material 3 ColorScheme
// slots. Dynamic color is deliberately disabled (see `CoherenceTheme`
// default below) so the branded aesthetic isn't overridden by the
// user's system wallpaper on Android 12+.

private val LightColorScheme = lightColorScheme(
  primary = Color(0xFF0B0B0B),             // ink — buttons, emphasis
  onPrimary = Color(0xFFF6F2E7),           // paper — text on primary
  primaryContainer = Color(0xFFF6C83A),    // yellow — highlighter
  onPrimaryContainer = Color(0xFF0B0B0B),  // ink on yellow
  secondary = Color(0xFFE23B2B),           // red — alerts, strikes
  onSecondary = Color(0xFFF6F2E7),
  secondaryContainer = Color(0xFFECEAD9),  // paper-2
  onSecondaryContainer = Color(0xFF0B0B0B),
  tertiary = Color(0xFF1D4ED8),            // blue — calendar/links
  onTertiary = Color(0xFFF6F2E7),
  surface = Color(0xFFF6F2E7),             // paper
  onSurface = Color(0xFF0B0B0B),           // ink
  surfaceVariant = Color(0xFFECEAD9),      // paper-2
  onSurfaceVariant = Color(0xFF3A3A3A),    // ink-2
  background = Color(0xFFE8E4D4),          // paper-3 (viewport)
  onBackground = Color(0xFF0B0B0B),
  error = Color(0xFFE23B2B),
  onError = Color(0xFFF6F2E7),
  outline = Color(0xFF0B0B0B),             // hard ink rules
  outlineVariant = Color(0xFF666666),      // ink-3
)

private val DarkColorScheme = darkColorScheme(
  primary = Color(0xFFF2EEDF),             // ink-mode ink (cream)
  onPrimary = Color(0xFF0E0D0A),           // ink-mode paper
  primaryContainer = Color(0xFFFFD84A),    // ink-mode yellow
  onPrimaryContainer = Color(0xFF0E0D0A),
  secondary = Color(0xFFFF5A47),           // ink-mode red
  onSecondary = Color(0xFF0E0D0A),
  secondaryContainer = Color(0xFF1A1914),  // ink-mode paper-2
  onSecondaryContainer = Color(0xFFF2EEDF),
  tertiary = Color(0xFF6A8AFF),            // ink-mode blue
  onTertiary = Color(0xFF0E0D0A),
  surface = Color(0xFF0E0D0A),             // ink-mode paper
  onSurface = Color(0xFFF2EEDF),
  surfaceVariant = Color(0xFF1A1914),
  onSurfaceVariant = Color(0xFFC9C5B4),    // ink-mode ink-2
  background = Color(0xFF070605),          // ink-mode paper-3
  onBackground = Color(0xFFF2EEDF),
  error = Color(0xFFFF5A47),
  onError = Color(0xFF0E0D0A),
  outline = Color(0xFFF2EEDF),
  outlineVariant = Color(0xFF8F8B78),      // ink-mode ink-3
)

// ── Theme composable ────────────────────────────────────────────────────────────

@Composable
fun CoherenceTheme(
  themeMode: ThemeMode = ThemeMode.SYSTEM,
  // Phase E.3: Basquiat palette is branded. Dynamic color is OFF by
  // default so the system wallpaper can't override the aesthetic.
  // A Settings toggle can still flip this to true per user if we
  // ever want a Material You escape hatch.
  dynamicColor: Boolean = false,
  trueBlack: Boolean = false,
  content: @Composable () -> Unit,
) {
  val systemDark = isSystemInDarkTheme()
  val darkTheme = when (themeMode) {
    ThemeMode.SYSTEM -> systemDark
    ThemeMode.LIGHT -> false
    ThemeMode.DARK -> true
  }

  val baseColorScheme = when {
    dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !trueBlack -> {
      val context = LocalContext.current
      if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
    }
    darkTheme -> DarkColorScheme
    else -> LightColorScheme
  }

  val colorScheme = if (darkTheme && trueBlack) {
    baseColorScheme.copy(
      background = Color.Black,
      surface = Color.Black,
      surfaceVariant = Color(0xFF121212),
    )
  } else {
    baseColorScheme
  }

  val tokens = if (darkTheme) DarkTokens else LightTokens

  CompositionLocalProvider(LocalCoherenceTokens provides tokens) {
    MaterialTheme(
      colorScheme = colorScheme,
      content = content,
    )
  }
}
