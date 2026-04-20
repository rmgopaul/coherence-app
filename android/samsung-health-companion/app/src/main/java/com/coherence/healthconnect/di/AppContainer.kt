package com.coherence.healthconnect.di

import android.content.Context
import com.coherence.healthconnect.auth.AuthManager
import com.coherence.healthconnect.data.repository.AppPreferencesRepository
import com.coherence.healthconnect.data.repository.AuthRepository
import com.coherence.healthconnect.data.repository.ChatRepository
import com.coherence.healthconnect.data.repository.ClockifyRepository
import com.coherence.healthconnect.data.repository.GoogleRepository
import com.coherence.healthconnect.data.repository.HabitsRepository
import com.coherence.healthconnect.data.repository.MarketRepository
import com.coherence.healthconnect.data.repository.MetricsRepository
import com.coherence.healthconnect.data.repository.NotesRepository
import com.coherence.healthconnect.data.repository.PlanRepository
import com.coherence.healthconnect.data.repository.SearchRepository
import com.coherence.healthconnect.data.repository.SportsRepository
import com.coherence.healthconnect.data.repository.SupplementsRepository
import com.coherence.healthconnect.data.repository.TodoistRepository
import com.coherence.healthconnect.data.repository.WhoopRepository
import com.coherence.healthconnect.network.TrpcClient
import com.coherence.healthconnect.sdk.HealthConnectCooldown
import com.coherence.healthconnect.sdk.HealthConnectPermissionManager
import com.coherence.healthconnect.sdk.HealthConnectRepository
import com.coherence.healthconnect.sdk.HealthConnectPayloadSource
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
  val healthConnectRepository: HealthConnectPayloadSource =
    HealthConnectRepository(
      context = context,
      permissionManager = healthConnectPermissionManager,
      cooldown = healthConnectCooldown,
    )
}

