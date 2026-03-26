import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { X, Mail, Calendar, FileSpreadsheet, CheckSquare, Link as LinkIcon } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

interface DroppedItem {
  id: string;
  url: string;
  title: string;
  type: "gmail" | "gcal" | "gsheet" | "todoist" | "url";
  meta?: Record<string, any>;
  position: { x: number; y: number };
}

export default function UniversalDropDock() {
  const [items, setItems] = useState<DroppedItem[]>([]);
  const [inputUrl, setInputUrl] = useState("");
  const [draggedItemId, setDraggedItemId] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dockRef = useRef<HTMLDivElement>(null);
  
  const fetchItemDetails = trpc.dock.getItemDetails.useMutation();
  
  const shouldRefreshTitle = (item: DroppedItem) => {
    if (item.type !== "gmail" && item.type !== "todoist") return false;
    const title = item.title.trim().toLowerCase();
    return title === "loading..." || title === "email" || title === "task";
  };

  // Load items from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem("dropDockItems");
    if (saved) {
      try {
        const loadedItems: DroppedItem[] = JSON.parse(saved);
        setItems(loadedItems);

        // Backfill generic labels from older saves to real API titles.
        loadedItems
          .filter((item) => shouldRefreshTitle(item))
          .forEach(async (item) => {
            try {
              const details = await fetchItemDetails.mutateAsync({
                url: item.url,
                source: item.type,
                meta: item.meta,
              });
              setItems((prev) =>
                prev.map((current) =>
                  current.id === item.id ? { ...current, title: details.title } : current
                )
              );
            } catch (error) {
              console.error("Failed to refresh dock item title:", error);
            }
          });
      } catch (e) {
        console.error("Failed to load items:", e);
      }
    }
  }, []);

  // Save items to localStorage whenever they change
  useEffect(() => {
    localStorage.setItem("dropDockItems", JSON.stringify(items));
  }, [items]);

  const parseUrl = (url: string) => {
    try {
      const urlObj = new URL(url);
      const host = urlObj.hostname.toLowerCase();
      const pathname = urlObj.pathname;
      const searchParams = urlObj.searchParams;

      // Gmail
      if (host === "mail.google.com" && pathname.includes("/mail/")) {
        const hash = urlObj.hash.startsWith("#") ? urlObj.hash.slice(1) : urlObj.hash;
        const hashMessageId = hash.split("/").pop();
        const queryMessageId = searchParams.get("th");
        const messageId = queryMessageId || hashMessageId;
        return {
          type: "gmail" as const,
          meta: { messageId },
        };
      }

      // Google Calendar
      if (host === "www.google.com" && pathname.startsWith("/calendar")) {
        const eid = searchParams.get("eid");
        if (eid) {
          try {
            const decoded = atob(eid);
            const eventId = decoded.split(" ")[0];
            return {
              type: "gcal" as const,
              meta: { eid, eventId },
            };
          } catch (e) {
            console.error("[Drop Dock] Failed to decode eid:", e);
          }
        }
      }

      if (host === "calendar.google.com") {
        const eventId = searchParams.get("eid");
        if (eventId) {
          return {
            type: "gcal" as const,
            meta: { eventId },
          };
        }
      }

      // Google Sheets
      if (host === "docs.google.com" && pathname.includes("/spreadsheets/")) {
        const parts = pathname.split("/");
        const sheetId = parts[parts.indexOf("d") + 1];
        return {
          type: "gsheet" as const,
          meta: { sheetId },
        };
      }

      // Todoist
      if (host === "todoist.com" || host === "app.todoist.com") {
        const hash = urlObj.hash.startsWith("#") ? urlObj.hash.slice(1) : urlObj.hash;
        const taskMatch =
          pathname.match(/\/task\/([A-Za-z0-9_-]+)/) ||
          hash.match(/\/task\/([A-Za-z0-9_-]+)/);
        if (taskMatch) {
          return {
            type: "todoist" as const,
            meta: { taskId: taskMatch[1] },
          };
        }
      }

      // Generic URL
      return {
        type: "url" as const,
        meta: { domain: host },
      };
    } catch (e) {
      console.error("[Drop Dock] Failed to parse URL:", e);
      return null;
    }
  };

  const addItem = async (url: string) => {
    const parsed = parseUrl(url);
    if (!parsed) {
      toast.error("Invalid URL");
      return;
    }

    const newItem: DroppedItem = {
      id: Date.now().toString(),
      url,
      title: "Loading...",
      type: parsed.type,
      meta: parsed.meta,
      position: { x: 20, y: 20 + items.length * 10 },
    };

    setItems((prev) => [...prev, newItem]);
    setInputUrl("");

    // Fetch real title in background
    try {
      const details = await fetchItemDetails.mutateAsync({
        url,
        source: parsed.type,
        meta: parsed.meta,
      });
      
      setItems((prev) =>
        prev.map((item) =>
          item.id === newItem.id ? { ...item, title: details.title } : item
        )
      );
      toast.success("Item added");
    } catch (error) {
      console.error("Failed to fetch item details:", error);
      const fallbackTitle = 
        parsed.type === "gmail" ? "Email" :
        parsed.type === "gcal" ? "Calendar Event" :
        parsed.type === "gsheet" ? "Spreadsheet" :
        parsed.type === "todoist" ? "Task" :
        parsed.meta?.domain || "Link";
      
      setItems((prev) =>
        prev.map((item) =>
          item.id === newItem.id ? { ...item, title: fallbackTitle } : item
        )
      );
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const url = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain");
    if (url && !draggedItemId) {
      addItem(url);
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const url = e.clipboardData.getData("text");
    if (url) {
      addItem(url);
    }
  };

  const removeItem = (id: string) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
  };

  const handleMouseDown = (e: React.MouseEvent, itemId: string) => {
    if ((e.target as HTMLElement).closest("button")) return;
    
    e.preventDefault();
    const item = items.find((i) => i.id === itemId);
    if (!item) return;

    const rect = (e.target as HTMLElement).getBoundingClientRect();
    setDragOffset({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
    setDraggedItemId(itemId);
    setIsDragging(false);
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (!draggedItemId || !dockRef.current) return;

    setIsDragging(true);
    const dockRect = dockRef.current.getBoundingClientRect();
    const x = e.clientX - dockRect.left - dragOffset.x;
    const y = e.clientY - dockRect.top - dragOffset.y;

    setItems((prev) =>
      prev.map((item) =>
        item.id === draggedItemId
          ? { ...item, position: { x: Math.max(0, x), y: Math.max(0, y) } }
          : item
      )
    );
  };

  const handleMouseUp = () => {
    setDraggedItemId(null);
    setTimeout(() => setIsDragging(false), 100);
  };

  useEffect(() => {
    if (draggedItemId) {
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
      return () => {
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
      };
    }
  }, [draggedItemId, dragOffset]);

  const getIcon = (type: DroppedItem["type"]) => {
    switch (type) {
      case "gmail":
        return <Mail className="h-4 w-4" />;
      case "gcal":
        return <Calendar className="h-4 w-4" />;
      case "gsheet":
        return <FileSpreadsheet className="h-4 w-4" />;
      case "todoist":
        return <CheckSquare className="h-4 w-4" />;
      default:
        return <LinkIcon className="h-4 w-4" />;
    }
  };

  const getColor = (type: DroppedItem["type"]) => {
    switch (type) {
      case "gmail":
        return "bg-red-50 border-red-200 text-red-700 hover:bg-red-100";
      case "gcal":
        return "bg-blue-50 border-blue-200 text-blue-700 hover:bg-blue-100";
      case "gsheet":
        return "bg-green-50 border-green-200 text-green-700 hover:bg-green-100";
      case "todoist":
        return "bg-orange-50 border-orange-200 text-orange-700 hover:bg-orange-100";
      default:
        return "bg-gray-50 border-gray-200 text-gray-700 hover:bg-gray-100";
    }
  };

  const getTitleClass = (item: DroppedItem) => {
    const length = item.title.trim().length;

    // Email subjects are usually longer, so shrink text progressively.
    if (item.type === "gmail") {
      if (length > 90) return "text-xs leading-tight font-medium truncate flex-1";
      if (length > 65) return "text-xs leading-tight font-medium truncate flex-1";
      return "text-sm leading-tight font-medium truncate flex-1";
    }

    if (length > 70) return "text-xs font-medium truncate flex-1";
    return "text-sm font-medium truncate flex-1";
  };

  return (
    <div className="space-y-2">
      {/* Unified Drop Zone - Input at top */}
      <div className="flex gap-2">
        <Input
          type="text"
          placeholder="Paste a link or drag & drop from Calendar, Gmail, Sheets, or Todoist..."
          value={inputUrl}
          onChange={(e) => setInputUrl(e.target.value)}
          onPaste={handlePaste}
          onKeyDown={(e) => {
            if (e.key === "Enter" && inputUrl) {
              addItem(inputUrl);
            }
          }}
          className="flex-1"
        />
        <Button
          onClick={() => inputUrl && addItem(inputUrl)}
          disabled={!inputUrl}
        >
          Add
        </Button>
        <Button
          variant="outline"
          onClick={() => setItems([])}
          disabled={items.length === 0}
        >
          Clear
        </Button>
      </div>

      {/* Drop Dock Canvas - Half the previous height (250px) */}
      <div
        ref={dockRef}
        className="relative border-2 border-dashed border-gray-300 rounded-lg bg-gray-50/50 overflow-hidden"
        style={{ height: "250px", minHeight: "250px" }}
        onDrop={handleDrop}
        onDragOver={(e) => e.preventDefault()}
      >
        {items.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center text-gray-400 text-sm">
            Drop or paste links here to create bookmarks
          </div>
        ) : (
          items.map((item) => (
            <a
              key={item.id}
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              className={`absolute flex items-center gap-2 px-3 py-2 rounded-md border transition-all cursor-move select-none ${getColor(
                item.type
              )} ${draggedItemId === item.id ? "shadow-lg scale-105 z-50" : "shadow-sm"}`}
              style={{
                left: `${item.position.x}px`,
                top: `${item.position.y}px`,
                maxWidth: item.type === "gmail" ? "320px" : "250px",
              }}
              onMouseDown={(e) => handleMouseDown(e, item.id)}
              onClick={(e) => {
                if (isDragging || draggedItemId) {
                  e.preventDefault();
                }
              }}
            >
              {getIcon(item.type)}
              <span className={getTitleClass(item)} title={item.title}>
                {item.title}
              </span>
              <button
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  removeItem(item.id);
                }}
                className="flex-shrink-0 hover:bg-white/50 rounded p-1 transition-colors"
              >
                <X className="h-3 w-3" />
              </button>
            </a>
          ))
        )}
      </div>
    </div>
  );
}
