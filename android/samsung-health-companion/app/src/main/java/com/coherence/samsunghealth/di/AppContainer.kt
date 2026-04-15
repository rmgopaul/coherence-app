package com.coherence.samsunghealth.di

import android.content.Context
import com.coherence.samsunghealth.auth.AuthManager
import com.coherence.samsunghealth.data.repository.AppPreferencesRepository
import com.coherence.samsunghealth.data.repository.AuthRepository
import com.coherence.samsunghealth.data.repository.ChatRepository
import com.coherence.samsunghealth.data.repository.ClockifyRepository
import com.coherence.samsunghealth.data.repository.GoogleRepository
import com.coherence.samsunghealth.data.repository.HabitsRepository
import com.coherence.samsunghealth.data.repository.MarketRepository
import com.coherence.samsunghealth.data.repository.MetricsRepository
import com.coherence.samsunghealth.data.repository.NotesRepository
import com.coherence.samsunghealth.data.repository.PlanRepository
import com.coherence.samsunghealth.data.repository.SearchRepository
import com.coherence.samsunghealth.data.repository.SportsRepository
import com.coherence.samsunghealth.data.repository.SupplementsRepository
import com.coherence.samsunghealth.data.repository.TodoistRepository
import com.coherence.samsunghealth.data.repository.WhoopRepository
import com.coherence.samsunghealth.network.TrpcClient
import com.coherence.samsunghealth.sdk.HealthConnectCooldown
import com.coherence.samsunghealth.sdk.HealthConnectPermissionManager
import com.coherence.samsunghealth.sdk.SamsungHealthDataSdkRepository
import com.coherence.samsunghealth.sdk.SamsungHealthRepository
import kotlinx.serialization.json.Json

/**
 * Application-level dependency container.
 * Owns shared infrastructure (AuthManager, TrpcClient, Json) and all repositories.
 */
class AppContainer(context: Context) {

  val json: Json = Json {
    ignoreUnknownKeys = true
    isLenient = true
  }

  val authManager = AuthManager(context)
  val trpcClient = TrpcClient(authManager, json)

  // Repositories
  val authRepository = AuthRepository(trpcClient, json)
  val appPreferencesRepository = AppPreferencesRepository(context)
  val todoistRepository = TodoistRepository(trpcClient, json)
  val googleRepository = GoogleRepository(trpcClient, json)
  val whoopRepository = WhoopRepository(trpcClient, json)
  val chatRepository = ChatRepository(trpcClient, json)
  val planRepository = PlanRepository(trpcClient, json)
  val searchRepository = SearchRepository(trpcClient, json)
  val supplementsRepository = SupplementsRepository(trpcClient, json)
  val habitsRepository = HabitsRepository(trpcClient, json)
  val notesRepository = NotesRepository(trpcClient, json)
  val metricsRepository = MetricsRepository(trpcClient, json)
  val clockifyRepository = ClockifyRepository(trpcClient, json)
  val marketRepository = MarketRepository(trpcClient, json)
  val sportsRepository = SportsRepository(trpcClient, json)

  // Health Connect layer. Shared between the periodic sync worker,
  // the historical backfill worker, and the UI permission flow so
  // every caller sees the same permission + client + cooldown
  // instance.
  val healthConnectPermissionManager = HealthConnectPermissionManager(context)
  val healthConnectCooldown = HealthConnectCooldown(context)
  val samsungHealthRepository: SamsungHealthRepository =
    SamsungHealthDataSdkRepository(
      context = context,
      permissionManager = healthConnectPermissionManager,
      cooldown = healthConnectCooldown,
    )
}

