/**
 * Phase E (2026-04-28) — admin Feedback Review Dashboard.
 *
 * Triages every row in `userFeedback` (the same table the
 * `GlobalFeedbackWidget` writes to). Pipeline summary chips up
 * top, a filter bar (status / category / page-path / search), and
 * a table per row with an inline status dropdown that fires
 * `feedback.updateStatus`.
 *
 * Gated by `adminProcedure` on the server; the client also
 * guards via the route component (the role check happens in
 * `App.tsx` so non-admins land on a friendlier message instead of
 * a tRPC FORBIDDEN screen).
 */

import { useMemo, useState } from "react";
import { ArrowLeft, MessageSquareText, Loader2 } from "lucide-react";
import { Link } from "wouter";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";
import {
  FEEDBACK_STATUSES,
  FEEDBACK_CATEGORIES,
  filterFeedbackRows,
  sortFeedbackForReview,
  topPagePaths,
  type FeedbackStatus,
} from "@shared/feedback.helpers";

const STATUS_LABELS: Record<FeedbackStatus, string> = {
  open: "Open",
  triaged: "Triaged",
  "in-progress": "In progress",
  resolved: "Resolved",
  "wont-fix": "Won't fix",
};

const STATUS_BADGE_CLASSES: Record<FeedbackStatus, string> = {
  open: "bg-amber-500/15 text-amber-700 border-amber-500/40",
  triaged: "bg-sky-500/15 text-sky-700 border-sky-500/40",
  "in-progress": "bg-violet-500/15 text-violet-700 border-violet-500/40",
  resolved: "bg-emerald-500/15 text-emerald-700 border-emerald-500/40",
  "wont-fix": "bg-slate-500/15 text-slate-600 border-slate-500/40",
};

const CATEGORY_LABELS: Record<string, string> = {
  improvement: "Improvement",
  bug: "Bug",
  ui: "UI",
  data: "Data",
  workflow: "Workflow",
  other: "Other",
};

function formatTimestamp(value: unknown): string {
  if (value == null) return "—";
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function tryFormatJson(value: string | null): string {
  if (!value) return "";
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

export default function FeedbackReviewDashboard() {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [pathFilter, setPathFilter] = useState<string>("all");
  const [search, setSearch] = useState("");

  const utils = trpc.useUtils();
  const listQuery = trpc.feedback.listRecent.useQuery(
    { limit: 500 },
    { staleTime: 30_000, refetchOnWindowFocus: false }
  );

  const updateStatus = trpc.feedback.updateStatus.useMutation({
    onSuccess: async (result, variables) => {
      if (!result.updated) {
        toast.error("That row no longer exists — refreshing the list.");
      } else {
        toast.success(
          `Status set to ${STATUS_LABELS[variables.status as FeedbackStatus] ?? variables.status}`
        );
      }
      await utils.feedback.listRecent.invalidate();
    },
    onError: (error) => {
      toast.error(`Update failed: ${error.message}`);
    },
  });

  const allRows = useMemo(() => listQuery.data?.rows ?? [], [listQuery.data]);
  const statusCounts = listQuery.data?.statusCounts;

  const pagePathOptions = useMemo(() => topPagePaths(allRows, 24), [allRows]);

  const filtered = useMemo(() => {
    const byPath =
      pathFilter === "all"
        ? allRows
        : allRows.filter((r) => r.pagePath === pathFilter);
    const filtered = filterFeedbackRows(byPath, {
      status: statusFilter,
      category: categoryFilter,
      search,
    });
    return sortFeedbackForReview(filtered);
  }, [allRows, pathFilter, statusFilter, categoryFilter, search]);

  const totalUnseen = (statusCounts?.open ?? 0) + (statusCounts?.triaged ?? 0);

  return (
    <div className="container max-w-6xl space-y-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <MessageSquareText className="h-5 w-5 text-amber-600" />
          <h1 className="text-2xl font-semibold">Feedback Review</h1>
          {totalUnseen > 0 ? (
            <Badge variant="outline" className="ml-2 border-amber-500/40 text-amber-700">
              {totalUnseen} awaiting triage
            </Badge>
          ) : null}
        </div>
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3" />
          Back to dashboard
        </Link>
      </header>

      {/* Pipeline summary chips */}
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {FEEDBACK_STATUSES.map((status) => {
          const count = statusCounts?.[status] ?? 0;
          const active = statusFilter === status;
          return (
            <button
              key={status}
              type="button"
              onClick={() =>
                setStatusFilter((prev) => (prev === status ? "all" : status))
              }
              className={`rounded-md border px-3 py-2 text-left transition ${
                active
                  ? "border-primary bg-primary/10"
                  : "border-slate-200 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-900"
              }`}
            >
              <div className="text-xs uppercase tracking-wider text-muted-foreground">
                {STATUS_LABELS[status]}
              </div>
              <div className="text-2xl font-semibold tabular-nums">
                {count}
              </div>
            </button>
          );
        })}
      </div>

      {/* Filter bar */}
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">Status</label>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {FEEDBACK_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">Category</label>
            <Select value={categoryFilter} onValueChange={setCategoryFilter}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {FEEDBACK_CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {CATEGORY_LABELS[c] ?? c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">Page</label>
            <Select value={pathFilter} onValueChange={setPathFilter}>
              <SelectTrigger className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All pages</SelectItem>
                {pagePathOptions.map((p) => (
                  <SelectItem key={p.pagePath} value={p.pagePath}>
                    {p.pagePath} ({p.count})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex grow flex-col gap-1">
            <label className="text-xs text-muted-foreground" htmlFor="feedback-search">
              Search
            </label>
            <Input
              id="feedback-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search note, page, or section…"
            />
          </div>

          {(statusFilter !== "all" ||
            categoryFilter !== "all" ||
            pathFilter !== "all" ||
            search.trim()) && (
            <Button
              variant="ghost"
              onClick={() => {
                setStatusFilter("all");
                setCategoryFilter("all");
                setPathFilter("all");
                setSearch("");
              }}
            >
              Clear
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          {listQuery.isLoading ? (
            <div className="space-y-2 p-4">
              {[0, 1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">
              No feedback matches the current filters.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-32">Status</TableHead>
                  <TableHead className="w-28">Category</TableHead>
                  <TableHead className="w-44">Submitted</TableHead>
                  <TableHead className="w-16">User</TableHead>
                  <TableHead>Page</TableHead>
                  <TableHead>Note</TableHead>
                  <TableHead className="w-24">Context</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((row) => (
                  <TableRow key={row.id} className="align-top">
                    <TableCell>
                      <StatusCell
                        currentStatus={row.status}
                        disabled={updateStatus.isPending}
                        onChange={(next) =>
                          updateStatus.mutate({ id: row.id, status: next })
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="capitalize">
                        {CATEGORY_LABELS[row.category] ?? row.category}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatTimestamp(row.createdAt)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground tabular-nums">
                      #{row.userId}
                    </TableCell>
                    <TableCell className="max-w-xs whitespace-normal text-xs">
                      <div className="font-mono">{row.pagePath}</div>
                      {row.sectionId ? (
                        <div className="text-muted-foreground">
                          {row.sectionId}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="max-w-md whitespace-normal text-sm">
                      {row.note}
                    </TableCell>
                    <TableCell>
                      {row.contextJson ? (
                        <Popover>
                          <PopoverTrigger asChild>
                            <Button variant="outline" size="sm">
                              View
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent
                            align="end"
                            className="max-h-96 w-96 overflow-auto"
                          >
                            <pre className="text-xs">
                              {tryFormatJson(row.contextJson)}
                            </pre>
                          </PopoverContent>
                        </Popover>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Showing {filtered.length} of {allRows.length} loaded rows. The
        list refetches on demand — switch tabs and back to refresh.
      </p>
    </div>
  );
}

function StatusCell({
  currentStatus,
  onChange,
  disabled,
}: {
  currentStatus: string;
  onChange: (next: FeedbackStatus) => void;
  disabled: boolean;
}) {
  const known = (FEEDBACK_STATUSES as readonly string[]).includes(currentStatus)
    ? (currentStatus as FeedbackStatus)
    : "open";
  const klass = STATUS_BADGE_CLASSES[known];
  return (
    <div className="flex items-center gap-2">
      <Select
        value={known}
        onValueChange={(value) => onChange(value as FeedbackStatus)}
        disabled={disabled}
      >
        <SelectTrigger className={`h-8 w-32 ${klass}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {FEEDBACK_STATUSES.map((s) => (
            <SelectItem key={s} value={s}>
              {STATUS_LABELS[s]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {disabled ? (
        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
      ) : null}
    </div>
  );
}
