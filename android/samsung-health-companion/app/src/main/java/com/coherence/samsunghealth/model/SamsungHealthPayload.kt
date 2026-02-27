package com.coherence.samsunghealth.model

import kotlinx.serialization.Serializable

@Serializable
data class SamsungHealthPayload(
  val date: String,
  val capturedAtIso: String,
  val timezone: String,
  val source: SourceMetadata,
  val activity: ActivityMetrics,
  val sleep: SleepMetrics,
  val cardio: CardioMetrics,
  val oxygenAndTemperature: OxygenAndTemperatureMetrics,
  val bloodPressure: BloodPressureMetrics,
  val bodyComposition: BodyCompositionMetrics,
  val nutrition: NutritionMetrics,
  val hydration: HydrationMetrics,
  val glucose: GlucoseMetrics,
  val mindfulness: MindfulnessMetrics,
  val reproductiveHealth: ReproductiveHealthMetrics,
  val samples: SampleBuckets,
  val sync: SyncMetadata,
)

@Serializable
data class SourceMetadata(
  val provider: String = "samsung-health-data-sdk",
  val appVersion: String,
  val deviceModel: String,
  val osVersion: String,
)

@Serializable
data class ActivityMetrics(
  val steps: Int,
  val distanceMeters: Double,
  val floorsClimbed: Double,
  val activeMinutes: Int,
  val sedentaryMinutes: Int,
  val exerciseMinutes: Int,
  val caloriesActiveKcal: Double,
  val caloriesBasalKcal: Double,
  val caloriesTotalKcal: Double,
  val walkingDurationMinutes: Int,
  val runningDurationMinutes: Int,
  val cyclingDurationMinutes: Int,
  val swimmingDurationMinutes: Int,
  val exerciseSessionCount: Int,
)

@Serializable
data class SleepMetrics(
  val totalSleepMinutes: Int,
  val inBedMinutes: Int,
  val awakeMinutes: Int,
  val lightMinutes: Int,
  val deepMinutes: Int,
  val remMinutes: Int,
  val sleepOnsetLatencyMinutes: Int,
  val wakeAfterSleepOnsetMinutes: Int,
  val sleepEfficiencyPercent: Double,
  val sleepConsistencyPercent: Double,
  val sleepScore: Double,
  val bedtimeIso: String? = null,
  val wakeTimeIso: String? = null,
)

@Serializable
data class CardioMetrics(
  val restingHeartRateBpm: Double,
  val averageHeartRateBpm: Double,
  val minHeartRateBpm: Double,
  val maxHeartRateBpm: Double,
  val hrvRmssdMs: Double,
  val hrvSdnnMs: Double,
  val respiratoryRateBrpm: Double,
  val vo2MaxMlKgMin: Double,
  val stressScore: Double,
  val stressMinutes: Int,
)

@Serializable
data class OxygenAndTemperatureMetrics(
  val spo2AvgPercent: Double,
  val spo2MinPercent: Double,
  val skinTemperatureCelsius: Double,
  val bodyTemperatureCelsius: Double,
)

@Serializable
data class BloodPressureMetrics(
  val systolicMmHg: Double,
  val diastolicMmHg: Double,
  val pulseBpm: Double,
)

@Serializable
data class BodyCompositionMetrics(
  val weightKg: Double,
  val bmi: Double,
  val bodyFatPercent: Double,
  val skeletalMuscleMassKg: Double,
  val bodyWaterPercent: Double,
  val basalMetabolicRateKcal: Double,
)

@Serializable
data class NutritionMetrics(
  val caloriesIntakeKcal: Double,
  val proteinGrams: Double,
  val carbsGrams: Double,
  val fatGrams: Double,
  val saturatedFatGrams: Double,
  val sugarGrams: Double,
  val fiberGrams: Double,
  val sodiumMg: Double,
  val cholesterolMg: Double,
  val caffeineMg: Double,
)

@Serializable
data class HydrationMetrics(
  val waterMl: Double,
)

@Serializable
data class GlucoseMetrics(
  val fastingMgDl: Double,
  val avgMgDl: Double,
  val maxMgDl: Double,
)

@Serializable
data class MindfulnessMetrics(
  val mindfulMinutes: Int,
  val meditationMinutes: Int,
)

@Serializable
data class ReproductiveHealthMetrics(
  val menstruationStartIso: String? = null,
  val menstruationEndIso: String? = null,
  val ovulationIso: String? = null,
)

@Serializable
data class SampleBuckets(
  val workouts: List<WorkoutSample> = emptyList(),
  val heartRateSeries: List<TimedValueSample> = emptyList(),
  val spo2Series: List<TimedValueSample> = emptyList(),
  val glucoseSeries: List<TimedValueSample> = emptyList(),
  val bloodPressureSeries: List<BloodPressureSample> = emptyList(),
  val sleepSessions: List<SleepSessionSample> = emptyList(),
  val sleepStageSeries: List<SleepStageSample> = emptyList(),
)

@Serializable
data class WorkoutSample(
  val type: String,
  val startIso: String,
  val endIso: String,
  val durationMinutes: Int,
  val caloriesKcal: Double,
  val distanceMeters: Double,
  val avgHeartRateBpm: Double,
  val maxHeartRateBpm: Double,
)

@Serializable
data class TimedValueSample(
  val atIso: String,
  val value: Double,
  val unit: String,
)

@Serializable
data class BloodPressureSample(
  val atIso: String,
  val systolicMmHg: Double,
  val diastolicMmHg: Double,
  val pulseBpm: Double,
)

@Serializable
data class SleepSessionSample(
  val startIso: String,
  val endIso: String,
  val score: Double,
)

@Serializable
data class SleepStageSample(
  val stage: String,
  val startIso: String,
  val endIso: String,
  val minutes: Int,
)

@Serializable
data class SyncMetadata(
  val sdkLinked: Boolean,
  val permissionsGranted: Boolean,
  val recordTypesAttempted: List<String>,
  val recordTypesSucceeded: List<String>,
  val warnings: List<String>,
)
