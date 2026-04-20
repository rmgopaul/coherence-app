/**
 * Experiment list + start dialog, rendered above the correlation canvas.
 * An experiment ties a hypothesis to a window; ending it captures the
 * snapshot and leaves the report to the correlation analysis.
 */

import { useState } from "react";
import { FlaskConical, Plus } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { toErrorMessage, toLocalDateKey } from "@/lib/helpers";
import type { SupplementDefinition } from "@/features/dashboard/types";
import { METRIC_OPTIONS } from "./SupplementsInsightsPanel";

export interface SupplementsExperimentsProps {
  definitions: readonly SupplementDefinition[];
}

const METRIC_GROUPS = Array.from(new Set(METRIC_OPTIONS.map((m) => m.group)));

export function SupplementsExperiments({
  definitions,
}: SupplementsExperimentsProps) {
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [definitionId, setDefinitionId] = useState(definitions[0]?.id ?? "");
  const [hypothesis, setHypothesis] = useState("");
  const [startDateKey, setStartDateKey] = useState(toLocalDateKey());
  const [primaryMetric, setPrimaryMetric] = useState<string>("");
  const [notes, setNotes] = useState("");

  const { data: experiments = [] } = trpc.supplements.listExperiments.useQuery(
    undefined,
    { retry: false }
  );
  const create = trpc.supplements.createExperiment.useMutation();
  const end = trpc.supplements.endExperiment.useMutation();

  function reset() {
    setDefinitionId(definitions[0]?.id ?? "");
    setHypothesis("");
    setStartDateKey(toLocalDateKey());
    setPrimaryMetric("");
    setNotes("");
  }

  async function submit() {
    if (!definitionId || !hypothesis.trim()) {
      toast.error("Pick a supplement and enter a hypothesis.");
      return;
    }
    try {
      await create.mutateAsync({
        definitionId,
        hypothesis: hypothesis.trim(),
        startDateKey,
        primaryMetric:
          (primaryMetric as (typeof METRIC_OPTIONS)[number]["value"]) || undefined,
        notes: notes.trim() || undefined,
      });
      toast.success("Experiment started.");
      reset();
      setOpen(false);
      void utils.supplements.listExperiments.invalidate();
    } catch (err) {
      toast.error(toErrorMessage(err));
    }
  }

  async function endExperiment(id: string, status: "ended" | "abandoned") {
    try {
      await end.mutateAsync({
        id,
        endDateKey: toLocalDateKey(),
        status,
      });
      toast.success(status === "ended" ? "Experiment ended." : "Experiment abandoned.");
      void utils.supplements.listExperiments.invalidate();
    } catch (err) {
      toast.error(toErrorMessage(err));
    }
  }

  const defNameById = new Map(definitions.map((d) => [d.id, d.name]));
  const metricLabelByValue = new Map<string, string>(
    METRIC_OPTIONS.map((m) => [m.value, m.label])
  );

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <FlaskConical className="h-4 w-4 text-indigo-600" />
          Experiments
        </CardTitle>
        <Dialog
          open={open}
          onOpenChange={(o) => {
            setOpen(o);
            if (!o) reset();
          }}
        >
          <DialogTrigger asChild>
            <Button size="sm" variant="outline" disabled={definitions.length === 0}>
              <Plus className="mr-1 h-3 w-3" />
              Start experiment
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Start a supplement experiment</DialogTitle>
              <DialogDescription>
                Descriptive trial only — records a hypothesis and a window so
                you can compare health metrics before and after. Not medical
                advice.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3 pt-2">
              <div className="space-y-1">
                <Label>Supplement</Label>
                <Select value={definitionId} onValueChange={setDefinitionId}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {definitions.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="exp-hypothesis">Hypothesis</Label>
                <Textarea
                  id="exp-hypothesis"
                  value={hypothesis}
                  onChange={(e) => setHypothesis(e.target.value)}
                  placeholder="e.g. Taking magnesium before bed raises my recovery score."
                  rows={3}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="exp-start">Start date</Label>
                  <Input
                    id="exp-start"
                    type="date"
                    value={startDateKey}
                    onChange={(e) => setStartDateKey(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label>Primary metric (optional)</Label>
                  <Select
                    value={primaryMetric}
                    onValueChange={(v) => setPrimaryMetric(v === "__none" ? "" : v)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="—" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none">None</SelectItem>
                      {METRIC_GROUPS.map((group) => (
                        <SelectGroup key={group}>
                          <SelectLabel>{group}</SelectLabel>
                          {METRIC_OPTIONS.filter((m) => m.group === group).map((m) => (
                            <SelectItem key={m.value} value={m.value}>
                              {m.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="exp-notes">Notes (optional)</Label>
                <Textarea
                  id="exp-notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                />
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button onClick={submit} disabled={create.isPending}>
                Start
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent className="space-y-2">
        {experiments.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No experiments yet. Start one to tie a hypothesis to a window of
            time and compare health metrics.
          </p>
        ) : (
          <ul className="space-y-2">
            {experiments.map((exp) => {
              const name = defNameById.get(exp.definitionId) ?? "Unknown";
              const metricLabel = exp.primaryMetric
                ? metricLabelByValue.get(exp.primaryMetric)
                : null;
              return (
                <li
                  key={exp.id}
                  className="rounded-md border bg-muted/40 px-3 py-2 text-xs"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold">{name}</p>
                      <p className="break-words text-muted-foreground">
                        {exp.hypothesis}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      <Badge
                        variant={
                          exp.status === "active"
                            ? "default"
                            : exp.status === "ended"
                              ? "secondary"
                              : "outline"
                        }
                      >
                        {exp.status}
                      </Badge>
                      {exp.status === "active" ? (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 px-2 text-xs"
                            onClick={() => endExperiment(exp.id, "ended")}
                            disabled={end.isPending}
                          >
                            End
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 px-2 text-xs text-muted-foreground"
                            onClick={() => endExperiment(exp.id, "abandoned")}
                            disabled={end.isPending}
                          >
                            Abandon
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                    <span>
                      {exp.startDateKey}
                      {exp.endDateKey ? ` → ${exp.endDateKey}` : " → ongoing"}
                    </span>
                    {metricLabel ? (
                      <>
                        <span>·</span>
                        <span>metric: {metricLabel}</span>
                      </>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
