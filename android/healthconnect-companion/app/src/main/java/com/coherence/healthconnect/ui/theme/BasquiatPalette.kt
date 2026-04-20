package com.coherence.healthconnect.ui.theme

import androidx.compose.ui.graphics.Color

/**
 * Paper/Ink palette — Phase E.
 *
 * Mirrors productivity-hub/handoff/design-tokens.md §Color. Use these
 * names (never "light"/"dark") so the Android app visually matches
 * the web front page.
 *
 * - Paper is the default (warm newsprint background + ink text).
 * - Ink is the dark mode (near-black paper + cream text).
 *
 * This file intentionally sits alongside the existing CoherenceTheme
 * color scheme without replacing it — the new BasquiatDashboardHero
 * consumes these constants directly, so swapping a hero over is a
 * one-line change at the call site rather than a repo-wide theme
 * refactor.
 */
object BasquiatPalette {
  // ── Paper (default) ──────────────────────────────────────────────
  val Paper = Color(0xFFF6F2E7)         // warm newsprint
  val Paper2 = Color(0xFFECEAD9)        // card surface
  val Paper3 = Color(0xFFE8E4D4)        // viewport edge
  val Ink = Color(0xFF0B0B0B)           // text, rules, frames
  val Ink2 = Color(0xFF3A3A3A)          // secondary text
  val Ink3 = Color(0xFF666666)          // tertiary / mono labels
  val Rule = Color(0xFF0B0B0B)

  // ── Accents — same values in both modes, color is semantic. ──────
  val Yellow = Color(0xFFF6C83A)        // Basquiat crown + highlighter
  val HighlightYellow = Color(0xFFFAE185) // headline highlighter fill
  val Red = Color(0xFFE23B2B)           // alert + strikethrough
  val Blue = Color(0xFF1D4ED8)          // link / calendar
  val Green = Color(0xFF2F7D32)         // up / positive / done

  // ── Ink mode (dark) — same semantic slots, different tones. ──────
  val InkModePaper = Color(0xFF0E0D0A)
  val InkModePaper2 = Color(0xFF1A1914)
  val InkModePaper3 = Color(0xFF070605)
  val InkModeInk = Color(0xFFF2EEDF)
  val InkModeInk2 = Color(0xFFC9C5B4)
  val InkModeInk3 = Color(0xFF8F8B78)
  val InkModeRule = Color(0xFFF2EEDF)

  val InkModeYellow = Color(0xFFFFD84A)
  val InkModeHighlightYellow = Color(0xFFE0C64A)
  val InkModeRed = Color(0xFFFF5A47)
  val InkModeBlue = Color(0xFF6A8AFF)
  val InkModeGreen = Color(0xFF66C266)
}

/**
 * Active palette for a given dark-mode state. Callers pick this and
 * hand it to composables; no CompositionLocal plumbing — keeps the
 * Phase E surface area tight until the full theme swap lands.
 */
data class BasquiatColors(
  val paper: Color,
  val paper2: Color,
  val paper3: Color,
  val ink: Color,
  val ink2: Color,
  val ink3: Color,
  val rule: Color,
  val yellow: Color,
  val highlightYellow: Color,
  val red: Color,
  val blue: Color,
  val green: Color,
) {
  companion object {
    fun forMode(darkTheme: Boolean): BasquiatColors = if (darkTheme) {
      BasquiatColors(
        paper = BasquiatPalette.InkModePaper,
        paper2 = BasquiatPalette.InkModePaper2,
        paper3 = BasquiatPalette.InkModePaper3,
        ink = BasquiatPalette.InkModeInk,
        ink2 = BasquiatPalette.InkModeInk2,
        ink3 = BasquiatPalette.InkModeInk3,
        rule = BasquiatPalette.InkModeRule,
        yellow = BasquiatPalette.InkModeYellow,
        highlightYellow = BasquiatPalette.InkModeHighlightYellow,
        red = BasquiatPalette.InkModeRed,
        blue = BasquiatPalette.InkModeBlue,
        green = BasquiatPalette.InkModeGreen,
      )
    } else {
      BasquiatColors(
        paper = BasquiatPalette.Paper,
        paper2 = BasquiatPalette.Paper2,
        paper3 = BasquiatPalette.Paper3,
        ink = BasquiatPalette.Ink,
        ink2 = BasquiatPalette.Ink2,
        ink3 = BasquiatPalette.Ink3,
        rule = BasquiatPalette.Rule,
        yellow = BasquiatPalette.Yellow,
        highlightYellow = BasquiatPalette.HighlightYellow,
        red = BasquiatPalette.Red,
        blue = BasquiatPalette.Blue,
        green = BasquiatPalette.Green,
      )
    }
  }
}
