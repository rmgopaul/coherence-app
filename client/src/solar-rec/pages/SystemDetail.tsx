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
  MapPin,
} from "lucide-react";
import { compareAddresses } from "@/lib/addressCompare";
import {
  buildRecValueRollup,
  recValueSourceLabel,
} from "@/lib/recValueRollup";

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
          <MeterReadsSection
            meterReads={data.meterReads}
            onJump={(vendor) => {
              const slug = vendorSlugFor(vendor);
              if (slug) setLocation(`/solar-rec/meter-reads/${slug}`);
              else setLocation("/solar-rec/monitoring");
            }}
          />
          <InvoiceStatusSection
            invoiceStatus={data.invoiceStatus}
            onJump={() => setLocation("/solar-rec/abp-invoice-settlement")}
          />
          <AddressSection
            registry={data.registry}
            contractScan={data.contractScan}
            onJump={() => setLocation("/solar-rec/address-checker")}
          />
          <RecValueSection
            registry={data.registry}
            contractScan={data.contractScan}
            scheduleBResult={data.scheduleBResult}
            invoiceStatus={data.invoiceStatus}
            onJump={() => setLocation("/solar-rec/early-payment")}
          />
          <OwnershipSection
            ownership={data.ownership}
            registry={data.registry}
            onJump={() => setLocation("/solar-rec/dashboard")}
          />
          <p className="text-[10px] text-muted-foreground text-right font-mono">
            runner: {data._runnerVersion}
          </p>
        </>
      )}
    </div>
  );
}

/**
 * Map a generation-entry "Online Monitoring" string to the `/solar-rec/
 * meter-reads/<slug>` URL the vendor's manage page lives at. Returns
 * `null` for unknown vendors — the section falls through to the
 * Monitoring overview in that case. Names come from the
 * `srDsGenerationEntry.onlineMonitoring` column which today is one of
 * the 16 vendor labels seeded into Solar Applications. Update both
 * sides when a new vendor adapter ships in Phase 5.
 */
function vendorSlugFor(vendor: string | null): string | null {
  if (!vendor) return null;
  const v = vendor.trim().toLowerCase();
  if (!v) return null;
  const direct: Record<string, string> = {
    solaredge: "solaredge",
    "enphase v4": "enphase-v4",
    "enphase": "enphase-v4", // legacy spelling
    apsystems: "apsystems",
    hoymiles: "hoymiles",
    fronius: "fronius",
    generac: "generac",
    goodwe: "goodwe",
    solis: "solis",
    locus: "locus",
    growatt: "growatt",
    solarlog: "solarlog",
    "solar-log": "solarlog",
    ekm: "ekm",
    ennexos: "ennexos",
    egauge: "egauge",
    sunpower: "sunpower",
    "tesla powerhub": "tesla-powerhub",
    "tesla": "tesla-powerhub",
  };
  return direct[v] ?? null;
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

function MeterReadsSection({
  meterReads,
  onJump,
}: {
  meterReads: SystemDetailResponse["meterReads"];
  onJump: (vendor: string | null) => void;
}) {
  // The "delta last 7 days" stat: walk the most recent 7 reads and
  // show the lifetime delta between first and last. Reads come back
  // newest-first, so reverse the slice. Filters out rows with null
  // lifetimeMeterReadWh — those are placeholder entries.
  const recent7DayDelta = useMemo(() => {
    const valid = meterReads.reads
      .filter((r) => r.lifetimeMeterReadWh !== null)
      .slice(0, 7);
    if (valid.length < 2) return null;
    const newest = valid[0].lifetimeMeterReadWh as number;
    const oldest = valid[valid.length - 1].lifetimeMeterReadWh as number;
    const delta = newest - oldest;
    if (!Number.isFinite(delta) || delta < 0) return null;
    return delta;
  }, [meterReads.reads]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="text-base">Meter reads</CardTitle>
            <CardDescription>
              Lifetime cumulative meter readings from the system's
              monitoring vendor.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onJump(meterReads.monitoringVendor)}
            disabled={!meterReads.monitoringVendor && meterReads.reads.length === 0}
          >
            <ArrowUpRight className="h-3.5 w-3.5 mr-1" />
            {meterReads.monitoringVendor
              ? `Open ${meterReads.monitoringVendor}`
              : "Monitoring"}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {meterReads.reads.length === 0 ? (
          <NoData
            primary="No meter reads on file."
            secondary={
              meterReads.monitoringVendor
                ? `Vendor "${meterReads.monitoringVendor}" is configured but no readings have been ingested yet. Run today's monitoring batch.`
                : "No monitoring vendor resolved for this system. Verify the Generation Entry dataset has a row matching this system's tracking ID."
            }
          />
        ) : (
          <>
            <dl className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-3 text-sm">
              <Field
                label="Vendor"
                value={meterReads.monitoringVendor ?? "—"}
              />
              <Field
                label="Vendor system ID"
                value={meterReads.monitoringSystemId ?? "—"}
              />
              <Field
                label="Latest reading"
                value={
                  meterReads.latestReadWh !== null
                    ? `${formatNumber(meterReads.latestReadWh / 1000, 0)} kWh`
                    : "—"
                }
              />
              <Field
                label="Latest read date"
                value={meterReads.latestReadDate ?? "—"}
              />
              <Field
                label="7-day delta"
                value={
                  recent7DayDelta !== null
                    ? `${formatNumber(recent7DayDelta / 1000, 0)} kWh`
                    : "—"
                }
              />
              <Field
                label="Reads on file"
                value={`${meterReads.reads.length} (last 30)`}
              />
            </dl>
            <div className="mt-3">
              <p className="text-xs text-muted-foreground mb-1">
                Recent readings
              </p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Lifetime kWh</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {meterReads.reads.slice(0, 7).map((r) => (
                    <TableRow key={`${r.readDate}-${r.lifetimeMeterReadWh}`}>
                      <TableCell className="text-xs font-mono">
                        {r.readDate}
                      </TableCell>
                      <TableCell className="text-xs">
                        {r.lifetimeMeterReadWh !== null
                          ? formatNumber(r.lifetimeMeterReadWh / 1000, 0)
                          : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function InvoiceStatusSection({
  invoiceStatus,
  onJump,
}: {
  invoiceStatus: SystemDetailResponse["invoiceStatus"];
  onJump: () => void;
}) {
  const { utilityInvoices, iccReport } = invoiceStatus;
  const noData =
    utilityInvoices.count === 0 && iccReport === null;

  // Roll-up: % of contracted REC quantity already invoiced. Useful
  // sanity check that the system is on track. Only meaningful when
  // the ICC report has a contractedRecs value AND we've seen any
  // utility invoice with a totalRecs.
  const recsInvoicedPct = useMemo(() => {
    if (!iccReport?.contractedRecs || iccReport.contractedRecs <= 0) return null;
    if (utilityInvoices.totalRecs === null) return null;
    return (utilityInvoices.totalRecs / iccReport.contractedRecs) * 100;
  }, [iccReport, utilityInvoices.totalRecs]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="text-base">Invoice status</CardTitle>
            <CardDescription>
              Utility invoices paid + ICC contract value baseline.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={onJump}>
            <ArrowUpRight className="h-3.5 w-3.5 mr-1" />
            Open settlement
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {noData ? (
          <NoData
            primary="No invoice data on file."
            secondary="Upload ABP Utility Invoice + ICC Report 3 datasets to populate this section. Verify the system's `systemId` matches the invoice rows."
          />
        ) : (
          <>
            <dl className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-3 text-sm">
              <Field
                label="Invoices on file"
                value={utilityInvoices.count.toString()}
              />
              <Field
                label="Total invoiced"
                value={
                  utilityInvoices.totalInvoiceAmount !== null
                    ? formatMoney(utilityInvoices.totalInvoiceAmount)
                    : "—"
                }
              />
              <Field
                label="Total RECs invoiced"
                value={
                  utilityInvoices.totalRecs !== null
                    ? formatNumber(utilityInvoices.totalRecs, 0)
                    : "—"
                }
              />
              <Field
                label="ICC contracted RECs"
                value={
                  iccReport?.contractedRecs !== undefined &&
                  iccReport?.contractedRecs !== null
                    ? formatNumber(iccReport.contractedRecs, 0)
                    : "—"
                }
              />
              <Field
                label="ICC contract value"
                value={
                  iccReport?.grossContractValue !== undefined &&
                  iccReport?.grossContractValue !== null
                    ? formatMoney(iccReport.grossContractValue)
                    : "—"
                }
              />
              <Field
                label="ICC REC price"
                value={
                  iccReport?.recPrice !== undefined &&
                  iccReport?.recPrice !== null
                    ? formatMoney(iccReport.recPrice)
                    : "—"
                }
              />
              <Field
                label="% of contract invoiced"
                value={
                  recsInvoicedPct !== null
                    ? `${formatNumber(recsInvoicedPct, 1)}%`
                    : "—"
                }
              />
              <Field
                label="Scheduled energization"
                value={iccReport?.scheduledEnergizationDate ?? "—"}
              />
            </dl>

            {utilityInvoices.rows.length > 0 && (
              <div className="mt-3">
                <p className="text-xs text-muted-foreground mb-1">
                  Recent utility invoices
                </p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Payment #</TableHead>
                      <TableHead>RECs</TableHead>
                      <TableHead>REC price</TableHead>
                      <TableHead>Invoice amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {utilityInvoices.rows.map((r, i) => (
                      <TableRow key={`${r.paymentNumber ?? "noPayment"}-${i}`}>
                        <TableCell className="text-xs font-mono">
                          {r.paymentNumber ?? "—"}
                        </TableCell>
                        <TableCell className="text-xs">
                          {r.totalRecs !== null
                            ? formatNumber(r.totalRecs, 0)
                            : "—"}
                        </TableCell>
                        <TableCell className="text-xs">
                          {r.recPrice !== null
                            ? formatMoney(r.recPrice)
                            : "—"}
                        </TableCell>
                        <TableCell className="text-xs">
                          {r.invoiceAmount !== null
                            ? formatMoney(r.invoiceAmount)
                            : "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function AddressSection({
  registry,
  contractScan,
  onJump,
}: {
  registry: SystemDetailResponse["registry"];
  contractScan: SystemDetailResponse["contractScan"];
  onJump: () => void;
}) {
  const comparison = useMemo(
    () =>
      compareAddresses(
        contractScan
          ? {
              mailingAddress1: contractScan.mailingAddress1,
              mailingAddress2: contractScan.mailingAddress2,
              cityStateZip: contractScan.cityStateZip,
              payeeName: contractScan.payeeName,
            }
          : null,
        registry
          ? {
              state: registry.state,
              zipCode: registry.zipCode,
              county: registry.county,
            }
          : null
      ),
    [contractScan, registry]
  );

  const overallLabel = useMemo(() => {
    switch (comparison.overall) {
      case "match":
        return { text: "Sources agree", variant: "outline" as const };
      case "mismatch":
        return { text: "Mismatch detected", variant: "destructive" as const };
      case "partial":
        return { text: "Partial data", variant: "secondary" as const };
      default:
        return { text: "No address data", variant: "outline" as const };
    }
  }, [comparison.overall]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <MapPin className="h-4 w-4" />
              Address
              <Badge variant={overallLabel.variant} className="text-xs">
                {overallLabel.text}
              </Badge>
            </CardTitle>
            <CardDescription>
              Mailing + service-location addresses on file. Cross-checks
              the contract scan against Solar Applications. Run a USPS
              verification via Address Checker for deliverability.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={onJump}>
            <ArrowUpRight className="h-3.5 w-3.5 mr-1" />
            Address Checker
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {comparison.overall === "none" ? (
          <NoData
            primary="No address data on file."
            secondary="Run a contract scrape including this CSG ID and confirm Solar Applications has the system's state + zip."
          />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {/* Contract scan source */}
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                Contract scan (mailing)
              </p>
              {!contractScan ? (
                <p className="text-sm text-muted-foreground">
                  No contract scan on file.
                </p>
              ) : (
                <dl className="space-y-1 text-sm">
                  <Field
                    label="Payee"
                    value={contractScan.payeeName ?? "—"}
                  />
                  <Field
                    label="Address 1"
                    value={contractScan.mailingAddress1 ?? "—"}
                  />
                  <Field
                    label="Address 2"
                    value={contractScan.mailingAddress2 ?? "—"}
                  />
                  <Field
                    label="City, ST ZIP"
                    value={contractScan.cityStateZip ?? "—"}
                  />
                  {(comparison.contractCity ||
                    comparison.contractState ||
                    comparison.contractZip) && (
                    <p className="text-[10px] text-muted-foreground pt-1">
                      Parsed: {comparison.contractCity ?? "?"} ·{" "}
                      {comparison.contractState ?? "?"} ·{" "}
                      {comparison.contractZip ?? "?"}
                    </p>
                  )}
                </dl>
              )}
            </div>

            {/* Solar Applications source */}
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                Solar Applications (registry)
              </p>
              {!registry ? (
                <p className="text-sm text-muted-foreground">
                  No registry record.
                </p>
              ) : (
                <dl className="space-y-1 text-sm">
                  <Field label="County" value={registry.county ?? "—"} />
                  <Field label="State" value={registry.state ?? "—"} />
                  <Field label="ZIP" value={registry.zipCode ?? "—"} />
                </dl>
              )}
            </div>

            {/* Comparison rollup */}
            {comparison.overall !== "partial" && (
              <div className="md:col-span-2 pt-2 border-t">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                  Cross-source check
                </p>
                <div className="grid grid-cols-2 gap-x-6 text-sm">
                  <div className="flex items-center gap-2">
                    {matchIcon(comparison.zipMatch)}
                    <span className="text-muted-foreground">ZIP:</span>
                    <span>{matchLabel(comparison.zipMatch)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {matchIcon(comparison.stateMatch)}
                    <span className="text-muted-foreground">State:</span>
                    <span>{matchLabel(comparison.stateMatch)}</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function matchIcon(status: ReturnType<typeof compareAddresses>["zipMatch"]) {
  if (status === "match")
    return <CircleCheck className="h-3.5 w-3.5 text-green-600" />;
  if (status === "mismatch")
    return <CircleAlert className="h-3.5 w-3.5 text-amber-600" />;
  return <CircleAlert className="h-3.5 w-3.5 text-muted-foreground" />;
}

function matchLabel(
  status: ReturnType<typeof compareAddresses>["zipMatch"]
): string {
  switch (status) {
    case "match":
      return "Matches";
    case "mismatch":
      return "Disagrees";
    case "missing-a":
      return "Contract scan missing";
    case "missing-b":
      return "Registry missing";
    case "missing-both":
      return "Both missing";
  }
}

function RecValueSection({
  registry,
  contractScan,
  scheduleBResult,
  invoiceStatus,
  onJump,
}: {
  registry: SystemDetailResponse["registry"];
  contractScan: SystemDetailResponse["contractScan"];
  scheduleBResult: SystemDetailResponse["scheduleBResult"];
  invoiceStatus: SystemDetailResponse["invoiceStatus"];
  onJump: () => void;
}) {
  const rollup = useMemo(
    () =>
      buildRecValueRollup({
        registry: registry
          ? {
              totalContractAmount: registry.totalContractAmount,
              recPrice: registry.recPrice,
              annualRecs: registry.annualRecs,
            }
          : null,
        contractScan: contractScan
          ? {
              recQuantity: contractScan.recQuantity,
              recPrice: contractScan.recPrice,
            }
          : null,
        scheduleB: scheduleBResult
          ? {
              maxRecQuantity: scheduleBResult.maxRecQuantity,
              contractPrice: scheduleBResult.contractPrice,
              deliveryYearsJson: scheduleBResult.deliveryYearsJson,
            }
          : null,
        iccReport: invoiceStatus.iccReport
          ? {
              contractedRecs: invoiceStatus.iccReport.contractedRecs,
              recPrice: invoiceStatus.iccReport.recPrice,
              grossContractValue: invoiceStatus.iccReport.grossContractValue,
            }
          : null,
        utilityInvoices:
          invoiceStatus.utilityInvoices.count > 0
            ? {
                totalRecs: invoiceStatus.utilityInvoices.totalRecs,
                totalInvoiceAmount:
                  invoiceStatus.utilityInvoices.totalInvoiceAmount,
              }
            : null,
      }),
    [registry, contractScan, scheduleBResult, invoiceStatus]
  );

  const noContractedData =
    rollup.contractedRecs.value === null &&
    rollup.contractedRecPrice.value === null &&
    rollup.contractedTotalValue.value === null;
  const noPaidData =
    rollup.paidRecs === null && rollup.paidTotalValue === null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="text-base">REC value</CardTitle>
            <CardDescription>
              Contracted vs paid-to-date with the most authoritative
              source picked per field.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={onJump}>
            <ArrowUpRight className="h-3.5 w-3.5 mr-1" />
            Early Payment
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {noContractedData && noPaidData ? (
          <NoData
            primary="No REC value data on file."
            secondary="Run a contract scrape, upload a Schedule B PDF, or import the ICC Report 3 dataset to populate this section."
          />
        ) : (
          <>
            <dl className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-3 text-sm">
              <FieldWithSource
                label="Contracted RECs"
                value={
                  rollup.contractedRecs.value !== null
                    ? formatNumber(rollup.contractedRecs.value, 0)
                    : "—"
                }
                source={recValueSourceLabel(rollup.contractedRecs.source)}
              />
              <FieldWithSource
                label="REC price"
                value={
                  rollup.contractedRecPrice.value !== null
                    ? formatMoney(rollup.contractedRecPrice.value)
                    : "—"
                }
                source={recValueSourceLabel(
                  rollup.contractedRecPrice.source
                )}
              />
              <FieldWithSource
                label="Total contract value"
                value={
                  rollup.contractedTotalValue.value !== null
                    ? formatMoney(rollup.contractedTotalValue.value)
                    : "—"
                }
                source={recValueSourceLabel(
                  rollup.contractedTotalValue.source
                )}
              />
              <Field
                label="RECs invoiced to date"
                value={
                  rollup.paidRecs !== null
                    ? formatNumber(rollup.paidRecs, 0)
                    : "—"
                }
              />
              <Field
                label="$ invoiced to date"
                value={
                  rollup.paidTotalValue !== null
                    ? formatMoney(rollup.paidTotalValue)
                    : "—"
                }
              />
              <Field
                label="Outstanding value"
                value={
                  rollup.outstandingValue !== null
                    ? formatMoney(rollup.outstandingValue)
                    : "—"
                }
              />
              <Field
                label="% RECs delivered"
                value={
                  rollup.pctDelivered !== null
                    ? `${formatNumber(
                        Math.min(rollup.pctDelivered, 999),
                        1
                      )}%`
                    : "—"
                }
              />
              {registry?.annualRecs !== undefined &&
                registry.annualRecs !== null && (
                  <Field
                    label="Annual production estimate"
                    value={`${formatNumber(registry.annualRecs, 0)} RECs/yr`}
                  />
                )}
            </dl>

            {rollup.deliveryYears.length > 0 && (
              <div className="mt-3 pt-3 border-t">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                  Per-year delivery schedule (Schedule B)
                </p>
                <div className="flex flex-wrap gap-2">
                  {rollup.deliveryYears.map((y) => (
                    <Badge
                      key={y.year}
                      variant="outline"
                      className="text-xs"
                    >
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

function FieldWithSource({
  label,
  value,
  source,
}: {
  label: string;
  value: string;
  source: string;
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{value}</dd>
      {source !== "—" && (
        <p className="text-[10px] text-muted-foreground mt-0.5">
          from {source}
        </p>
      )}
    </div>
  );
}

function OwnershipSection({
  ownership,
  registry,
  onJump,
}: {
  ownership: SystemDetailResponse["ownership"];
  registry: SystemDetailResponse["registry"];
  onJump: () => void;
}) {
  const trackingId = registry?.trackingSystemRefId ?? null;
  const noData = ownership.count === 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              Ownership
              {ownership.count > 0 && (
                <Badge variant="outline" className="text-xs">
                  {ownership.count} transfer
                  {ownership.count === 1 ? "" : "s"}
                </Badge>
              )}
            </CardTitle>
            <CardDescription>
              REC ownership transfers from GATS / MRETS, joined on the
              system's tracking unit ID.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={onJump}>
            <ArrowUpRight className="h-3.5 w-3.5 mr-1" />
            Open dashboard
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {noData ? (
          <NoData
            primary={
              trackingId
                ? "No transfer history on file."
                : "No tracking ID resolved for this system."
            }
            secondary={
              trackingId
                ? "Upload the latest Transfer History dataset to populate this section."
                : "The Solar Applications row for this system is missing `tracking_system_ref_id` (or PJM_GATS / MRETS Unit ID Part 2). Without it, transfer rows can't be joined."
            }
          />
        ) : (
          <>
            <dl className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-3 text-sm">
              <Field
                label="Latest transfer"
                value={ownership.latestTransferDate ?? "—"}
              />
              <Field
                label="Total RECs transferred"
                value={
                  ownership.totalQuantityTransferred !== null
                    ? formatNumber(ownership.totalQuantityTransferred, 0)
                    : "—"
                }
              />
              <Field
                label="Distinct transferors"
                value={ownership.uniqueTransferors.length.toString()}
              />
              <Field
                label="Distinct transferees"
                value={ownership.uniqueTransferees.length.toString()}
              />
            </dl>

            {(ownership.uniqueTransferors.length > 0 ||
              ownership.uniqueTransferees.length > 0) && (
              <div className="mt-3 pt-3 border-t grid gap-3 md:grid-cols-2">
                {ownership.uniqueTransferors.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                      Transferors
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {ownership.uniqueTransferors.map((name) => (
                        <Badge
                          key={name}
                          variant="secondary"
                          className="text-xs font-normal"
                        >
                          {name}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
                {ownership.uniqueTransferees.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                      Transferees
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {ownership.uniqueTransferees.map((name) => (
                        <Badge
                          key={name}
                          variant="secondary"
                          className="text-xs font-normal"
                        >
                          {name}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="mt-3 pt-3 border-t">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                Recent transfers
              </p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Completion date</TableHead>
                    <TableHead>Transferor</TableHead>
                    <TableHead>Transferee</TableHead>
                    <TableHead>Quantity</TableHead>
                    <TableHead>Txn ID</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {ownership.transfers.map((t, i) => (
                    <TableRow
                      key={`${t.transactionId ?? "no-txn"}-${i}`}
                    >
                      <TableCell className="text-xs font-mono">
                        {t.transferCompletionDate ?? "—"}
                      </TableCell>
                      <TableCell
                        className="text-xs truncate max-w-[180px]"
                        title={t.transferor ?? ""}
                      >
                        {t.transferor ?? "—"}
                      </TableCell>
                      <TableCell
                        className="text-xs truncate max-w-[180px]"
                        title={t.transferee ?? ""}
                      >
                        {t.transferee ?? "—"}
                      </TableCell>
                      <TableCell className="text-xs">
                        {t.quantity !== null
                          ? formatNumber(t.quantity, 0)
                          : "—"}
                      </TableCell>
                      <TableCell
                        className="text-xs font-mono truncate max-w-[140px]"
                        title={t.transactionId ?? ""}
                      >
                        {t.transactionId ?? "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
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

