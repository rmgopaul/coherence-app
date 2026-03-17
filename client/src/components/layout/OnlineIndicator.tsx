import { useState, useEffect } from "react";
import { Wifi, WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";

export function OnlineIndicator() {
  const [online, setOnline] = useState(navigator.onLine);

  useEffect(() => {
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  // Only show when offline
  if (online) return null;

  return (
    <div className={cn(
      "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium",
      "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
      "animate-in fade-in duration-200"
    )}>
      <WifiOff className="h-3 w-3" />
      <span>Offline</span>
    </div>
  );
}
