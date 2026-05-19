pluginManagement {
  repositories {
    google()
    mavenCentral()
    gradlePluginPortal()
  }
}

dependencyResolutionManagement {
  repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
  repositories {
    google()
    mavenCentral()
    // The Samsung Health Data SDK ships as a local .aar (app/libs/),
    // not a Maven artifact. `flatDir` lets the `:app` module resolve
    // it via the `libs(...)` coordinate in app/build.gradle.kts while
    // still keeping FAIL_ON_PROJECT_REPOS for everything else.
    flatDir { dirs("app/libs") }
  }
}

rootProject.name = "samsung-health-companion"
include(":app")
