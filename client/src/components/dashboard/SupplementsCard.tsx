import { Pill, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SectionRating } from "@/components/SectionRating";
import { SUPPLEMENT_UNITS } from "@shared/const";
import type { SupplementDefinition, SupplementLog } from "@/features/dashboard/types";

type SupplementUnit = (typeof SUPPLEMENT_UNITS)[number];

export interface SupplementsCardProps {
  // Data
  supplementName: string;
  supplementDose: string;
  supplementDoseUnit: SupplementUnit;
  supplementTiming: "am" | "pm";
  supplementDefinitions: SupplementDefinition[] | undefined;
  supplementLogs: SupplementLog[] | undefined;
  sectionRating: number | undefined;

  // Handlers
  setSupplementName: (name: string) => void;
  setSupplementDose: (dose: string) => void;
  setSupplementDoseUnit: (unit: SupplementUnit) => void;
  setSupplementTiming: (timing: "am" | "pm") => void;
  onAddDefinition: () => void;
  onLogOnce: () => void;
  onToggleLock: (definitionId: string, isLocked: boolean) => void;
  onDeleteDefinition: (definitionId: string) => void;
  onDeleteLog: (logId: string) => void;

  // Mutation state
  addDefinitionPending: boolean;
  addLogPending: boolean;
}

export function SupplementsCard({
  supplementName,
  supplementDose,
  supplementDoseUnit,
  supplementTiming,
  supplementDefinitions,
  supplementLogs,
  sectionRating,
  setSupplementName,
  setSupplementDose,
  setSupplementDoseUnit,
  setSupplementTiming,
  onAddDefinition,
  onLogOnce,
  onToggleLock,
  onDeleteDefinition,
  onDeleteLog,
  addDefinitionPending,
  addLogPending,
}: SupplementsCardProps) {
  return (
    <Card className="min-w-0 flex flex-col">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <div className="flex items-center gap-2">
          <Pill className="h-4 w-4 text-emerald-600" />
          <CardTitle className="text-base">Supplements</CardTitle>
        </div>
        <SectionRating
          sectionId="section-supplements"
          currentRating={sectionRating as never}
        />
      </CardHeader>
      <CardContent className="space-y-3 min-w-0">
        <div className="space-y-2 min-w-0">
          <Input
            value={supplementName}
            onChange={(e) => setSupplementName(e.target.value)}
            placeholder="Supplement"
            className="h-9 min-w-0 text-sm"
          />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 min-w-0">
            <Input
              value={supplementDose}
              onChange={(e) => setSupplementDose(e.target.value)}
              placeholder="Dose"
              className="h-9 min-w-0 text-sm"
            />
            <Select
              value={supplementDoseUnit}
              onValueChange={(value) =>
                setSupplementDoseUnit(value as SupplementUnit)
              }
            >
              <SelectTrigger className="h-9 w-full min-w-0 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SUPPLEMENT_UNITS.map((unit) => (
                  <SelectItem key={unit} value={unit}>
                    {unit}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 min-w-0">
            <Select
              value={supplementTiming}
              onValueChange={(value) =>
                setSupplementTiming(value as "am" | "pm")
              }
            >
              <SelectTrigger className="h-9 w-full min-w-0 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="am">am</SelectItem>
                <SelectItem value="pm">pm</SelectItem>
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant="outline"
              className="h-9 w-full text-sm"
              onClick={onAddDefinition}
              disabled={addDefinitionPending}
            >
              Add to List
            </Button>
            <Button
              size="sm"
              className="h-9 w-full text-sm"
              onClick={onLogOnce}
              disabled={addLogPending}
            >
              Log Once
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Lock items below to auto-log daily.
        </p>

        <div className="space-y-1 max-h-28 overflow-y-auto pr-1">
          {(supplementDefinitions || []).length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No curated supplements yet.
            </p>
          ) : (
            (supplementDefinitions || []).map((definition) => (
              <div
                key={definition.id}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md border border-border bg-muted px-2 py-1.5"
              >
                <p className="min-w-0 break-words pr-1 text-xs leading-tight text-slate-800">
                  {definition.name} • {definition.dose} {definition.doseUnit} •{" "}
                  {definition.timing}
                </p>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant={definition.isLocked ? "default" : "outline"}
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={() =>
                      onToggleLock(definition.id, !definition.isLocked)
                    }
                  >
                    {definition.isLocked ? "Locked" : "Lock"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0"
                    onClick={() => onDeleteDefinition(definition.id)}
                  >
                    <Trash2 className="h-3 w-3 text-muted-foreground" />
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
        <div className="space-y-1 max-h-40 overflow-y-auto pr-1">
          {(supplementLogs || []).length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No supplements logged today.
            </p>
          ) : (
            (supplementLogs || []).map((log) => (
              <div
                key={log.id}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md border border-emerald-100 bg-emerald-50 px-2 py-1.5"
              >
                <div className="min-w-0 pr-1">
                  <p className="break-words text-xs font-medium leading-tight text-emerald-900">
                    {log.name} • {log.dose} {log.doseUnit} • {log.timing}
                    {log.autoLogged ? " • auto" : ""}
                  </p>
                  <p className="text-xs text-emerald-700">
                    {new Date(log.takenAt).toLocaleTimeString("en-US", {
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 shrink-0 p-0"
                  onClick={() => onDeleteLog(log.id)}
                >
                  <Trash2 className="h-3 w-3 text-emerald-700" />
                </Button>
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}
