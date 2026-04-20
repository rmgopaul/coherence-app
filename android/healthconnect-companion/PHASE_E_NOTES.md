# Phase E — Android theme overhaul notes

First drop of the Basquiat-themed hero. Shipped **alongside** the
existing gradient `DashboardHero`, not replacing it — the call site in
`DashboardScreen.kt` still renders the legacy hero so nothing changes
in the running app until you opt in.

## What's new

| File | Status |
|---|---|
| `ui/theme/BasquiatPalette.kt` | ✅ shipped — Paper/Ink color tokens |
| `ui/theme/BasquiatTypography.kt` | ✅ shipped — 9 text styles (Hero, Subhead, Section, StatBig, StatHuge, Headline, Body, Label, Kicker) |
| `ui/widgets/BasquiatDashboardHero.kt` | ✅ shipped — full broadsheet hero with inline Crown canvas |
| `ui/theme/CoherenceTheme.kt` | unchanged — dynamic color still on |
| `ui/widgets/DashboardHero.kt` | unchanged — still gradient, still the one in DashboardScreen |

## To flip to the new hero

In `ui/screens/DashboardScreen.kt`, swap the single hero line:

```diff
-import com.coherence.healthconnect.ui.widgets.DashboardHero
+import com.coherence.healthconnect.ui.widgets.BasquiatDashboardHero
...
-      DashboardHero(stats = heroStats)
+      BasquiatDashboardHero(stats = heroStats)
```

The hero accepts the same `HeroStats` signature, so no data wiring
changes. No theme-wide refactor; the new composable reads its colors
from the `BasquiatColors.forMode(darkTheme)` helper directly.

## Fonts — still todo

The typography file declares placeholders (`FontFamily.Default`,
`FontFamily.Serif`, etc.) because the TTF files aren't bundled yet.
Drop these files into `app/src/main/res/font/`:

```
archivo_black.ttf
instrument_serif_regular.ttf
instrument_serif_italic.ttf
jetbrains_mono_regular.ttf
jetbrains_mono_bold.ttf
caveat_regular.ttf
caveat_bold.ttf
inter_regular.ttf
inter_medium.ttf
inter_semibold.ttf
inter_bold.ttf
```

All are SIL OFL — Google Fonts direct-download or `pnpm` the
`@fontsource/*` packages and copy the TTFs into place.

Then update `BasquiatTypography.kt`:

```diff
-val ArchivoBlack: FontFamily = FontFamily.Default
+val ArchivoBlack: FontFamily = FontFamily(
+  Font(R.font.archivo_black, FontWeight.Black)
+)
```

Until the fonts land, the layout still renders — just with the system
sans face instead of the display families. The crown, colors, stat
row, and highlighter already look correct.

## Deferred to Phase E.2

These items from `handoff/android-spec.md` are NOT in this commit:

- **Glance home-screen widget** redesign (`ui/widget/CoherenceDashboardWidget.kt`)
- **Launcher icon** refresh (yellow crown on ink, `res/mipmap-*`)
- **Dynamic color disable** on `CoherenceTheme` (breaks every non-hero
  screen visually without a full screen-by-screen audit — tackle after
  the hero ships)
- **Focus mode** rail in Glance
- **Screenshot tests** for the new hero

Order them by review appetite. The hero swap is the single highest-
impact move; the rest are nice-to-haves that can land one at a time.

## Verification

The new files typecheck on their own (Kotlin + Compose imports) but
the Android build hasn't been run in this session. Before merging:

```bash
cd android/healthconnect-companion
./gradlew assembleDebug
```

If the Compose preview in Android Studio renders
`BasquiatDashboardHeroPreview` cleanly, the hero is shippable.
