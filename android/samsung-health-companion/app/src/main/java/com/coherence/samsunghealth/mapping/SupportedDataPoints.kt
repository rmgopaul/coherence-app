package com.coherence.samsunghealth.mapping

/**
 * Canonical data points targeted for Samsung Health Data SDK ingestion.
 * Keep this list aligned with backend contract and settings UI.
 */
object SupportedDataPoints {
  val aggregateDataPoints = listOf(
    "steps",
    "distance",
    "floors_climbed",
    "active_minutes",
    "sedentary_minutes",
    "exercise_minutes",
    "active_calories",
    "basal_calories",
    "total_calories",
    "resting_heart_rate",
    "average_heart_rate",
    "max_heart_rate",
    "min_heart_rate",
    "hrv_rmssd",
    "hrv_sdnn",
    "respiratory_rate",
    "vo2max",
    "spo2_avg",
    "spo2_min",
    "skin_temperature",
    "body_temperature",
    "blood_pressure_systolic",
    "blood_pressure_diastolic",
    "blood_pressure_pulse",
    "sleep_total_minutes",
    "sleep_in_bed_minutes",
    "sleep_awake_minutes",
    "sleep_light_minutes",
    "sleep_deep_minutes",
    "sleep_rem_minutes",
    "sleep_score",
    "sleep_efficiency",
    "sleep_consistency",
    "sleep_latency",
    "wake_after_sleep_onset",
    "weight",
    "bmi",
    "body_fat_percent",
    "skeletal_muscle_mass",
    "body_water_percent",
    "bmr",
    "water_intake",
    "nutrition_calories",
    "protein",
    "carbohydrates",
    "fat",
    "saturated_fat",
    "sugar",
    "fiber",
    "sodium",
    "cholesterol",
    "caffeine",
    "stress_score",
    "stress_minutes",
    "mindfulness_minutes",
    "meditation_minutes",
    "fasting_glucose",
    "average_glucose",
    "max_glucose"
  )

  val sampleDataPoints = listOf(
    "workout_sessions",
    "sleep_sessions",
    "sleep_stages",
    "heart_rate_series",
    "spo2_series",
    "blood_pressure_series",
    "glucose_series"
  )
}
