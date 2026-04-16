/// <reference lib="webworker" />

/**
 * Phase 19: off-main-thread `systems` builder.
 *
 * The main thread posts a `SystemsWorkerRequest` with the raw dataset
 * rows the pure `buildSystems` reducer needs, and gets back a
 * `SystemsWorkerResponse` with the resulting `SystemRecord[]`. All
 * of the ~436-line builder body runs here instead of blocking the
 * UI.
 *
 * The worker has zero ambient state — each request is handled
 * independently. The main thread is responsible for de-duplicating
 * stale responses via the `id` field (increment it per request,
 * discard any response whose id doesn't match the latest outstanding).
 */

import {
  buildSystems,
  type BuildSystemsInput,
} from "@/solar-rec-dashboard/lib/buildSystems";
import type { SystemRecord } from "@/solar-rec-dashboard/state/types";

export interface SystemsWorkerRequest {
  id: number;
  input: BuildSystemsInput;
}

export type SystemsWorkerResponse =
  | {
      id: number;
      ok: true;
      systems: SystemRecord[];
    }
  | {
      id: number;
      ok: false;
      error: string;
    };

self.onmessage = (event: MessageEvent<SystemsWorkerRequest>) => {
  const { id, input } = event.data;
  try {
    const systems = buildSystems(input);
    const response: SystemsWorkerResponse = { id, ok: true, systems };
    self.postMessage(response);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "buildSystems worker threw an unknown error.";
    const response: SystemsWorkerResponse = { id, ok: false, error: message };
    self.postMessage(response);
  }
};
