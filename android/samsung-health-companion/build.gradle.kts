plugins {
  id("com.android.application") version "8.9.1" apply false
  id("org.jetbrains.kotlin.android") version "2.1.10" apply false
  id("org.jetbrains.kotlin.plugin.serialization") version "2.1.10" apply false
  id("org.jetbrains.kotlin.plugin.compose") version "2.1.10" apply false
  // 2026-05-19 — REQUIRED by the Samsung Health Data SDK. Its
  // ReadDataRequest builders (DualTimeBuilder / LocalDateBuilder)
  // are @Parcelize classes that reference kotlinx.parcelize.Parceler
  // at runtime. Without this plugin the app compiles fine (the .aar
  // bytecode resolves at build time) but ReadDataRequest.build()
  // throws NoClassDefFoundError: kotlinx/parcelize/Parceler on the
  // first real read — caught on the Galaxy Z Fold7 smoke test where
  // every score silently fell back to 0.0. See SamsungHealthReader
  // .readSleepScore / .readEnergyScore.
  id("org.jetbrains.kotlin.plugin.parcelize") version "2.1.10" apply false
}
