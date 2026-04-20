package com.coherence.samsunghealth.ui.theme

import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.coherence.samsunghealth.R

/**
 * Typography for the Basquiat hero overhaul — Phase E.
 *
 * Mirrors productivity-hub/handoff/design-tokens.md §Typography.
 * Four display families, each with a specific job:
 *   Archivo Black     — big display numbers and headlines
 *   Instrument Serif  — italic emphasis inside headlines, bylines
 *   JetBrains Mono    — labels, tickers, timestamps
 *   Caveat            — scribble annotations ("the one thing")
 *   Inter             — body copy
 *
 * FONT FILES ARE NOT BUNDLED IN THIS COMMIT. Drop TTF/WOFF2 files
 * into `app/src/main/res/font/` named:
 *
 *   archivo_black.ttf
 *   instrument_serif_regular.ttf, instrument_serif_italic.ttf
 *   jetbrains_mono_regular.ttf, jetbrains_mono_bold.ttf
 *   caveat_regular.ttf, caveat_bold.ttf
 *   inter_regular.ttf … inter_bold.ttf
 *
 * Then replace the `FontFamily.Default` placeholders below with
 * `FontFamily(Font(R.font.archivo_black, FontWeight.Black))` etc.
 * Without the files, Android falls back to the system sans which
 * still renders the layout — just not the intended display face.
 *
 * All fonts are SIL OFL. Download links in the spec doc.
 */
object BasquiatTypography {
  // TTFs live in app/src/main/res/font/, downloaded from the Google
  // google/fonts repo (all SIL OFL). JetBrains Mono, Caveat, and Inter
  // are bundled as variable-weight fonts — the Font(..., weight = X)
  // indirection lets Compose interpolate to the requested weight.
  val ArchivoBlack: FontFamily = FontFamily(
    Font(R.font.archivo_black, FontWeight.Black),
  )
  val InstrumentSerif: FontFamily = FontFamily(
    Font(R.font.instrument_serif_regular, FontWeight.Normal),
    Font(
      R.font.instrument_serif_italic,
      FontWeight.Normal,
      FontStyle.Italic,
    ),
  )
  val JetBrainsMono: FontFamily = FontFamily(
    Font(R.font.jetbrains_mono, FontWeight.Normal),
    Font(R.font.jetbrains_mono, FontWeight.SemiBold),
    Font(R.font.jetbrains_mono, FontWeight.Bold),
  )
  val Caveat: FontFamily = FontFamily(
    Font(R.font.caveat, FontWeight.Normal),
    Font(R.font.caveat, FontWeight.SemiBold),
    Font(R.font.caveat, FontWeight.Bold),
  )
  val Inter: FontFamily = FontFamily(
    Font(R.font.inter, FontWeight.Normal),
    Font(R.font.inter, FontWeight.Medium),
    Font(R.font.inter, FontWeight.SemiBold),
    Font(R.font.inter, FontWeight.Bold),
  )

  // Type scale (sp) — mirrors CoherenceType from design-tokens.md.
  val Hero = TextStyle(
    fontFamily = ArchivoBlack,
    fontWeight = FontWeight.Black,
    fontSize = 72.sp,
    lineHeight = 68.sp,
    letterSpacing = (-0.02 * 72).sp,
  )

  val Subhead = TextStyle(
    fontFamily = InstrumentSerif,
    fontStyle = FontStyle.Italic,
    fontWeight = FontWeight.Normal,
    fontSize = 28.sp,
    lineHeight = 32.sp,
  )

  val Section = TextStyle(
    fontFamily = ArchivoBlack,
    fontWeight = FontWeight.Black,
    fontSize = 22.sp,
    lineHeight = 24.sp,
    letterSpacing = (-0.01 * 22).sp,
  )

  val StatBig = TextStyle(
    fontFamily = ArchivoBlack,
    fontWeight = FontWeight.Black,
    fontSize = 48.sp,
    lineHeight = 48.sp,
    letterSpacing = (-0.02 * 48).sp,
  )

  val StatHuge = TextStyle(
    fontFamily = ArchivoBlack,
    fontWeight = FontWeight.Black,
    fontSize = 88.sp,
    lineHeight = 86.sp,
    letterSpacing = (-0.02 * 88).sp,
  )

  val Headline = TextStyle(
    fontFamily = Inter,
    fontWeight = FontWeight.Medium,
    fontSize = 18.sp,
    lineHeight = 22.sp,
  )

  val Body = TextStyle(
    fontFamily = Inter,
    fontWeight = FontWeight.Normal,
    fontSize = 14.sp,
    lineHeight = 20.sp,
  )

  val Label = TextStyle(
    fontFamily = JetBrainsMono,
    fontWeight = FontWeight.Normal,
    fontSize = 10.sp,
    lineHeight = 12.sp,
    letterSpacing = (0.12 * 10).sp,
  )

  val Kicker = TextStyle(
    fontFamily = Caveat,
    fontStyle = FontStyle.Italic,
    fontWeight = FontWeight.Normal,
    fontSize = 13.sp,
    lineHeight = 14.sp,
  )
}
