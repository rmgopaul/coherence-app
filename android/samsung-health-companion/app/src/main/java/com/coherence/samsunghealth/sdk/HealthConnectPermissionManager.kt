package com.coherence.samsunghealth.sdk

import android.content.Context
import android.content.Intent
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
import androidx.health.connect.client.records.BasalMetabolicRateRecord
import androidx.health.connect.client.records.BloodGlucoseRecord
import androidx.health.connect.client.records.BloodPressureRecord
import androidx.health.connect.client.records.BodyFatRecord
import androidx.health.connect.client.records.BodyTemperatureRecord
import androidx.health.connect.client.records.BodyWaterMassRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.FloorsClimbedRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.HeartRateVariabilityRmssdRecord
import androidx.health.connect.client.records.HeightRecord
import androidx.health.connect.client.records.HydrationRecord
import androidx.health.connect.client.records.NutritionRecord
import androidx.health.connect.client.records.OxygenSaturationRecord
import androidx.health.connect.client.records.PowerRecord
import androidx.health.connect.client.records.RespiratoryRateRecord
import androidx.health.connect.client.records.RestingHeartRateRecord
import androidx.health.connect.client.records.SkinTemperatureRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.SpeedRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.TotalCaloriesBurnedRecord
import androidx.health.connect.client.records.Vo2MaxRecord
import androidx.health.connect.client.records.WeightRecord

/**
 * Connection state + permission state for Health Connect. Produced by
 * [HealthConnectPermissionManager.getStatus].
 */
data class HealthConnectStatus(
  val sdkAvailable: Boolean,
  val permissionsGranted: Boolean,
  val grantedPermissions: Set<String>,
  val missingPermissions: Set<String>,
  val sdkStatusCode: Int,
)

/**
 * Single source of truth for Health Connect availability and
 * permissions. Also exposes the permission set used by the activity
 * launcher via [PermissionController.createRequestPermissionResultContract].
 *
 * Separated from [HealthConnectReader] and [HealthConnectPayloadMapper]
 * so the permission list can be reused without pulling in the entire
 * read pipeline.
 */
class HealthConnectPermissionManager(
  private val context: Context,
) {

  companion object {
    const val HEALTH_CONNECT_PROVIDER_PACKAGE = "com.google.android.apps.healthdata"

    /**
     * Permissions the app *needs* to produce a minimally useful payload.
     * If any of these are missing, the UI should prompt the user.
     */
    val corePermissions: Set<String> = setOf(
      HealthPermission.getReadPermission(StepsRecord::class),
      HealthPermission.getReadPermission(DistanceRecord::class),
      HealthPermission.getReadPermission(ActiveCaloriesBurnedRecord::class),
      HealthPermission.getReadPermission(TotalCaloriesBurnedRecord::class),
      HealthPermission.getReadPermission(ExerciseSessionRecord::class),
      HealthPermission.getReadPermission(SleepSessionRecord::class),
      HealthPermission.getReadPermission(HeartRateRecord::class),
    )

    /**
     * Permissions the app *would like* but can function without.
     * Declared in the manifest and requested alongside the core set,
     * but a missing optional permission is not treated as an error.
     */
    val optionalPermissions: Set<String> = setOf(
      HealthPermission.getReadPermission(FloorsClimbedRecord::class),
      HealthPermission.getReadPermission(RestingHeartRateRecord::class),
      HealthPermission.getReadPermission(HeartRateVariabilityRmssdRecord::class),
      HealthPermission.getReadPermission(RespiratoryRateRecord::class),
      HealthPermission.getReadPermission(Vo2MaxRecord::class),
      HealthPermission.getReadPermission(OxygenSaturationRecord::class),
      HealthPermission.getReadPermission(BodyTemperatureRecord::class),
      HealthPermission.getReadPermission(SkinTemperatureRecord::class),
      HealthPermission.getReadPermission(BloodPressureRecord::class),
      HealthPermission.getReadPermission(BloodGlucoseRecord::class),
      HealthPermission.getReadPermission(WeightRecord::class),
      HealthPermission.getReadPermission(HeightRecord::class),
      HealthPermission.getReadPermission(BodyFatRecord::class),
      HealthPermission.getReadPermission(BodyWaterMassRecord::class),
      HealthPermission.getReadPermission(BasalMetabolicRateRecord::class),
      HealthPermission.getReadPermission(HydrationRecord::class),
      HealthPermission.getReadPermission(NutritionRecord::class),
      HealthPermission.getReadPermission(PowerRecord::class),
      HealthPermission.getReadPermission(SpeedRecord::class),
    )

    /** The full set of permissions requested in the permission prompt. */
    val allPermissions: Set<String> = corePermissions + optionalPermissions

    fun getSdkStatus(context: Context): Int {
      return HealthConnectClient.getSdkStatus(context, HEALTH_CONNECT_PROVIDER_PACKAGE)
    }

    fun buildHealthConnectSettingsIntent(): Intent {
      return Intent(HealthConnectClient.ACTION_HEALTH_CONNECT_SETTINGS)
    }

    /**
     * Activity-result contract used by Compose / Activity code to
     * launch the Health Connect permission dialog.
     */
    fun createPermissionRequestContract() =
      PermissionController.createRequestPermissionResultContract()
  }

  /**
   * Snapshot the current SDK + permission state. Returns even when the
   * SDK is unavailable so callers can surface actionable messages.
   */
  suspend fun getStatus(): HealthConnectStatus {
    val sdkStatus = getSdkStatus(context)
    if (sdkStatus != HealthConnectClient.SDK_AVAILABLE) {
      return HealthConnectStatus(
        sdkAvailable = false,
        permissionsGranted = false,
        grantedPermissions = emptySet(),
        missingPermissions = allPermissions,
        sdkStatusCode = sdkStatus,
      )
    }

    val client = HealthConnectClient.getOrCreate(context)
    val granted = client.permissionController.getGrantedPermissions()
    val missingCore = corePermissions - granted
    return HealthConnectStatus(
      sdkAvailable = true,
      // "permissionsGranted" reflects core permissions only — optional
      // permissions missing should never block sync.
      permissionsGranted = missingCore.isEmpty(),
      grantedPermissions = granted,
      missingPermissions = allPermissions - granted,
      sdkStatusCode = sdkStatus,
    )
  }
}
