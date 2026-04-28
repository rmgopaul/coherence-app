package com.coherence.healthconnect.ui.navigation

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Dashboard
import androidx.compose.material.icons.filled.EditNote
import androidx.compose.material.icons.filled.FavoriteBorder
import androidx.compose.material.icons.filled.LocalPharmacy
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.Repeat
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import androidx.navigation.compose.currentBackStackEntryAsState

/**
 * Bottom-nav destinations.
 *
 * Material 3 `NavigationBar` is fixed-width and recommended for 3–5
 * destinations. We exceed that — Habits, Notes, and Supplements were
 * previously buried under "More" but the user uses them daily and
 * wants them at the same level as Dashboard / Tasks / Calendar. So
 * the bar is now a horizontally-scrollable `LazyRow` of fixed-width
 * items styled to match `NavigationBarItem`. Anything genuinely
 * less-frequently-used (Chat, Drive, Clockify, Settings, Sign Out)
 * still lives behind the trailing "More" tab.
 */
enum class BottomNavTab(
  val route: String,
  val label: String,
  val icon: ImageVector,
) {
  Dashboard(Routes.DASHBOARD, "Dashboard", Icons.Default.Dashboard),
  Tasks(Routes.TASKS, "Tasks", Icons.Default.CheckCircle),
  Calendar(Routes.CALENDAR, "Calendar", Icons.Default.CalendarMonth),
  Habits(Routes.HABITS, "Habits", Icons.Default.Repeat),
  Notes(Routes.NOTES, "Notes", Icons.Default.EditNote),
  Supplements(Routes.SUPPLEMENTS, "Supplements", Icons.Default.LocalPharmacy),
  Health(Routes.HEALTH, "Health", Icons.Default.FavoriteBorder),
  More(Routes.MORE, "More", Icons.Default.MoreHoriz),
}

private val NavItemMinWidth = 76.dp
private val NavBarHeight = 72.dp

@Composable
fun BottomNavBar(navController: NavController) {
  val currentRoute = navController.currentBackStackEntryAsState().value?.destination?.route

  Surface(
    color = MaterialTheme.colorScheme.surface,
    tonalElevation = 3.dp,
    // Pad above the system gesture / nav bar. Without this the
    // Z Fold 7's bottom gesture pill sits on top of our icons; tapping
    // the lower half of a tab triggers the system pill instead of
    // navigation.
    modifier = Modifier.navigationBarsPadding(),
  ) {
    LazyRow(
      modifier = Modifier
        .fillMaxWidth()
        .height(NavBarHeight),
      horizontalArrangement = Arrangement.spacedBy(0.dp),
      contentPadding = PaddingValues(horizontal = 4.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      items(BottomNavTab.entries.toList()) { tab ->
        val selected = currentRoute == tab.route

        val iconScale by animateFloatAsState(
          targetValue = if (selected) 1.15f else 1.0f,
          animationSpec = spring(
            dampingRatio = Spring.DampingRatioMediumBouncy,
            stiffness = Spring.StiffnessMedium,
          ),
          label = "iconScale",
        )

        val tintColor by animateColorAsState(
          targetValue = if (selected) {
            MaterialTheme.colorScheme.primary
          } else {
            MaterialTheme.colorScheme.onSurfaceVariant
          },
          label = "tintColor",
        )

        Column(
          modifier = Modifier
            .widthIn(min = NavItemMinWidth)
            .clickable {
              if (currentRoute != tab.route) {
                navController.navigate(tab.route) {
                  popUpTo("dashboard") { saveState = true }
                  launchSingleTop = true
                  restoreState = true
                }
              }
            }
            .padding(horizontal = 8.dp, vertical = 8.dp),
          horizontalAlignment = Alignment.CenterHorizontally,
          verticalArrangement = Arrangement.Center,
        ) {
          val indicatorBg = if (selected) {
            MaterialTheme.colorScheme.primaryContainer
          } else {
            MaterialTheme.colorScheme.surface
          }
          Surface(
            color = indicatorBg,
            shape = MaterialTheme.shapes.large,
            modifier = Modifier.padding(bottom = 4.dp),
          ) {
            Row(
              modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
              verticalAlignment = Alignment.CenterVertically,
            ) {
              Icon(
                imageVector = tab.icon,
                contentDescription = tab.label,
                tint = tintColor,
                modifier = Modifier
                  .size(20.dp)
                  .scale(iconScale),
              )
            }
          }
          Text(
            text = tab.label,
            color = tintColor,
            style = MaterialTheme.typography.labelSmall,
            maxLines = 1,
          )
        }
      }
    }
  }
}
