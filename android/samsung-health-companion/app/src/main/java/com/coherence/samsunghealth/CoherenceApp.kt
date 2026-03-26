package com.coherence.samsunghealth

import android.app.Application
import com.coherence.samsunghealth.auth.AuthManager
import com.coherence.samsunghealth.data.local.AppDatabase
import com.coherence.samsunghealth.data.repository.AuthRepository
import com.coherence.samsunghealth.data.repository.AppPreferencesRepository
import com.coherence.samsunghealth.data.repository.ChatRepository
import com.coherence.samsunghealth.data.repository.ClockifyRepository
import com.coherence.samsunghealth.data.repository.GoogleRepository
import com.coherence.samsunghealth.data.repository.HabitsRepository
import com.coherence.samsunghealth.data.repository.MarketRepository
import com.coherence.samsunghealth.data.repository.MetricsRepository
import com.coherence.samsunghealth.data.repository.SportsRepository
import com.coherence.samsunghealth.data.repository.NotesRepository
import com.coherence.samsunghealth.data.repository.PlanRepository
import com.coherence.samsunghealth.data.repository.SearchRepository
import com.coherence.samsunghealth.data.repository.SupplementsRepository
import com.coherence.samsunghealth.data.repository.TodoistRepository
import com.coherence.samsunghealth.data.repository.WhoopRepository
import com.coherence.samsunghealth.network.TrpcClient
import com.coherence.samsunghealth.ui.screens.DashboardViewModel

/**
 * Application-level singleton container for shared dependencies.
 */
class CoherenceApplication : Application() {

  lateinit var authManager: AuthManager
    private set
  lateinit var trpcClient: TrpcClient
    private set
  lateinit var database: AppDatabase
    private set

  // Shared ViewModel (survives navigation)
  lateinit var dashboardViewModel: DashboardViewModel
    private set

  // Repositories
  lateinit var authRepository: AuthRepository
    private set
  lateinit var appPreferencesRepository: AppPreferencesRepository
    private set
  lateinit var todoistRepository: TodoistRepository
    private set
  lateinit var googleRepository: GoogleRepository
    private set
  lateinit var whoopRepository: WhoopRepository
    private set
  lateinit var chatRepository: ChatRepository
    private set
  lateinit var planRepository: PlanRepository
    private set
  lateinit var searchRepository: SearchRepository
    private set
  lateinit var supplementsRepository: SupplementsRepository
    private set
  lateinit var habitsRepository: HabitsRepository
    private set
  lateinit var notesRepository: NotesRepository
    private set
  lateinit var metricsRepository: MetricsRepository
    private set
  lateinit var clockifyRepository: ClockifyRepository
    private set
  lateinit var marketRepository: MarketRepository
    private set
  lateinit var sportsRepository: SportsRepository
    private set

  override fun onCreate() {
    super.onCreate()

    authManager = AuthManager(this)
    trpcClient = TrpcClient(authManager)
    database = AppDatabase.getInstance(this)

    authRepository = AuthRepository(trpcClient)
    appPreferencesRepository = AppPreferencesRepository(this)
    todoistRepository = TodoistRepository(trpcClient)
    googleRepository = GoogleRepository(trpcClient)
    whoopRepository = WhoopRepository(trpcClient)
    chatRepository = ChatRepository(trpcClient)
    planRepository = PlanRepository(trpcClient)
    searchRepository = SearchRepository(trpcClient)
    supplementsRepository = SupplementsRepository(trpcClient)
    habitsRepository = HabitsRepository(trpcClient)
    notesRepository = NotesRepository(trpcClient)
    metricsRepository = MetricsRepository(trpcClient)
    clockifyRepository = ClockifyRepository(trpcClient)
    marketRepository = MarketRepository(trpcClient)
    sportsRepository = SportsRepository(trpcClient)

    dashboardViewModel = DashboardViewModel(
      todoistRepo = todoistRepository,
      googleRepo = googleRepository,
      whoopRepo = whoopRepository,
      metricsRepo = metricsRepository,
      planRepo = planRepository,
      marketRepo = marketRepository,
      sportsRepo = sportsRepository,
    )
  }
}
