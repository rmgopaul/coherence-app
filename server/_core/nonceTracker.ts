/**
 * In-memory nonce replay-prevention for signed webhook payloads.
 *
 * Shared between supplementIngest.ts and solarReadingsIngest.ts.
 * Tracks seen nonces within a configurable time window to prevent
 * duplicate deliveries.
 *
 * Note: nonces are lost on server restart — requests within the
 * replay window may succeed if the server restarts. Consider
 * persisting to Redis or DB if this becomes a concern.
 */

export function createNonceTracker(replayWindowMs: number) {
  const seenNonces = new Map<string, number>();

  function cleanup(nowMs: number): void {
    seenNonces.forEach((expiresAt, nonce) => {
      if (expiresAt <= nowMs) {
        seenNonces.delete(nonce);
      }
    });
  }

  function remember(nonce: string, nowMs: number): void {
    seenNonces.set(nonce, nowMs + replayWindowMs);
  }

  function hasReplay(nonce: string, nowMs: number): boolean {
    const expiresAt = seenNonces.get(nonce);
    if (!expiresAt) return false;
    if (expiresAt <= nowMs) {
      seenNonces.delete(nonce);
      return false;
    }
    return true;
  }

  function reset(): void {
    seenNonces.clear();
  }

  return { cleanup, remember, hasReplay, reset };
}
