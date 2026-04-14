package com.coherence.samsunghealth.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.coherence.samsunghealth.data.model.DailyHealthMetric
import com.coherence.samsunghealth.data.model.TrendSeriesResponse
import com.coherence.samsunghealth.ui.LocalApp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DailyLogScreen(onBack: () -> Unit) {
  val app = LocalApp.current
  val repo = app.container.metricsRepository

  val metrics = remember { mutableStateListOf<DailyHealthMetric>() }
  var isLoading by remember { mutableStateOf(true) }
  var loadError by remember { mutableStateOf<String?>(null) }
  var trendSeries by remember { mutableStateOf<TrendSeriesResponse?>(null) }

  LaunchedEffect(Unit) {
    try {
      metrics.clear()
      metrics.addAll(repo.getHistory(30))
      trendSeries = repo.getTrendSeries(30)
      loadError = null
    } catch (error: Exception) {
      loadError = error.message ?: "Could not load Daily Log data."
    }
    isLoading = false
  }

  Scaffold(
    topBar = {
      TopAppBar(
        title = { Text("Daily Log") },
        navigationIcon = {
          IconButton(onClick = onBack) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
          }
        },
      )
    },
  ) { padding ->
    LazyColumn(
      modifier = Modifier.padding(padding),
      contentPadding = PaddingValues(16.dp),
      verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
      if (isLoading) {
        item { Text("Loading metrics...") }
      } else if (loadError != null) {
        item {
          Text(
            text = loadError ?: "Could not load Daily Log data.",
            color = MaterialTheme.colorScheme.error,
          )
        }
      } else {
        if (trendSeries != null) {
          item {
            TrendSummaryCard(trendSeries = trendSeries!!)
          }
        }
        if (metrics.isEmpty()) {
          item { Text("No daily log data yet. Metrics are captured from your WHOOP, Samsung Health, and Todoist data.", color = MaterialTheme.colorScheme.onSurfaceVariant) }
        } else {
          items(metrics) { metric ->
            MetricDayCard(metric)
          }
        }
      }
    }
  }
}

@Composable
private fun TrendSummaryCard(trendSeries: TrendSeriesResponse) {
  val recoveryVsSleep = trendSeries.correlations.recoveryVsSleep
  val recoveryVsTasks = trendSeries.correlations.recoveryVsTasksCompleted
  val recoveryAvg = trendSeries.series.recovery.mapNotNull { it.value }.averageOrNull()
  val sleepAvg = trendSeries.series.sleepHours.mapNotNull { it.value }.averageOrNull()

  Card(
    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
  ) {
    Column(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
      Text("30-Day Trends", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
      Spacer(Modifier.height(8.dp))
      Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
        MetricValue("Recovery Avg", recoveryAvg?.let { "${it.toInt()}%" } ?: "—")
        MetricValue("Sleep Avg", sleepAvg?.let { "%.1fh".format(it) } ?: "—")
      }
      Spacer(Modifier.height(10.dp))
      Text(
        text = "Recovery vs sleep correlation: ${formatCorrelation(recoveryVsSleep)}",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
      Text(
        text = "Recovery vs tasks correlation: ${formatCorrelation(recoveryVsTasks)}",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    }
  }
}

private fun formatCorrelation(value: Double?): String {
  return when {
    value == null -> "not enough data"
    value >= 0.6 -> "strong positive (${String.format("%.2f", value)})"
    value >= 0.25 -> "moderate positive (${String.format("%.2f", value)})"
    value > -0.25 -> "weak / no clear signal (${String.format("%.2f", value)})"
    value > -0.6 -> "moderate negative (${String.format("%.2f", value)})"
    else -> "strong negative (${String.format("%.2f", value)})"
  }
}

private fun List<Double>.averageOrNull(): Double? {
  if (isEmpty()) return null
  return average()
}

@Composable
private fun MetricDayCard(metric: DailyHealthMetric) {
  Card(
    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
  ) {
    Column(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
      Text(metric.dateKey, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
      Spacer(Modifier.height(8.dp))

      Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceEvenly,
      ) {
        metric.whoopRecoveryScore?.let { MetricValue("Recovery", "${it.toInt()}%") }
        metric.whoopDayStrain?.let { MetricValue("Strain", "%.1f".format(it)) }
        metric.whoopSleepHours?.let { MetricValue("Sleep", "%.1fh".format(it)) }
        metric.whoopHrvMs?.let { MetricValue("HRV", "${it.toInt()}ms") }
      }

      val hasSecondRow = metric.samsungSteps != null || metric.samsungSleepHours != null || metric.todoistCompletedCount != null
      if (hasSecondRow) {
        Spacer(Modifier.height(8.dp))
        Row(
          modifier = Modifier.fillMaxWidth(),
          horizontalArrangement = Arrangement.SpaceEvenly,
        ) {
          metric.samsungSteps?.let { MetricValue("Steps", "%,d".format(it)) }
          metric.samsungSleepHours?.let { MetricValue("SH Sleep", "%.1fh".format(it)) }
          metric.samsungEnergyScore?.let { MetricValue("Energy", "${it.toInt()}") }
          metric.todoistCompletedCount?.let { MetricValue("Tasks", "$it") }
        }
      }
    }
  }
}

@Composable
private fun MetricValue(label: String, value: String) {
  Column(horizontalAlignment = Alignment.CenterHorizontally) {
    Text(value, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Bold)
    Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
  }
}
