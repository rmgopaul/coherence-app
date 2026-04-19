/**
 * FocusModeContext — per-device focus toggle.
 *
 * Collapses the dashboard to just the hero + next event. Persisted in
 * localStorage only (not synced to DB), per handoff/focus-mode.md.
 *
 * - `f` key anywhere (not in inputs) toggles.
 * - `Escape` exits when focused.
 * - Consumers pass `enabled: !focusMode` to tRPC queries they want to
 *   skip while in focus mode.
 *
 * The context is provided above `AppRoutes` so the Masthead toggle and
 * any component under it share state without prop-drilling.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

const STORAGE_KEY = "fp-focus";

interface FocusModeContextValue {
  focusMode: boolean;
  toggle: () => void;
  set: (v: boolean) => void;
}

const FocusModeContext = createContext<FocusModeContextValue | null>(null);

function readInitial(): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function FocusModeProvider({ children }: { children: ReactNode }) {
  const [focusMode, setFocusModeState] = useState<boolean>(readInitial);

  const set = useCallback((v: boolean) => {
    setFocusModeState(v);
    try {
      localStorage.setItem(STORAGE_KEY, v ? "1" : "0");
    } catch {
      // localStorage disabled — fall through, state still lives in memory.
    }
    if (typeof document !== "undefined") {
      document.documentElement.dataset.focus = v ? "1" : "0";
    }
  }, []);

  const toggle = useCallback(() => {
    setFocusModeState((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      } catch {
        // ignore
      }
      if (typeof document !== "undefined") {
        document.documentElement.dataset.focus = next ? "1" : "0";
      }
      return next;
    });
  }, []);

  // Mirror initial state onto the <html> element so CSS can react
  // (e.g., dimming the page background).
  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.dataset.focus = focusMode ? "1" : "0";
    }
  }, [focusMode]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const tag = target.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target.isContentEditable
      ) {
        return;
      }
      if (e.key === "f" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        toggle();
      } else if (e.key === "Escape" && focusMode) {
        set(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusMode, set, toggle]);

  const value = useMemo<FocusModeContextValue>(
    () => ({ focusMode, toggle, set }),
    [focusMode, toggle, set]
  );

  return (
    <FocusModeContext.Provider value={value}>
      {children}
    </FocusModeContext.Provider>
  );
}

export function useFocusMode(): FocusModeContextValue {
  const ctx = useContext(FocusModeContext);
  if (!ctx) {
    // Silently no-op outside of the provider so the hook can be safely
    // referenced by components rendered in both dashboards.
    return {
      focusMode: false,
      toggle: () => {},
      set: () => {},
    };
  }
  return ctx;
}
