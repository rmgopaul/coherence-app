package com.coherence.samsunghealth.ui.navigation

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Dashboard
import androidx.compose.material.icons.filled.FavoriteBorder
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import androidx.navigation.compose.currentBackStackEntryAsState

enum class BottomNavTab(
  val route: String,
  val label: String,
  val icon: ImageVector,
) {
  Dashboard("dashboard", "Dashboard", Icons.Default.Dashboard),
  Tasks("tasks", "Tasks", Icons.Default.CheckCircle),
  Calendar("calendar", "Calendar", Icons.Default.CalendarMonth),
  Health("health", "Health", Icons.Default.FavoriteBorder),
  More("more", "More", Icons.Default.MoreHoriz),
}

@Composable
fun BottomNavBar(navController: NavController) {
  val currentRoute = navController.currentBackStackEntryAsState().value?.destination?.route

  NavigationBar {
    BottomNavTab.entries.forEach { tab ->
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

      NavigationBarItem(
        selected = selected,
        onClick = {
          if (currentRoute != tab.route) {
            navController.navigate(tab.route) {
              popUpTo("dashboard") { saveState = true }
              launchSingleTop = true
              restoreState = true
            }
          }
        },
        icon = {
          Icon(
            imageVector = tab.icon,
            contentDescription = tab.label,
            tint = tintColor,
            modifier = Modifier
              .size(24.dp)
              .scale(iconScale),
          )
        },
        label = { Text(tab.label) },
        colors = NavigationBarItemDefaults.colors(
          selectedIconColor = MaterialTheme.colorScheme.primary,
          selectedTextColor = MaterialTheme.colorScheme.primary,
          unselectedIconColor = MaterialTheme.colorScheme.onSurfaceVariant,
          unselectedTextColor = MaterialTheme.colorScheme.onSurfaceVariant,
          indicatorColor = MaterialTheme.colorScheme.primaryContainer,
        ),
      )
    }
  }
}
