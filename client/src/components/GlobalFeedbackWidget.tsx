import { useAuth } from "@/_core/hooks/useAuth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { MessageSquareText } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";

type FeedbackCategory = "improvement" | "bug" | "ui" | "data" | "workflow" | "other";

const FEEDBACK_CATEGORY_OPTIONS: Array<{ value: FeedbackCategory; label: string }> = [
  { value: "improvement", label: "Improvement idea" },
  { value: "bug", label: "Bug / broken behavior" },
  { value: "ui", label: "UI / layout" },
  { value: "data", label: "Data quality" },
  { value: "workflow", label: "Workflow / automation" },
  { value: "other", label: "Other" },
];

function extractSectionHints(): string[] {
  if (typeof window === "undefined") return [];

  const values = new Set<string>();

  const addValue = (value: string | null | undefined) => {
    const cleaned = (value ?? "").trim();
    if (!cleaned) return;
    if (cleaned.length > 120) return;
    values.add(cleaned);
  };

  const sectionNodes = document.querySelectorAll<HTMLElement>(
    "[id^='section-'], [id$='-section'], [data-feedback-section]"
  );
  sectionNodes.forEach((node) => {
    addValue(node.dataset.feedbackSection);
    addValue(node.id);
  });

  const headings = document.querySelectorAll<HTMLElement>("main h1, main h2, main h3, main [data-section-title]");
  headings.forEach((node) => {
    addValue(node.dataset.sectionTitle);
    addValue(node.textContent);
  });

  return Array.from(values).slice(0, 24);
}

function formatCreatedAt(value: unknown): string {
  const date = new Date(typeof value === "string" || value instanceof Date ? value : Date.now());
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function GlobalFeedbackWidget() {
  const { user, loading } = useAuth();
  const [path] = useLocation();
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<FeedbackCategory>("improvement");
  const [sectionInput, setSectionInput] = useState("");
  const [noteInput, setNoteInput] = useState("");
  const [sectionHints, setSectionHints] = useState<string[]>([]);

  const feedbackListQuery = trpc.feedback.listMine.useQuery(
    { limit: 8 },
    {
      enabled: !!user && open,
      retry: false,
      refetchOnWindowFocus: false,
    }
  );

  const submitFeedback = trpc.feedback.submit.useMutation({
    onSuccess: async (result) => {
      toast.success(
        result.feedbackId
          ? `Feedback saved (ID: ${result.feedbackId.slice(0, 8)})`
          : "Feedback saved"
      );
      setNoteInput("");
      await feedbackListQuery.refetch();
    },
    onError: (error) => {
      toast.error(`Could not save feedback: ${error.message}`);
    },
  });

  useEffect(() => {
    if (!open) return;
    setSectionHints(extractSectionHints());
  }, [open, path]);

  const trimmedNote = noteInput.trim();
  const canSubmit = trimmedNote.length >= 3 && !submitFeedback.isPending;

  const pathLabel = useMemo(() => {
    const cleaned = (path || "/").trim();
    return cleaned.length > 0 ? cleaned : "/";
  }, [path]);

  const handleSubmit = () => {
    if (!canSubmit) {
      toast.error("Please enter at least 3 characters.");
      return;
    }

    const contextPayload =
      typeof window === "undefined"
        ? null
        : JSON.stringify({
            href: window.location.href,
            userAgent: navigator.userAgent,
            capturedAt: new Date().toISOString(),
          });

    submitFeedback.mutate({
      pagePath: pathLabel,
      sectionId: sectionInput.trim() || undefined,
      category,
      note: trimmedNote,
      contextJson: contextPayload || undefined,
    });
  };

  if (loading || !user) {
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          className="fixed bottom-4 left-4 z-50 rounded-full shadow-lg"
          size="sm"
          variant="secondary"
        >
          <MessageSquareText className="h-4 w-4 mr-2" />
          Feedback
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Share Feedback</DialogTitle>
          <DialogDescription>
            Send improvement notes for this page or a specific section.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
            <p className="font-medium text-slate-900">Page</p>
            <p className="text-slate-700">{pathLabel}</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="feedback-category">Category</Label>
            <Select value={category} onValueChange={(value) => setCategory(value as FeedbackCategory)}>
              <SelectTrigger id="feedback-category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FEEDBACK_CATEGORY_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="feedback-section">Section (optional)</Label>
            <Input
              id="feedback-section"
              value={sectionInput}
              onChange={(event) => setSectionInput(event.target.value)}
              placeholder="Example: section-todoist or Ownership Mix graph"
            />
            {sectionHints.length > 0 ? (
              <div className="flex flex-wrap gap-2 pt-1">
                {sectionHints.slice(0, 10).map((hint) => (
                  <button
                    key={hint}
                    type="button"
                    onClick={() => setSectionInput(hint)}
                    className="rounded-full border border-slate-300 px-2 py-0.5 text-xs text-slate-700 hover:bg-slate-100"
                  >
                    {hint}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="feedback-note">Improvement Note</Label>
            <Textarea
              id="feedback-note"
              rows={5}
              value={noteInput}
              onChange={(event) => setNoteInput(event.target.value)}
              placeholder="What should change? What behavior did you expect?"
              maxLength={4000}
            />
            <p className="text-xs text-slate-500">{noteInput.length}/4000</p>
          </div>

          <div className="flex justify-end">
            <Button onClick={handleSubmit} disabled={!canSubmit}>
              {submitFeedback.isPending ? "Saving..." : "Submit Feedback"}
            </Button>
          </div>

          <div className="space-y-2 border-t border-slate-200 pt-3">
            <p className="text-sm font-medium text-slate-900">Recent Feedback</p>
            {feedbackListQuery.isLoading ? (
              <p className="text-sm text-slate-500">Loading...</p>
            ) : feedbackListQuery.data && feedbackListQuery.data.length > 0 ? (
              <div className="max-h-40 space-y-2 overflow-auto pr-1">
                {feedbackListQuery.data.map((row) => (
                  <div key={row.id} className="rounded-md border border-slate-200 p-2 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <Badge variant="outline">{row.category}</Badge>
                      <span className="text-slate-500">{formatCreatedAt(row.createdAt)}</span>
                    </div>
                    <p className="mt-1 text-slate-800">{row.note}</p>
                    <p className="mt-1 text-slate-500">
                      {row.pagePath}
                      {row.sectionId ? ` • ${row.sectionId}` : ""}
                    </p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-slate-500">No feedback submitted yet.</p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
