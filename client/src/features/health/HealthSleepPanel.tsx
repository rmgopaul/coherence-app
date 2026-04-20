/**
 * Sleep-focused view. Two halves:
 *   1. A picker + editor for one night's sleepNotes entry (tags + notes)
 *   2. A recent-nights list with sleep hours + score overlay
 */

import { useEffect, useMemo, useState } from "react";
import { Moon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { toErrorMessage, toLocalDateKey } from "@/lib/helpers";
import { SLEEP_QUICK_TAGS } from "./health.constants";
import { parseTags, stringifyTags, formatMetricValue } from "./health.helpers";

function daysAgoKey(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return toLocalDateKey(d);
}

const HISTORY_DAYS = 30;

export function HealthSleepPanel() {
  const utils = trpc.useUtils();
  const [dateKey, setDateKey] = useState<string>(toLocalDateKey());
  const [noteDraft, setNoteDraft] = useState<string>("");
  const [tagsDraft, setTagsDraft] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState<string>("");

  const { data: note } = trpc.sleep.getNote.useQuery(
    { dateKey },
    { retry: false }
  );

  useEffect(() => {
    setNoteDraft(note?.notes ?? "");
    setTagsDraft(parseTags(note?.tags ?? null));
  }, [note]);

  const upsert = trpc.sleep.upsertNote.useMutation();

  // Recent-nights metric history for the list below the editor.
  const { data: metricHistory = [] } = trpc.metrics.getHistory.useQuery(
    { limit: HISTORY_DAYS },
    { retry: false }
  );

  // Pre-fetch notes for the range so nights with journal entries can surface.
  const { data: notesRange = [] } = trpc.sleep.listNotesRange.useQuery(
    {
      startDateKey: daysAgoKey(HISTORY_DAYS - 1),
      endDateKey: toLocalDateKey(),
    },
    { retry: false }
  );

  const notesByDateKey = useMemo(
    () => new Map(notesRange.map((n) => [n.dateKey, n])),
    [notesRange]
  );

  async function save() {
    try {
      await upsert.mutateAsync({
        dateKey,
        tags: stringifyTags(tagsDraft),
        notes: noteDraft.trim() || null,
      });
      toast.success("Saved.");
      void utils.sleep.getNote.invalidate();
      void utils.sleep.listNotesRange.invalidate();
    } catch (err) {
      toast.error(toErrorMessage(err));
    }
  }

  function toggleTag(tag: string) {
    setTagsDraft((prev) => {
      const lower = tag.toLowerCase();
      const exists = prev.some((t) => t.toLowerCase() === lower);
      return exists ? prev.filter((t) => t.toLowerCase() !== lower) : [...prev, tag];
    });
  }

  function addCustomTag() {
    const t = tagInput.trim();
    if (!t) return;
    toggleTag(t);
    setTagInput("");
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-2 pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Moon className="h-4 w-4 text-indigo-600" />
            Sleep journal
          </CardTitle>
          <Input
            type="date"
            className="h-8 w-44"
            value={dateKey}
            onChange={(e) => setDateKey(e.target.value)}
          />
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Quick tags
            </p>
            <div className="flex flex-wrap gap-1">
              {SLEEP_QUICK_TAGS.map((tag) => {
                const active = tagsDraft.some(
                  (t) => t.toLowerCase() === tag.toLowerCase()
                );
                return (
                  <Button
                    key={tag}
                    size="sm"
                    variant={active ? "default" : "outline"}
                    className="h-7 px-2 text-xs"
                    onClick={() => toggleTag(tag)}
                  >
                    {tag}
                  </Button>
                );
              })}
            </div>
          </div>

          <div>
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Custom tags
            </p>
            <div className="flex flex-wrap items-center gap-1">
              {tagsDraft
                .filter(
                  (t) =>
                    !SLEEP_QUICK_TAGS.some(
                      (q) => q.toLowerCase() === t.toLowerCase()
                    )
                )
                .map((t) => (
                  <Badge
                    key={t}
                    variant="secondary"
                    className="cursor-pointer"
                    onClick={() => toggleTag(t)}
                    title="Click to remove"
                  >
                    {t} ×
                  </Badge>
                ))}
              <Input
                className="h-7 w-40 text-xs"
                placeholder="add tag"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addCustomTag();
                  }
                }}
              />
            </div>
          </div>

          <div>
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Notes
            </p>
            <Textarea
              rows={3}
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              placeholder="Anything worth remembering about this night…"
            />
          </div>

          <div className="flex justify-end">
            <Button onClick={save} disabled={upsert.isPending} size="sm">
              Save night
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Last {HISTORY_DAYS} nights</CardTitle>
        </CardHeader>
        <CardContent>
          {metricHistory.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No metrics captured yet.
            </p>
          ) : (
            <ul className="space-y-1">
              {metricHistory.map((row) => {
                const sleep =
                  row.whoopSleepHours ??
                  (row.samsungSleepHours !== null &&
                  row.samsungSleepHours !== undefined
                    ? Number(row.samsungSleepHours)
                    : null);
                const score =
                  row.samsungSleepScore !== null && row.samsungSleepScore !== undefined
                    ? Number(row.samsungSleepScore)
                    : null;
                const n = notesByDateKey.get(row.dateKey);
                const tags = parseTags(n?.tags ?? null);
                return (
                  <li
                    key={row.dateKey}
                    className={cn(
                      "flex items-start justify-between gap-2 rounded-md border px-2 py-1.5 text-xs cursor-pointer",
                      row.dateKey === dateKey
                        ? "border-indigo-300 bg-indigo-50"
                        : "bg-muted/40"
                    )}
                    onClick={() => setDateKey(row.dateKey)}
                  >
                    <div className="min-w-0">
                      <p className="font-medium">{row.dateKey}</p>
                      <p className="text-muted-foreground">
                        {formatMetricValue("whoopSleepHours", sleep)}
                        {score !== null ? ` · score ${Math.round(score)}` : null}
                      </p>
                      {n?.notes ? (
                        <p className="truncate text-muted-foreground">{n.notes}</p>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap justify-end gap-1">
                      {tags.map((t) => (
                        <Badge key={t} variant="outline" className="text-[10px]">
                          {t}
                        </Badge>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
