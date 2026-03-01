import { Calendar, CheckSquare, FileText, FolderOpen } from "lucide-react";
import { useEffect, useRef } from "react";

export type LinkMenuOptionKey = "calendar" | "todoist" | "note" | "drive";

type LinkMenuOption = {
  key: LinkMenuOptionKey;
  label: string;
  icon: typeof Calendar;
};

type LinkMenuProps = {
  open: boolean;
  onClose: () => void;
  onSelect: (option: LinkMenuOptionKey) => void | Promise<void>;
  className?: string;
};

const OPTIONS: LinkMenuOption[] = [
  { key: "calendar", label: "Link to Calendar Event...", icon: Calendar },
  { key: "todoist", label: "Link to Todoist Task...", icon: CheckSquare },
  { key: "note", label: "Link to another Note...", icon: FileText },
  { key: "drive", label: "Link to Google Drive File...", icon: FolderOpen },
];

export function LinkMenu({ open, onClose, onSelect, className = "" }: LinkMenuProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current) return;
      if (rootRef.current.contains(event.target as Node)) return;
      onClose();
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={rootRef}
      role="menu"
      aria-label="Link targets"
      className={`absolute z-30 w-64 rounded-md border border-slate-200 bg-white p-1.5 shadow-lg ${className}`}
    >
      {OPTIONS.map((option) => {
        const Icon = option.icon;
        return (
          <button
            key={option.key}
            type="button"
            role="menuitem"
            onClick={() => {
              onSelect(option.key);
              onClose();
            }}
            className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-sm text-slate-700 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
          >
            <Icon className="h-4 w-4 text-slate-500" />
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
