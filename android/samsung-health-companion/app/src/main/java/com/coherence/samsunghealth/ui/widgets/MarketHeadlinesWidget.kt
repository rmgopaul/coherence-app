package com.coherence.samsunghealth.ui.widgets

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.TrendingUp
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.coherence.samsunghealth.data.model.ApprovalRatingSource
import com.coherence.samsunghealth.data.model.MarketDashboardResponse
import com.coherence.samsunghealth.data.model.MarketHeadline
import com.coherence.samsunghealth.data.model.MarketQuote
import java.util.Locale

private val CRYPTO_SYMBOLS = setOf("BTC-USD", "ETH-USD")

@Composable
fun MarketHeadlinesWidget(
  marketData: MarketDashboardResponse?,
  isLoading: Boolean,
  error: String? = null,
  lastUpdatedMillis: Long? = null,
  onRetry: (() -> Unit)? = null,
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
      if (crypto.isNotEmpty()) {
        SectionTitle("Crypto")
        crypto.take(2).forEach { quote -> QuoteRow(quote) }
      }

      if (stocks.isNotEmpty()) {
        SectionTitle("Stocks")
        stocks.take(5).forEach { quote -> QuoteRow(quote) }
      }

      if (approvals.isNotEmpty()) {
        SectionTitle("Trump Approval Averages")
        approvals.take(2).forEach { source -> ApprovalRow(source) }
      }

      if (headlines.isNotEmpty()) {
        SectionTitle("Headlines")
        headlines.take(4).forEach { headline -> HeadlineRow(headline) }
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

@Composable
private fun QuoteRow(quote: MarketQuote) {
  val isPositive = quote.change >= 0
  val color = if (isPositive) Color(0xFF1B5E20) else MaterialTheme.colorScheme.error
  Row(
    modifier = Modifier.fillMaxWidth(),
    horizontalArrangement = Arrangement.SpaceBetween,
  ) {
    val symbolLabel = quote.symbol.replace("-USD", "")
    Text(
      text = "$symbolLabel  ${quote.shortName.ifBlank { symbolLabel }}",
      style = MaterialTheme.typography.bodySmall,
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
      modifier = Modifier.weight(1f),
    )
    Text(
      text = "${formatPrice(quote.price)} (${formatPercent(quote.changePercent)})",
      style = MaterialTheme.typography.bodySmall,
      color = color,
      fontWeight = FontWeight.SemiBold,
      modifier = Modifier.padding(start = 10.dp),
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

@Composable
private fun HeadlineRow(headline: MarketHeadline) {
  val source = headline.source.ifBlank { "Source unavailable" }
  Text(
    text = "- ${headline.title.ifBlank { "Untitled headline" }} ($source)",
    style = MaterialTheme.typography.bodySmall,
    maxLines = 2,
    overflow = TextOverflow.Ellipsis,
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
