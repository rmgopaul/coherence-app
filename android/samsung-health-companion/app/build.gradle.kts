plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
  id("org.jetbrains.kotlin.plugin.serialization")
}

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

    buildConfigField("String", "WEBHOOK_URL", "\"https://app.coherence-rmg.com/api/webhooks/samsung-health\"")
    buildConfigField("String", "SYNC_KEY", "\"V5PYAoAFr6qjTSQ_hUtv5ZexAsh2PzX_OkdmZVCIyHM\"")
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
  }
}

dependencies {
  implementation("androidx.core:core-ktx:1.15.0")
  implementation("androidx.appcompat:appcompat:1.7.0")
  implementation("androidx.activity:activity-ktx:1.10.1")
  implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
  implementation("com.google.android.material:material:1.12.0")
  implementation("androidx.work:work-runtime-ktx:2.10.0")
  implementation("androidx.health.connect:connect-client:1.1.0")

  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.1")
  implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.8.0")

  implementation("com.squareup.okhttp3:okhttp:4.12.0")
  implementation("com.squareup.okhttp3:logging-interceptor:4.12.0")

  // Samsung Health Data SDK dependency will be added once your partner access package is approved.
  // Example placeholder only:
  // implementation("com.samsung.android.sdk.healthdata:health-data:VERSION")
}
