export type CoreDatasetSyncProgressPhase =
  | "pending"
  | "loading_payload"
  | "parsing_csv"
  | "filtering_duplicates"
  | "persisting_rows"
  | "activating_batch"
  | "completed";

export type CoreDatasetSyncProgress = {
  phase: CoreDatasetSyncProgressPhase;
  percent: number;
  current: number;
  total: number;
  unitLabel: string;
  message: string;
};

type BuildSyncProgressInput = {
  phase: CoreDatasetSyncProgressPhase;
  startPercent: number;
  endPercent: number;
  current: number;
  total: number;
  unitLabel: string;
  message: string;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function buildSyncProgress(
  input: BuildSyncProgressInput
): CoreDatasetSyncProgress {
  const safeTotal = input.total > 0 ? input.total : 1;
  const safeCurrent = clamp(input.current, 0, safeTotal);
  const ratio = safeTotal > 0 ? safeCurrent / safeTotal : 0;
  const percent =
    input.phase === "completed"
      ? 100
      : clamp(
          input.startPercent +
            (input.endPercent - input.startPercent) * ratio,
          input.startPercent,
          input.endPercent
        );

  return {
    phase: input.phase,
    percent: Math.round(percent * 10) / 10,
    current: safeCurrent,
    total: safeTotal,
    unitLabel: input.unitLabel,
    message: input.message,
  };
}
