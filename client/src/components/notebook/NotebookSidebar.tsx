import { Calendar, Folder, Pin, StickyNote } from "lucide-react";

type NotebookItem = {
  name: string;
  count: number;
};

export type NotebookSystemViewKey = "all" | "calendar" | "pinned";

type NotebookSidebarProps = {
  notebooks: NotebookItem[];
  systemCounts: {
    all: number;
    calendar: number;
    pinned: number;
  };
  selected: {
    kind: "system" | "notebook";
    key?: NotebookSystemViewKey;
    notebookName?: string;
  };
  onSelectSystem: (key: NotebookSystemViewKey) => void;
  onSelectNotebook: (name: string) => void;
};

function navButtonClass(isActive: boolean): string {
  return `flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
    isActive ? "bg-emerald-600 text-white" : "text-slate-700 hover:bg-slate-100"
  }`;
}

export function NotebookSidebar({
  notebooks,
  systemCounts,
  selected,
  onSelectSystem,
  onSelectNotebook,
}: NotebookSidebarProps) {
  const systemViews: Array<{
    key: NotebookSystemViewKey;
    label: string;
    count: number;
    icon: typeof StickyNote;
  }> = [
    { key: "all", label: "All Notes", count: systemCounts.all, icon: StickyNote },
    { key: "calendar", label: "Calendar", count: systemCounts.calendar, icon: Calendar },
    { key: "pinned", label: "Pinned", count: systemCounts.pinned, icon: Pin },
  ];

  return (
    <div className="space-y-2.5">
      <div className="space-y-1">
        {systemViews.map((view) => {
          const active = selected.kind === "system" && selected.key === view.key;
          const Icon = view.icon;
          return (
            <button
              key={view.key}
              type="button"
              onClick={() => onSelectSystem(view.key)}
              className={navButtonClass(active)}
              aria-current={active ? "page" : undefined}
              aria-label={`Open ${view.label}`}
            >
              <span className="flex min-w-0 items-center gap-2">
                <Icon className="h-4 w-4 shrink-0" />
                <span className="truncate">{view.label}</span>
              </span>
              <span className={`text-xs ${active ? "text-emerald-50" : "text-slate-500"}`}>{view.count}</span>
            </button>
          );
        })}
      </div>

      <div className="border-t border-slate-200 pt-2.5">
        <p className="px-2.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Notebooks</p>
        <div className="mt-1.5 space-y-1">
          {notebooks.length === 0 ? (
            <p className="px-2.5 py-2 text-xs text-slate-500">No notebooks yet.</p>
          ) : (
            notebooks.map((notebook) => {
              const active = selected.kind === "notebook" && selected.notebookName === notebook.name;
              return (
                <button
                  key={notebook.name}
                  type="button"
                  onClick={() => onSelectNotebook(notebook.name)}
                  className={navButtonClass(active)}
                  aria-current={active ? "page" : undefined}
                  aria-label={`Open notebook ${notebook.name}`}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Folder className="h-4 w-4 shrink-0" />
                    <span className="truncate">{notebook.name}</span>
                  </span>
                  <span className={`text-xs ${active ? "text-emerald-50" : "text-slate-500"}`}>{notebook.count}</span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

