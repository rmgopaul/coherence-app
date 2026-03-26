import { useState } from "react";
import { BarChart3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { trpc } from "@/lib/trpc";

type RatingValue = "essential" | "useful" | "rarely-use" | "remove";

const RATING_OPTIONS: Array<{
  value: RatingValue;
  label: string;
  dotColor: string;
  hoverBg: string;
}> = [
  { value: "essential", label: "Essential", dotColor: "bg-emerald-500", hoverBg: "hover:bg-emerald-50 dark:hover:bg-emerald-950/40" },
  { value: "useful", label: "Useful", dotColor: "bg-blue-500", hoverBg: "hover:bg-blue-50 dark:hover:bg-blue-950/40" },
  { value: "rarely-use", label: "Rarely use", dotColor: "bg-amber-500", hoverBg: "hover:bg-amber-50 dark:hover:bg-amber-950/40" },
  { value: "remove", label: "Remove", dotColor: "bg-red-500", hoverBg: "hover:bg-red-50 dark:hover:bg-red-950/40" },
];

export function SectionRating({
  sectionId,
  currentRating,
}: {
  sectionId: string;
  currentRating?: RatingValue | null;
}) {
  const [open, setOpen] = useState(false);
  const setRating = trpc.engagement.setRating.useMutation();
  const trpcUtils = trpc.useUtils();

  const currentOption = RATING_OPTIONS.find((o) => o.value === currentRating);

  const handleRate = (rating: RatingValue) => {
    setRating.mutate(
      { sectionId, rating },
      {
        onSuccess: () => {
          trpcUtils.engagement.getRatings.invalidate();
        },
      }
    );
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 opacity-30 hover:opacity-100 transition-opacity relative"
          title="Rate this section"
        >
          <BarChart3 className="h-3.5 w-3.5" />
          {currentOption && (
            <span
              className={`absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full ${currentOption.dotColor}`}
            />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-40 p-1" align="end">
        <p className="px-2 py-1 text-xs font-medium text-muted-foreground">
          How useful is this?
        </p>
        {RATING_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs transition-colors ${option.hoverBg} ${
              currentRating === option.value ? "font-semibold" : ""
            }`}
            onClick={() => handleRate(option.value)}
          >
            <span className={`h-2 w-2 rounded-full ${option.dotColor}`} />
            {option.label}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
