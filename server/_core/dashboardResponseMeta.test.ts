import { describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";
import { buildDashboardResponseMeta } from "./dashboardResponseMeta";

describe("buildDashboardResponseMeta", () => {
  it("returns empty meta when there are no errors", () => {
    expect(buildDashboardResponseMeta({ errors: [] })).toEqual({});
  });

  it("returns empty meta when errors exist but none are TOO_MANY_REQUESTS", () => {
    const errors = [
      new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "boom" }),
      new TRPCError({ code: "BAD_REQUEST", message: "bad" }),
      new TRPCError({ code: "UNAUTHORIZED", message: "auth" }),
    ];
    expect(buildDashboardResponseMeta({ errors })).toEqual({});
  });

  it("sets Retry-After: 5 when any error is TOO_MANY_REQUESTS", () => {
    const errors = [
      new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: "Server heap pressure — retry in a moment",
      }),
    ];
    const result = buildDashboardResponseMeta({ errors });
    expect(result.headers).toEqual({ "Retry-After": "5" });
  });

  it("sets Retry-After even when other (non-overload) errors are also present", () => {
    // tRPC batches multiple procedures into one HTTP call. If even
    // one fires TOO_MANY_REQUESTS, the entire batch should signal
    // retry — the other errors don't override.
    const errors = [
      new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "boom" }),
      new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: "Server heap pressure",
      }),
    ];
    const result = buildDashboardResponseMeta({ errors });
    expect(result.headers).toEqual({ "Retry-After": "5" });
  });

  it("does not set status (lets tRPC's default code-based mapping apply)", () => {
    // The Retry-After header travels alongside whatever HTTP status
    // tRPC chose (429 for TOO_MANY_REQUESTS by default). We only
    // augment headers; we don't override the status.
    const errors = [
      new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: "Server heap pressure",
      }),
    ];
    const result = buildDashboardResponseMeta({ errors });
    expect(result.status).toBeUndefined();
  });
});
