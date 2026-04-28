/**
 * Task 9.4 (2026-04-28) — System detail page MVP.
 *
 * `/solar-rec/system/:csgId`. One page per system, keyed by the
 * canonical CSG ID. Composed from a single tRPC call
 * (`systems.getDetailByCsgId`) which joins the registry record +
 * latest contract scan + latest DIN scrape + latest Schedule B
 * import result. Each section renders independently and shows a
 * clear "no data yet" state when its piece is missing.
 *
 * Module gate: `portfolio-workbench` (read).
 *
 * MVP scope (per the plan): four sections — Header, Contract, DINs,
 * Schedule B / Delivery. Each shows "last updated" and (where
 * applicable) a "Re-run" link to the relevant manager. Future
 * sections (meter reads, invoices, address verification, REC
 * value, ownership, monitoring) ship one-per-PR in Task 9.5.
 */
import { Suspense, useMemo } from "react";
import { useParams, useLocation } from "wouter";
import type { inferRouterOutputs } from "@trpc/server";
import type { SolarRecAppRouter } from "@server/_core/solarRecRouter";
import { solarRecTrpc as trpc } from "../solarRecTrpc";
import { PermissionGate } from "../components/PermissionGate";

// Pull the detail-query response shape off the router type so each
// section's props are typed without forcing every consumer to know
// about tRPC. `useQuery`'s `.data` is `T | undefined`; the page
// gates render on a non-null value before forwarding to children.
type SystemDetailResponse =
  inferRouterOutputs<SolarRecAppRouter>["systems"]["getDetailByCsgId"];
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ArrowLeft,
  ArrowUpRight,
  CircleCheck,
  CircleAlert,
} from "lucide-react";

function formatRelativeTime(date: Date | null | undefined): string {
  if (!date) return "—";
  const ms = Date.now() - date.getTime();
  if (ms < 0) return "just now";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function formatNumber(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function formatMoney(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  });
}

export default function SystemDetail() {
  return (
    <PermissionGate moduleKey="portfolio-workbench">
      <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading...</div>}>
        <SystemDetailImpl />
      </Suspense>
    </PermissionGate>
  );
}

function SystemDetailImpl() {
  const params = useParams<{ csgId?: string }>();
  const [, setLocation] = useLocation();
  const rawCsgId = params.csgId ?? "";
  const csgId = useMemo(() => decodeURIComponent(rawCsgId).trim(), [rawCsgId]);

  const detailQuery = trpc.systems.getDetailByCsgId.useQuery(
    { csgId },
    {
      enabled: csgId.length > 0,
      // Detail page is mostly cached server-side via `withArtifactCache`
      // for the registry pieces; the contract/DIN/Schedule B sections
      // are point reads. Refetch on focus so a teammate's update is
      // visible without a manual refresh.
      refetchOnWindowFocus: true,
    }
  );

  if (!csgId) {
    return (
      <div className="container mx-auto p-6 space-y-2">
        <h1 className="text-2xl font-semibold">System detail</h1>
        <p className="text-sm text-muted-foreground">
          Missing CSG ID in the URL. Open a system from a workset or the
          dashboard.
        </p>
      </div>
    );
  }

  const data = detailQuery.data;

  return (
    <div className="container mx-auto p-6 space-y-4">
      {/* Breadcrumb / back nav */}
      <div className="flex items-center gap-2 text-sm">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setLocation("/solar-rec/dashboard")}
          className="h-7 px-2"
        >
          <ArrowLeft className="h-3.5 w-3.5 mr-1" />
          Back
        </Button>
        <span className="text-muted-foreground">/</span>
        <span className="font-mono text-xs text-muted-foreground">
          {csgId}
        </span>
      </div>

      {detailQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading system…</p>
      ) : detailQuery.error ? (
        <p className="text-sm text-destructive">{detailQuery.error.message}</p>
      ) : !data ? null : (
        <>
          <HeaderSection registry={data.registry} csgId={csgId} />
          <ContractSection
            contractScan={data.contractScan}
            csgId={csgId}
            onJump={() =>
              setLocation("/solar-rec/contract-scrape-manager")
            }
          />
          <DinsSection
            dinScrape={data.dinScrape}
            onJump={() => setLocation("/solar-rec/din-scrape-manager")}
          />
          <ScheduleBSection
            scheduleBResult={data.scheduleBResult}
            onJump={() =>
              setLocation("/solar-rec/dashboard?tab=delivery-tracker")
            }
          />
          <p className="text-[10px] text-muted-foreground text-right font-mono">
            runner: {data._runnerVersion}
          </p>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function HeaderSection({
  registry,
  csgId,
}: {
  registry: SystemDetailResponse["registry"];
  csgId: string;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="text-2xl">
              {registry?.systemName ?? "Unknown system"}
            </CardTitle>
            <CardDescription className="font-mono text-xs">
              CSG {csgId}
              {registry?.abpId && (
                <>
                  {" · "}
                  ABP {registry.abpId}
                </>
              )}
            </CardDescription>
          </div>
          {registry?.contractType && (
            <Badge variant="outline" className="text-xs">
              {registry.contractType}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {!registry ? (
          <p className="text-sm text-muted-foreground">
            <CircleAlert className="inline-block h-3.5 w-3.5 mr-1 text-muted-foreground" />
            No registry record. The system may not be in the active Solar
            Applications dataset for this scope, or the CSG ID may be
            mistyped.
          </p>
        ) : (
          <dl className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-3 text-sm">
            <Field
              label="AC size"
              value={
                registry.installedKwAc !== null
                  ? `${formatNumber(registry.installedKwAc)} kW`
                  : "—"
              }
            />
            <Field
              label="DC size"
              value={
                registry.installedKwDc !== null
                  ? `${formatNumber(registry.installedKwDc)} kW`
                  : "—"
              }
            />
            <Field
              label="REC price"
              value={
                registry.recPrice !== null
                  ? formatMoney(registry.recPrice)
                  : "—"
              }
            />
            <Field
              label="Contract value"
              value={
                registry.totalContractAmount !== null
                  ? formatMoney(registry.totalContractAmount)
                  : "—"
              }
            />
            <Field label="Installer" value={registry.installerName ?? "—"} />
            <Field
              label="Location"
              value={
                [registry.county, registry.state, registry.zipCode]
                  .filter(Boolean)
                  .join(", ") || "—"
              }
            />
            <Field
              label="Contracted"
              value={registry.contractedDate ?? "—"}
            />
            <Field
              label="Tracking ID"
              value={registry.trackingSystemRefId ?? "—"}
            />
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

function ContractSection({
  contractScan,
  csgId,
  onJump,
}: {
  contractScan: SystemDetailResponse["contractScan"];
  csgId: string;
  onJump: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="text-base">Contract</CardTitle>
            <CardDescription>
              Latest CSG-portal scrape result for this system.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={onJump}>
            <ArrowUpRight className="h-3.5 w-3.5 mr-1" />
            Manage
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {!contractScan ? (
          <NoData
            primary="No contract scan on file."
            secondary={`Run a contract scrape including CSG ${csgId} to populate this section.`}
          />
        ) : (
          <>
            <SectionMeta
              scannedAt={contractScan.scannedAt}
              status={contractScan.error ? "error" : "ok"}
              error={contractScan.error}
            />
            <dl className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-3 text-sm">
              <Field
                label="Vendor fee"
                value={
                  contractScan.overrideVendorFeePercent !== null
                    ? `${formatNumber(contractScan.overrideVendorFeePercent)}% (override)`
                    : contractScan.vendorFeePercent !== null
                      ? `${formatNumber(contractScan.vendorFeePercent)}%`
                      : "—"
                }
              />
              <Field
                label="Add'l collateral"
                value={
                  contractScan.overrideAdditionalCollateralPercent !== null
                    ? `${formatNumber(contractScan.overrideAdditionalCollateralPercent)}% (override)`
                    : contractScan.additionalCollateralPercent !== null
                      ? `${formatNumber(contractScan.additionalCollateralPercent)}%`
                      : "—"
                }
              />
              <Field
                label="REC quantity"
                value={
                  contractScan.recQuantity !== null
                    ? formatNumber(contractScan.recQuantity, 0)
                    : "—"
                }
              />
              <Field
                label="REC price"
                value={
                  contractScan.recPrice !== null
                    ? formatMoney(contractScan.recPrice)
                    : "—"
                }
              />
              <Field label="Payment method" value={contractScan.paymentMethod ?? "—"} />
              <Field label="Payee" value={contractScan.payeeName ?? "—"} />
              <Field
                label="CC auth"
                value={
                  contractScan.ccAuthorizationCompleted === true
                    ? "Completed"
                    : contractScan.ccAuthorizationCompleted === false
                      ? "Not completed"
                      : "—"
                }
              />
              <Field
                label="Mailing address"
                value={
                  [
                    contractScan.mailingAddress1,
                    contractScan.mailingAddress2,
                    contractScan.cityStateZip,
                  ]
                    .filter(Boolean)
                    .join(", ") || "—"
                }
              />
            </dl>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function DinsSection({
  dinScrape,
  onJump,
}: {
  dinScrape: SystemDetailResponse["dinScrape"];
  onJump: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="text-base">DINs</CardTitle>
            <CardDescription>
              Inverter and meter Device Identification Numbers extracted
              from CSG portal photos.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={onJump}>
            <ArrowUpRight className="h-3.5 w-3.5 mr-1" />
            Re-run
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {!dinScrape.result ? (
          <NoData
            primary="No DIN scrape on file."
            secondary="Run a DIN scrape including this CSG ID to populate the inverter and meter IDs."
          />
        ) : (
          <>
            <SectionMeta
              scannedAt={dinScrape.result.scannedAt}
              status={dinScrape.result.error ? "error" : "ok"}
              error={dinScrape.result.error}
              extra={
                <span>
                  {dinScrape.result.inverterPhotoCount} inverter photo
                  {dinScrape.result.inverterPhotoCount === 1 ? "" : "s"} ·{" "}
                  {dinScrape.result.meterPhotoCount} meter photo
                  {dinScrape.result.meterPhotoCount === 1 ? "" : "s"} ·{" "}
                  {dinScrape.result.dinCount} DIN
                  {dinScrape.result.dinCount === 1 ? "" : "s"} extracted
                </span>
              }
            />
            {dinScrape.dins.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Scrape ran but extracted zero DINs. Open the DIN Scrape
                Manager to inspect the extractor log.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead>DIN</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Extracted by</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {dinScrape.dins.map((d) => (
                    <TableRow key={d.id}>
                      <TableCell>
                        <Badge variant="secondary" className="text-xs">
                          {d.sourceType}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {d.dinValue}
                      </TableCell>
                      <TableCell
                        className="text-xs truncate max-w-[260px]"
                        title={d.sourceFileName ?? d.sourceUrl ?? ""}
                      >
                        {d.sourceFileName ?? d.sourceUrl ?? "—"}
                      </TableCell>
                      <TableCell className="text-xs">{d.extractedBy}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ScheduleBSection({
  scheduleBResult,
  onJump,
}: {
  scheduleBResult: SystemDetailResponse["scheduleBResult"];
  onJump: () => void;
}) {
  // Parse delivery years JSON for the chip row.
  const deliveryYears: Array<{ year: number; quantity: number | null }> =
    useMemo(() => {
      if (!scheduleBResult?.deliveryYearsJson) return [];
      try {
        const parsed = JSON.parse(scheduleBResult.deliveryYearsJson);
        if (!Array.isArray(parsed)) return [];
        return parsed
          .map((entry) =>
            typeof entry === "object" &&
            entry !== null &&
            typeof (entry as Record<string, unknown>).year === "number"
              ? {
                  year: (entry as { year: number }).year,
                  quantity:
                    typeof (entry as Record<string, unknown>).quantity ===
                    "number"
                      ? ((entry as { quantity: number }).quantity as number)
                      : null,
                }
              : null
          )
          .filter((v): v is { year: number; quantity: number | null } => !!v)
          .sort((a, b) => a.year - b.year);
      } catch {
        return [];
      }
    }, [scheduleBResult?.deliveryYearsJson]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="text-base">Schedule B / Delivery</CardTitle>
            <CardDescription>
              Latest extracted Schedule B for this system.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={onJump}>
            <ArrowUpRight className="h-3.5 w-3.5 mr-1" />
            Manage
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {!scheduleBResult ? (
          <NoData
            primary="No Schedule B on file."
            secondary="Upload a Schedule B PDF or run a CSG-portal Schedule B import to populate this section."
          />
        ) : (
          <>
            <SectionMeta
              scannedAt={scheduleBResult.scannedAt}
              status={scheduleBResult.error ? "error" : "ok"}
              error={scheduleBResult.error}
              extra={
                <span className="font-mono text-xs">
                  {scheduleBResult.fileName}
                </span>
              }
            />
            <dl className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-3 text-sm">
              <Field label="GATS ID" value={scheduleBResult.gatsId ?? "—"} />
              <Field
                label="Designated system ID"
                value={scheduleBResult.designatedSystemId ?? "—"}
              />
              <Field
                label="Contract #"
                value={scheduleBResult.contractNumber ?? "—"}
              />
              <Field
                label="Energization"
                value={scheduleBResult.energizationDate ?? "—"}
              />
              <Field
                label="AC size"
                value={
                  scheduleBResult.acSizeKw !== null
                    ? `${formatNumber(scheduleBResult.acSizeKw)} kW`
                    : "—"
                }
              />
              <Field
                label="Capacity factor"
                value={
                  scheduleBResult.capacityFactor !== null
                    ? `${formatNumber(scheduleBResult.capacityFactor * 100, 1)}%`
                    : "—"
                }
              />
              <Field
                label="Contract price"
                value={
                  scheduleBResult.contractPrice !== null
                    ? formatMoney(scheduleBResult.contractPrice)
                    : "—"
                }
              />
              <Field
                label="Max REC quantity"
                value={
                  scheduleBResult.maxRecQuantity !== null
                    ? formatNumber(scheduleBResult.maxRecQuantity, 0)
                    : "—"
                }
              />
            </dl>
            {deliveryYears.length > 0 && (
              <div className="mt-3">
                <p className="text-xs text-muted-foreground mb-1">
                  Delivery schedule
                </p>
                <div className="flex flex-wrap gap-2">
                  {deliveryYears.map((y) => (
                    <Badge key={y.year} variant="outline" className="text-xs">
                      {y.year}
                      {y.quantity !== null
                        ? `: ${formatNumber(y.quantity, 0)}`
                        : ""}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Atoms
// ---------------------------------------------------------------------------

function Field({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{value}</dd>
    </div>
  );
}

function NoData({
  primary,
  secondary,
}: {
  primary: string;
  secondary?: string;
}) {
  return (
    <div className="text-sm">
      <p className="text-muted-foreground">
        <CircleAlert className="inline-block h-3.5 w-3.5 mr-1" />
        {primary}
      </p>
      {secondary && (
        <p className="text-xs text-muted-foreground mt-1">{secondary}</p>
      )}
    </div>
  );
}

function SectionMeta({
  scannedAt,
  status,
  error,
  extra,
}: {
  scannedAt: Date | null | undefined;
  status: "ok" | "error";
  error?: string | null;
  extra?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 mb-3 text-xs text-muted-foreground">
      <span className="flex items-center gap-1">
        {status === "ok" ? (
          <CircleCheck className="h-3.5 w-3.5 text-green-600" />
        ) : (
          <CircleAlert className="h-3.5 w-3.5 text-amber-600" />
        )}
        Last updated {formatRelativeTime(scannedAt ?? null)}
      </span>
      {extra}
      {error && (
        <span className="text-destructive truncate max-w-[260px]" title={error}>
          {error}
        </span>
      )}
    </div>
  );
}

