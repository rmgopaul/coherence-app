import java.util.Properties

plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
  id("org.jetbrains.kotlin.plugin.serialization")
  id("org.jetbrains.kotlin.plugin.compose")
}

// Load local.properties so command-line `./gradlew` builds get the
// same secrets Android Studio injects automatically. `project.findProperty()`
// alone only reads gradle.properties — not local.properties. Mirrors
// the healthconnect-companion module so a single local.properties
// (same SAMSUNG_HEALTH_* keys) works for both.
val localProperties = Properties().apply {
  val f = rootProject.file("local.properties")
  if (f.exists()) f.inputStream().use { load(it) }
}
fun prop(key: String): String? =
  localProperties.getProperty(key) ?: project.findProperty(key) as String?

android {
  namespace = "com.coherence.samsunghealth"
  compileSdk = 36

  defaultConfig {
    applicationId = "com.coherence.samsunghealth"
    minSdk = 29
    targetSdk = 36
    versionCode = 1
    versionName = "0.1.0"

    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

    // Secrets — read from `local.properties` (gitignored) or the
    // project's Gradle properties. Falls back to a "REPLACE_ME"
    // sentinel that `SyncConfig.isConfigured()` detects, so a fresh
    // checkout builds but refuses to call the webhook until the
    // developer populates the property. Identical key names to the
    // healthconnect-companion module.
    val samsungSyncKey = prop("SAMSUNG_HEALTH_SYNC_KEY") ?: "REPLACE_ME_SYNC_KEY"
    val samsungWebhookUrl = prop("SAMSUNG_HEALTH_WEBHOOK_URL")
      ?: "https://app.coherence-rmg.com/api/webhooks/samsung-health"

    buildConfigField("String", "WEBHOOK_URL", "\"$samsungWebhookUrl\"")
    buildConfigField("String", "SYNC_KEY", "\"$samsungSyncKey\"")

    // Build-time secret visibility. Print one redacted line per
    // secret at configuration time so a missing SYNC_KEY surfaces
    // BEFORE the APK ships to the device (the webhook 401s silently
    // otherwise). Shows presence + length, never the value itself.
    val secretStatus = listOf(
      "SYNC_KEY" to samsungSyncKey.takeIf { it != "REPLACE_ME_SYNC_KEY" }.orEmpty(),
      "WEBHOOK_URL" to samsungWebhookUrl,
    )
    secretStatus.forEach { (key, value) ->
      val mark = if (value.isNotBlank()) "✓" else "✗ MISSING"
      val hint = if (value.isNotBlank()) "(${value.length} chars)" else "— add to local.properties"
      println("[coherence:buildconfig] $key $mark $hint")
    }
  }

  buildTypes {
    release {
      isMinifyEnabled = true
      isShrinkResources = true
      proguardFiles(
        getDefaultProguardFile("proguard-android-optimize.txt"),
        "proguard-rules.pro"
      )
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  kotlinOptions {
    jvmTarget = "17"
  }

  // Return stubbed default values from android.* framework classes
  // (notably `android.util.Log`) in JVM unit tests so pure-function
  // tests that touch a Log.* path don't crash.
  testOptions {
    unitTests.isReturnDefaultValues = true
  }

  buildFeatures {
    buildConfig = true
    compose = true
  }
}

dependencies {
  // Core Android
  implementation("androidx.core:core-ktx:1.15.0")
  implementation("androidx.appcompat:appcompat:1.7.0")
  implementation("androidx.activity:activity-compose:1.10.1")
  implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
  implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")

  // Compose — single minimal status screen only
  val composeBom = platform("androidx.compose:compose-bom:2025.01.01")
  implementation(composeBom)
  implementation("androidx.compose.ui:ui")
  implementation("androidx.compose.ui:ui-graphics")
  implementation("androidx.compose.ui:ui-tooling-preview")
  implementation("androidx.compose.material3:material3")
  debugImplementation("androidx.compose.ui:ui-tooling")

  // WorkManager — periodic background sync of the two scores
  implementation("androidx.work:work-runtime-ktx:2.10.0")

  // Samsung Health Data SDK (local .aar in app/libs/, resolved via
  // the flatDir repo declared in settings.gradle.kts).
  implementation("com.samsung.android.sdk.health.data:samsung-health-data-api-1.1.0@aar")

  // Coroutines
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.1")

  // Serialization (SamsungHealthPayload JSON — same shape as the
  // healthconnect-companion model so the existing webhook parses it).
  implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.8.0")

  // Networking
  implementation("com.squareup.okhttp3:okhttp:4.12.0")
  implementation("com.squareup.okhttp3:logging-interceptor:4.12.0")

  // JVM unit tests
  testImplementation("junit:junit:4.13.2")
  testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.1")
}
