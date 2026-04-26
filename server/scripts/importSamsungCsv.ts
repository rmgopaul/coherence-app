/**
 * One-shot importer for a Samsung Health "Download personal data"
 * CSV export. Aggregates per-day metrics from the relevant CSVs and
 * POSTs them to `/api/webhooks/samsung-health/import-daily-metrics`,
 * which writes them straight into `dailyHealthMetrics`.
 *
 * Why this exists: Health Connect (the Android worker's source) only
 * retains records from the moment Samsung Health was granted write
 * access. The CSV export contains years of data — sleep_score from
 * `com.samsung.shealth.sleep`, energy score (Samsung's internal
 * "vitality_score" → `total_score`), daily steps, daily SpO2 average
 * — that we want to land in the dashboard's history view without
 * waiting on Samsung to backfill Health Connect.
 *
 * Usage:
 *   SAMSUNG_HEALTH_SYNC_KEY=<key> tsx server/scripts/importSamsungCsv.ts <export-dir>
 *
 * Optional env:
 *   SAMSUNG_HEALTH_WEBHOOK_URL — defaults to
 *     https://app.coherence-rmg.com/api/webhooks/samsung-health/import-daily-metrics
 *
 * Optional flags:
 *   --dry-run   parse + aggregate, print summary, do not POST
 *
 * The export dir should contain the unzipped Samsung Health export
 * CSVs. The script picks files by prefix and ignores the rest:
 *   - com.samsung.shealth.activity.day_summary.*.csv
 *       → samsungSteps (step_count, day_time)
 *   - com.samsung.shealth.sleep.*.csv          (note trailing dot —
 *       deliberately excludes sleep_combined / sleep_data / etc.)
 *       → samsungSleepHours (sleep_duration / 60), samsungSleepScore
 *         (sleep_score), keyed by wake-up date
 *   - com.samsung.shealth.vitality_score.*.csv
 *       → samsungEnergyScore (round(total_score)), day_time
 *   - com.samsung.shealth.tracker.oxygen_saturation.*.csv
 *       → samsungSpo2AvgPercent (daily mean of spo2 column)
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_URL =
  "https://app.coherence-rmg.com/api/webhooks/samsung-health/import-daily-metrics";
const BATCH_SIZE = 500;

type ParsedCsv = { headers: string[]; rows: Record<string, string>[] };

function parseLine(line: string): string[] {
  // Minimal RFC-4180 parser: handles quoted fields with embedded
  // commas / escaped quotes. Samsung CSV exports rarely use quoting,
  // but a few free-text columns (comment, custom) can have commas.
  const fields: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') {
        inQuote = false;
      } else {
        cur += c;
      }
    } else {
      if (c === '"') {
        inQuote = true;
      } else if (c === ",") {
        fields.push(cur);
        cur = "";
      } else {
        cur += c;
      }
    }
  }
  fields.push(cur);
  return fields;
}

function parseCsv(content: string): ParsedCsv {
  // Strip UTF-8 BOM if present (some Samsung CSVs include it).
  const text = content.replace(/^﻿/, "");
  const lines = text.split(/\r?\n/);
  if (lines.length < 3) return { headers: [], rows: [] };
  // Line 0: type/version header (e.g. "com.samsung.shealth.sleep,6320001,11")
  // Line 1: column headers
  // Line 2..: data rows
  const headers = parseLine(lines[1]);
  const rows: Record<string, string>[] = [];
  for (let i = 2; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw || !raw.trim()) continue;
    const fields = parseLine(raw);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = fields[idx] ?? "";
    });
    rows.push(row);
  }
  return { headers, rows };
}

function findCsv(dir: string, prefix: string): string | null {
  const files = readdirSync(dir);
  return files.find((f) => f.startsWith(prefix) && f.endsWith(".csv")) ?? null;
}

function dateKeyOf(timestamp: string | undefined | null): string | null {
  if (!timestamp) return null;
  const m = String(timestamp).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function num(value: string | undefined | null): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

interface DayAggregate {
  steps?: number;
  sleepDurationMin?: number;
  sleepScore?: number;
  energyScore?: number;
  spo2Sum?: number;
  spo2Count?: number;
}

interface ImportEntry {
  dateKey: string;
  samsungSteps: number | null;
  samsungSleepHours: number | null;
  samsungSpo2AvgPercent: number | null;
  samsungSleepScore: number | null;
  samsungEnergyScore: number | null;
}

function aggregate(dir: string): ImportEntry[] {
  const days = new Map<string, DayAggregate>();
  const ensure = (dk: string): DayAggregate => {
    const existing = days.get(dk);
    if (existing) return existing;
    const fresh: DayAggregate = {};
    days.set(dk, fresh);
    return fresh;
  };

  // 1) Steps from activity.day_summary (cleaner than pedometer_day_summary
  //    which uses unix-millis day_time instead of a calendar string).
  const stepsCsv = findCsv(dir, "com.samsung.shealth.activity.day_summary");
  if (stepsCsv) {
    const { rows } = parseCsv(readFileSync(join(dir, stepsCsv), "utf-8"));
    let counted = 0;
    for (const row of rows) {
      const dk = dateKeyOf(row.day_time);
      if (!dk) continue;
      const steps = num(row.step_count);
      if (steps === null) continue;
      const day = ensure(dk);
      // Multiple rows for the same dateKey can occur when two devices
      // each wrote a daily summary; take the max so we don't pick a
      // partial sample.
      day.steps = day.steps == null ? steps : Math.max(day.steps, steps);
      counted++;
    }
    console.log(`activity.day_summary: parsed ${counted} step rows`);
  } else {
    console.warn("activity.day_summary CSV not found — steps will be null");
  }

  // 2) Sleep from sleep.csv. Exact prefix `com.samsung.shealth.sleep.`
  //    (with trailing dot before the timestamp) excludes sleep_combined,
  //    sleep_data, sleep_raw_data, sleep_snoring, etc.
  const sleepCsv = findCsv(dir, "com.samsung.shealth.sleep.20");
  if (sleepCsv) {
    const { rows } = parseCsv(readFileSync(join(dir, sleepCsv), "utf-8"));
    let counted = 0;
    for (const row of rows) {
      const wakeTime = row["com.samsung.health.sleep.end_time"];
      const dk = dateKeyOf(wakeTime);
      if (!dk) continue;
      const day = ensure(dk);
      const durationMin = num(row.sleep_duration);
      if (durationMin !== null) {
        day.sleepDurationMin = (day.sleepDurationMin ?? 0) + durationMin;
      }
      const score = num(row.sleep_score);
      if (score !== null && score > 0) {
        day.sleepScore = day.sleepScore == null ? score : Math.max(day.sleepScore, score);
      }
      counted++;
    }
    console.log(`sleep: parsed ${counted} session rows`);
  } else {
    console.warn("sleep CSV not found — sleep hours / score will be null");
  }

  // 3) Energy score from vitality_score (Samsung's internal name for
  //    the user-facing "Energy Score"). `total_score` is the headline
  //    number, decimal-valued; round to int to match SH UI.
  const vitalityCsv = findCsv(dir, "com.samsung.shealth.vitality_score");
  if (vitalityCsv) {
    const { rows } = parseCsv(readFileSync(join(dir, vitalityCsv), "utf-8"));
    let counted = 0;
    for (const row of rows) {
      const dk = dateKeyOf(row.day_time);
      if (!dk) continue;
      const total = num(row.total_score);
      if (total === null) continue;
      ensure(dk).energyScore = Math.round(total);
      counted++;
    }
    console.log(`vitality_score: parsed ${counted} day rows`);
  } else {
    console.warn(
      "vitality_score CSV not found — energy score will be null (only available on Galaxy Watch7+)",
    );
  }

  // 4) Daily SpO2 average. The tracker.oxygen_saturation file has one
  //    row per measurement; aggregate by start_time's calendar date in
  //    the local tz the measurement carried.
  const spo2Csv = findCsv(dir, "com.samsung.shealth.tracker.oxygen_saturation");
  if (spo2Csv) {
    const { rows } = parseCsv(readFileSync(join(dir, spo2Csv), "utf-8"));
    let counted = 0;
    for (const row of rows) {
      const start = row["com.samsung.health.oxygen_saturation.start_time"];
      const dk = dateKeyOf(start);
      if (!dk) continue;
      const spo2 = num(row["com.samsung.health.oxygen_saturation.spo2"]);
      if (spo2 === null || spo2 <= 0) continue;
      const day = ensure(dk);
      day.spo2Sum = (day.spo2Sum ?? 0) + spo2;
      day.spo2Count = (day.spo2Count ?? 0) + 1;
      counted++;
    }
    console.log(`oxygen_saturation: parsed ${counted} sample rows`);
  } else {
    console.warn("oxygen_saturation CSV not found — SpO2 will be null");
  }

  const sortedDateKeys = Array.from(days.keys()).sort();
  return sortedDateKeys.map((dateKey) => {
    const d = days.get(dateKey)!;
    const sleepHours =
      d.sleepDurationMin != null
        ? Number((d.sleepDurationMin / 60).toFixed(1))
        : null;
    const spo2Avg =
      d.spo2Count && d.spo2Sum != null
        ? Number((d.spo2Sum / d.spo2Count).toFixed(1))
        : null;
    return {
      dateKey,
      samsungSteps: d.steps ?? null,
      samsungSleepHours: sleepHours,
      samsungSpo2AvgPercent: spo2Avg,
      samsungSleepScore: d.sleepScore ?? null,
      samsungEnergyScore: d.energyScore ?? null,
    };
  });
}

async function postBatches(
  entries: ImportEntry[],
  url: string,
  syncKey: string,
): Promise<void> {
  let written = 0;
  const errors: Array<{ batchStart: number; error: unknown }> = [];
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-sync-key": syncKey,
      },
      body: JSON.stringify({ entries: batch }),
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = { error: "non-json response", status: res.status };
    }
    const ok =
      res.ok &&
      json &&
      typeof json === "object" &&
      (json as Record<string, unknown>).success === true;
    if (!ok) {
      console.error(
        `Batch ${i}–${i + batch.length - 1} failed (HTTP ${res.status}):`,
        json,
      );
      errors.push({ batchStart: i, error: json });
      continue;
    }
    const w = (json as Record<string, unknown>).written;
    written += typeof w === "number" ? w : 0;
    console.log(
      `Batch ${i}–${i + batch.length - 1} ✓ written ${typeof w === "number" ? w : "?"}`,
    );
  }
  console.log(
    `\nDone. Wrote ${written} of ${entries.length} entries. ${errors.length} batch error(s).`,
  );
  if (errors.length) process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith("--"));
  const dryRun = args.includes("--dry-run");
  if (!dir) {
    console.error(
      "Usage: tsx server/scripts/importSamsungCsv.ts <unzipped-export-dir> [--dry-run]",
    );
    process.exit(1);
  }
  const url = process.env.SAMSUNG_HEALTH_WEBHOOK_URL ?? DEFAULT_URL;
  const syncKey = process.env.SAMSUNG_HEALTH_SYNC_KEY;
  if (!syncKey && !dryRun) {
    console.error(
      "SAMSUNG_HEALTH_SYNC_KEY env var required (or pass --dry-run for offline preview).",
    );
    process.exit(1);
  }

  console.log(`Reading Samsung Health CSVs from ${dir}\n`);
  const entries = aggregate(dir);
  if (entries.length === 0) {
    console.error("No entries aggregated. Wrong directory?");
    process.exit(1);
  }
  console.log(
    `\nAggregated ${entries.length} days. Range: ${entries[0].dateKey} → ${entries[entries.length - 1].dateKey}`,
  );

  if (dryRun) {
    console.log("\n--dry-run: not posting. Last 5 entries:");
    console.log(JSON.stringify(entries.slice(-5), null, 2));
    return;
  }

  console.log(`\nPOSTing to ${url} in batches of ${BATCH_SIZE}…\n`);
  await postBatches(entries, url, syncKey!);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
