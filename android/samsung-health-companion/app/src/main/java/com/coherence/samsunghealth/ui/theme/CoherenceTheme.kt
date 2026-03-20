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

// ── Color schemes ───────────────────────────────────────────────────────────────

private val CoherenceBlue = Color(0xFF1A73E8)
private val CoherenceBlueDark = Color(0xFF8AB4F8)

private val LightColorScheme = lightColorScheme(
  primary = CoherenceBlue,
  onPrimary = Color.White,
  primaryContainer = Color(0xFFD3E3FD),
  onPrimaryContainer = Color(0xFF001D36),
  secondary = Color(0xFF5F6368),
  onSecondary = Color.White,
  surface = Color(0xFFFAFAFA),
  onSurface = Color(0xFF1F1F1F),
  surfaceVariant = Color(0xFFF1F3F4),
  onSurfaceVariant = Color(0xFF5F6368),
  background = Color.White,
  onBackground = Color(0xFF1F1F1F),
  error = Color(0xFFD93025),
  onError = Color.White,
)

private val DarkColorScheme = darkColorScheme(
  primary = CoherenceBlueDark,
  onPrimary = Color(0xFF003258),
  primaryContainer = Color(0xFF00497D),
  onPrimaryContainer = Color(0xFFD3E3FD),
  secondary = Color(0xFFBDC1C6),
  onSecondary = Color(0xFF282A2D),
  surface = Color(0xFF1A1A1A),
  onSurface = Color(0xFFECEFF1),
  surfaceVariant = Color(0xFF28292C),
  onSurfaceVariant = Color(0xFFAEB3B7),
  background = Color(0xFF0E0E0E),
  onBackground = Color(0xFFECEFF1),
  error = Color(0xFFF28B82),
  onError = Color(0xFF601410),
)

// ── Theme composable ────────────────────────────────────────────────────────────

@Composable
fun CoherenceTheme(
  themeMode: ThemeMode = ThemeMode.SYSTEM,
  dynamicColor: Boolean = true,
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
