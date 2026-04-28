/**
 * Today's supplements — split by AM / PM with quick lock toggle,
 * log-once form, and delete.
 *
 * Mutations reuse the already-existing tRPC procedures; no new calls here.
 */

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { SUPPLEMENT_UNITS, type SupplementUnit } from "@shared/const";
import { toErrorMessage, toLocalDateKey } from "@/lib/helpers";
import type {
  SupplementDefinition,
  SupplementLog,
} from "@/features/dashboard/types";

export interface SupplementsTodayPanelProps {
  definitions: readonly SupplementDefinition[];
  logs: readonly SupplementLog[];
  onChanged: () => void;
}

interface NewLogDraft {
  name: string;
  dose: string;
  doseUnit: SupplementUnit;
  timing: "am" | "pm";
}

const EMPTY_DRAFT: NewLogDraft = {
  name: "",
  dose: "",
  doseUnit: "capsule",
  timing: "am",
};

export function SupplementsTodayPanel({
  definitions,
  logs,
  onChanged,
}: SupplementsTodayPanelProps) {
  const [draft, setDraft] = useState<NewLogDraft>(EMPTY_DRAFT);
  const today = toLocalDateKey();

  const addLog = trpc.supplements.addLog.useMutation();
  const deleteLog = trpc.supplements.deleteLog.useMutation();
  const setLock = trpc.supplements.setDefinitionLock.useMutation();
  // Phase E (2026-04-28) — "Log all AM/PM" batch. Server skips
  // any supplement already logged today (idempotent), so a
  // double-click is safe.
  const logAllForTiming = trpc.supplements.logAllForTiming.useMutation();

  const todaysLogs = logs.filter((l) => l.dateKey === today);
  const amLogs = todaysLogs.filter((l) => l.timing === "am");
  const pmLogs = todaysLogs.filter((l) => l.timing === "pm");

  async function logAll(timing: "am" | "pm") {
    try {
      const result = await logAllForTiming.mutateAsync({ timing });
      if (result.logged === 0 && result.skipped === 0) {
        toast.info(`No ${timing.toUpperCase()} supplements to log.`);
      } else if (result.logged === 0) {
        toast.info(`All ${timing.toUpperCase()} supplements already logged.`);
      } else {
        const skipMsg =
          result.skipped > 0
            ? ` (${result.skipped} already logged)`
            : "";
        toast.success(
          `Logged ${result.logged} ${timing.toUpperCase()} supplement${result.logged === 1 ? "" : "s"}${skipMsg}`
        );
      }
      onChanged();
    } catch (error) {
      toast.error(toErrorMessage(error));
    }
  }

  async function submitDraft() {
    if (!draft.name.trim() || !draft.dose.trim()) {
      toast.error("Name and dose are required.");
      return;
    }
    try {
      await addLog.mutateAsync({
        name: draft.name.trim(),
        dose: draft.dose.trim(),
        doseUnit: draft.doseUnit,
        timing: draft.timing,
      });
      setDraft(EMPTY_DRAFT);
      onChanged();
    } catch (error) {
      toast.error(toErrorMessage(error));
    }
  }

  async function removeLog(id: string) {
    try {
      await deleteLog.mutateAsync({ id });
      onChanged();
    } catch (error) {
      toast.error(toErrorMessage(error));
    }
  }

  async function toggleLock(definitionId: string, isLocked: boolean) {
    try {
      await setLock.mutateAsync({ definitionId, isLocked });
      onChanged();
    } catch (error) {
      toast.error(toErrorMessage(error));
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Log a supplement</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 sm:grid-cols-[1fr_1fr_120px_90px_auto]">
          <Input
            placeholder="Name"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
          <Input
            placeholder="Dose"
            value={draft.dose}
            onChange={(e) => setDraft({ ...draft, dose: e.target.value })}
          />
          <Select
            value={draft.doseUnit}
            onValueChange={(v) => setDraft({ ...draft, doseUnit: v as SupplementUnit })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SUPPLEMENT_UNITS.map((u) => (
                <SelectItem key={u} value={u}>
                  {u}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={draft.timing}
            onValueChange={(v) => setDraft({ ...draft, timing: v as "am" | "pm" })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="am">am</SelectItem>
              <SelectItem value="pm">pm</SelectItem>
            </SelectContent>
          </Select>
          <Button onClick={submitDraft} disabled={addLog.isPending}>
            <Plus className="mr-1 h-3 w-3" />
            Log
          </Button>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <TimingColumn
          title="Morning"
          timing="am"
          definitions={definitions}
          todaysLogs={amLogs}
          onToggleLock={toggleLock}
          onDeleteLog={removeLog}
          onLogAll={() => logAll("am")}
          logAllPending={
            logAllForTiming.isPending &&
            logAllForTiming.variables?.timing === "am"
          }
        />
        <TimingColumn
          title="Evening"
          timing="pm"
          definitions={definitions}
          todaysLogs={pmLogs}
          onToggleLock={toggleLock}
          onDeleteLog={removeLog}
          onLogAll={() => logAll("pm")}
          logAllPending={
            logAllForTiming.isPending &&
            logAllForTiming.variables?.timing === "pm"
          }
        />
      </div>
    </div>
  );
}

interface TimingColumnProps {
  title: string;
  timing: "am" | "pm";
  definitions: readonly SupplementDefinition[];
  todaysLogs: readonly SupplementLog[];
  onToggleLock: (definitionId: string, isLocked: boolean) => void;
  onDeleteLog: (id: string) => void;
  onLogAll: () => void;
  logAllPending: boolean;
}

function TimingColumn({
  title,
  timing,
  definitions,
  todaysLogs,
  onToggleLock,
  onDeleteLog,
  onLogAll,
  logAllPending,
}: TimingColumnProps) {
  const timingDefinitions = definitions.filter(
    (d) => d.isActive && d.timing === timing
  );
  // Phase E (2026-04-28) — disable "Log all" when there are no
  // active supplements for this timing OR every active one already
  // has a today's log. The proc would no-op in those cases anyway,
  // but disabling the button avoids a "nothing to log" toast for
  // a user who clicked nothing.
  const loggedDefinitionIds = new Set(
    todaysLogs
      .filter((log) => log.definitionId !== null)
      .map((log) => log.definitionId)
  );
  const unloggedCount = timingDefinitions.filter(
    (def) => !loggedDefinitionIds.has(def.id)
  ).length;
  return (
    <Card>
      <CardHeader className="pb-2 flex flex-row items-center justify-between">
        <CardTitle className="text-sm">{title}</CardTitle>
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 text-xs"
          onClick={onLogAll}
          disabled={logAllPending || unloggedCount === 0}
          title={
            unloggedCount === 0
              ? `All ${title.toLowerCase()} supplements already logged today`
              : `Log all ${unloggedCount} unlogged ${title.toLowerCase()} supplements`
          }
        >
          {logAllPending
            ? "Logging…"
            : unloggedCount === 0
              ? "All logged"
              : `Log all (${unloggedCount})`}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <section className="space-y-1">
          <h4 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Protocol
          </h4>
          {timingDefinitions.length === 0 ? (
            <p className="text-xs text-muted-foreground">No {timing} supplements.</p>
          ) : (
            timingDefinitions.map((def) => (
              <div
                key={def.id}
                className="flex items-center justify-between rounded-md border bg-muted px-2 py-1.5 text-xs"
              >
                <span className="min-w-0 truncate">
                  {def.name} · {def.dose} {def.doseUnit}
                </span>
                <Button
                  size="sm"
                  variant={def.isLocked ? "default" : "outline"}
                  className="h-6 px-2 text-xs"
                  onClick={() => onToggleLock(def.id, !def.isLocked)}
                >
                  {def.isLocked ? "Locked" : "Lock"}
                </Button>
              </div>
            ))
          )}
        </section>

        <section className="space-y-1">
          <h4 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Logged today
          </h4>
          {todaysLogs.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nothing logged.</p>
          ) : (
            todaysLogs.map((log) => (
              <div
                key={log.id}
                className="flex items-center justify-between rounded-md border border-emerald-100 bg-emerald-50 px-2 py-1.5 text-xs text-emerald-900"
              >
                <span className="min-w-0 truncate">
                  {log.name} · {log.dose} {log.doseUnit}
                  {log.autoLogged ? " · auto" : ""}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 w-6 p-0 text-emerald-700"
                  onClick={() => onDeleteLog(log.id)}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            ))
          )}
        </section>
      </CardContent>
    </Card>
  );
}
