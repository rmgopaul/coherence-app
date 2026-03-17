plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
  id("org.jetbrains.kotlin.plugin.serialization")
  id("org.jetbrains.kotlin.plugin.compose")
  id("com.google.devtools.ksp") version "2.1.10-1.0.31"
}

android {
  namespace = "com.coherence.samsunghealth"
  compileSdk = 36

  defaultConfig {
    applicationId = "com.coherence.samsunghealth"
    minSdk = 29
    targetSdk = 36
    versionCode = 2
    versionName = "0.2.0"

    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

    buildConfigField("String", "WEBHOOK_URL", "\"https://app.coherence-rmg.com/api/webhooks/samsung-health\"")
    buildConfigField("String", "SYNC_KEY", "\"V5PYAoAFr6qjTSQ_hUtv5ZexAsh2PzX_OkdmZVCIyHM\"")
    buildConfigField("String", "BASE_URL", "\"https://app.coherence-rmg.com\"")
  }

  buildTypes {
    release {
      isMinifyEnabled = false
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

  // Room
  implementation("androidx.room:room-runtime:2.7.0")
  implementation("androidx.room:room-ktx:2.7.0")
  ksp("androidx.room:room-compiler:2.7.0")

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

  // Networking
  implementation("com.squareup.okhttp3:okhttp:4.12.0")
  implementation("com.squareup.okhttp3:logging-interceptor:4.12.0")
}
