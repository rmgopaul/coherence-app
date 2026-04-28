package com.coherence.healthconnect.ui.widgets

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.TrendingUp
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import com.coherence.healthconnect.data.model.ApprovalRatingSource
import com.coherence.healthconnect.data.model.MarketDashboardResponse
import com.coherence.healthconnect.data.model.MarketHeadline
import com.coherence.healthconnect.data.model.MarketQuote
import java.util.Locale

private val CRYPTO_SYMBOLS = setOf("BTC-USD", "ETH-USD")

// Cap headline rendering. The market provider returns up to ~50; we
// were showing 4. The user wants more, but the dashboard widget would
// look unreadable past ~15 entries on a phone screen. Capping at 15
// strikes the balance — every notable headline visible without
// requiring an in-card scroll.
private const val MAX_HEADLINES = 15

@Composable
fun MarketHeadlinesWidget(
  marketData: MarketDashboardResponse?,
  isLoading: Boolean,
  error: String? = null,
  lastUpdatedMillis: Long? = null,
  onRetry: (() -> Unit)? = null,
  // Distinct from `onRetry` which only fires when there is no data
  // yet. `onRefresh` powers the in-section refresh button so the user
  // can pull fresh headlines on demand without a full pull-to-refresh
  // of the dashboard. Wires to viewModel.retryMarket() at the call
  // site.
  onRefresh: (() -> Unit)? = null,
) {
  val quotes = marketData?.quotes.orEmpty()
  val stocks = quotes.filter { !CRYPTO_SYMBOLS.contains(it.symbol) }
  val crypto = quotes.filter { CRYPTO_SYMBOLS.contains(it.symbol) }
  val approvals = marketData?.approvalRatings.orEmpty()
  val headlines = marketData?.headlines.orEmpty()

  WidgetShell(
    title = "Headlines & Markets",
    icon = Icons.Default.TrendingUp,
    category = WidgetCategory.PRODUCTIVITY,
    isLoading = isLoading && marketData == null,
    error = if (marketData == null) error else null,
    onRetry = if (marketData == null) onRetry else null,
    lastUpdated = lastUpdatedMillis,
  ) {
    if (isLoading && marketData == null) {
      Text(
        text = "Loading market data...",
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
      return@WidgetShell
    }

    if (stocks.isEmpty() && crypto.isEmpty() && approvals.isEmpty() && headlines.isEmpty()) {
      Text(
        text = "No market data available.",
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
      return@WidgetShell
    }

    Column(
      modifier = Modifier.fillMaxWidth(),
      verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      // Crypto + stocks combined into a single 2-column grid. Used to
      // be split sections each in a single column (lots of unused
      // horizontal space on a phone). Combining gives every ticker a
      // visible row without scrolling and uses both columns.
      val allQuotes = crypto + stocks
      if (allQuotes.isNotEmpty()) {
        SectionTitle("Markets")
        QuoteGrid(allQuotes)
      }

      if (approvals.isNotEmpty()) {
        SectionTitle("Trump Approval Averages")
        approvals.forEach { source -> ApprovalRow(source) }
      }

      if (headlines.isNotEmpty()) {
        SectionHeaderWithRefresh(
          title = "Headlines",
          onRefresh = onRefresh,
        )
        headlines.take(MAX_HEADLINES).forEach { headline -> HeadlineRow(headline) }
      }

      if (marketData?.marketRateLimited == true) {
        Text(
          text = "Market providers are currently rate-limited. Displaying best available values.",
          style = MaterialTheme.typography.labelSmall,
          color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
      }
    }
  }
}

@Composable
private fun SectionTitle(title: String) {
  Text(
    text = title,
    style = MaterialTheme.typography.labelLarge,
    fontWeight = FontWeight.SemiBold,
    color = MaterialTheme.colorScheme.onSurfaceVariant,
  )
}

/**
 * Section header that pairs a title with a small refresh icon button
 * on the right edge. Used by the Headlines section so the user can
 * pull new news on demand rather than waiting for the next periodic
 * worker tick.
 */
@Composable
private fun SectionHeaderWithRefresh(
  title: String,
  onRefresh: (() -> Unit)?,
) {
  Row(
    modifier = Modifier.fillMaxWidth(),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.SpaceBetween,
  ) {
    Text(
      text = title,
      style = MaterialTheme.typography.labelLarge,
      fontWeight = FontWeight.SemiBold,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    if (onRefresh != null) {
      IconButton(
        onClick = onRefresh,
        modifier = Modifier.size(24.dp),
      ) {
        Icon(
          imageVector = Icons.Default.Refresh,
          contentDescription = "Refresh headlines",
          tint = MaterialTheme.colorScheme.onSurfaceVariant,
        )
      }
    }
  }
}

/**
 * Two-column quote grid. The web markets card already renders all
 * tickers; the Android widget previously capped stocks at 5 and
 * crypto at 2 in two single-column sections, leaving the right half
 * of the card empty.
 */
@Composable
private fun QuoteGrid(quotes: List<MarketQuote>) {
  Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
    quotes.chunked(2).forEach { pair ->
      Row(modifier = Modifier.fillMaxWidth()) {
        QuoteCell(pair[0], modifier = Modifier.weight(1f))
        Spacer(Modifier.width(12.dp))
        if (pair.size == 2) {
          QuoteCell(pair[1], modifier = Modifier.weight(1f))
        } else {
          // Empty placeholder cell to keep the leading cell aligned
          // to the left half rather than stretching to full width.
          Spacer(Modifier.weight(1f))
        }
      }
    }
  }
}

@Composable
private fun QuoteCell(quote: MarketQuote, modifier: Modifier = Modifier) {
  val isPositive = quote.change >= 0
  val color = if (isPositive) Color(0xFF1B5E20) else MaterialTheme.colorScheme.error
  val symbolLabel = quote.symbol.replace("-USD", "")
  Column(modifier = modifier) {
    Text(
      text = symbolLabel,
      style = MaterialTheme.typography.labelSmall,
      fontWeight = FontWeight.SemiBold,
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
    )
    Text(
      text = formatPrice(quote.price),
      style = MaterialTheme.typography.bodySmall,
      maxLines = 1,
    )
    Text(
      text = formatPercent(quote.changePercent),
      style = MaterialTheme.typography.labelSmall,
      color = color,
      fontWeight = FontWeight.SemiBold,
    )
  }
}

@Composable
private fun ApprovalRow(source: ApprovalRatingSource) {
  val approve = source.approve
  val disapprove = source.disapprove
  val net = source.net
  val netColor = if ((net ?: 0.0) >= 0) Color(0xFF1B5E20) else MaterialTheme.colorScheme.error

  Column(modifier = Modifier.fillMaxWidth()) {
    Text(
      text = source.source,
      style = MaterialTheme.typography.bodySmall,
      fontWeight = FontWeight.SemiBold,
    )
    if (approve != null && disapprove != null) {
      Text(
        text = "Approve ${formatPercent(approve)} | Disapprove ${formatPercent(disapprove)}",
        style = MaterialTheme.typography.bodySmall,
      )
      if (net != null) {
        Text(
          text = "Net ${if (net >= 0) "+" else ""}${String.format(Locale.US, "%.1f", net)}",
          style = MaterialTheme.typography.bodySmall,
          color = netColor,
        )
      }
    } else {
      Text(
        text = source.error ?: "Data unavailable",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    }
  }
}

/**
 * Headlines now open the article in the system browser when tapped.
 * `MarketHeadline.link` already exists in the data model and the web
 * card has used it as an `<a>` href all along — Android just never
 * wired the click. Underlined text + clickable Modifier matches the
 * web's visual affordance.
 */
@Composable
private fun HeadlineRow(headline: MarketHeadline) {
  val context = LocalContext.current
  val source = headline.source.ifBlank { "Source unavailable" }
  val link = headline.link.takeIf { it.isNotBlank() }
  Text(
    text = "- ${headline.title.ifBlank { "Untitled headline" }} ($source)",
    style = MaterialTheme.typography.bodySmall,
    color = if (link != null) MaterialTheme.colorScheme.primary
    else MaterialTheme.colorScheme.onSurface,
    textDecoration = if (link != null) TextDecoration.Underline else null,
    maxLines = 2,
    overflow = TextOverflow.Ellipsis,
    modifier = if (link != null) {
      Modifier.fillMaxWidth().clickable {
        try {
          context.startActivity(Intent(Intent.ACTION_VIEW, link.toUri()))
        } catch (_: Throwable) {
          // No browser, malformed URI, etc. — drop silently rather
          // than crashing the dashboard.
        }
      }
    } else {
      Modifier.fillMaxWidth()
    },
  )
}

private fun formatPrice(value: Double): String {
  return if (kotlin.math.abs(value) >= 1000) {
    String.format(Locale.US, "$%,.2f", value)
  } else {
    String.format(Locale.US, "$%.2f", value)
  }
}

private fun formatPercent(value: Double): String {
  return "${if (value >= 0) "+" else ""}${String.format(Locale.US, "%.2f", value)}%"
}
