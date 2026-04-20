/**
 * Delivery Tracker tab.
 *
 * Extracted from SolarRecDashboard.tsx. Phase 8. Owns zero memos and
 * zero state of its own — the tab is entirely a reader of
 * `deliveryTrackerData` (which stays in the parent because
 * `createLogEntry` and `aiDataContext` both consume it too).
 *
 * ## ScheduleBImport slot pattern
 *
 * The tab's top section is the `<ScheduleBImport>` card, which has a
 * ~140-line `onApplyComplete` callback that touches the parent's cloud
 * sync machinery (remoteDatasetSignatureRef, parseCsvTextAsync,
 * deserializeRemoteDatasetPayload, setDatasets, ...). Moving that
 * callback into a child component would require plumbing five refs and
 * three setters through props — not worth it for a single callsite.
 *
 * Instead this component accepts the `<ScheduleBImport>` element
 * (already wired up with all its callbacks) as `children` and renders
 * it above the visualization. The parent retains full ownership of
 * the cloud sync glue; the child owns the visualization layout.
 */

import { memo } from "react";
import type { ReactNode } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  buildCsv,
  timestampForCsvFileName,
  triggerCsvDownload,
} from "@/solar-rec-dashboard/lib/csvIo";
import { formatNumber } from "@/solar-rec-dashboard/lib/helpers";
import {
  BUCKET,
  type DeliveryTrackerData,
} from "@/solar-rec-dashboard/lib/buildDeliveryTrackerData";

export interface DeliveryTrackerTabProps {
  /**
   * Already-wired `<ScheduleBImport>` element. The parent owns all
   * its callbacks and refs; this component renders it at the top of
   * the layout without touching its state.
   */
  scheduleBImportSlot: ReactNode;
  /** Computed by the parent's `deliveryTrackerData` useMemo. */
  deliveryTrackerData: DeliveryTrackerData;
}

export default memo(function DeliveryTrackerTab(props: DeliveryTrackerTabProps) {
  const { scheduleBImportSlot, deliveryTrackerData } = props;

  return (
    <div className="space-y-4 mt-4">
      {/* Schedule B PDF Import — the parent wires up all the callbacks
          because they touch cloud sync refs and dataset setters. */}
      {scheduleBImportSlot}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card>
          <CardHeader>
            <CardDescription>Systems in Schedule</CardDescription>
            <CardTitle className="text-2xl">
              {formatNumber(
                deliveryTrackerData.contracts.reduce((a, c) => a + c.systems, 0),
              )}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Transfers Processed</CardDescription>
            <CardTitle className="text-2xl">
              {formatNumber(deliveryTrackerData.totalTransfers)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card
          className={
            deliveryTrackerData.unmatchedTransfers > 0
              ? "border-amber-200 bg-amber-50/50"
              : ""
          }
        >
          <CardHeader>
            <CardDescription>Unmatched Transfers</CardDescription>
            <CardTitle className="text-2xl">
              {formatNumber(deliveryTrackerData.unmatchedTransfers)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Schedule Systems Loaded</CardDescription>
            <CardTitle className="text-2xl">
              {formatNumber(deliveryTrackerData.scheduleCount ?? 0)}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      {deliveryTrackerData.unmatchedTransfers > 0 &&
        ((deliveryTrackerData.scheduleIdSample ?? []).length > 0 ||
          (deliveryTrackerData.transferIdSample ?? []).length > 0) && (
          <Card className="border-amber-200 bg-amber-50/30">
            <CardContent className="pt-3 pb-3">
              <p className="text-xs font-medium text-amber-800 mb-1">
                Debug: Sample IDs for matching
              </p>
              <div className="grid grid-cols-2 gap-4 text-xs font-mono">
                <div>
                  <p className="text-amber-700 mb-1">Schedule IDs (first 5):</p>
                  {(deliveryTrackerData.scheduleIdSample ?? []).map((id, i) => (
                    <div key={i}>{id}</div>
                  ))}
                </div>
                <div>
                  <p className="text-amber-700 mb-1">Transfer Unit IDs (first 5):</p>
                  {(deliveryTrackerData.transferIdSample ?? []).map((id, i) => (
                    <div key={i}>{id}</div>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        )}

      {deliveryTrackerData.transfersMissingObligation.length > 0 && (
        <Card className="border-amber-200 bg-amber-50/40">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-2">
              <div>
                <CardTitle className="text-base text-amber-900">
                  Missing Schedule B Coverage (
                  {formatNumber(deliveryTrackerData.transfersMissingObligation.length)})
                </CardTitle>
                <CardDescription className="text-amber-800">
                  These tracking IDs have transfers recorded in GATS Transfer History
                  but no matching Schedule B PDF has been scraped yet. Their obligations
                  are therefore unknown and they are not counted in the contract summary
                  below. Upload and scrape the corresponding Schedule B PDFs to restore
                  coverage. The export groups every unmatched transfer into three buckets:
                  <code>missing_schedule_b</code> (this card),
                  <code>pre_delivery_schedule</code> (transfer ran before the
                  system's earliest scraped year), and
                  <code>year_mismatch</code> (Schedule B exists but the transfer
                  date fell outside every year window — usually a malformed PDF
                  parse or transfers after the contract term).
                  {deliveryTrackerData.schedulesWithYearsOutsideBounds.length > 0 ? (
                    <>
                      {" "}
                      <strong>
                        {formatNumber(
                          deliveryTrackerData.schedulesWithYearsOutsideBounds.length,
                        )}{" "}
                        scraped Schedule B{deliveryTrackerData.schedulesWithYearsOutsideBounds.length === 1 ? "" : "s"}
                      </strong>{" "}
                      have year boundaries outside the plausible 2019–2042 window
                      and are likely bad parses. Because their earliest year sits
                      outside that window, their transfers get classified under{" "}
                      <code>pre_delivery_schedule</code> rather than{" "}
                      <code>year_mismatch</code> (which is why the
                      year_mismatch bucket looks empty). Re-scrape these PDFs.
                    </>
                  ) : null}
                </CardDescription>
                {deliveryTrackerData.schedulesWithYearsOutsideBounds.length > 0 ? (
                  <div className="mt-2 rounded border border-amber-300 bg-white p-2">
                    <p className="text-xs font-medium text-amber-900 mb-1">
                      Flagged Schedule Bs (out-of-bounds year ranges)
                    </p>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="text-xs">Tracking ID</TableHead>
                          <TableHead className="text-xs">System</TableHead>
                          <TableHead className="text-xs">
                            Offending year ranges (scraped)
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {deliveryTrackerData.schedulesWithYearsOutsideBounds.map(
                          ({ trackingId, systemName, outOfBoundsYears }) => (
                            <TableRow key={trackingId}>
                              <TableCell className="font-mono text-xs">
                                {trackingId}
                              </TableCell>
                              <TableCell className="text-xs">
                                {systemName}
                              </TableCell>
                              <TableCell className="font-mono text-xs">
                                {outOfBoundsYears
                                  .map(
                                    ({ yearLabel, startYear, endYear }) =>
                                      `${yearLabel} (start=${startYear ?? "?"}, end=${endYear ?? "?"})`,
                                  )
                                  .join("; ")}
                              </TableCell>
                            </TableRow>
                          ),
                        )}
                      </TableBody>
                    </Table>
                  </div>
                ) : null}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  // Combined export of every transfer that did NOT land
                  // in a Schedule B year slot, partitioned into three
                  // buckets. The summary-card Unmatched Transfers total
                  // excludes pre_delivery_schedule, so it equals the
                  // sum of the missing_schedule_b + year_mismatch rows
                  // only. The pre_delivery_schedule rows are surfaced
                  // here for completeness.
                  const rows = [
                    ...deliveryTrackerData.transfersMissingObligation.map(
                      ({ trackingId, transferCount }) => ({
                        tracking_system_ref_id: trackingId,
                        bucket: BUCKET.missingScheduleB,
                        transfer_count: String(transferCount),
                      }),
                    ),
                    ...deliveryTrackerData.transfersPreDeliverySchedule.map(
                      ({ trackingId, transferCount }) => ({
                        tracking_system_ref_id: trackingId,
                        bucket: BUCKET.preDeliverySchedule,
                        transfer_count: String(transferCount),
                      }),
                    ),
                    ...deliveryTrackerData.transfersUnmatchedByYear.map(
                      ({ trackingId, transferCount }) => ({
                        tracking_system_ref_id: trackingId,
                        bucket: BUCKET.yearMismatch,
                        transfer_count: String(transferCount),
                      }),
                    ),
                  ];
                  const csv = buildCsv(
                    ["tracking_system_ref_id", "bucket", "transfer_count"],
                    rows,
                  );
                  triggerCsvDownload(
                    `delivery-tracker-unmatched-transfers-${timestampForCsvFileName()}.csv`,
                    csv,
                  );
                }}
              >
                Export CSV
              </Button>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="max-h-48 overflow-y-auto rounded border border-amber-200 bg-white">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Tracking ID</TableHead>
                    <TableHead className="text-right">Transfers</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {deliveryTrackerData.transfersMissingObligation
                    .slice(0, 20)
                    .map(({ trackingId, transferCount }) => (
                      <TableRow key={trackingId}>
                        <TableCell className="font-mono text-xs">
                          {trackingId}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs">
                          {formatNumber(transferCount)}
                        </TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </div>
            {deliveryTrackerData.transfersMissingObligation.length > 20 && (
              <p className="text-xs text-amber-700 mt-2">
                Showing first 20 of{" "}
                {formatNumber(deliveryTrackerData.transfersMissingObligation.length)}{" "}
                missing tracking IDs. Export CSV for the full list.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Contract summary */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">Delivery by Contract</CardTitle>
              <CardDescription>
                Obligations from Schedule B PDFs, actuals computed from Transfer History
                uploads.
              </CardDescription>
            </div>
            {deliveryTrackerData.contracts.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const csv = buildCsv(
                    [
                      "contract",
                      "systems",
                      "total_obligated",
                      "total_delivered",
                      "total_gap",
                      "delivery_percent",
                    ],
                    deliveryTrackerData.contracts.map((c) => ({
                      contract: c.contractId,
                      systems: c.systems,
                      total_obligated: c.totalObligated,
                      total_delivered: c.totalDelivered,
                      total_gap: c.totalGap,
                      delivery_percent:
                        c.deliveryPercent !== null ? c.deliveryPercent.toFixed(1) : "",
                    })),
                  );
                  triggerCsvDownload(
                    `delivery-tracker-contracts-${timestampForCsvFileName()}.csv`,
                    csv,
                  );
                }}
              >
                Export CSV
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {deliveryTrackerData.contracts.length === 0 ? (
            <p className="text-sm text-slate-500 py-4 text-center">
              Import Schedule B PDFs above and upload Transfer History (GATS) in Step 1
              to see delivery tracking.
            </p>
          ) : (
            <>
              <div className="h-72 rounded-md border border-slate-200 bg-white p-2 mb-4">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={deliveryTrackerData.contracts}
                    margin={{ top: 8, right: 12, left: 4, bottom: 8 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis
                      dataKey="contractId"
                      tick={{ fontSize: 10 }}
                      angle={-35}
                      textAnchor="end"
                      height={60}
                    />
                    <YAxis tick={{ fontSize: 12 }} />
                    <Tooltip />
                    <Legend />
                    <Bar dataKey="totalObligated" fill="#94a3b8" name="Obligated" />
                    <Bar dataKey="totalDelivered" fill="#16a34a" name="Delivered" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Contract</TableHead>
                    <TableHead className="text-right">Systems</TableHead>
                    <TableHead className="text-right">Obligated</TableHead>
                    <TableHead className="text-right">Delivered</TableHead>
                    <TableHead className="text-right">Gap</TableHead>
                    <TableHead className="text-right">Delivery %</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {deliveryTrackerData.contracts.map((c) => (
                    <TableRow key={c.contractId}>
                      <TableCell className="font-medium">{c.contractId}</TableCell>
                      <TableCell className="text-right">{c.systems}</TableCell>
                      <TableCell className="text-right">
                        {formatNumber(c.totalObligated)}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatNumber(c.totalDelivered)}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatNumber(c.totalGap)}
                      </TableCell>
                      <TableCell className="text-right">
                        {c.deliveryPercent !== null
                          ? `${c.deliveryPercent.toFixed(1)}%`
                          : "N/A"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}
        </CardContent>
      </Card>

      {/* System-level detail (paginated) */}
      {deliveryTrackerData.rows.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base">System × Year Detail</CardTitle>
                <CardDescription>
                  {formatNumber(deliveryTrackerData.rows.length)} system-year rows
                </CardDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const csv = buildCsv(
                    [
                      "system_name",
                      "unit_id",
                      "contract",
                      "year",
                      "start_date",
                      "end_date",
                      "obligated",
                      "delivered",
                      "gap",
                    ],
                    deliveryTrackerData.rows.map((r) => ({
                      system_name: r.systemName,
                      unit_id: r.unitId,
                      contract: r.contractId,
                      year: r.yearLabel,
                      start_date: r.yearStart?.toISOString().slice(0, 10) ?? "",
                      end_date: r.yearEnd?.toISOString().slice(0, 10) ?? "",
                      obligated: r.obligated,
                      delivered: r.delivered,
                      gap: r.gap,
                    })),
                  );
                  triggerCsvDownload(
                    `delivery-tracker-detail-${timestampForCsvFileName()}.csv`,
                    csv,
                  );
                }}
              >
                Export CSV
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="max-h-[500px] overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>System</TableHead>
                    <TableHead>Unit ID</TableHead>
                    <TableHead>Contract</TableHead>
                    <TableHead>Year</TableHead>
                    <TableHead className="text-right">Obligated</TableHead>
                    <TableHead className="text-right">Delivered</TableHead>
                    <TableHead className="text-right">Gap</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {deliveryTrackerData.rows.slice(0, 200).map((r, i) => (
                    <TableRow key={i}>
                      <TableCell className="text-sm">{r.systemName}</TableCell>
                      <TableCell className="text-xs text-slate-500">{r.unitId}</TableCell>
                      <TableCell className="text-sm">{r.contractId}</TableCell>
                      <TableCell className="text-sm">{r.yearLabel}</TableCell>
                      <TableCell className="text-right">
                        {formatNumber(r.obligated)}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatNumber(r.delivered)}
                      </TableCell>
                      <TableCell
                        className={`text-right ${r.gap > 0 ? "text-rose-600" : r.gap < 0 ? "text-emerald-600" : ""}`}
                      >
                        {formatNumber(r.gap)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {deliveryTrackerData.rows.length > 200 && (
              <p className="text-xs text-slate-500 mt-2 text-center">
                Showing first 200 of {formatNumber(deliveryTrackerData.rows.length)} rows.
                Export CSV for full data.
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
});
