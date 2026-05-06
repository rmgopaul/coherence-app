export function isTerminalDashboardBuildStatus(
  status: string | null | undefined,
): boolean {
  return status === "succeeded" || status === "failed" || status === "notFound";
}
