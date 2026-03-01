import { Button } from "@/components/ui/button";
import { Lightbulb } from "lucide-react";

type SuggestedActionProps = {
  description: string;
  onAddToPlan: () => void;
};

export function SuggestedAction({ description, onAddToPlan }: SuggestedActionProps) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5">
      <div className="flex min-w-0 items-start gap-2">
        <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
        <p className="text-sm text-amber-900">{description}</p>
      </div>
      <Button size="sm" variant="outline" className="shrink-0" onClick={onAddToPlan}>
        Add to Plan
      </Button>
    </div>
  );
}

