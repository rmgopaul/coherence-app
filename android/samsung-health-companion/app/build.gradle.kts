plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
  id("org.jetbrains.kotlin.plugin.serialization")
  id("org.jetbrains.kotlin.plugin.compose")
}

android {
  namespace = "com.coherence.healthconnect"
  compileSdk = 36

  defaultConfig {
    applicationId = "com.coherence.healthconnect"
    minSdk = 29
    targetSdk = 36
    versionCode = 7
    versionName = "0.5.1"

    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

    // Secrets — read from `local.properties` (gitignored) or the
    // project's Gradle properties. Falls back to a "REPLACE_ME"
    // sentinel that `SyncConfig.isConfigured()` detects, so a fresh
    // checkout builds but refuses to call the webhook until the
    // developer populates the property.
    val samsungSyncKey = project.findProperty("SAMSUNG_HEALTH_SYNC_KEY") as String?
      ?: "REPLACE_ME_SYNC_KEY"
    val samsungWebhookUrl = project.findProperty("SAMSUNG_HEALTH_WEBHOOK_URL") as String?
      ?: "https://app.coherence-rmg.com/api/webhooks/samsung-health"
    val baseUrl = project.findProperty("COHERENCE_BASE_URL") as String?
      ?: "https://app.coherence-rmg.com"

    buildConfigField("String", "WEBHOOK_URL", "\"$samsungWebhookUrl\"")
    buildConfigField("String", "SYNC_KEY", "\"$samsungSyncKey\"")
    buildConfigField("String", "BASE_URL", "\"$baseUrl\"")
    buildConfigField("String", "GOOGLE_CLIENT_ID", "\"${project.findProperty("GOOGLE_CLIENT_ID") ?: ""}\"")
    buildConfigField("String", "OAUTH_REDIRECT_SCHEME", "\"coherence\"")
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
  implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")

  // Compose
  val composeBom = platform("androidx.compose:compose-bom:2025.01.01")
  implementation(composeBom)
  implementation("androidx.compose.ui:ui")
  implementation("androidx.compose.ui:ui-graphics")
  implementation("androidx.compose.ui:ui-tooling-preview")
  implementation("androidx.compose.material3:material3")
  implementation("androidx.compose.material:material-icons-extended")
  debugImplementation("androidx.compose.ui:ui-tooling")

  // Navigation
  implementation("androidx.navigation:navigation-compose:2.8.6")

  // DataStore
  implementation("androidx.datastore:datastore-preferences:1.1.1")

  // Auth (CustomTabs)
  implementation("androidx.browser:browser:1.8.0")
  implementation("androidx.security:security-crypto:1.1.0-alpha06")

  // Material (legacy, for existing views during transition)
  implementation("com.google.android.material:material:1.12.0")

  // WorkManager
  implementation("androidx.work:work-runtime-ktx:2.10.0")

  // Health Connect
  implementation("androidx.health.connect:connect-client:1.1.0")

  // Coroutines
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.1")

  // Serialization
  implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.8.0")

  // Glance (home-screen App Widget)
  implementation("androidx.glance:glance-appwidget:1.1.0")
  implementation("androidx.glance:glance-material3:1.1.0")

  // Image loading (team logos in sports widget)
  implementation("io.coil-kt:coil-compose:2.7.0")

  // Networking
  implementation("com.squareup.okhttp3:okhttp:4.12.0")
  implementation("com.squareup.okhttp3:logging-interceptor:4.12.0")

  // JVM unit tests (running on the host JVM, no Android runtime).
  // The mapper is stateless so no mocking is required — tests build
  // record fixtures directly via their public HC 1.1.0 constructors,
  // pulled in transitively via the `implementation` coord above.
  testImplementation("junit:junit:4.13.2")
  testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.1")
}
