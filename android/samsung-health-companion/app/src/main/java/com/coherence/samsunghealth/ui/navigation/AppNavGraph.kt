package com.coherence.samsunghealth.ui.navigation

import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.lifecycle.viewmodel.compose.viewModel
import com.coherence.samsunghealth.data.model.ClockifyTimeEntry
import com.coherence.samsunghealth.ui.LocalApp
import com.coherence.samsunghealth.ui.screens.DashboardViewModel
import com.coherence.samsunghealth.ui.screens.CalendarScreen
import com.coherence.samsunghealth.ui.screens.ChatScreen
import com.coherence.samsunghealth.ui.screens.ClockifyScreen
import com.coherence.samsunghealth.ui.screens.DailyLogScreen
import com.coherence.samsunghealth.ui.screens.DashboardScreen
import com.coherence.samsunghealth.ui.screens.DriveScreen
import com.coherence.samsunghealth.ui.screens.HabitsScreen
import com.coherence.samsunghealth.ui.screens.HealthScreen
import com.coherence.samsunghealth.ui.screens.MoreScreen
import com.coherence.samsunghealth.ui.screens.NotesScreen
import com.coherence.samsunghealth.ui.screens.SettingsScreen
import com.coherence.samsunghealth.ui.screens.SupplementsScreen
import com.coherence.samsunghealth.ui.screens.TasksScreen
import com.coherence.samsunghealth.ui.widgets.ClockifyTimerStrip
import kotlinx.coroutines.delay

private const val TAB_FADE_DURATION = 300
private const val SLIDE_DURATION = 350

private val tabEnter: EnterTransition = fadeIn(animationSpec = tween(TAB_FADE_DURATION))
private val tabExit: ExitTransition = fadeOut(animationSpec = tween(TAB_FADE_DURATION))

private val detailEnter: EnterTransition = slideInHorizontally(
  animationSpec = tween(SLIDE_DURATION, easing = FastOutSlowInEasing),
  initialOffsetX = { fullWidth -> fullWidth },
) + fadeIn(animationSpec = tween(SLIDE_DURATION))

private val detailExit: ExitTransition = slideOutHorizontally(
  animationSpec = tween(SLIDE_DURATION, easing = FastOutSlowInEasing),
  targetOffsetX = { fullWidth -> -fullWidth / 4 },
) + fadeOut(animationSpec = tween(SLIDE_DURATION))

private val detailPopEnter: EnterTransition = slideInHorizontally(
  animationSpec = tween(SLIDE_DURATION, easing = FastOutSlowInEasing),
  initialOffsetX = { fullWidth -> -fullWidth / 4 },
) + fadeIn(animationSpec = tween(SLIDE_DURATION))

private val detailPopExit: ExitTransition = slideOutHorizontally(
  animationSpec = tween(SLIDE_DURATION, easing = FastOutSlowInEasing),
  targetOffsetX = { fullWidth -> fullWidth },
) + fadeOut(animationSpec = tween(SLIDE_DURATION))

@Composable
fun AppNavGraph() {
  val app = LocalApp.current
  val dashboardViewModel: DashboardViewModel = viewModel(
    factory = DashboardViewModel.Factory(app.container),
  )
  val navController = rememberNavController()
  val currentRoute by navController.currentBackStackEntryAsState()
  val showBottomBar = currentRoute?.destination?.route in BottomNavTab.entries.map { it.route }
  var clockifyConnected by remember { mutableStateOf(false) }
  var currentClockifyEntry by remember { mutableStateOf<ClockifyTimeEntry?>(null) }

  LaunchedEffect(Unit) {
    while (true) {
      try {
        val status = app.container.clockifyRepository.getStatus()
        clockifyConnected = status?.connected == true
        currentClockifyEntry =
          if (clockifyConnected) app.container.clockifyRepository.getCurrentEntry() else null
      } catch (e: Exception) {
        android.util.Log.w("AppNavGraph", "Clockify poll failed", e)
        clockifyConnected = false
        currentClockifyEntry = null
      }
      val pollIntervalMs = if (clockifyConnected && currentClockifyEntry?.isRunning == true) {
        5_000L
      } else {
        20_000L
      }
      delay(pollIntervalMs)
    }
  }

  Scaffold(
    bottomBar = {
      if (showBottomBar) {
        BottomNavBar(navController)
      }
    },
  ) { innerPadding ->
    Box(
      modifier = Modifier
        .fillMaxSize()
        .padding(innerPadding),
    ) {
      NavHost(
        navController = navController,
        startDestination = Routes.DASHBOARD,
        modifier = Modifier
          .fillMaxSize()
          .padding(top = if (clockifyConnected) 58.dp else 0.dp),
        enterTransition = { detailEnter },
        exitTransition = { detailExit },
        popEnterTransition = { detailPopEnter },
        popExitTransition = { detailPopExit },
      ) {
      // --- Bottom nav tab routes (crossfade) ---
      composable(
        route = Routes.DASHBOARD,
        enterTransition = { tabEnter },
        exitTransition = { tabExit },
        popEnterTransition = { tabEnter },
        popExitTransition = { tabExit },
      ) { DashboardScreen(viewModel = dashboardViewModel) }

      composable(
        route = Routes.TASKS,
        enterTransition = { tabEnter },
        exitTransition = { tabExit },
        popEnterTransition = { tabEnter },
        popExitTransition = { tabExit },
      ) { TasksScreen(viewModel = dashboardViewModel) }

      composable(
        route = Routes.CALENDAR,
        enterTransition = { tabEnter },
        exitTransition = { tabExit },
        popEnterTransition = { tabEnter },
        popExitTransition = { tabExit },
      ) { CalendarScreen(viewModel = dashboardViewModel) }

      composable(
        route = Routes.HEALTH,
        enterTransition = { tabEnter },
        exitTransition = { tabExit },
        popEnterTransition = { tabEnter },
        popExitTransition = { tabExit },
      ) { HealthScreen(viewModel = dashboardViewModel) }

      composable(
        route = Routes.MORE,
        enterTransition = { tabEnter },
        exitTransition = { tabExit },
        popEnterTransition = { tabEnter },
        popExitTransition = { tabExit },
      ) {
        MoreScreen(
          onNavigateToChat = { navController.navigate(Routes.CHAT) { launchSingleTop = true } },
          onNavigateToNotes = { navController.navigate(Routes.NOTES) { launchSingleTop = true } },
          onNavigateToSupplements = { navController.navigate(Routes.SUPPLEMENTS) { launchSingleTop = true } },
          onNavigateToHabits = { navController.navigate(Routes.HABITS) { launchSingleTop = true } },
          onNavigateToDailyLog = { navController.navigate(Routes.DAILY_LOG) { launchSingleTop = true } },
          onNavigateToDrive = { navController.navigate(Routes.DRIVE) { launchSingleTop = true } },
          onNavigateToClockify = { navController.navigate(Routes.CLOCKIFY) { launchSingleTop = true } },
          onNavigateToSettings = { navController.navigate(Routes.SETTINGS) { launchSingleTop = true } },
        )
      }

      // --- Detail / push routes (slide from right) ---
      // These inherit the NavHost-level slide transitions defined above.
      composable(Routes.CHAT) { ChatScreen() }
      composable(Routes.NOTES) { NotesScreen(onBack = { navController.popBackStack() }) }
      composable(Routes.SUPPLEMENTS) { SupplementsScreen(onBack = { navController.popBackStack() }) }
      composable(Routes.HABITS) { HabitsScreen(onBack = { navController.popBackStack() }) }
      composable(Routes.DAILY_LOG) { DailyLogScreen(onBack = { navController.popBackStack() }) }
      composable(Routes.DRIVE) { DriveScreen(onBack = { navController.popBackStack() }) }
      composable(Routes.CLOCKIFY) { ClockifyScreen(onBack = { navController.popBackStack() }) }
      composable(Routes.SETTINGS) { SettingsScreen(onBack = { navController.popBackStack() }) }
      }

      if (clockifyConnected) {
        ClockifyTimerStrip(
          entry = currentClockifyEntry,
          modifier = Modifier
            .fillMaxWidth()
            .align(Alignment.TopCenter),
        )
      }
    }
  }
}
