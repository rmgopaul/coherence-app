import { describe, it, expect } from "vitest";
import { toUserFacingHydrationMessage } from "./hydrationErrors";

describe("toUserFacingHydrationMessage", () => {
  it("returns a generic message for non-Error inputs", () => {
    expect(toUserFacingHydrationMessage("oops")).toMatch(/try refreshing/i);
    expect(toUserFacingHydrationMessage(null)).toMatch(/try refreshing/i);
    expect(toUserFacingHydrationMessage(undefined)).toMatch(/try refreshing/i);
    expect(toUserFacingHydrationMessage({ message: "x" })).toMatch(/try refreshing/i);
  });

  it("maps AbortError to a timeout message", () => {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    expect(toUserFacingHydrationMessage(err)).toMatch(/timed out/i);
  });

  it("maps SyntaxError to a re-upload prompt", () => {
    const err = new Error("Unexpected token o in JSON at position 1");
    err.name = "SyntaxError";
    const message = toUserFacingHydrationMessage(err);
    expect(message).toMatch(/corrupt/i);
    expect(message).toMatch(/re-upload/i);
    // Must NOT leak the raw parser message.
    expect(message).not.toContain("Unexpected token");
  });

  it("maps QuotaExceededError to a storage-full message", () => {
    const err = new Error("…");
    err.name = "QuotaExceededError";
    expect(toUserFacingHydrationMessage(err)).toMatch(/browser storage is full/i);
  });

  it("maps DataError / DataCloneError / NotFoundError", () => {
    const data = new Error();
    data.name = "DataError";
    const clone = new Error();
    clone.name = "DataCloneError";
    const missing = new Error();
    missing.name = "NotFoundError";
    expect(toUserFacingHydrationMessage(data)).toMatch(/re-upload/i);
    expect(toUserFacingHydrationMessage(clone)).toMatch(/re-upload/i);
    expect(toUserFacingHydrationMessage(missing)).toMatch(/re-upload/i);
  });

  it("falls through to generic for unknown Error names", () => {
    const err = new Error("Random internal problem #42");
    err.name = "TotallyMadeUpError";
    const message = toUserFacingHydrationMessage(err);
    expect(message).toMatch(/try refreshing/i);
    expect(message).not.toContain("Random internal problem");
    expect(message).not.toContain("#42");
  });
});
