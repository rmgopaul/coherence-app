package com.coherence.samsunghealth.ui.widgets

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import com.coherence.samsunghealth.ui.theme.LocalCoherenceTokens

/** Category for widget tinting. */
enum class WidgetCategory {
  HEALTH,
  PRODUCTIVITY,
  AI,
  ENERGY,
  GENERAL,
}

/**
 * Enhanced widget container that replaces [WidgetCard].
 *
 * Features: category tinting, collapse/expand, shimmer loading, error panel, last-updated footer.
 */
@Composable
fun WidgetShell(
  title: String,
  icon: ImageVector,
  modifier: Modifier = Modifier,
  category: WidgetCategory = WidgetCategory.GENERAL,
  initiallyExpanded: Boolean = true,
  isLoading: Boolean = false,
  error: String? = null,
  onRetry: (() -> Unit)? = null,
  lastUpdated: Long? = null,
  content: @Composable () -> Unit,
) {
  val tokens = LocalCoherenceTokens.current
  var expanded by rememberSaveable { mutableStateOf(initiallyExpanded) }

  val categoryColor = categoryAccentColor(category)
  val categoryContainerColor = categoryContainerColor(category)

  Card(
    modifier = modifier.fillMaxWidth(),
    colors = CardDefaults.cardColors(
      containerColor = MaterialTheme.colorScheme.surface,
    ),
    elevation = CardDefaults.cardElevation(defaultElevation = tokens.elevationLow),
    shape = RoundedCornerShape(tokens.cornerMd),
  ) {
    Column(modifier = Modifier.animateContentSize()) {
      // ── Header with category tint gradient ──────────────────────────
      Box(
        modifier = Modifier
          .fillMaxWidth()
          .background(
            brush = Brush.horizontalGradient(
              colors = listOf(
                categoryContainerColor.copy(alpha = 0.55f),
                Color.Transparent,
              ),
            ),
          )
          .clickable { expanded = !expanded }
          .padding(horizontal = tokens.spacingLg, vertical = tokens.spacingMd),
      ) {
        Row(
          verticalAlignment = Alignment.CenterVertically,
          modifier = Modifier.fillMaxWidth(),
        ) {
          Icon(
            icon,
            contentDescription = null,
            modifier = Modifier.size(20.dp),
            tint = categoryColor,
          )
          Spacer(modifier = Modifier.width(tokens.spacingSm))
          Text(
            text = title,
            style = MaterialTheme.typography.titleMedium,
            modifier = Modifier.weight(1f),
          )
          Icon(
            imageVector = if (expanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore,
            contentDescription = if (expanded) "Collapse" else "Expand",
            modifier = Modifier.size(20.dp),
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
          )
        }
      }

      // ── Body (animated expand/collapse) ─────────────────────────────
      AnimatedVisibility(
        visible = expanded,
        enter = expandVertically() + fadeIn(),
        exit = shrinkVertically() + fadeOut(),
      ) {
        Column(
          modifier = Modifier
            .fillMaxWidth()
            .padding(
              start = tokens.spacingLg,
              end = tokens.spacingLg,
              bottom = tokens.spacingLg,
            ),
        ) {
          when {
            // Error panel
            error != null -> {
              ErrorPanel(error = error, onRetry = onRetry)
            }
            // Shimmer loading
            isLoading -> {
              ShimmerPlaceholder()
            }
            // Normal content
            else -> {
              content()
            }
          }

          // Last updated footer
          if (lastUpdated != null) {
            Spacer(modifier = Modifier.height(tokens.spacingSm))
            Text(
              text = formatLastUpdated(lastUpdated),
              style = MaterialTheme.typography.labelSmall,
              color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
            )
          }
        }
      }
    }
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

@Composable
private fun categoryAccentColor(category: WidgetCategory): Color {
  val tokens = LocalCoherenceTokens.current
  return when (category) {
    WidgetCategory.HEALTH -> tokens.categoryColors.health
    WidgetCategory.PRODUCTIVITY -> tokens.categoryColors.productivity
    WidgetCategory.AI -> tokens.categoryColors.ai
    WidgetCategory.ENERGY -> tokens.categoryColors.energy
    WidgetCategory.GENERAL -> MaterialTheme.colorScheme.primary
  }
}

@Composable
private fun categoryContainerColor(category: WidgetCategory): Color {
  val tokens = LocalCoherenceTokens.current
  return when (category) {
    WidgetCategory.HEALTH -> tokens.categoryColors.healthContainer
    WidgetCategory.PRODUCTIVITY -> tokens.categoryColors.productivityContainer
    WidgetCategory.AI -> tokens.categoryColors.aiContainer
    WidgetCategory.ENERGY -> tokens.categoryColors.energyContainer
    WidgetCategory.GENERAL -> MaterialTheme.colorScheme.surfaceVariant
  }
}

@Composable
private fun ShimmerPlaceholder() {
  val transition = rememberInfiniteTransition(label = "shimmer")
  val shimmerOffset by transition.animateFloat(
    initialValue = -300f,
    targetValue = 900f,
    animationSpec = infiniteRepeatable(
      animation = tween(durationMillis = 1200, easing = LinearEasing),
      repeatMode = RepeatMode.Restart,
    ),
    label = "shimmerOffset",
  )
  val shimmerBrush = Brush.linearGradient(
    colors = listOf(
      MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.3f),
      MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.7f),
      MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.3f),
    ),
    start = Offset(shimmerOffset, 0f),
    end = Offset(shimmerOffset + 300f, 0f),
  )

  Column(verticalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(8.dp)) {
    repeat(3) {
      Box(
        modifier = Modifier
          .fillMaxWidth(if (it == 2) 0.6f else 1f)
          .height(16.dp)
          .clip(RoundedCornerShape(4.dp))
          .background(shimmerBrush),
      )
    }
  }
}

@Composable
private fun ErrorPanel(
  error: String,
  onRetry: (() -> Unit)?,
) {
  val tokens = LocalCoherenceTokens.current
  Column(
    modifier = Modifier
      .fillMaxWidth()
      .clip(RoundedCornerShape(tokens.cornerSm))
      .background(tokens.categoryColors.errorContainer.copy(alpha = 0.5f))
      .padding(tokens.spacingMd),
  ) {
    Text(
      text = error,
      style = MaterialTheme.typography.bodySmall,
      color = tokens.categoryColors.error,
    )
    if (onRetry != null) {
      Spacer(modifier = Modifier.height(tokens.spacingSm))
      Button(
        onClick = onRetry,
        colors = ButtonDefaults.buttonColors(
          containerColor = tokens.categoryColors.error,
          contentColor = Color.White,
        ),
        contentPadding = ButtonDefaults.TextButtonContentPadding,
      ) {
        Icon(
          Icons.Default.Refresh,
          contentDescription = null,
          modifier = Modifier.size(16.dp),
        )
        Spacer(modifier = Modifier.width(4.dp))
        Text("Retry", style = MaterialTheme.typography.labelMedium)
      }
    }
  }
}

private fun formatLastUpdated(epochMillis: Long): String {
  val diffMs = System.currentTimeMillis() - epochMillis
  val minutes = (diffMs / 60_000).toInt()
  return when {
    minutes < 1 -> "Updated just now"
    minutes == 1 -> "Updated 1 min ago"
    minutes < 60 -> "Updated $minutes min ago"
    else -> {
      val hours = minutes / 60
      if (hours == 1) "Updated 1 hr ago" else "Updated $hours hrs ago"
    }
  }
}
