import { useEffect, useRef, useCallback } from "react";
import { trpc } from "@/lib/trpc";

type EngagementEvent = {
  sectionId: string;
  eventType: string;
  eventValue?: string;
  sessionDate: string;
  durationMs?: number;
};

const MIN_VIEW_DURATION_MS = 2_000;
const FLUSH_INTERVAL_MS = 30_000;

function buildLocalDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Passively tracks which dashboard sections are visible (via IntersectionObserver)
 * and allows explicit interaction recording. Batches events and flushes every 30s.
 */
export function useSectionVisibilityTracker(sectionIds: string[]) {
  const batchRef = useRef<EngagementEvent[]>([]);
  const visibilityTimers = useRef<Map<string, number>>(new Map());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const flushTimerRef = useRef<number | null>(null);

  const recordBatch = trpc.engagement.recordBatch.useMutation();

  const flush = useCallback(() => {
    const events = batchRef.current;
    if (events.length === 0) return;
    batchRef.current = [];
    recordBatch.mutate({ events });
  }, [recordBatch]);

  const recordInteraction = useCallback((sectionId: string) => {
    batchRef.current.push({
      sectionId,
      eventType: "interact",
      sessionDate: buildLocalDateKey(),
    });
  }, []);

  const recordEvent = useCallback(
    (sectionId: string, eventType: string, eventValue?: string) => {
      batchRef.current.push({
        sectionId,
        eventType,
        eventValue,
        sessionDate: buildLocalDateKey(),
      });
    },
    []
  );

  useEffect(() => {
    // Set up IntersectionObserver for section visibility
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const sectionId = entry.target.getAttribute("data-section-id");
          if (!sectionId) continue;

          if (entry.isIntersecting) {
            // Section entered viewport — start timer
            if (!visibilityTimers.current.has(sectionId)) {
              visibilityTimers.current.set(sectionId, Date.now());
            }
          } else {
            // Section left viewport — record view if duration > threshold
            const startTime = visibilityTimers.current.get(sectionId);
            if (startTime) {
              const durationMs = Date.now() - startTime;
              visibilityTimers.current.delete(sectionId);
              if (durationMs >= MIN_VIEW_DURATION_MS) {
                batchRef.current.push({
                  sectionId,
                  eventType: "view",
                  sessionDate: buildLocalDateKey(),
                  durationMs,
                });
              }
            }
          }
        }
      },
      { threshold: 0.3 }
    );

    observerRef.current = observer;

    // Observe all section elements
    for (const id of sectionIds) {
      const el = document.getElementById(id);
      if (el) {
        el.setAttribute("data-section-id", id);
        observer.observe(el);
      }
    }

    // Periodic flush
    flushTimerRef.current = window.setInterval(() => {
      // Flush accumulated view events for sections still visible
      for (const [sectionId, startTime] of Array.from(visibilityTimers.current.entries())) {
        const durationMs = Date.now() - startTime;
        if (durationMs >= MIN_VIEW_DURATION_MS) {
          batchRef.current.push({
            sectionId,
            eventType: "view",
            sessionDate: buildLocalDateKey(),
            durationMs,
          });
          // Reset timer for ongoing visibility
          visibilityTimers.current.set(sectionId, Date.now());
        }
      }

      const events = batchRef.current;
      if (events.length > 0) {
        batchRef.current = [];
        recordBatch.mutate({ events });
      }
    }, FLUSH_INTERVAL_MS);

    // Flush on page unload
    const handleBeforeUnload = () => {
      // Finalize any in-progress views
      for (const [sectionId, startTime] of Array.from(visibilityTimers.current.entries())) {
        const durationMs = Date.now() - startTime;
        if (durationMs >= MIN_VIEW_DURATION_MS) {
          batchRef.current.push({
            sectionId,
            eventType: "view",
            sessionDate: buildLocalDateKey(),
            durationMs,
          });
        }
      }

      if (batchRef.current.length > 0) {
        const events = batchRef.current;
        batchRef.current = [];
        // Use sendBeacon for reliable delivery on page unload
        const url = "/api/trpc/engagement.recordBatch";
        const body = JSON.stringify({ json: { events } });
        navigator.sendBeacon(url, body);
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      observer.disconnect();
      window.removeEventListener("beforeunload", handleBeforeUnload);
      if (flushTimerRef.current !== null) {
        window.clearInterval(flushTimerRef.current);
      }
    };
  }, [sectionIds, recordBatch]);

  return { recordInteraction, recordEvent, flush };
}
