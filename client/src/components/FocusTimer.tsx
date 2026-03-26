import { useState, useEffect, useRef, useCallback } from "react";
import { Play, Pause, RotateCcw, Timer } from "lucide-react";

const PRESETS = [
  { label: "25m", seconds: 25 * 60 },
  { label: "15m", seconds: 15 * 60 },
  { label: "5m", seconds: 5 * 60 },
] as const;

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function FocusTimer() {
  const [remaining, setRemaining] = useState(25 * 60);
  const [running, setRunning] = useState(false);
  const [totalDuration, setTotalDuration] = useState(25 * 60);
  const intervalRef = useRef<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const stop = useCallback(() => {
    setRunning(false);
    if (intervalRef.current !== null) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const start = useCallback(() => {
    if (remaining <= 0) return;
    setRunning(true);
  }, [remaining]);

  const reset = useCallback(
    (seconds?: number) => {
      stop();
      const dur = seconds ?? totalDuration;
      setTotalDuration(dur);
      setRemaining(dur);
    },
    [stop, totalDuration]
  );

  // Tick
  useEffect(() => {
    if (!running) return;

    intervalRef.current = window.setInterval(() => {
      setRemaining((prev) => {
        if (prev <= 1) {
          stop();
          // Play a short beep via Web Audio API
          try {
            const ctx = new AudioContext();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.frequency.value = 880;
            gain.gain.value = 0.3;
            osc.start();
            osc.stop(ctx.currentTime + 0.3);
          } catch {
            // Audio unavailable — silent fallback
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (intervalRef.current !== null) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [running, stop]);

  // Update document title while running
  useEffect(() => {
    if (running && remaining > 0) {
      document.title = `${formatTime(remaining)} — Coherence`;
    } else if (remaining === 0) {
      document.title = "⏰ Timer done — Coherence";
    }
    return () => {
      document.title = "Coherence";
    };
  }, [running, remaining]);

  const progress = totalDuration > 0 ? ((totalDuration - remaining) / totalDuration) * 100 : 0;
  const isDone = remaining === 0 && !running;

  return (
    <div className="rounded-md border border-slate-200 bg-white/90 p-2.5">
      <p className="text-xs uppercase tracking-wide text-slate-500">Focus Timer</p>
      <div className="mt-1 flex items-center gap-2">
        <Timer className={`h-4 w-4 ${isDone ? "text-amber-500" : running ? "text-emerald-600" : "text-slate-500"}`} />
        <span className={`text-sm font-semibold tabular-nums ${isDone ? "text-amber-600" : "text-slate-900"}`}>
          {formatTime(remaining)}
        </span>

        <div className="flex items-center gap-0.5 ml-auto">
          {!running ? (
            <button
              type="button"
              onClick={start}
              disabled={remaining === 0}
              className="rounded p-1 text-emerald-700 hover:bg-emerald-100 disabled:opacity-30 disabled:cursor-not-allowed"
              title="Start"
            >
              <Play className="h-3.5 w-3.5" />
            </button>
          ) : (
            <button
              type="button"
              onClick={stop}
              className="rounded p-1 text-amber-700 hover:bg-amber-100"
              title="Pause"
            >
              <Pause className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={() => reset()}
            className="rounded p-1 text-slate-500 hover:bg-slate-100"
            title="Reset"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Progress bar */}
      {(running || (progress > 0 && remaining > 0)) && (
        <div className="mt-1.5 h-1 w-full rounded-full bg-slate-200 overflow-hidden">
          <div
            className="h-full rounded-full bg-emerald-500 transition-all duration-1000"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}

      {/* Presets */}
      {!running && (
        <div className="mt-1.5 flex gap-1">
          {PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              onClick={() => reset(preset.seconds)}
              className={`rounded px-1.5 py-0.5 text-xs font-medium transition-colors ${
                totalDuration === preset.seconds && remaining === preset.seconds
                  ? "bg-emerald-100 text-emerald-800"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}
            >
              {preset.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
