/**
 * Tests for `batchedDelete` (nightly-prune batching, 2026-05-22).
 *
 * The helper takes its delete callback as a parameter, so the loop /
 * termination / safety-cap logic can be pinned in isolation with a
 * fake `deleteBatch` — no DB or mocks required. `withDbRetry` and
 * `getDbExecuteAffectedRows` run for real (the callback never throws).
 */
import { describe, expect, it, vi } from "vitest";
import { batchedDelete } from "./_core";

// Driver result shape the real delete returns: [OkPacket, fields].
const okPacket = (affectedRows: number) => [{ affectedRows }];

describe("batchedDelete", () => {
  it("stops after one batch when fewer than batchSize rows match", async () => {
    const deleteBatch = vi.fn(async () => okPacket(3));
    const total = await batchedDelete("test", deleteBatch, 10);
    expect(deleteBatch).toHaveBeenCalledTimes(1);
    expect(deleteBatch).toHaveBeenCalledWith(10);
    expect(total).toBe(3);
  });

  it("loops across full batches then stops on the partial tail", async () => {
    const affected = [5, 5, 2];
    let i = 0;
    const deleteBatch = vi.fn(async () => okPacket(affected[i++]));
    const total = await batchedDelete("test", deleteBatch, 5);
    expect(deleteBatch).toHaveBeenCalledTimes(3);
    expect(total).toBe(12);
  });

  it("treats an exact multiple as a final empty batch and terminates", async () => {
    const affected = [5, 0];
    let i = 0;
    const deleteBatch = vi.fn(async () => okPacket(affected[i++]));
    const total = await batchedDelete("test", deleteBatch, 5);
    expect(deleteBatch).toHaveBeenCalledTimes(2);
    expect(total).toBe(5);
  });

  it("honors the hard batch cap when rows never drop below batchSize", async () => {
    const deleteBatch = vi.fn(async () => okPacket(5));
    const total = await batchedDelete("test", deleteBatch, 5);
    expect(deleteBatch).toHaveBeenCalledTimes(10_000);
    expect(total).toBe(50_000);
  });
});
