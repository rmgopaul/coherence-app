package com.coherence.healthconnect.widget

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.action.actionStartActivity
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.width
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import com.coherence.healthconnect.MainActivity
import java.util.Locale

/**
 * Right half of the King widget pair.
 *
 * Owns: markets (all configured tickers in a 2-column grid),
 * headlines (5), and sports (4 games). Designed to sit immediately
 * to the right of [CoherenceKingLeftWidget] on the Z Fold inner
 * display. Together they form a contiguous "full screen" King
 * dashboard — see CoherenceKingLeftWidget's docstring for the
 * background on why two widgets instead of one.
 *
 * No header strip — the left widget owns "COHERENCE — KING" so the
 * pair reads as one editorial layout. The right widget starts
 * straight in with section labels.
 */
class CoherenceKingRightWidget : GlanceAppWidget() {

  override val sizeMode: SizeMode = SizeMode.Single

  override suspend fun provideGlance(context: Context, id: GlanceId) {
    val data = WidgetDataStore.load(context)
    provideContent {
      GlanceTheme {
        RightContent(data)
      }
    }
  }
}

private val Ink = ColorProvider(Color(0xFF0E0D0A))
private val TextPrimary = ColorProvider(Color(0xFFF2EEDF))
private val TextSecondary = ColorProvider(Color(0xFFC9C5B4))
private val TextTertiary = ColorProvider(Color(0xFF8F8B78))
private val AccentYellow = ColorProvider(Color(0xFFFFD84A))
private val AccentRed = ColorProvider(Color(0xFFFF5A47))
private val AccentBlue = ColorProvider(Color(0xFF6A8AFF))
private val AccentGreen = ColorProvider(Color(0xFF66C266))
private val AccentOrange = ColorProvider(Color(0xFFFFB74D))

private val SectionTitle = TextStyle(
  color = TextTertiary,
  fontSize = 12.sp,
  fontWeight = FontWeight.Bold,
)
private val Body = TextStyle(color = TextPrimary, fontSize = 14.sp)
private val Secondary = TextStyle(color = TextSecondary, fontSize = 12.sp)

@Composable
private fun RightContent(data: WidgetData) {
  Box(
    modifier = GlanceModifier
      .fillMaxSize()
      .background(Ink)
      .clickable(actionStartActivity<MainActivity>()),
  ) {
    Column(
      modifier = GlanceModifier
        .fillMaxSize()
        .padding(horizontal = 18.dp, vertical = 16.dp),
    ) {
      if (data.tickers.isNotEmpty()) {
        TickersSection(data.tickers)
        Spacer(GlanceModifier.height(12.dp))
      }
      if (data.headlines.isNotEmpty()) {
        HeadlinesSection(data.headlines)
        Spacer(GlanceModifier.height(12.dp))
      }
      if (data.sports.isNotEmpty()) {
        SportsSection(data.sports)
      }
      if (data.error != null) {
        Spacer(GlanceModifier.height(8.dp))
        Text(text = data.error, style = TextStyle(color = AccentRed, fontSize = 11.sp))
      }
    }
  }
}

@Composable
private fun TickersSection(tickers: List<WidgetTicker>) {
  Column(modifier = GlanceModifier.fillMaxWidth()) {
    Text(text = "MARKETS", style = SectionTitle)
    Spacer(GlanceModifier.height(4.dp))
    // 2-column subgrid — half-width widget can't fit 3 ticker
    // columns legibly. Pairs of {symbol, price, change%} stack
    // vertically inside each cell.
    tickers.chunked(2).forEach { row ->
      Row(modifier = GlanceModifier.fillMaxWidth().padding(vertical = 2.dp)) {
        row.forEach { ticker ->
          Column(
            modifier = GlanceModifier.defaultWeight().padding(horizontal = 4.dp),
          ) {
            Text(
              text = ticker.symbol,
              style = TextStyle(
                color = TextSecondary,
                fontSize = 11.sp,
                fontWeight = FontWeight.Medium,
              ),
            )
            Text(
              text = ticker.price,
              style = TextStyle(color = TextPrimary, fontSize = 14.sp),
            )
            Text(
              text = ticker.changePercent,
              style = TextStyle(
                color = if (ticker.isPositive) AccentGreen else AccentRed,
                fontSize = 11.sp,
                fontWeight = FontWeight.Bold,
              ),
            )
          }
        }
        if (row.size == 1) Spacer(GlanceModifier.defaultWeight())
      }
    }
  }
}

@Composable
private fun HeadlinesSection(headlines: List<WidgetHeadline>) {
  Column(modifier = GlanceModifier.fillMaxWidth()) {
    Text(text = "NEWS", style = SectionTitle)
    Spacer(GlanceModifier.height(4.dp))
    headlines.take(5).forEach { hl ->
      Column(modifier = GlanceModifier.fillMaxWidth().padding(vertical = 2.dp)) {
        Text(text = hl.title, style = Body, maxLines = 2)
        if (hl.source.isNotBlank()) {
          Text(text = hl.source, style = Secondary)
        }
      }
    }
  }
}

@Composable
private fun SportsSection(games: List<WidgetGame>) {
  Column(modifier = GlanceModifier.fillMaxWidth()) {
    Text(text = "SPORTS", style = SectionTitle)
    Spacer(GlanceModifier.height(4.dp))
    games.take(4).forEach { game ->
      Row(
        modifier = GlanceModifier.fillMaxWidth().padding(vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        val leagueColor = when (game.league) {
          "NBA" -> AccentOrange
          "NFL" -> AccentGreen
          "MLB" -> AccentRed
          else -> AccentBlue
        }
        Text(
          text = game.league,
          style = TextStyle(
            color = leagueColor,
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold,
          ),
        )
        Spacer(GlanceModifier.width(8.dp))
        Text(
          text = game.teams,
          style = Body,
          maxLines = 1,
          modifier = GlanceModifier.defaultWeight(),
        )
        Spacer(GlanceModifier.width(6.dp))
        val scoreColor = when (game.status) {
          "in", "halftime" -> AccentGreen
          "post" -> TextSecondary
          else -> AccentOrange
        }
        Text(
          text = game.score,
          style = TextStyle(
            color = scoreColor,
            fontSize = 13.sp,
            fontWeight = FontWeight.Medium,
          ),
        )
      }
    }
  }
}
