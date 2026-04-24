import { useSyncExternalStore } from "react";
import { formatTodayKey as sharedFormatTodayKey } from "@shared/dateKey";

/**
 * Schedule `callback` at the next local-midnight boundary, then again
 * at each subsequent midnight until the returned unsubscribe fn is
 * called. Exported for testing.
 */
export function subscribeMidnight(callback: () => void): () => void {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  function schedule() {
    const now = new Date();
    const next = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1,
      0,
      0,
      0,
      0,
    );
    timeoutId = setTimeout(() => {
      callback();
      schedule();
    }, next.getTime() - now.getTime());
  }

  schedule();
  return () => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  };
}

function getSnapshot(): string {
  return sharedFormatTodayKey();
}

/**
 * Local YYYY-MM-DD key for "today". Re-renders the calling component
 * exactly at midnight without needing any other state change, via
 * useSyncExternalStore subscribed to a midnight setTimeout that
 * re-arms itself.
 */
export function useTodayKey(): string {
  return useSyncExternalStore(subscribeMidnight, getSnapshot, getSnapshot);
}
